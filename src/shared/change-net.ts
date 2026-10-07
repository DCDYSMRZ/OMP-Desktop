import type { RecordedFileChange, SessionResourceContext } from './contracts';
import type { ChangeEndpointPair, FileChangeEvidence } from './turn-change-types';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const optionalText = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const MAX_LINES = 100_000, MAX_TEXT = 8 * 1024 * 1024, MAX_WORK = 2_000_000;

/** Lexical identity only: this never grants filesystem access or resolves symlinks. */
export function changePath(value: string, cwd = ''): string {
  if (!value || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return '';
  value = value.replace(/\\/g, '/');
  const joined = value.startsWith('/') ? value : cwd ? `${cwd}/${value}` : value;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !joined.startsWith('/')) parts.push(part);
  }
  return `${joined.startsWith('/') ? '/' : ''}${parts.join('/')}`.replace(/^\/private\/(tmp|var|etc)(?=\/|$)/, '/$1');
}
const displayPath = (path: string, cwd: string) => { const root = changePath(cwd).replace(/\/$/, ''); return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path; };

export interface ToolEvidenceInput {
  source: { sessionId: string; cwd: string; sourcePath?: string; context?: SessionResourceContext; label?: string; parentToolCallId?: string };
  toolId: string; entryId?: string; resultEntryId?: string; name: string; args?: unknown; result?: unknown; status: string; sequence: number; timestamp?: number;
}

/** Only result carriers and successful native filesystem tools establish mutations. */
export function normalizeToolEvidence(input: ToolEvidenceInput): FileChangeEvidence[] {
  if (!['complete', 'error'].includes(input.status)) return [];
  const args = object(input.args), result = object(input.result), details = object(result.details);
  const name = input.name.split(/[/.]/).at(-1) ?? input.name;
  if (['task', 'subagent', 'yield', 'readSessionArtifact'].includes(name)) return [];
  const nativeWrite = name === 'write' || name === 'write_file';
  const nativeEdit = ['edit', 'hashline', 'hashline_edit', 'apply_patch', 'apply-patch', 'ast_edit', 'delete', 'move'].includes(name);
  const nativeRead = name === 'read' || name === 'read_file';
  const perFile = Array.isArray(details.perFileResults) ? details.perFileResults : Array.isArray(details.files) ? details.files : undefined;
  const output = typeof result.content === 'string' ? result.content : Array.isArray(result.content) ? result.content.map(block => string(object(block).text)).join('\n') : string(result.text);
  const cwd = typeof args.cwd === 'string' ? changePath(args.cwd, input.source.cwd) : input.source.cwd;
  const { cwd: _cwd, ...source } = input.source;
  const origin = { ...source, toolId: input.toolId, entryId: input.entryId, resultEntryId: input.resultEntryId };
  const evidence: FileChangeEvidence[] = [];
  for (const [index, value] of (perFile ?? [details]).entries()) {
    const file = object(value), nested = object(file.details);
    if (file.isError === true || file.errorText || file.error || file.success === false || file.applied === false) continue;
    if (!perFile && (input.status === 'error' || result.isError === true)) continue;
    const argumentPath = nativeRead ? string(args.path).replace(/#L\d+(?:-L?\d+)?$/, '').replace(/:(?:raw|img|\d+(?:[-+]\d*)?)(?::raw)?$/, '') : string(args.path);
    const fallback = argumentPath || /^\[([^\n]+)#[a-f\d]{4}\]/i.exec(string(args.input).trimStart())?.[1] || '';
    const original = string(file.resolvedPath) || string(file.path) || (!perFile ? string(details.resolvedPath) : '') || fallback;
    const move = string(file.move) || (name === 'move' ? string(args.destination) : '');
    const path = changePath(move || original, cwd);
    if (!path) continue;
    const sourcePath = changePath(string(file.sourcePath) || (move ? original : ''), cwd) || undefined;
    const rawPatch = optionalText(file.diff) ?? optionalText(file.patch) ?? optionalText(nested.diff) ?? (!perFile && nativeEdit && /^(?:@@ -\d+|[+-]\s*\d+\|)/m.test(output) ? output : undefined);
    const before = optionalText(file.oldText) ?? optionalText(file.beforeText);
    const after = optionalText(file.newText) ?? optionalText(file.afterText);
    const op = string(file.op) || string(file.operation);
    if (!nativeRead && !nativeWrite && !nativeEdit && !perFile && file.applied !== true) continue;
    if (!nativeRead && !nativeWrite && !nativeEdit && rawPatch === undefined && before === undefined && after === undefined && !['create', 'update', 'delete', 'move'].includes(op)) continue;
    const operation: FileChangeEvidence['operation'] = nativeRead ? 'read' : move || sourcePath ? 'move' : op === 'create' || file.created === true ? 'create' : op === 'delete' || name === 'delete' ? 'delete' : 'update';
    // Display lines can omit EOF newlines or BOM bytes even when every line is shown.
    // Only explicit endpoint carriers above are byte-exact; read displays prove no content endpoint.
    if (nativeRead && (details.isDirectory || result.historyResourceDeferred)) continue;
    const patch = rawPatch === undefined ? undefined : normalizePatch(rawPatch);
    const truncated = file.truncated === true || details.truncated === true || !!object(details.meta).truncation || /^(?:\s*…\s*|\s*\.\.\.\s*|.*(?:truncated|omitted)\s*)$/mi.test(rawPatch ?? '');
    evidence.push({ id: JSON.stringify([input.source.sessionId, input.source.sourcePath ?? '', input.entryId ?? '', input.toolId, index, path]), path, sourcePath, operation, origin, sequence: input.sequence, timestamp: input.timestamp, applied: 'confirmed', before, after, patch, patchComplete: patch !== undefined && !truncated && parsePatch(patch) !== undefined, binary: file.binary === true, reason: result.historyResourceDeferred ? 'deferred' : truncated ? 'truncated' : undefined });
  }
  return evidence;
}

type PatchLine = { sign: '+' | '-' | ' '; text: string; newline: boolean };
type Hunk = { oldStart: number; newStart: number; oldCount: number; newCount: number; lines: PatchLine[] };
function parsePatch(patch: string): Hunk[] | undefined {
  if (patch.length > MAX_TEXT) return undefined;
  const lines = patch.split('\n');
  if (lines.length > MAX_LINES) return undefined;
  const hunks: Hunk[] = []; let hunk: Hunk | undefined, old = 0, next = 0, oldEOF = false, newEOF = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (hunk && (old !== hunk.oldCount || next !== hunk.newCount)) return undefined;
      hunk = { oldStart: Number(header[1]), oldCount: Number(header[2] ?? 1), newStart: Number(header[3]), newCount: Number(header[4] ?? 1), lines: [] };
      if (![hunk.oldStart, hunk.newStart, hunk.oldCount, hunk.newCount].every(n => Number.isSafeInteger(n) && n >= 0) || hunk.oldCount > MAX_LINES || hunk.newCount > MAX_LINES) return undefined;
      hunks.push(hunk); old = 0; next = 0; continue;
    }
    if (line === '\\ No newline at end of file') { const previous = hunk?.lines.at(-1); if (!previous || !previous.newline) return undefined; previous.newline = false; if (previous.sign !== '+') oldEOF = true; if (previous.sign !== '-') newEOF = true; continue; }
    if (hunk && old === hunk.oldCount && next === hunk.newCount) { if (line === '' && i === lines.length - 1) continue; return undefined; }
    if (!hunk) { if (!line || /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode )/.test(line)) continue; return undefined; }
    if (!/^[ +\-]/.test(line)) return undefined;
    const sign = line[0] as PatchLine['sign'];
    if (sign !== '+' && oldEOF || sign !== '-' && newEOF) return undefined;
    hunk.lines.push({ sign, text: line.slice(1), newline: true });
    if (sign !== '+') old++; if (sign !== '-') next++;
    if (old > hunk.oldCount || next > hunk.newCount) return undefined;
  }
  return hunk && old === hunk.oldCount && next === hunk.newCount ? hunks : undefined;
}

function normalizePatch(raw: string): string | undefined {
  if (raw.length > MAX_TEXT) return undefined;
  if (/^@@ -/m.test(raw)) return raw;
  const hunks: string[] = []; let rows: { sign: string; text: string; old: number; next: number }[] = [], delta = 0;
  const flush = () => {
    if (!rows.length) return;
    const oldRows = rows.filter(row => row.sign !== '+'), newRows = rows.filter(row => row.sign !== '-');
    hunks.push(`@@ -${oldRows.length ? rows[0].old : rows[0].old - 1},${oldRows.length} +${newRows.length ? rows[0].next : rows[0].next - 1},${newRows.length} @@\n${rows.map(row => row.sign + row.text).join('\n')}`); rows = [];
  };
  for (const line of raw.split('\n')) {
    const match = /^([+ -])\s*(\d+)\|(.*)$/.exec(line);
    if (!match) { flush(); continue; }
    const sign = match[1], number = Number(match[2]);
    const old = sign === '+' ? number - delta : sign === '-' ? number : number - delta;
    const next = sign === '-' ? number + delta : number;
    const previous = rows.at(-1);
    if (previous && (old !== previous.old + (previous.sign === '+' ? 0 : 1) || next !== previous.next + (previous.sign === '-' ? 0 : 1))) flush();
    rows.push({ sign, text: match[3], old, next });
    if (sign === '+') delta++; if (sign === '-') delta--;
  }
  flush(); return hunks.length ? hunks.join('\n') : undefined;
}

const lineTokens = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const token = (line: PatchLine) => line.text + (line.newline ? '\n' : '');
function applyPatch(text: string, hunks: Hunk[]): string | undefined {
  if (text.length > MAX_TEXT) return undefined;
  const source = lineTokens(text), output: string[] = []; let cursor = 0, delta = 0;
  for (const hunk of hunks) {
    const start = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart;
    const target = hunk.newCount ? hunk.newStart - 1 : hunk.newStart;
    if (start < cursor || start > source.length || target !== start + delta) return undefined;
    for (; cursor < start; cursor++) output.push(source[cursor]);
    for (const line of hunk.lines) {
      if (line.sign !== '+' && source[cursor++] !== token(line)) return undefined;
      if (line.sign !== '-') output.push(token(line));
    }
    delta += hunk.newCount - hunk.oldCount;
    if (output.length > MAX_LINES) return undefined;
  }
  for (; cursor < source.length; cursor++) output.push(source[cursor]);
  if (output.some((value, index) => index < output.length - 1 && !value.endsWith('\n'))) return undefined;
  return output.join('');
}

type NetPatch = { patch: string; added: number; removed: number; firstChangedLine?: number };
/** Bounded LCS on the changed window; large adversarial inputs stay explicitly unknown. */
function contentDiff(before: string, after: string): NetPatch | undefined {
  if (before === after) return { patch: '', added: 0, removed: 0 };
  if (before.length + after.length > MAX_TEXT) return undefined;
  const a = lineTokens(before), b = lineTokens(after);
  if (a.length + b.length > MAX_LINES) return undefined;
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const m = a.length - start - end, n = b.length - start - end;
  if (m * n > MAX_WORK) return undefined;
  const width = n + 1, scores = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) scores[i * width + j] = a[start + i] === b[start + j] ? scores[(i + 1) * width + j + 1] + 1 : Math.max(scores[(i + 1) * width + j], scores[i * width + j + 1]);
  const body: string[] = []; let i = 0, j = 0, added = 0, removed = 0;
  const emit = (sign: string, value: string) => { body.push(sign + (value.endsWith('\n') ? value.slice(0, -1) : value)); if (!value.endsWith('\n')) body.push('\\ No newline at end of file'); };
  while (i < m || j < n) {
    if (i < m && j < n && a[start + i] === b[start + j]) { emit(' ', a[start + i++]); j++; }
    else if (i < m && (j === n || scores[(i + 1) * width + j] >= scores[i * width + j + 1])) { emit('-', a[start + i++]); removed++; }
    else { emit('+', b[start + j++]); added++; }
  }
  return { patch: `@@ -${m ? start + 1 : start},${m} +${n ? start + 1 : start},${n} @@\n${body.join('\n')}`, added, removed, firstChangedLine: start + 1 };
}

/** Sparse original-line identities avoid allocating untouched or attacker-sized gaps. */
type Piece = { start: number; length: number } | { values: string[] };
interface SparseNetState { push(operation: FileChangeEvidence): boolean; finish(): NetPatch | undefined }
function createSparseDiff(): SparseNetState {
  let pieces: Piece[] = [{ start: 0, length: Number.MAX_SAFE_INTEGER }];
  const known = new Map<number, string>();
  const split = (position: number): number | undefined => {
    let offset = 0;
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i], length = 'values' in piece ? piece.values.length : piece.length;
      if (position === offset) return i;
      if (position < offset + length) {
        const at = position - offset;
        pieces.splice(i, 1, ...('values' in piece ? [{ values: piece.values.slice(0, at) }, { values: piece.values.slice(at) }] : [{ start: piece.start, length: at }, { start: piece.start + at, length: piece.length - at }])); return i + 1;
      }
      offset += length;
    }
    return undefined;
  };
  const push = (operation: FileChangeEvidence): boolean => {
    let work = 0;
    if (operation.operation === 'move' && !operation.patch && operation.before === undefined && operation.after === undefined) return true;
    if (operation.operation !== 'update' || !operation.patchComplete || !operation.patch) return false;
    const hunks = parsePatch(operation.patch); if (!hunks || hunks.some(hunk => hunk.lines.some(line => !line.newline))) return false;
    let delta = 0, previousEnd = 0;
    for (const hunk of hunks) {
      const originalStart = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart;
      const start = originalStart + delta, target = hunk.newCount ? hunk.newStart - 1 : hunk.newStart;
      if (originalStart < previousEnd || target !== start || start < 0 || !Number.isSafeInteger(start + hunk.oldCount)) return false;
      previousEnd = originalStart + hunk.oldCount;
      const left = split(start), right = split(start + hunk.oldCount);
      if (left === undefined || right === undefined) return false;
      const oldLines = hunk.lines.filter(line => line.sign !== '+'); let at = 0;
      for (let p = left; p < right; p++) {
        const piece = pieces[p], length = 'values' in piece ? piece.values.length : piece.length;
        for (let k = 0; k < length; k++) {
          const expected = token(oldLines[at++]);
          if ('values' in piece) { if (piece.values[k] !== expected) return false; }
          else { const id = piece.start + k; if (known.has(id) && known.get(id) !== expected) return false; known.set(id, expected); }
          if (++work > MAX_WORK) return false;
        }
      }
      // Context remains original identity; only changed rows replace it.
      const replacements: Piece[] = []; let oldIndex = start;
      for (const line of hunk.lines) {
        if (line.sign === '+') replacements.push({ values: [token(line)] });
        else {
          if (line.sign === ' ') {
            let pos = 0;
            for (const piece of pieces) { if (++work > MAX_WORK) return false; const size = 'values' in piece ? piece.values.length : piece.length; if (oldIndex < pos + size) { replacements.push('values' in piece ? { values: [piece.values[oldIndex - pos]] } : { start: piece.start + oldIndex - pos, length: 1 }); break; } pos += size; }
          }
          oldIndex++;
        }
      }
      work += pieces.length + replacements.length;
      if (work > MAX_WORK) return false;
      pieces = [...pieces.slice(0, left), ...replacements, ...pieces.slice(right)];
      // Coalesce context splits so repeated overlapping updates do not grow state.
      const compact: Piece[] = [];
      for (const piece of pieces) {
        const previous = compact.at(-1);
        if (previous && !('values' in previous) && !('values' in piece) && previous.start + previous.length === piece.start) previous.length += piece.length;
        else compact.push(piece);
      }
      pieces = compact;
      delta += hunk.newCount - hunk.oldCount;
      if (pieces.length > MAX_LINES) return false;
    }
    return true;
  };
  const finish = (): NetPatch | undefined => {
    const patches: string[] = []; let added = 0, removed = 0, original = 0, next = 0, firstChangedLine: number | undefined;
    let inserted: string[] = [];
    const flush = (until: number): boolean => {
      const old: string[] = [];
      if (until - original > MAX_LINES) return false;
      for (let i = original; i < until; i++) { const value = known.get(i); if (value === undefined) return false; old.push(value); }
      const net = contentDiff(old.join(''), inserted.join('')); if (!net) return false;
      if (net.patch) {
        const shifted = net.patch.replace(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/, (_, a, ac, b, bc) => `@@ -${Number(a) + original},${ac} +${Number(b) + next},${bc} @@`);
        patches.push(shifted); added += net.added; removed += net.removed; firstChangedLine ??= next + (net.firstChangedLine ?? 1);
      }
      next += inserted.length; original = until; inserted = []; return true;
    };
    for (const piece of pieces) {
      if ('values' in piece) { for (const value of piece.values) inserted.push(value); continue; }
      if (!flush(piece.start)) return undefined;
      original += piece.length; next += piece.length;
    }
    return { patch: patches.join('\n'), added, removed, firstChangedLine };
  };
  return { push, finish };
}

/** Recover only requested endpoint hashes; intermediate versions are never retained. */
class EndpointTextRecovery {
  readonly endpoints: ChangeEndpointPair[];
  private readonly pending = new Map<string, Map<string, { index: number; side: 'before' | 'after' }[]>>();
  constructor(endpoints: readonly ChangeEndpointPair[], private readonly hashText?: (text: string) => string, private readonly cwd = '') {
    this.endpoints = [...endpoints];
    if (!hashText) return;
    for (let index = 0; index < endpoints.length; index++) {
      const pair = endpoints[index], path = changePath(pair.path, cwd);
      if (!path) continue;
      for (const side of ['before', 'after'] as const) {
        const endpoint = pair[side];
        if (!endpoint?.exists || endpoint.binary || endpoint.text !== undefined || endpoint.hash === undefined) continue;
        let hashes = this.pending.get(path);
        if (!hashes) { hashes = new Map(); this.pending.set(path, hashes); }
        const targets = hashes.get(endpoint.hash) ?? [];
        targets.push({ index, side }); hashes.set(endpoint.hash, targets);
      }
    }
  }
  push(operation: FileChangeEvidence): void {
    if (!this.hashText || operation.applied !== 'confirmed' || operation.binary) return;
    for (const side of ['before', 'after'] as const) {
      const text = operation[side];
      if (text === undefined) continue;
      const path = changePath(side === 'before' ? operation.sourcePath ?? operation.path : operation.path, this.cwd);
      const hashes = this.pending.get(path);
      if (!hashes?.size) continue;
      const hash = this.hashText(text), targets = hashes.get(hash);
      if (!targets) continue;
      for (const target of targets) {
        const pair = this.endpoints[target.index];
        this.endpoints[target.index] = { ...pair, [target.side]: { ...pair[target.side]!, text } };
      }
      hashes.delete(hash);
    }
  }
}

/** Recover evicted capture text only from exact native bytes with the captured hash. */
export function withRecoveredEndpointText(operations: readonly FileChangeEvidence[], endpoints: readonly ChangeEndpointPair[], hashText: (text: string) => string): ChangeEndpointPair[] {
  const recovery = new EndpointTextRecovery(endpoints, hashText);
  for (const operation of operations) recovery.push(operation);
  return recovery.endpoints;
}

export interface ChangeNetAccumulatorOptions {
  /** Bind captures before pushing so matching intermediate native bytes can be recovered. */
  endpoints?: readonly ChangeEndpointPair[];
  cwd?: string;
  hashText?: (text: string) => string;
  /** Optional process presentation only; neither budget limits the final net reduction. */
  maxProcessSteps?: number;
  maxProcessBytes?: number;
}

class FileNetState {
  baseline?: string;
  current?: string;
  existed?: boolean;
  exists?: boolean;
  started = false;
  conflict = false;
  missing = false;
  multipleSources = false;
  source?: string;
  sourcePath?: string;
  allUpdates = true;
  noEndpointText = true;
  binary = false;
  textEvidence = false;
  toolId = '';
  sparse: SparseNetState | undefined = createSparseDiff();
  steps: RecordedFileChange['steps'] = [];
  processTruncated = false;
  constructor(initial?: ChangeEndpointPair['before']) {
    this.baseline = this.current = initial ? initial.exists ? initial.text : '' : undefined;
    this.existed = this.exists = initial?.exists;
  }
}

/**
 * Push confirmed native evidence exactly once in source-local chronological order.
 * Only baseline/current bytes, sparse original-line identities and bounded optional
 * process details survive a push. There is no cumulative history work/byte budget.
 * Hash recovery requires constructor endpoints; finish endpoints remain authoritative.
 */
export class ChangeNetAccumulator {
  private readonly groups = new Map<string, FileNetState>();
  private readonly initialEndpoints = new Map<string, ChangeEndpointPair>();
  private readonly recovery: EndpointTextRecovery;
  private readonly cwd: string;
  private readonly maxProcessSteps: number;
  private readonly maxProcessBytes: number;
  private processSteps = 0;
  private processBytes = 0;
  constructor(options: ChangeNetAccumulatorOptions = {}) {
    this.cwd = options.cwd ?? '';
    this.maxProcessSteps = options.maxProcessSteps ?? 256;
    this.maxProcessBytes = options.maxProcessBytes ?? 1024 * 1024;
    this.recovery = new EndpointTextRecovery(options.endpoints ?? [], options.hashText, this.cwd);
    for (const endpoint of options.endpoints ?? []) this.initialEndpoints.set(changePath(endpoint.path, this.cwd), endpoint);
  }
  push(operation: FileChangeEvidence): void {
    if (operation.applied !== 'confirmed') return;
    const path = changePath(operation.path, this.cwd); if (!path) return;
    this.recovery.push(operation);
    const sourcePath = operation.sourcePath ? changePath(operation.sourcePath, this.cwd) : undefined;
    if (operation.operation === 'move' && sourcePath && sourcePath !== path && !this.groups.has(path)) {
      const previous = this.groups.get(sourcePath);
      if (previous) { this.groups.set(path, previous); this.groups.delete(sourcePath); }
    }
    let state = this.groups.get(path);
    if (!state) { state = new FileNetState(this.initialEndpoints.get(path)?.before); this.groups.set(path, state); }
    if (operation.operation === 'read') {
      if (!state.started && operation.after !== undefined) { state.baseline ??= operation.after; state.current ??= operation.after; state.existed ??= true; state.exists ??= true; }
      return;
    }
    const source = JSON.stringify([operation.origin.sessionId, operation.origin.sourcePath]);
    if (state.source !== undefined && state.source !== source) state.multipleSources = true;
    state.source ??= source; state.sourcePath ??= sourcePath; state.toolId = operation.origin.toolId;
    state.binary ||= !!operation.binary;
    state.textEvidence ||= !!operation.patch || operation.before !== undefined || operation.after !== undefined;
    state.noEndpointText &&= operation.before === undefined && operation.after === undefined;
    state.allUpdates &&= operation.operation === 'update';
    if (!state.started) {
      state.baseline ??= operation.before; state.current ??= operation.before;
      if (operation.before !== undefined) state.existed ??= true;
      if (operation.operation === 'create') { state.baseline ??= ''; state.current ??= ''; state.existed ??= false; }
    }
    state.started = true;
    if (operation.before !== undefined && state.current !== undefined && operation.before !== state.current) state.conflict = true;
    const old = operation.before ?? state.current;
    const hunks = operation.patch && operation.patchComplete ? parsePatch(operation.patch) : undefined;
    const applied = old !== undefined && hunks ? applyPatch(old, hunks) : undefined;
    if (old !== undefined && hunks && applied === undefined) state.conflict = true;
    const next = operation.operation === 'delete' ? '' : operation.after ?? applied ?? (operation.operation === 'move' && !operation.patch ? state.current : undefined);
    if (operation.after !== undefined && applied !== undefined && operation.after !== applied) state.conflict = true;
    if (state.sparse && !state.sparse.push(operation)) state.sparse = undefined;
    if (next === undefined) state.missing = true;
    state.current = next; state.exists = operation.operation !== 'delete';
    if (this.processSteps < this.maxProcessSteps && this.processBytes < this.maxProcessBytes) {
      const diff = old !== undefined && next !== undefined ? contentDiff(old, next) : undefined;
      const step: RecordedFileChange['steps'][number] = { toolId: operation.origin.toolId, origin: operation.origin, operation: operation.operation, patch: diff?.patch ?? operation.patch ?? '', added: diff?.added ?? 0, removed: diff?.removed ?? 0, countsKnown: !!diff, unknownReason: diff ? undefined : operation.reason ?? 'missingBefore', binary: operation.binary, firstChangedLine: diff?.firstChangedLine };
      // UTF-16 storage accounting also bounds retained origin strings, not just patches.
      const bytes = JSON.stringify(step).length * 2;
      if (bytes <= this.maxProcessBytes - this.processBytes) { state.steps.push(step); this.processSteps++; this.processBytes += bytes; return; }
    }
    state.processTruncated = true;
  }
  finish(endpoints: readonly ChangeEndpointPair[] = this.recovery.endpoints, cwd = this.cwd): RecordedFileChange[] {
    const recovered = new Map(this.recovery.endpoints.map(pair => [changePath(pair.path, this.cwd), pair]));
    const endpointMap = new Map<string, ChangeEndpointPair>();
    for (const pair of endpoints) {
      const path = changePath(pair.path, cwd), matched = recovered.get(path);
      let endpoint = pair;
      for (const side of ['before', 'after'] as const) {
        const capture = pair[side], bytes = matched?.[side];
        if (capture?.exists && !capture.binary && capture.text === undefined && capture.hash !== undefined && capture.hash === bytes?.hash && bytes.text !== undefined) endpoint = { ...endpoint, [side]: { ...capture, text: bytes.text } };
      }
      endpointMap.set(path, endpoint);
    }
    const files: RecordedFileChange[] = [];
    const paths = new Set([...this.groups.keys(), ...endpointMap.keys()]);
    for (const path of paths) {
      const endpoint = endpointMap.get(path), initial = endpoint?.before, final = endpoint?.after;
      const state = this.groups.get(path) ?? new FileNetState(initial);
      const sameMode = initial?.mode === undefined || final?.mode === undefined || initial.mode === final.mode;
      if (initial && final && initial.exists === final.exists && (!initial.exists || sameMode && (initial.hash !== undefined && initial.hash === final.hash || initial.text !== undefined && initial.text === final.text))) continue;
      const changed = !!(initial && final && (initial.exists !== final.exists || initial.hash !== undefined && final.hash !== undefined && initial.hash !== final.hash || initial.text !== undefined && final.text !== undefined && initial.text !== final.text || !sameMode));
      if (!changed && !state.started) continue;
      const before = initial ? initial.exists ? initial.text : '' : state.baseline;
      const after = final ? final.exists ? final.text : '' : state.current;
      let conflict = state.conflict;
      let net = before !== undefined && after !== undefined && (!conflict || initial && final) ? contentDiff(before, after) : undefined;
      if (!net && !initial && !final && !conflict && !state.multipleSources && (!state.missing || state.noEndpointText)) net = state.sparse?.finish();
      if (state.multipleSources && !(initial && final && (!initial.exists || initial.text !== undefined) && (!final.exists || final.text !== undefined))) { net = undefined; conflict = true; }
      const beforeExists = initial?.exists ?? state.existed, afterExists = final?.exists ?? state.exists;
      const moved = !!state.sourcePath && state.sourcePath !== path;
      if (!changed && net && !net.patch && !moved && (beforeExists === afterExists || state.allUpdates)) continue;
      if (!changed && beforeExists === false && afterExists === false) continue;
      const binary = initial?.binary || final?.binary || state.binary;
      if (binary) net = undefined;
      const op: RecordedFileChange['op'] = beforeExists === false && afterExists === true ? 'create' : afterExists === false ? 'delete' : moved && !endpoint ? 'move' : 'update';
      files.push({ path: displayPath(path, cwd), sourcePath: moved ? displayPath(state.sourcePath!, cwd) : undefined, op, patch: net?.patch ?? '', added: net?.added ?? 0, removed: net?.removed ?? 0, countsKnown: !!net && !binary, content: binary ? 'binary' : net ? 'complete' : state.textEvidence ? 'partial' : 'unavailable', evidence: changed ? 'snapshot' : net ? 'reconstructed' : 'recorded', reason: net ? undefined : conflict ? 'conflictingEvidence' : binary ? 'binary' : changed ? 'contentUnavailable' : 'missingBefore', toolId: state.toolId, firstChangedLine: net?.firstChangedLine, steps: [...state.steps], ...(state.processTruncated ? { processTruncated: true } : {}) });
    }
    return files;
  }
}

/** Array callers retain duplicate suppression and source-local sorting before streaming. */
export function resolveFinalChanges(operations: readonly FileChangeEvidence[], endpoints: readonly ChangeEndpointPair[] = [], cwd = ''): RecordedFileChange[] {
  const groups = new Map<string, FileChangeEvidence[]>(), seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.id)) continue; seen.add(operation.id);
    const path = changePath(operation.path, cwd); if (!path) continue;
    const source = operation.sourcePath ? changePath(operation.sourcePath, cwd) : undefined;
    if (operation.operation === 'move' && source && source !== path && !groups.has(path)) { const previous = groups.get(source); if (previous) { groups.set(path, previous); groups.delete(source); } }
    const group = groups.get(path) ?? []; group.push(operation); groups.set(path, group);
  }
  const accumulator = new ChangeNetAccumulator({ endpoints, cwd });
  for (const group of groups.values()) {
    const sources = new Set(group.filter(item => item.operation !== 'read' && item.applied === 'confirmed').map(item => JSON.stringify([item.origin.sessionId, item.origin.sourcePath])));
    if (sources.size <= 1) group.sort((a, b) => a.sequence - b.sequence);
    for (const operation of group) accumulator.push(operation);
  }
  return accumulator.finish();
}

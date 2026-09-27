import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { HistoryTranscriptPage, NativeSubagent, SessionResourcePage } from '../../shared/contracts';
import type { NativeTaskDeliveryJob } from '../../shared/native-task-results';
import { record } from './io';
import { HistoryReader } from './journal';

const PAGE_BYTES = 64 * 1024;
const SCAN_BYTES = 8 * 1024 * 1024;
const MAX_CHILDREN = 10000;
const MAX_DIRECTORY_ENTRIES = 20000;
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const text = (value: unknown, limit = 4096): string | undefined => typeof value === 'string' ? value.slice(0, limit) : undefined;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string): Record<string, unknown> {
  if (value.length > 4096) throw new Error('Resource cursor is too large');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new Error('Invalid resource cursor'); }
  if (!record(parsed)) throw new Error('Invalid resource cursor');
  return parsed;
}
function diagnostic(items: string[], message: string): void { if (items.length < 100 && !items.includes(message)) items.push(message); }
interface Child { metadata: NativeSubagent; sourceName?: string; age: number }
interface Discovery { children: Child[]; parent: HistoryTranscriptPage; roots: string[]; blobs: string; diagnostics: string[] }
interface Selection { id: string; ranges: [number, number][]; region?: number; tailLines?: number }
function selection(reference: string): Selection {
  const match = /^artifact:\/\/(\d+)((?::[^\s()]+)*)(?:\s*\(region (\d+)\))?$/.exec(reference);
  if (!match) throw new Error('Expected a native artifact://numeric-id reference, optionally with line selectors or (region N)');
  const ranges: [number, number][] = [];
  let tailLines: number | undefined;
  for (const selector of match[2]!.split(':').filter(Boolean)) {
    if (selector === 'raw') continue;
    if (ranges.length || tailLines !== undefined) throw new Error('Only one line selector is supported per artifact reference');
    if (/^-\d+$/.test(selector)) {
      tailLines = Number(selector.slice(1));
      if (!Number.isSafeInteger(tailLines) || tailLines < 1) throw new Error('Invalid native tail line count');
      continue;
    }
    for (const part of selector.split(',')) {
      const range = /^(\d+)(?:(-)(\d*)|\+(\d+))?$/.exec(part);
      if (!range) throw new Error('Use positive native line selectors N, N-M, N-, or N+count');
      const start = Number(range[1]);
      const end = range[2] ? (range[3] ? Number(range[3]) : Number.MAX_SAFE_INTEGER) : range[4] ? start + Number(range[4]) - 1 : start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || ranges.length >= 64) throw new Error('Invalid or excessive artifact line range');
      ranges.push([start, end]);
    }
  }
  const region = match[3] === undefined ? undefined : Number(match[3]);
  if (region !== undefined && (!Number.isSafeInteger(region) || region < 1)) throw new Error('Invalid recovery region');
  if (tailLines !== undefined && region !== undefined) throw new Error('Read a recovery region or a tail selector separately');
  return { id: match[1]!, ranges, region, tailLines };
}

/** Read-only resources for authorized parents, including owned runtimes; persisted paths never grant filesystem authority. */
export class SessionResources {
  constructor(private readonly reader: HistoryReader, private readonly blobsRoot: (parentPath: string) => Promise<string>) {}

  async listHistorySubagents(options: { path: string; leafId?: string | null }): Promise<{ subagents: NativeSubagent[]; diagnostics: string[] }> {
    const found = await this.discover(options);
    return { subagents: found.children.map(child => child.metadata), diagnostics: found.diagnostics };
  }

  async readHistorySubagent(options: { parentPath: string; subagentId: string; leafId?: string | null; before?: string }): Promise<HistoryTranscriptPage> {
    const found = await this.discover({ path: options.parentPath, leafId: options.leafId });
    const child = found.children.find(item => item.metadata.id === options.subagentId);
    if (!child) throw new Error('Saved child does not belong to the selected parent task ancestry');
    const diagnostics = [...found.diagnostics];
    const missing = (reason: string): HistoryTranscriptPage => ({
      session: { ...found.parent.session, id: child.metadata.id, title: child.metadata.description || child.metadata.agent || 'Saved child', writable: false, canFork: false },
      revision: found.parent.revision, leafId: null, selectedLeafId: null, messages: [], hasMore: false, diagnostics: [...diagnostics, reason],
    });
    if (!child.sourceName) return missing('Saved task metadata is available, but no native child journal identity was persisted.');
    const paths = await this.findFiles(found.roots, name => name === `${child.sourceName}.jsonl` || name === `${child.sourceName}.jsonl.gz`, diagnostics);
    if (paths.length !== 1) return missing(paths.length ? 'Child journal is ambiguous across parent artifact roots; no source was selected.' : 'Child journal is unavailable; saved task metadata has been retained.');
    let before: string | undefined;
    let leafId: string | null | undefined;
    if (options.before) {
      const cursor = decode(options.before);
      if (cursor.child !== options.subagentId || cursor.parent !== found.parent.revision || cursor.parentLeaf !== found.parent.selectedLeafId || typeof cursor.before !== 'string' || !(cursor.leaf === null || typeof cursor.leaf === 'string')) throw new Error('Saved child cursor is stale or belongs to another parent task');
      before = cursor.before; leafId = cursor.leaf;
    }
    try {
      const page = await this.reader.read({ path: paths[0]!, leafId, before }, found.blobs);
      // Native forks copy journals verbatim, including older parentSession headers.
      // The selected task and confined copied root authorize this file, not ancestry.
      return { ...page, session: { ...page.session, writable: false, canFork: false }, diagnostics: [...diagnostics, ...page.diagnostics], ...(page.nextBefore ? { nextBefore: encode({ child: options.subagentId, parent: found.parent.revision, parentLeaf: found.parent.selectedLeafId, leaf: page.selectedLeafId, before: page.nextBefore }) } : {}) };
    } catch (error) {
      if (options.before) throw error;
      return missing(`Child journal could not be read: ${errorText(error)}. Saved task metadata has been retained.`);
    }
  }

  readSessionEntry(options: { parentPath: string; entryId: string; cursor?: string }): Promise<SessionResourcePage> {
    return this.reader.entryDetail({ path: options.parentPath, entryId: options.entryId, cursor: options.cursor });
  }

  async readSessionArtifact(options: { parentPath: string; reference: string; cursor?: string; subagentId?: string; leafId?: string | null }): Promise<SessionResourcePage> {
    if (options.reference.length > 4096) throw new Error('Resource reference is too large');
    let entryPath = options.parentPath;
    let childDiagnostics: string[] = [];
    if (options.subagentId !== undefined) {
      const found = await this.discover({ path: options.parentPath, leafId: options.leafId });
      const child = found.children.find(item => item.metadata.id === options.subagentId);
      if (!child) throw new Error('Saved child does not belong to the selected parent task ancestry');
      childDiagnostics = [...found.diagnostics];
      const paths = child.sourceName ? await this.findFiles(found.roots, name => name === `${child.sourceName}.jsonl` || name === `${child.sourceName}.jsonl.gz`, childDiagnostics) : [];
      if (paths.length !== 1) return { name: options.reference, kind: 'text', sourceLabel: 'Saved child resource', diagnostics: [...childDiagnostics, paths.length ? 'Child journal is ambiguous; no resource source was selected.' : 'Child journal is unavailable; saved task metadata has been retained.'] };
      entryPath = paths[0]!;
    }
    if (options.reference.startsWith('desktop-image:')) {
      if (options.cursor) throw new Error('Saved images do not have a text cursor');
      const page = await this.reader.imageDetail({ path: entryPath, reference: options.reference }, await this.blobsRoot(options.parentPath));
      return { ...page, diagnostics: [...childDiagnostics, ...page.diagnostics] };
    }
    if (options.reference.startsWith('desktop-entry:')) {
      const encoded = options.reference.slice('desktop-entry:'.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid saved entry reference');
      const page = await this.readSessionEntry({ parentPath: entryPath, entryId: Buffer.from(encoded, 'base64url').toString('utf8'), cursor: options.cursor });
      return { ...page, diagnostics: [...childDiagnostics, ...page.diagnostics] };
    }
    const selected = selection(options.reference);
    const context = await this.reader.resourceContext(options.parentPath);
    // Native children adopt the parent's ArtifactManager; numeric IDs share the parent's store.
    const diagnostics = [...childDiagnostics, ...context.diagnostics];
    const roots = await this.safeRoots(context.artifactRoots, diagnostics);
    const paths = await this.findFiles(roots, name => name.startsWith(`${selected.id}.`) && /^\d+\.[A-Za-z0-9_-]+\.log$/.test(name), diagnostics);
    const base: SessionResourcePage = { name: options.reference, kind: 'text', sourceLabel: 'Saved native artifact', diagnostics };
    if (paths.length !== 1) {
      diagnostic(diagnostics, paths.length ? 'Artifact ID is ambiguous across persisted parent roots; no source was selected.' : 'Artifact is missing from the authorized parent artifact roots.');
      return base;
    }
    return this.readArtifact(paths[0]!, options, selected, base);
  }

  private async discover(options: { path: string; leafId?: string | null }): Promise<Discovery> {
    const context = await this.reader.resourceContext(options.path);
    const diagnostics = [...context.diagnostics];
    const roots = await this.safeRoots(context.artifactRoots, diagnostics);
    const blobs = await this.blobsRoot(options.path);
    const parent = await this.reader.read(options, blobs);
    let page = parent;
    const children = new Map<string, Child>();
    const deliveries = new Map<string, { job: NativeTaskDeliveryJob; age: number }>();
    let age = 0;
    let scanned = 0;
    let pages = 0;
    do {
      const metadata = await this.reader.taskMetadata({ path: options.path, revision: page.revision, entryIds: page.messages.map(message => message.entryId ?? Buffer.from(message.resourceReference!.slice('desktop-entry:'.length), 'base64url').toString('utf8')) });
      for (const item of metadata.diagnostics) diagnostic(diagnostics, item);
      for (let position = metadata.records.length - 1; position >= 0; position--) {
        const item = metadata.records[position]!;
        const currentAge = age++;
        if (item.delivery) {
          for (const reason of item.delivery.diagnostics) diagnostic(diagnostics, reason);
          for (const job of item.delivery.jobs) {
            if (deliveries.has(job.id)) continue;
            if (deliveries.size >= MAX_CHILDREN) { diagnostic(diagnostics, 'Saved task deliveries reached the 10,000-job bound.'); break; }
            deliveries.set(job.id, { job, age: currentAge });
          }
          continue;
        }
        const message = item.message;
        if (!message || message.role !== 'toolResult' || message.toolName !== 'task' || typeof message.toolCallId !== 'string' || !record(message.details)) continue;
        const details = message.details;
        const results = Array.isArray(details.results) ? details.results : [];
        const progress = Array.isArray(details.progress) ? details.progress : [];
        for (const row of [...results, ...progress]) {
          if (!record(row)) continue;
          const nativeId = typeof row.id === 'string' && row.id.length <= 200 ? row.id : undefined;
          const index = typeof row.index === 'number' && Number.isSafeInteger(row.index) && row.index >= 0 ? row.index : undefined;
          if (!nativeId && index === undefined) { diagnostic(diagnostics, 'A saved task row has neither a native ID nor a task index and cannot be identified safely.'); continue; }
          const identity = `${message.toolCallId}:${index === undefined ? `id:${nativeId}` : `index:${index}`}`;
          const existing = children.get(identity);
          if (existing) {
            if (!existing.metadata.assignment && typeof row.assignment === 'string') {
              existing.metadata.assignment = text(row.assignment);
              existing.metadata.task = text(row.assignment) || existing.metadata.task;
            }
            continue;
          }
          if (children.size >= MAX_CHILDREN) { diagnostic(diagnostics, 'Saved child discovery reached the 10,000-child bound; narrow the selected history branch.'); break; }
          const outputPath = text(row.outputPath, 4096);
          let sourceName = nativeId && SAFE_NAME.test(nativeId) ? nativeId : undefined;
          if (!sourceName && outputPath) {
            const candidate = basename(outputPath, '.md');
            if (outputPath.endsWith('.md') && SAFE_NAME.test(candidate) && context.artifactRoots.some(root => resolve(dirname(outputPath)) === resolve(root))) sourceName = candidate;
          }
          const status = row.aborted === true ? 'aborted' : typeof row.exitCode === 'number' ? (row.exitCode === 0 ? 'completed' : 'failed') : text(row.status, 40) || 'unknown';
          const metadata: NativeSubagent = {
            id: `saved-${digest(JSON.stringify([context.session.path, message.toolCallId, index ?? nativeId]))}`,
            ...(nativeId ? { nativeId } : {}), parentToolCallId: message.toolCallId, status,
            agent: text(row.agent, 256), description: text(row.description), task: text(row.assignment) || text(row.task), assignment: text(row.assignment), historical: true, readonly: true,
          };
          const metrics: Record<string, unknown> = {};
          for (const key of ['index', 'durationMs', 'tokens', 'requests', 'contextTokens', 'contextWindow', 'cost', 'toolCount']) if (typeof row[key] === 'number' && Number.isFinite(row[key])) metrics[key] = row[key];
          for (const key of ['lastIntent', 'currentTool', 'resolvedModel', 'modelRole', 'error', 'abortReason']) if (typeof row[key] === 'string') metrics[key] = text(row[key]);
          metadata.progress = metrics;
          children.set(identity, { metadata, sourceName, age: currentAge });
        }
      }
      for (const message of page.diagnostics) diagnostic(diagnostics, message);
      scanned += page.messages.length; pages++;
      if (!page.nextBefore) break;
      if (scanned >= 100000 || pages >= 512 || children.size >= MAX_CHILDREN) { diagnostic(diagnostics, 'Saved child discovery reached its bounded history scan; older tasks may not be listed.'); break; }
      page = await this.reader.read({ ...options, leafId: parent.selectedLeafId, before: page.nextBefore }, blobs);
    } while (true);
    const byNativeId = new Map<string, Child[]>();
    for (const child of children.values()) {
      const id = child.metadata.nativeId;
      if (id) {
        const matches = byNativeId.get(id);
        if (matches) matches.push(child);
        else byNativeId.set(id, [child]);
      }
    }
    for (const [id, delivery] of deliveries) {
      const matches = byNativeId.get(id);
      if (!matches) continue; // Notification identities never establish children or paths.
      if (matches.length !== 1) {
        diagnostic(diagnostics, `Native task delivery identity ${id} matches multiple saved children; settlement is unknown.`);
        for (const child of matches) if (delivery.age < child.age) child.metadata.status = 'unknown';
        continue;
      }
      const child = matches[0]!;
      if (delivery.age >= child.age) continue; // A delivery cannot settle a later task record.
      const job = delivery.job;
      child.metadata.status = job.status;
      if (!child.metadata.agent && job.agent) child.metadata.agent = job.agent;
      const progress = child.metadata.progress!;
      for (const key of ['error', 'abortReason', 'result', 'duration']) delete progress[key];
      for (const key of ['durationMs', 'duration', 'result', 'error', 'abortReason'] as const) if (job[key] !== undefined) progress[key] = job[key];
    }
    return { children: [...children.values()], parent, roots, blobs, diagnostics };
  }

  private async safeRoots(candidates: string[], diagnostics: string[]): Promise<string[]> {
    const roots = new Set<string>();
    for (const candidate of candidates.slice(0, 128)) {
      try {
        const parent = await realpath(dirname(candidate));
        const expected = join(parent, basename(candidate));
        const actual = await realpath(candidate);
        if (actual !== expected || !(await stat(actual)).isDirectory()) { diagnostic(diagnostics, 'A parent artifact root is not a direct, nonsymlink directory and was excluded.'); continue; }
        roots.add(actual);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostic(diagnostics, `Artifact root unavailable: ${errorText(error)}`); }
    }
    if (candidates.length > 128) diagnostic(diagnostics, 'Artifact root provenance exceeded the 128-root bound.');
    return [...roots];
  }

  private async findFiles(roots: string[], matches: (name: string) => boolean, diagnostics: string[]): Promise<string[]> {
    const found = new Set<string>();
    let entries = 0;
    for (const root of roots) {
      try {
        const directory = await opendir(root);
        for await (const entry of directory) {
          if (++entries > MAX_DIRECTORY_ENTRIES) { diagnostic(diagnostics, 'Artifact directory scan reached the 20,000-entry bound; uniqueness cannot be established.'); return []; }
          if (!matches(entry.name)) continue;
          const path = join(root, entry.name);
          if (!entry.isFile() || await realpath(path) !== path) { diagnostic(diagnostics, `Unsafe or nonregular resource ${entry.name} was excluded.`); continue; }
          found.add(path);
        }
      } catch (error) { diagnostic(diagnostics, `Artifact directory could not be read; uniqueness cannot be established: ${errorText(error)}`); return []; }
    }
    return [...found];
  }

  private async readArtifact(path: string, options: { parentPath: string; reference: string; cursor?: string }, selected: Selection, base: SessionResourcePage): Promise<SessionResourcePage> {
    const file = await open(path, FLAGS);
    try {
      const info = await file.stat({ bigint: true });
      if (await realpath(path) !== path) throw new Error('Artifact containment changed while opening the resource');
      if (!info.isFile()) throw new Error('Artifact is not a regular file');
      const revision = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      const binding = digest(JSON.stringify([resolve(options.parentPath), options.reference, path, revision]));
      const size = Number(info.size);
      let offset = 0, line = 1, region = 0;
      let lineStart = true;
      let tailRemaining = selected.tailLines;
      if (tailRemaining !== undefined) offset = size;
      if (options.cursor) {
        const cursor = decode(options.cursor);
        if (cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > size || !Number.isSafeInteger(cursor.line) || Number(cursor.line) < 1 || !Number.isSafeInteger(cursor.region) || Number(cursor.region) < 0 || typeof cursor.lineStart !== 'boolean') throw new Error('Artifact cursor is stale or invalid');
        offset = Number(cursor.offset); line = Number(cursor.line); region = Number(cursor.region); lineStart = cursor.lineStart;
        tailRemaining = typeof cursor.tailRemaining === 'number' ? cursor.tailRemaining : undefined;
        if (tailRemaining !== undefined && (!Number.isSafeInteger(tailRemaining) || tailRemaining < 1 || selected.tailLines === undefined || tailRemaining > selected.tailLines)) throw new Error('Invalid tail scan cursor');
      }
      if (tailRemaining !== undefined) {
        const backwards = Buffer.alloc(PAGE_BYTES);
        let scannedTail = 0;
        while (offset > 0 && tailRemaining > 0 && scannedTail < SCAN_BYTES) {
          const start = Math.max(0, offset - Math.min(PAGE_BYTES, SCAN_BYTES - scannedTail));
          const { bytesRead } = await file.read(backwards, 0, offset - start, start);
          if (bytesRead !== offset - start) throw new Error('Artifact changed during tail scan');
          let boundary = -1;
          for (let position = bytesRead - 1; position >= 0; position--) {
            if (backwards[position] !== 10 || start + position === size - 1) continue;
            if (--tailRemaining === 0) { boundary = start + position + 1; break; }
          }
          scannedTail += bytesRead;
          offset = boundary >= 0 ? boundary : start;
        }
        if (offset > 0 && tailRemaining > 0) {
          const after = await file.stat({ bigint: true });
          if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== revision) throw new Error('Artifact changed during tail scan');
          return { ...base, content: '', diagnostics: [...base.diagnostics, 'Tail scan reached the 8 MiB work bound; continue to locate the requested lines.'], nextCursor: encode({ binding, offset, line, region, lineStart, tailRemaining }) };
        }
      }
      const output: Buffer[] = [];
      let outputBytes = 0, scanned = 0;
      let done = false, pageFull = false;
      const buffer = Buffer.alloc(PAGE_BYTES + 4);
      const lastLine = selected.ranges.length ? Math.max(...selected.ranges.map(range => range[1])) : Number.MAX_SAFE_INTEGER;
      while (offset < size && outputBytes < PAGE_BYTES && scanned < SCAN_BYTES && !done && !pageFull) {
        const startOffset = offset;
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) break;
        const usable = Math.min(bytesRead, PAGE_BYTES, SCAN_BYTES - scanned);
        let position = 0;
        while (position < usable && outputBytes < PAGE_BYTES) {
          if (lineStart && selected.region !== undefined && bytesRead - position < 256 && startOffset + bytesRead < size) break;
          const newline = buffer.indexOf(10, position);
          let end = newline >= 0 && newline < usable ? newline + 1 : usable;
          if (lineStart && selected.region !== undefined) {
            const header = /^### region (\d+) \(/.exec(buffer.toString('utf8', position, Math.min(bytesRead, position + 256)));
            if (header) region = Number(header[1]);
            if (region > selected.region) { done = true; break; }
          }
          const include = (selected.region === undefined || region === selected.region) && (!selected.ranges.length || selected.ranges.some(([first, last]) => line >= first && line <= last));
          if (line > lastLine) { done = true; break; }
          if (include) end = Math.min(end, position + PAGE_BYTES - outputBytes);
          // Read-ahead makes the first byte of the next code point visible.
          if (end < bytesRead) while (end > position && (buffer[end]! & 0xc0) === 0x80) end--;
          if (end === position) { pageFull = true; break; }
          if (include) { const part = Buffer.from(buffer.subarray(position, end)); output.push(part); outputBytes += part.length; }
          lineStart = buffer[end - 1] === 10;
          if (lineStart) line++;
          const count = end - position; offset += count; scanned += count; position = end;
        }
        if (offset === startOffset && !done) break;
      }
      const after = await file.stat({ bigint: true });
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== revision) throw new Error('Artifact changed while reading; reload the resource');
      const content = Buffer.concat(output, outputBytes).toString('utf8');
      if (content.includes('\0')) return { ...base, kind: 'binary', diagnostics: [...base.diagnostics, 'Artifact contains binary bytes; inline text display was withheld.'] };
      const hasMore = !done && offset < size;
      if (hasMore && scanned >= SCAN_BYTES) diagnostic(base.diagnostics, 'Recovery scan reached the 8 MiB work bound; continue to scan the next bounded segment.');
      if (!hasMore && selected.region !== undefined && region < selected.region) diagnostic(base.diagnostics, `Recovery region ${selected.region} was not found in this artifact.`);
      return { ...base, content, ...(hasMore ? { nextCursor: encode({ binding, offset, line, region, lineStart }) } : {}) };
    } finally { await file.close(); }
  }
}

import { constants, type ReadStream, type BigIntStats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { createGunzip, type Gunzip } from 'node:zlib';

export const SOURCE_CHUNK = 64 * 1024;
export function sourceKind(path: string): 'archive' | 'journal' {
  return path.endsWith('.jsonl.gz') || path.split(sep).some((part, index, parts) => part === 'archive' && parts[index + 1] === 'sessions') ? 'archive' : 'journal';
}
export function sourceRevision(info: BigIntStats): string {
  if (!info.isFile()) throw new Error('History requires a regular journal file');
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** No decompressed files or persistent indexes: one range (8–16 MiB) per active reader, released on close/eviction. */
export class HistorySource {
  private cache?: { offset: number; bytes: Buffer };
  constructor(readonly path: string, readonly revision: string) {}
  private matches(info: BigIntStats): boolean {
    const revision = sourceRevision(info);
    if (revision === this.revision) return true;
    const expected = this.revision.split(':');
    return !this.path.endsWith('.gz') && String(info.dev) === expected[0] && String(info.ino) === expected[1] && info.size > BigInt(expected[2]!);
  }
  async assert(): Promise<void> {
    if (!this.matches(await stat(this.path, { bigint: true }))) throw new Error('Journal changed while being read; refresh history');
  }
  async *chunks(start = 0): AsyncGenerator<Buffer> {
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let input: ReadStream | undefined;
    let unzip: Gunzip | undefined;
    try {
      if (!this.matches(await file.stat({ bigint: true }))) throw new Error('Journal changed before reading');
      const size = Number(this.revision.split(':')[2]);
      if (start >= size) return;
      input = file.createReadStream({ autoClose: false, highWaterMark: SOURCE_CHUNK, start, end: size - 1 });
      const stream = this.path.endsWith('.gz') ? input.pipe(unzip = createGunzip({ chunkSize: SOURCE_CHUNK })) : input;
      if (unzip) input.on('error', error => unzip?.destroy(error));
      for await (const chunk of stream) yield chunk as Buffer;
      await this.assert();
    } finally {
      unzip?.destroy();
      input?.destroy();
      await file.close();
    }
  }
  async range(offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024) throw new Error('History source range must be a nonnegative offset and at most 16 MiB');
    await this.assert();
    if (this.cache && offset >= this.cache.offset && offset + length <= this.cache.offset + this.cache.bytes.length) return this.cache.bytes.subarray(offset - this.cache.offset, offset - this.cache.offset + length);
    if (!this.path.endsWith('.gz')) {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!this.matches(await file.stat({ bigint: true }))) throw new Error('Journal changed before reading');
        const bytes = Buffer.allocUnsafe(length);
        let count = 0;
        while (count < length) { const result = await file.read(bytes, count, length - count, offset + count); if (!result.bytesRead) break; count += result.bytesRead; }
        await this.assert();
        return bytes.subarray(0, count);
      } finally { await file.close(); }
    }
    const capacity = Math.max(length, 8 * 1024 * 1024);
    const bytes = Buffer.allocUnsafe(capacity);
    let position = 0; let count = 0;
    for await (const chunk of this.chunks()) {
      const start = Math.max(0, offset - position);
      if (start < chunk.length) { const take = Math.min(chunk.length - start, capacity - count); chunk.copy(bytes, count, start, start + take); count += take; }
      position += chunk.length;
      if (count === capacity) break;
    }
    await this.assert();
    this.cache = { offset, bytes: bytes.subarray(0, count) };
    return this.cache.bytes.subarray(0, Math.min(length, count));
  }
  /** Scan original bytes once; only mutation carriers survive in memory. Archives are never staged. */
  async projectEvidence(offset: number, length: number, metadata?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = typeof metadata?.toolName === 'string' ? metadata.toolName.split(/[/.]/).at(-1) : '';
    const editText = metadata?.role === 'toolResult' && metadata.isError !== true && ['edit', 'hashline', 'hashline_edit', 'apply_patch', 'apply-patch', 'ast_edit', 'delete', 'move'].includes(name ?? '');
    const projection = new RecordMetadata(true, editText);
    let remaining = length, position = this.path.endsWith('.gz') ? 0 : offset;
    await this.assert();
    for await (const chunk of this.chunks(position)) {
      const start = Math.max(0, offset - position), take = Math.min(remaining, Math.max(0, chunk.length - start));
      if (take) { projection.feed(chunk.subarray(start, start + take)); remaining -= take; }
      position += chunk.length;
      if (!remaining) break;
    }
    await this.assert();
    if (remaining || !projection.complete) throw new Error('Selected evidence entry is incomplete or invalid JSON');
    return projection.values;
  }
  close(): void { this.cache = undefined; }
  /** Native rewrites replace the inode or alter the title/head or committed tail. */
  async appendGuard(size: number): Promise<string> {
    if (this.path.endsWith('.gz')) return '';
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const first = Buffer.alloc(Math.min(size, 4096));
      const last = Buffer.alloc(Math.min(size, 4096));
      await file.read(first, 0, first.length, 0);
      await file.read(last, 0, last.length, Math.max(0, size - last.length));
      return first.toString('base64') + ':' + last.toString('base64');
    } finally { await file.close(); }
  }
}

/** Move aliases are provenance, never transcript segments or arbitrary artifact authority. */
export function lineage(header: Record<string, unknown>, path: string) {
  const previousSessionFiles = Array.isArray(header.previousSessionFiles) ? header.previousSessionFiles.filter((value): value is string => typeof value === 'string' && isAbsolute(value) && !value.includes('\0')).slice(0, 1000) : [];
  const current = path.replace(/\.jsonl(?:\.gz)?$/, '');
  const artifactRoots = [current];
  return { recordedCwd: String(header.cwd), ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}), previousSessionFiles, artifactRoots: [...new Set(artifactRoots)] };
}

type JsonPath = readonly (string | number)[];
type JsonFrame = { path: JsonPath; value?: Record<string, unknown> | unknown[]; kind: 'object' | 'array'; state: 'key' | 'keyOrEnd' | 'colon' | 'value' | 'valueOrEnd' | 'comma'; key?: string; index: number };
const rootFields = ['type', 'id', 'parentId', 'timestamp', 'cwd', 'version', 'v', 'title', 'method', 'display', 'customType', 'attribution', 'firstKeptEntryId', 'firstKeptEntryIndex', 'tokensBefore', 'targetId', 'label', 'parentSession', 'previousSessionFiles', 'summary'];
const messageFields = ['role', 'id', 'messageId', 'toolName', 'toolCallId', 'customType', 'display', 'attribution', 'steering', 'synthetic', 'userInitiated', 'timestamp', 'isError'];
const identityFields = ['path', 'resolvedPath', 'cwd', 'destination'];
const mutationFields = ['path', 'resolvedPath', 'sourcePath', 'move', 'diff', 'patch', 'oldText', 'newText', 'beforeText', 'afterText', 'op', 'operation', 'isError', 'errorText', 'error', 'success', 'applied', 'created', 'truncated', 'binary', 'isDirectory', 'status', 'complete', 'truncation'];
const taskFields = ['id', 'index', 'exitCode', 'aborted', 'status', 'outputPath', 'agent', 'description', 'task', 'assignment', 'durationMs', 'tokens', 'requests', 'contextTokens', 'contextWindow', 'cost', 'toolCount', 'issueCount', 'lastIntent', 'currentTool', 'resolvedModel', 'modelRole', 'error', 'abortReason', 'name', 'jobId', 'type', 'agentUrlId', 'queued', 'label', 'agentId', 'sessionFile', 'parentToolCallId'];

/** Strict JSON grammar with selective materialization. Skipped scalars are validated, not accumulated. */
export class RecordMetadata {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly stack: JsonFrame[] = [];
  private root: unknown;
  private done = false;
  private invalid = false;
  private ended = false;
  private mode: 'string' | 'literal' | undefined;
  private keyToken = false;
  private keep = false;
  private token: string[] = [];
  private tokenLength = 0;
  private escape = false;
  private unicode = 0;
  private literal = '';
  private placeholder = false;
  private prefixOnly = false;
  private prefixEnded = false;
  private unicodeDigits = '';
  private stringNonempty = false;
  constructor(private readonly evidence = false, private readonly editText = false) {}
  get values(): Record<string, unknown> { return this.root as Record<string, unknown>; }
  get complete(): boolean {
    if (!this.ended) {
      this.ended = true;
      try { this.scan(this.decoder.decode()); if (this.mode === 'literal') this.finishLiteral(); } catch { this.invalid = true; }
    }
    return !this.invalid && this.done && this.stack.length === 0 && this.mode === undefined && !!this.root && typeof this.root === 'object' && !Array.isArray(this.root);
  }
  feed(bytes: Buffer): void {
    if (this.invalid || !bytes.length) return;
    this.ended = false;
    try { this.scan(this.decoder.decode(bytes, { stream: true })); } catch { this.invalid = true; }
  }
  private selected(path: JsonPath): boolean {
    if (!path.length) return true;
    const key = path.at(-1);
    if (path.length === 1 && rootFields.includes(String(key))) return true;
    if (path[0] === 'previousSessionFiles') return true;
    const p = path[0] === 'message' ? path.slice(1) : path;
    if (!p.length) return true;
    if (p.length === 1 && messageFields.includes(String(key))) return true;
    if (p[0] === 'content') {
      if (p.length <= 2) return true;
      if (p.length === 3) return ['type', 'id', 'name', 'arguments'].includes(String(key)) || this.editText && key === 'text';
      if (p[2] === 'arguments') {
        if (p.length === 4) return identityFields.includes(String(key)) || this.evidence && ['input', 'type', 'complete', 'tasks'].includes(String(key));
        return this.evidence && (p[3] === 'type' || p[3] === 'tasks' && (typeof key === 'number' || ['id', 'name', 'agent', 'task'].includes(String(key))));
      }
      return false;
    }
    if (p[0] === 'text') return this.editText;
    if (p[0] === 'details') {
      if (p.length === 1) return true;
      if (p[1] === 'message') {
        if (!this.evidence) return false;
        return p.length === 2 || p.length === 3 && ['op', 'from', 'to', 'receipts'].includes(String(key)) || p[2] === 'receipts' && (p.length === 4 && typeof key === 'number' || p.length === 5 && ['to', 'outcome'].includes(String(key)));
      }
      if (p.length === 2 && key === 'from') return this.evidence;
      if (!this.evidence) return p.length === 2 && identityFields.includes(String(key));
      return typeof key === 'number' || mutationFields.includes(String(key)) || taskFields.includes(String(key)) || ['details', 'perFileResults', 'files', 'meta', 'results', 'progress', 'jobs', 'agents', 'projectAgent'].includes(String(key));
    }
    return false;
  }
  private path(): JsonPath {
    const parent = this.stack.at(-1);
    return parent ? [...parent.path, parent.kind === 'array' ? parent.index : parent.key!] : [];
  }
  private accept(value: unknown): void {
    const frame = this.stack.at(-1);
    if (!frame) { this.root = value; this.done = true; return; }
    if (frame.value !== undefined && value !== undefined) {
      if (Array.isArray(frame.value)) frame.value.push(value);
      else Object.defineProperty(frame.value, frame.key!, { value, enumerable: true, configurable: true, writable: true });
    }
    frame.index++; frame.state = 'comma';
  }
  private capture(text: string): void {
    if (!this.keep || this.prefixEnded) return;
    // Unknown keys cannot select evidence. Never retain an arbitrarily long property name.
    if (this.keyToken && this.tokenLength + text.length > 256) { this.keep = false; this.token = []; return; }
    this.token.push(text); this.tokenLength += text.length;
  }
  private scan(text: string): void {
    let i = 0;
    while (i < text.length) {
      const char = text[i]!;
      if (this.mode === 'string') {
        if (this.unicode) {
          if (!/[0-9a-f]/i.test(char)) throw new Error('Invalid JSON escape');
          this.capture(char); this.unicodeDigits += char; this.unicode--;
          if (!this.unicode && this.prefixOnly && /^(?:000a|000d)$/i.test(this.unicodeDigits)) this.prefixEnded = true;
          i++; continue;
        }
        if (this.escape) {
          if (!/["\\/bfnrtu]/.test(char)) throw new Error('Invalid JSON escape');
          this.capture(char); this.escape = false;
          if (char === 'u') { this.unicode = 4; this.unicodeDigits = ''; }
          if (this.prefixOnly && (char === 'n' || char === 'r')) this.prefixEnded = true;
          i++; continue;
        }
        const special = /["\\\x00-\x1f]/g; special.lastIndex = i;
        const match = special.exec(text), end = match?.index ?? text.length;
        if (end > i) this.stringNonempty = true;
        this.capture(text.slice(i, end)); i = end;
        if (!match) continue;
        const marker = text[i++]!;
        if (marker === '\\') { this.stringNonempty = true; this.capture(marker); this.escape = true; continue; }
        if (marker !== '"') throw new Error('Invalid JSON string');
        if (this.keep) this.token.push('"');
        const decoded: unknown = this.keep ? JSON.parse(this.token.join('')) : this.placeholder ? this.stringNonempty ? ' ' : '' : undefined;
        const value = this.prefixOnly && typeof decoded === 'string' ? decoded.split(/[\r\n]/, 1)[0] : decoded;
        this.token = []; this.mode = undefined;
        if (this.keyToken) { const frame = this.stack.at(-1)!; frame.key = typeof value === 'string' ? value : ''; frame.state = 'colon'; }
        else this.accept(value);
        continue;
      }
      if (this.mode === 'literal') {
        if (!/[\s,}\]]/.test(char)) { this.literal += char; i++; continue; }
        this.finishLiteral(); continue;
      }
      if (/[ \t\r\n]/.test(char)) { i++; continue; }
      const frame = this.stack.at(-1);
      if (frame?.state === 'colon') { if (char !== ':') throw new Error('Missing JSON colon'); frame.state = 'value'; i++; continue; }
      if (frame?.state === 'comma') {
        if (char === ',') { frame.state = frame.kind === 'array' ? 'value' : 'key'; i++; continue; }
        if (char !== (frame.kind === 'array' ? ']' : '}')) throw new Error('Missing JSON comma');
        this.stack.pop(); this.accept(frame.value); i++; continue;
      }
      if (frame && (frame.state === 'keyOrEnd' && char === '}' || frame.state === 'valueOrEnd' && char === ']')) { this.stack.pop(); this.accept(frame.value); i++; continue; }
      const key = frame?.state === 'key' || frame?.state === 'keyOrEnd';
      if (key && char !== '"' || !frame && this.done) throw new Error('Invalid JSON value');
      const path = this.path(), selected = !key && this.selected(path) && (!frame || frame.value !== undefined);
      if (char === '"') {
        this.mode = 'string'; this.keyToken = !!key; this.keep = !!key || selected;
        // Preserve the existence of prose carriers without retaining their bytes.
        this.placeholder = !key && selected && (path.at(-1) === 'content' || path.at(-1) === 'summary' || typeof path.at(-1) === 'number' && path.at(-2) === 'content') && !this.editText;
        if (this.placeholder) this.keep = false;
        this.prefixOnly = !key && path.at(-1) === 'input' && path.at(-2) === 'arguments'; this.prefixEnded = false;
        this.stringNonempty = false;
        this.token = []; this.tokenLength = 0; this.capture('"'); i++; continue;
      }
      if (char === '{' || char === '[') {
        const array = char === '[';
        this.stack.push({ path, value: selected ? array ? [] : {} : undefined, kind: array ? 'array' : 'object', state: array ? 'valueOrEnd' : 'keyOrEnd', index: 0 }); i++; continue;
      }
      if (!/[-0-9tfn]/.test(char)) throw new Error('Invalid JSON token');
      this.mode = 'literal'; this.keep = selected; this.literal = char; i++;
    }
  }
  private finishLiteral(): void {
    if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(this.literal)) throw new Error('Invalid JSON literal');
    this.accept(this.keep ? JSON.parse(this.literal) : undefined); this.literal = ''; this.mode = undefined;
  }
}

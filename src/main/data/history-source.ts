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
  async assert(): Promise<void> {
    if (sourceRevision(await stat(this.path, { bigint: true })) !== this.revision) throw new Error('Journal changed while being read; refresh history');
  }
  async *chunks(): AsyncGenerator<Buffer> {
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let input: ReadStream | undefined;
    let unzip: Gunzip | undefined;
    try {
      if (sourceRevision(await file.stat({ bigint: true })) !== this.revision) throw new Error('Journal changed before reading');
      input = file.createReadStream({ autoClose: false, highWaterMark: SOURCE_CHUNK });
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
        if (sourceRevision(await file.stat({ bigint: true })) !== this.revision) throw new Error('Journal changed before reading');
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
  close(): void { this.cache = undefined; }
}

/** Move aliases are provenance, never transcript segments or arbitrary artifact authority. */
export function lineage(header: Record<string, unknown>, path: string) {
  const previousSessionFiles = Array.isArray(header.previousSessionFiles) ? header.previousSessionFiles.filter((value): value is string => typeof value === 'string' && isAbsolute(value) && !value.includes('\0')).slice(0, 1000) : [];
  const current = path.replace(/\.jsonl(?:\.gz)?$/, '');
  const artifactRoots = [current];
  return { recordedCwd: String(header.cwd), ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}), previousSessionFiles, artifactRoots: [...new Set(artifactRoots)] };
}

/** Retains bounded top-level scalar metadata even when a nested message exceeds the record limit. */
export class RecordMetadata {
  private depth = 0; private quoted = false; private escaped = false; private token = '';
  private key?: string; private expectingKey = true; private capturing = false; private literal = '';
  readonly values: Record<string, unknown> = {};
  get complete(): boolean { return this.depth === 0 && !this.quoted; }
  feed(bytes: Buffer): void {
    for (const byte of bytes) {
      const char = String.fromCharCode(byte);
      if (this.quoted) {
        if (this.capturing && this.token.length < 4096) this.token += char;
        if (this.escaped) { this.escaped = false; continue; }
        if (char === '\\') { this.escaped = true; continue; }
        if (char !== '"') continue;
        this.quoted = false;
        if (this.capturing) {
          try {
            const value: unknown = JSON.parse(Buffer.from(this.token, 'latin1').toString('utf8'));
            if (this.expectingKey) { this.key = typeof value === 'string' ? value : undefined; this.expectingKey = false; }
            else if (this.key && ['type', 'id', 'parentId', 'timestamp', 'cwd', 'method'].includes(this.key)) this.values[this.key] = value;
          } catch { /* Overlong metadata is unavailable. */ }
        }
        this.token = ''; continue;
      }
      if (char === '"') { this.quoted = true; this.capturing = this.depth === 1; this.token = this.capturing ? '"' : ''; continue; }
      if (char === '{' || char === '[') { this.depth++; continue; }
      if (char === '}' || char === ']') { if (this.depth === 1) this.finishLiteral(); this.depth--; continue; }
      if (this.depth !== 1) continue;
      if (char === ',') { this.finishLiteral(); this.expectingKey = true; this.key = undefined; }
      else if (char !== ':' && !/\s/.test(char) && !this.expectingKey && this.literal.length < 128) this.literal += char;
    }
  }
  private finishLiteral(): void {
    if (this.key && ['version', 'parentId', 'display', 'tokensBefore'].includes(this.key) && this.literal) { try { this.values[this.key] = JSON.parse(this.literal); } catch { /* Not scalar metadata. */ } }
    this.literal = '';
  }
}

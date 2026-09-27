import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { HistoryMessage, HistoryRead, HistorySnapshot, HistoryTreeNode, HistoryTreeSnapshot, NativeMessage, SessionResourcePage, SessionSummary } from '../../shared/contracts';
import { parseNativeTaskDelivery, type NativeTaskDelivery } from '../../shared/native-task-results';
import { record } from './io';
import { HistorySource, lineage, RecordMetadata, sourceKind } from './history-source';
import { parseSessionPrefix } from './history';
import { HistoryEntryIndex, type IndexedHistoryEntry as Entry } from './history-entry-index';
import { stageArchiveFork, type ForkSource } from './history-fork';

const RECORD_BYTES = 16 * 1024 * 1024;
const PAGE_BYTES = 8 * 1024 * 1024;
const PAGE_MESSAGES = 200;
const IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TOTAL = 16 * 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const BLOB = /^blob:sha256:([a-f0-9]{64})$/;
type Row = Record<string, unknown>;
type Snapshot = Omit<HistorySnapshot, 'access'>;
interface Index {
  path: string; revision: string; session: SessionSummary; version: number; entries: HistoryEntryIndex; leafId: string | null; diagnostics: string[]; source: HistorySource; size: number; sourceMode: boolean; artifactRoots: string[];
}

function revisionOf(info: BigIntStats): string {
  if (!info.isFile()) throw new Error('History requires a regular journal file');
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}
function diagnostic(items: string[], message: string): void {
  if (items.length < 100 && !items.includes(message)) items.push(message);
  else if (items.length === 100) items.push('Further journal diagnostics omitted (100 diagnostic limit)');
}
function short(value: unknown, limit = 256): string { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function preview(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 256).replace(/\s+/g, ' ');
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (record(block) && block.type === 'text' && typeof block.text === 'string') text += block.text.slice(0, 256 - text.length);
    if (text.length >= 256) break;
  }
  return text.replace(/\s+/g, ' ');
}
function visible(entry: Row): boolean {
  if (entry.type === 'message') {
    const message = entry.message;
    return record(message) && typeof message.role === 'string' && (!['custom', 'hookMessage'].includes(message.role) || message.display === true);
  }
  if (entry.type === 'custom_message') return entry.display === true && (typeof entry.content === 'string' || Array.isArray(entry.content));
  return entry.type === 'compaction' || entry.type === 'reset_boundary' || (entry.type === 'branch_summary' && typeof entry.summary === 'string' && entry.summary.length > 0);
}
async function readBytes(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await file.read(bytes, read, length - read, offset + read);
    if (!result.bytesRead) throw new Error('Journal changed while being read; refresh history');
    read += result.bytesRead;
  }
  return bytes;
}
async function assertRevision(file: FileHandle, path: string, revision: string): Promise<void> {
  if (revisionOf(await file.stat({ bigint: true })) !== revision || revisionOf(await stat(path, { bigint: true })) !== revision) {
    throw new Error('Journal changed while being read; refresh history');
  }
}

/** One active bounded offset index and one materialized page. Never opens a writer or native runtime. */
export class HistoryReader {
  private index?: Index;
  private page?: { key: string; snapshot: Snapshot };
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;

  async revision(path: string): Promise<string> { return revisionOf(await stat(path, { bigint: true })); }
  close(): void { this.closed = true; this.index?.source.close(); this.index?.entries.close(); this.index = undefined; this.page = undefined; }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(async () => {
      if (this.closed) throw new Error('History reader is closed');
      return operation();
    });
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  read(options: HistoryRead, blobsDir: string): Promise<Snapshot> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      const leaf = options.leafId === undefined ? index.leafId : options.leafId;
      if (leaf !== null && !index.entries.has(leaf)) throw new Error('Selected history entry no longer exists; refresh the tree');
      if (options.before && options.before.length > 4096) throw new Error('Invalid history page cursor');
      const key = JSON.stringify([index.revision, leaf, options.before, blobsDir]);
      if (this.page?.key === key) return this.page.snapshot;
      const diagnostics = [...index.diagnostics];
      if (options.leafId === undefined) diagnostic(diagnostics, 'Default view follows the last persisted entry, not a verified active native leaf.');
      for (const item of await index.entries.select(leaf)) diagnostic(diagnostics, item);
      let before: string | undefined;
      if (options.before !== undefined) {
        let cursor: unknown;
        try { cursor = JSON.parse(Buffer.from(options.before, 'base64url').toString('utf8')); } catch { throw new Error('Invalid history page cursor'); }
        if (!record(cursor) || cursor.revision !== index.revision || cursor.leaf !== leaf || typeof cursor.id !== 'string') throw new Error('History page cursor is stale; reload the latest page');
        before = cursor.id;
      }
      const candidates = index.entries.page(before);
      const messages: Entry[] = [];
      let bytes = 0;
      for (const entry of candidates) {
        const weight = entry.oversized ? 1024 : Math.min(entry.length, 1024 * 1024) * 3;
        if (messages.length === PAGE_MESSAGES || bytes + weight > PAGE_BYTES) break;
        bytes += weight; messages.push(entry);
      }
      const hasMore = candidates.length > messages.length;
      messages.reverse();
      const pageMessages: HistoryMessage[] = [];
      await index.source.assert();
      const hydration = new ImageHydration(blobsDir, diagnostics);
      const sourceIdentity = createHash('sha256').update(await realpath(index.path)).digest('hex');
      for (const entry of messages) {
        let raw: NativeMessage;
        const resourceReference = `desktop-entry:${Buffer.from(entry.id).toString('base64url')}`;
        if (entry.oversized || entry.length > RECORD_BYTES) {
          raw = deferredMessage({ role: entry.role || 'custom', display: true });
        } else {
          const row: unknown = JSON.parse((await index.source.range(entry.offset, entry.length)).toString('utf8'));
          if (!record(row)) throw new Error('Journal record changed while reading');
          raw = project(row, entry, diagnostics);
          if (Buffer.byteLength(JSON.stringify(raw)) > 1024 * 1024) raw = deferredMessage(raw);
          imageReferences(raw, sourceIdentity, entry.id);
          await hydration.message(raw);
        }
        pageMessages.push({ id: `${index.session.id}:${entry.id}`, ...(entry.entryId ? { entryId: entry.entryId } : {}), resourceReference, raw });
      }
      await index.source.assert();
      const snapshot: Snapshot = {
        session: index.session, revision: index.revision, leafId: index.leafId, selectedLeafId: leaf, messages: pageMessages, hasMore, diagnostics,
        ...(index.sourceMode ? { sourceReference: `desktop-entry:${Buffer.from('$source').toString('base64url')}` } : {}),
        ...(hasMore ? { nextBefore: Buffer.from(JSON.stringify({ revision: index.revision, leaf, id: messages[0]!.id })).toString('base64url') } : {}),
      };
      if (!this.closed) this.page = { key, snapshot };
      return snapshot;
    });
  }

  tree(path: string, before?: string): Promise<HistoryTreeSnapshot> {
    return this.serial(async () => {
      const index = await this.load(path);
      let offset = Number.MAX_SAFE_INTEGER;
      if (before !== undefined) {
        if (before.length > 4096) throw new Error('Invalid tree cursor');
        let cursor: unknown;
        try { cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')); } catch { throw new Error('Invalid tree cursor'); }
        if (!record(cursor) || cursor.revision !== index.revision || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0) throw new Error('History tree cursor is stale or invalid');
        offset = Number(cursor.offset);
      }
      const candidates = index.entries.tree(offset);
      const hasMore = candidates.length > 1000;
      const entries = candidates.slice(0, 1000).reverse();
      const nodes: HistoryTreeNode[] = [];
      for (const entry of entries) {
        const { id, entryId, parentId, type, timestamp, role, label, preview } = entry;
        nodes.push({ id, ...(entryId ? { entryId } : {}), parentId: parentId === id || (parentId !== null && !index.entries.has(parentId)) ? null : parentId, type, timestamp, ...(role ? { role } : {}), ...(label ? { label } : {}), preview });
      }
      // A corrupt cycle must still be reachable in a readonly tree, without altering transcript ancestry.
      const byId = new Map(nodes.map(node => [node.id, node]));
      const visited = new Set<string>();
      for (const node of nodes) {
        const chain = new Set<string>();
        let current: HistoryTreeNode | undefined = node;
        while (current && !visited.has(current.id)) {
          if (chain.has(current.id)) { current.parentId = null; break; }
          chain.add(current.id);
          current = current.parentId === null ? undefined : byId.get(current.parentId);
        }
        for (const id of chain) visited.add(id);
      }
      return { revision: index.revision, leafId: index.leafId, nodes, hasMore, ...(hasMore ? { nextBefore: Buffer.from(JSON.stringify({ revision: index.revision, offset: entries[0]!.offset })).toString('base64url') } : {}), diagnostics: [...index.diagnostics] };
    });
  }

  async canFork(path: string, sessionId?: string): Promise<boolean> {
    try {
      const source = await this.resourceContext(path);
      return source.session.canFork && (sessionId === undefined || source.session.id === sessionId);
    } catch { return false; }
  }

  async forkSource(path: string): Promise<ForkSource> {
    if (!await this.canFork(path)) throw new Error('Native fork requires a readable persisted source session.');
    const expectedRevision = await this.revision(path);
    const context = await this.resourceContext(path);
    return this.serial(async () => {
      const index = await this.load(path);
      if (index.session.sourceKind === 'journal') return { path };
      if (index.revision !== expectedRevision || index.session.id !== context.session.id) throw new Error('Archive changed before fork staging');
      const present: string[] = [];
      for (const root of context.artifactRoots) {
        try { await lstat(root); present.push(root); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (present.length > 1) throw new Error('Archive fork has multiple persisted artifact roots; native artifact identity is ambiguous and cannot be merged safely');
      if (!present.length && context.session.previousSessionFiles?.length) throw new Error('Archive fork cannot preserve moved artifacts: no verified artifact root remains');
      return stageArchiveFork(index.source, present[0] ?? index.artifactRoots[0]!, index.session.id);
    });
  }

  resourceContext(path: string): Promise<{ session: SessionSummary; artifactRoots: string[]; diagnostics: string[] }> {
    return this.serial(async () => {
      const index = await this.load(path);
      const roots = [...index.artifactRoots];
      const diagnostics = [...index.diagnostics];
      const canonicalPath = await realpath(path);
      const profileRoot = (file: string): string | undefined => {
        const sessions = dirname(dirname(file));
        if (basename(sessions) !== 'sessions') return undefined;
        const parent = dirname(sessions);
        return basename(parent) === 'archive' ? dirname(parent) : parent;
      };
      const profile = profileRoot(canonicalPath);
      const filename = index.session.createdAt ? `${index.session.createdAt.replace(/[:.]/g, '-')}_${index.session.id}.jsonl` : undefined;
      for (const alias of index.session.previousSessionFiles ?? []) {
        let source: HistorySource | undefined;
        try {
          // The native move record plus identity-bearing filename authorizes only
          // sibling buckets in this profile, never arbitrary header-supplied paths.
          const parent = await realpath(dirname(alias));
          const canonical = join(parent, basename(alias));
          if (!profile || profileRoot(canonical) !== profile || basename(alias) !== filename || basename(canonicalPath).replace(/\.gz$/, '') !== filename) throw new Error('move alias is outside the identity-bound native session layout');
          try {
            const info = await lstat(canonical);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('move alias is not a regular journal');
            source = new HistorySource(canonical, await this.revision(canonical));
            const summary = parseSessionPrefix((await source.range(0, 64 * 1024)).toString('utf8'), canonical, '');
            if (!summary || summary.id !== index.session.id || summary.createdAt !== index.session.createdAt) throw new Error('move alias has no matching persisted session identity');
            await source.assert();
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          roots.push(canonical.slice(0, -6));
        } catch (error) { diagnostic(diagnostics, `Move artifact provenance unavailable for ${alias}: ${error instanceof Error ? error.message : String(error)}`); }
        finally { source?.close(); }
      }
      return { session: index.session, artifactRoots: [...new Set(roots)], diagnostics };
    });
  }

  entryDetail(options: { path: string; entryId: string; cursor?: string }): Promise<SessionResourcePage> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      const entry = options.entryId === '$source' ? undefined : index.entries.get(options.entryId);
      if (options.entryId !== '$source' && !entry) throw new Error('History entry no longer exists');
      let offset = 0;
      if (options.cursor) {
        if (options.cursor.length > 4096) throw new Error('Invalid entry cursor');
        let cursor: unknown;
        try { cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')); } catch { throw new Error('Invalid entry cursor'); }
        if (!record(cursor) || cursor.revision !== index.revision || cursor.id !== options.entryId || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0) throw new Error('Entry cursor is stale or invalid');
        offset = Number(cursor.offset);
      }
      const diagnostics: string[] = [];
      let data: Buffer;
      let images: NonNullable<SessionResourcePage['imageReferences']> = [];
      let size: number;
      if (entry && !entry.oversized && entry.length <= RECORD_BYTES) {
        const row: unknown = JSON.parse((await index.source.range(entry.offset, entry.length)).toString('utf8'));
        if (!record(row)) throw new Error('Invalid history entry');
        if (!entry.visible) throw new Error('This metadata entry has no displayable payload');
        const message = project(row, entry, diagnostics);
        images = imageReferences(message, createHash('sha256').update(await realpath(index.path)).digest('hex'), entry.id);
        const projected = Buffer.from(JSON.stringify(message, null, 2));
        size = projected.length;
        data = projected.subarray(offset, offset + 64 * 1024 + 4);
      } else {
        size = entry?.length ?? index.size;
        data = await index.source.range((entry?.offset ?? 0) + offset, Math.min(64 * 1024 + 4, Math.max(0, size - offset)));
        diagnostics.push('Raw persisted source detail, not a reconstructed message; may include native replay metadata. No blob payloads are hydrated.');
      }
      if (offset > size) throw new Error('Entry cursor is outside its source');
      let length = Math.min(data.length, 64 * 1024);
      while (length < data.length && (data[length]! & 0xc0) === 0x80) length++;
      const next = offset + length;
      await index.source.assert();
      return { name: entry ? `Entry ${entry.id}` : 'Journal source', kind: 'text', content: data.toString('utf8', 0, length), sourceLabel: index.path, diagnostics, ...(images.length ? { imageReferences: images } : {}), ...(next < size ? { nextCursor: Buffer.from(JSON.stringify({ revision: index.revision, id: options.entryId, offset: next })).toString('base64url') } : {}) };
    });
  }

  imageDetail(options: { path: string; reference: string }, blobs: string): Promise<SessionResourcePage> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      const encoded = options.reference.slice('desktop-image:'.length);
      if (!/^[A-Za-z0-9_-]{1,4096}$/.test(encoded)) throw new Error('Invalid saved image reference');
      const handle: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      const source = createHash('sha256').update(await realpath(index.path)).digest('hex');
      if (!record(handle) || handle.source !== source || typeof handle.entry !== 'string' || !Number.isSafeInteger(handle.index) || Number(handle.index) < 0) throw new Error('Saved image reference belongs to another source or is invalid');
      const entry = index.entries.get(handle.entry);
      if (!entry?.visible || entry.oversized || entry.length > RECORD_BYTES) throw new Error('Saved image entry is unavailable');
      const row: unknown = JSON.parse((await index.source.range(entry.offset, entry.length)).toString('utf8'));
      if (!record(row) || !visible(row)) throw new Error('Saved image entry has no visible payload');
      const diagnostics: string[] = [];
      const image = visibleImages(project(row, entry, diagnostics))[Number(handle.index)];
      if (!image) throw new Error('Saved image does not belong to this visible entry');
      const hydrated = await new ImageHydration(blobs, diagnostics).image(image);
      await index.source.assert();
      return { name: `Image ${Number(handle.index) + 1}`, kind: 'image', sourceLabel: index.path, diagnostics, ...(hydrated ? { dataUrl: hydrated } : {}) };
    });
  }

  taskMetadata(options: { path: string; revision: string; entryIds: string[] }): Promise<{ records: { message?: NativeMessage; delivery?: NativeTaskDelivery }[]; diagnostics: string[] }> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      if (index.revision !== options.revision) throw new Error('Saved task history changed; refresh history');
      const records: { message?: NativeMessage; delivery?: NativeTaskDelivery }[] = [];
      const diagnostics: string[] = [];
      let remaining = 10000;
      let metadataBytes = 0;
      for (let position = Math.min(options.entryIds.length, PAGE_MESSAGES) - 1; position >= 0; position--) {
        const id = options.entryIds[position]!;
        const entry = index.entries.get(id);
        if (!entry?.visible || !['message', 'custom_message'].includes(entry.type) || (entry.role && !['toolResult', 'custom'].includes(entry.role))) continue;
        if (entry.oversized || entry.length > RECORD_BYTES) { diagnostic(diagnostics, 'A saved entry exceeds the 16 MiB metadata extraction bound; its task metadata is unavailable.'); continue; }
        const row: unknown = JSON.parse((await index.source.range(entry.offset, entry.length)).toString('utf8'));
        const message = record(row) ? (record(row.message) ? row.message : row.type === 'custom_message' ? row : undefined) : undefined;
        const delivery = parseNativeTaskDelivery(message);
        if (delivery) {
          const bytes = Buffer.byteLength(JSON.stringify(delivery));
          if (metadataBytes + bytes > 1024 * 1024 || delivery.jobs.length > remaining) { diagnostic(diagnostics, 'Saved task delivery metadata reached its bounded page budget.'); continue; }
          metadataBytes += bytes; remaining -= delivery.jobs.length;
          records.push({ delivery });
          continue;
        }
        if (!message || message.role !== 'toolResult' || message.toolName !== 'task' || typeof message.toolCallId !== 'string' || message.toolCallId.length > 512 || !record(message.details)) continue;
        const details: Row = {};
        for (const key of ['results', 'progress']) {
          const rows: Row[] = [];
          const values = message.details[key];
          if (Array.isArray(values)) for (const value of values) {
            if (!remaining) { diagnostic(diagnostics, 'Saved task metadata reached its 10,000-row page bound.'); break; }
            if (!record(value)) continue;
            remaining--;
            const item: Row = {};
            for (const field of ['id', 'index', 'exitCode', 'aborted', 'status', 'outputPath', 'agent', 'description', 'task', 'assignment', 'durationMs', 'tokens', 'requests', 'contextTokens', 'contextWindow', 'cost', 'toolCount', 'lastIntent', 'currentTool', 'resolvedModel', 'modelRole', 'error', 'abortReason']) {
              const scalar = value[field];
              if (typeof scalar === 'string') item[field] = scalar.slice(0, 4096);
              else if (typeof scalar === 'boolean' || (typeof scalar === 'number' && Number.isFinite(scalar))) item[field] = scalar;
            }
            const bytes = Buffer.byteLength(JSON.stringify(item));
            if (metadataBytes + bytes > 1024 * 1024) { diagnostic(diagnostics, 'Saved task metadata reached its 1 MiB page bound.'); break; }
            metadataBytes += bytes;
            rows.push(item);
          }
          details[key] = rows;
        }
        records.push({ message: { role: 'toolResult', toolName: 'task', toolCallId: message.toolCallId, details } });
      }
      await index.source.assert();
      return { records: records.reverse(), diagnostics };
    });
  }


  private async load(path: string): Promise<Index> {
    const revision = await this.revision(path);
    if (this.index?.path === path && this.index.revision === revision) return this.index;
    this.index?.source.close();
    this.index?.entries.close();
    this.index = undefined; this.page = undefined;
    const sourceFile = new HistorySource(path, revision);
    const entries = new HistoryEntryIndex();
    try {
      const info = await stat(path, { bigint: true });
      if (revisionOf(info) !== revision || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Journal changed before reading');
      const diagnostics: string[] = [];
      const state: { header?: Row } = {};
      let titleSlot: string | undefined;
      let version = 1;
      let leafId: string | null = null;
      let ordinal = 0;
      let firstPreview = '';
      let titleChange: string | undefined;
      let sourceMode = false;
      const consume = (bytes: Buffer, offset: number, eof: boolean, metadata?: Row, length = bytes.length): void => {
        if (!bytes.length && !metadata) return;
        const source = metadata ? '' : bytes.toString('utf8');
        if (!metadata && !source.trim()) return;
        let row: unknown;
        try { row = metadata ?? JSON.parse(source); } catch {
          diagnostic(diagnostics, eof ? `Incomplete tail withheld at byte ${offset}` : `Malformed journal record skipped at byte ${offset}`);
          return;
        }
        if (eof) diagnostic(diagnostics, 'Complete historical EOF record accepted without a final newline');
        if (!record(row)) { diagnostic(diagnostics, `Invalid journal record at byte ${offset}`); return; }
        if (!state.header && row.type === 'title' && offset === 0) {
          if (row.v !== 1 || typeof row.title !== 'string') diagnostic(diagnostics, 'Invalid native title slot');
          else titleSlot = short(row.title, 500);
          return;
        }
        if (!state.header) {
          if (row.type !== 'session' || typeof row.id !== 'string' || !row.id || row.id.length > 512 || typeof row.cwd !== 'string' || !isAbsolute(row.cwd)) throw new Error('Invalid native session header');
          if (row.version !== undefined && ![1, 2, 3].includes(row.version as number)) throw new Error(`Unsupported native journal version: ${String(row.version)}`);
          version = typeof row.version === 'number' ? row.version : 1;
          state.header = { id: row.id, cwd: row.cwd, title: short(row.title, 500), timestamp: short(row.timestamp, 128), parentSession: row.parentSession, previousSessionFiles: row.previousSessionFiles };
          return;
        }
        ordinal++;
        if (typeof row.type !== 'string' || row.type.length > 128) { diagnostic(diagnostics, `Invalid entry type at byte ${offset}`); return; }
        if (!['message', 'custom_message', 'compaction', 'branch_summary', 'model_change', 'thinking_level_change', 'service_tier_change', 'mode_change', 'model_usage', 'label', 'title_change', 'ttsr_injection', 'credential_pin', 'session_init', 'custom', 'reset_boundary'].includes(row.type)) diagnostic(diagnostics, `Unknown journal entry type ${row.type}; retained as tree metadata`);
        const legacy = version === 1;
        if (!legacy && (typeof row.id !== 'string' || !row.id || row.id.length > 512 || !(row.parentId === null || (typeof row.parentId === 'string' && row.parentId.length <= 512)))) {
          diagnostic(diagnostics, `Invalid entry identity at byte ${offset}`); return;
        }
        const id = legacy ? `legacy-${ordinal}-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}` : row.id as string;
        const parentId = legacy ? leafId : row.parentId as string | null;
        const isVisible = metadata ? true : visible(row);
        const message = record(row.message) ? row.message : undefined;
        const role = row.type === 'message' ? short(message?.role, 128) : row.type === 'custom_message' ? 'custom' : undefined;
        const text = isVisible ? preview(message?.content ?? row.content ?? row.summary) : '';
        if (!firstPreview && role === 'user') firstPreview = text;
        if (row.type === 'title_change' && typeof row.title === 'string') titleChange = short(row.title, 500);
        if (row.type === 'label' && typeof row.targetId === 'string' && row.targetId.length <= 512) entries.setLabel(row.targetId, short(row.label, 512));
        if (entries.has(id)) diagnostic(diagnostics, `Duplicate entry ID ${id}; latest record wins`);
        if (!metadata && ((row.type === 'message' && !record(row.message)) || (row.type === 'custom_message' && typeof row.content !== 'string' && !Array.isArray(row.content)))) diagnostic(diagnostics, `Invalid message payload at ${id}`);
        entries.set(id, { id, ...(legacy ? {} : { entryId: id }), parentId, type: row.type, timestamp: short(row.timestamp, 128), ...(role ? { role } : {}), preview: text, offset, length, visible: isVisible, ...(metadata ? { oversized: true } : {}), ...(row.type === 'compaction' ? { method: short(row.method, 128), firstKept: typeof row.firstKeptEntryId === 'string' ? short(row.firstKeptEntryId, 512) : typeof row.firstKeptEntryIndex === 'number' ? row.firstKeptEntryIndex : undefined, tokensBefore: typeof row.tokensBefore === 'number' ? row.tokensBefore : undefined } : {}) });
        leafId = id;
      };
      let offset = 0;
      let lineOffset = 0;
      let parts: Buffer[] = [];
      let pendingBytes = 0;
      let metadata = new RecordMetadata();
      const append = (segment: Buffer) => {
        const previous = pendingBytes;
        pendingBytes += segment.length;
        if (pendingBytes <= RECORD_BYTES) parts.push(Buffer.from(segment));
        else {
          if (previous <= RECORD_BYTES) for (const part of parts) metadata.feed(part);
          metadata.feed(segment);
          parts = [];
        }
      };
      const finish = (eof: boolean) => {
        if (pendingBytes > RECORD_BYTES) {
          sourceMode = true;
          diagnostic(diagnostics, `Record at byte ${lineOffset} exceeds 16 MiB; bounded source detail is available without truncating persistence`);
          if (metadata.complete) consume(Buffer.alloc(0), lineOffset, eof, metadata.values, pendingBytes);
          else diagnostic(diagnostics, `Incomplete oversized record withheld at byte ${lineOffset}; source detail remains available`);
        } else consume(Buffer.concat(parts, pendingBytes), lineOffset, eof);
        parts = []; pendingBytes = 0; metadata = new RecordMetadata();
      };
      for await (const chunk of sourceFile.chunks()) {
        let start = 0;
        for (let cursor = 0; cursor < chunk.length; cursor++) {
          if (chunk[cursor] !== 10) continue;
          append(chunk.subarray(start, cursor));
          finish(false);
          start = cursor + 1; lineOffset = offset + start;
        }
        if (start < chunk.length) append(chunk.subarray(start));
        offset += chunk.length;
      }
      if (pendingBytes) finish(true);
      const header = state.header;
      if (!header) throw new Error('Native journal header is missing or incomplete');
      for (const item of entries.finish()) diagnostic(diagnostics, item);
      await sourceFile.assert();
      const createdAt = typeof header.timestamp === 'string' && Number.isFinite(Date.parse(header.timestamp)) ? header.timestamp : undefined;
      const kind = sourceKind(path);
      if (kind === 'archive') diagnostic(diagnostics, 'Archive is read-only. Explicit fork stages a bounded private source and artifact snapshot before native creation.');
      const { artifactRoots, ...provenance } = lineage(header, path);
      const session: SessionSummary = { id: header.id as string, path, cwd: header.cwd as string, ...provenance, sourceKind: kind, writable: kind === 'journal', canFork: true, title: (titleSlot ?? titleChange ?? header.title as string) || firstPreview.slice(0, 100) || 'Untitled session', preview: firstPreview, updatedAt: new Date(Number(info.mtimeMs)).toISOString(), ...(createdAt ? { createdAt } : {}) };
      const index: Index = { path, revision, session, version, entries, leafId, diagnostics, source: sourceFile, size: offset, sourceMode, artifactRoots };
      if (this.closed) throw new Error('History reader is closed');
      this.index = index; this.page = undefined;
      return index;
    } catch (error) { sourceFile.close(); entries.close(); throw error; }
  }
}

function deferredMessage(message: NativeMessage): NativeMessage {
  const result: NativeMessage = { role: message.role, historyResourceDeferred: true, content: '' };
  for (const key of ['toolName', 'toolCallId', 'customType', 'display', 'attribution', 'timestamp', 'isError']) {
    const value = message[key];
    if (typeof value === 'string') result[key] = value.slice(0, 512);
    else if (typeof value === 'boolean' || typeof value === 'number') result[key] = value;
  }
  return result;
}

/** Opaque provider transport fields are persistence, not display content. */
function displayFields(value: Row): Row {
  const result: Row = {};
  for (const [key, item] of Object.entries(value)) {
    if (/signature/i.test(key) || key === 'providerPayload' || key === 'encryptedContent') continue;
    result[key] = item;
  }
  return result;
}

function project(row: Row, entry: Entry, diagnostics: string[]): NativeMessage {
  if (row.type === 'message' && record(row.message)) {
    const message = displayFields(row.message);
    for (const key of ['content', 'blocks', 'images']) {
      const blocks = message[key];
      if (Array.isArray(blocks)) message[key] = blocks.map(block => record(block) ? displayFields(block) : block);
    }
    if (message.role === 'hookMessage') message.role = 'custom';
    return message as NativeMessage;
  }
  const timestamp = Date.parse(entry.timestamp);
  if (row.type === 'reset_boundary') return { role: 'custom', customType: 'reset_boundary', display: true, content: 'Context reset', timestamp };
  if (row.type === 'custom_message') {
    return { role: 'custom', customType: row.customType, content: row.content, display: true, details: row.details, ...(row.attribution === 'user' || row.attribution === 'agent' ? { attribution: row.attribution } : {}), timestamp };
  }
  if (row.type === 'branch_summary') return { role: 'branchSummary', summary: row.summary, fromId: row.fromId, timestamp };
  const result: NativeMessage = { role: 'compactionSummary', summary: row.summary, shortSummary: row.shortSummary, tokensBefore: row.tokensBefore, tokensAfter: row.tokensAfter, method: row.method, warning: row.warning, timestamp };
  const archive = record(row.preserveData) && record(row.preserveData.snapcompact) ? row.preserveData.snapcompact : undefined;
  if (archive) {
    const blocks: Row[] = [];
    const frames = Array.isArray(archive.frames) ? archive.frames : [];
    const valid = frames.filter(frame => record(frame) && typeof frame.data === 'string' && frame.data.length > 0 && typeof frame.mimeType === 'string' && typeof frame.cols === 'number' && typeof frame.rows === 'number' && typeof frame.chars === 'number') as Row[];
    const truncated = valid.some(frame => typeof frame.data === 'string' && frame.data.endsWith('\n\n[Session persistence truncated large content]'));
    if (valid.length !== frames.length || truncated) diagnostic(diagnostics, `Compaction ${entry.id} contains unavailable archive frames`);
    if (truncated && typeof archive.text === 'string' && archive.text) blocks.push({ type: 'text', text: archive.text });
    else {
      if (typeof archive.textHead === 'string' && archive.textHead) blocks.push({ type: 'text', text: archive.textHead });
      for (const frame of valid) if (!(typeof frame.data === 'string' && frame.data.endsWith('\n\n[Session persistence truncated large content]'))) blocks.push({ ...frame, type: 'image' });
      if (typeof archive.textTail === 'string' && archive.textTail) blocks.push({ type: 'text', text: archive.textTail });
      if (!blocks.length && typeof archive.text === 'string' && archive.text) blocks.push({ type: 'text', text: archive.text });
    }
    if (blocks.length) { result.blocks = blocks; result.images = blocks.filter(block => block.type === 'image'); }
    result.archive = { ...archive, frameCount: frames.length };
    if (typeof archive.truncatedChars === 'number' && archive.truncatedChars > 0) diagnostic(diagnostics, `Compaction ${entry.id} archive omits ${archive.truncatedChars} characters`);
  }
  return result;
}

interface VisibleImage { block: Row; value: string; dataUrl: boolean }
function visibleImages(message: NativeMessage): VisibleImage[] {
  const images: VisibleImage[] = [];
  const seen = new Set<object>();
  // Deliberately inspect only display carriers, never providerPayload or details.
  for (const key of ['content', 'blocks', 'images']) {
    if (key === 'images' && Array.isArray(message.blocks) && message.blocks.length) continue;
    const blocks = message[key];
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!record(block) || seen.has(block)) continue;
      seen.add(block);
      if ((block.type === 'image' || (!block.type && typeof block.mimeType === 'string')) && typeof block.data === 'string') images.push({ block, value: block.data, dataUrl: block.data.startsWith('data:') });
      else if (block.type === 'image_generation_call' && typeof block.result === 'string') images.push({ block, value: block.result, dataUrl: false });
      else if (block.type === 'image_url' || block.type === 'input_image') {
        const value = typeof block.image_url === 'string' ? block.image_url : record(block.image_url) ? block.image_url.url : undefined;
        if (typeof value === 'string') images.push({ block, value, dataUrl: true });
      }
    }
  }
  return images;
}
function imageReferences(message: NativeMessage, source: string, entry: string): NonNullable<SessionResourcePage['imageReferences']> {
  return visibleImages(message).map((image, index) => {
    const reference = `desktop-image:${Buffer.from(JSON.stringify({ source, entry, index })).toString('base64url')}`;
    image.block.resourceReference = reference;
    return { reference, name: `Image ${index + 1}` };
  });
}

function imageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

class ImageHydration {
  private remaining = IMAGE_TOTAL;
  private root?: Promise<string>;
  private seen = new Set<object>();
  private deferred = false;
  constructor(private directory: string, private diagnostics: string[]) {}

  async image(image: VisibleImage): Promise<string | undefined> {
    if (image.value.startsWith('blob:')) {
      const result = await this.blob(image.value, image.dataUrl);
      if (result && typeof image.block.mimeType === 'string' && image.block.mimeType !== result.mime) { diagnostic(this.diagnostics, 'Saved image bytes do not match their MIME type'); return undefined; }
      return result ? (image.dataUrl ? result.data : `data:${result.mime};base64,${result.data}`) : undefined;
    }
    const url = image.dataUrl ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.value) : undefined;
    const data = image.dataUrl ? url?.[2] : image.value;
    if (!data || data.length > Math.ceil(IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) { diagnostic(this.diagnostics, 'Saved image is not a bounded supported image'); return undefined; }
    const bytes = Buffer.from(data, 'base64');
    const mime = imageMime(bytes);
    if (bytes.length > IMAGE_BYTES || bytes.toString('base64') !== data || !mime || (url && mime !== url[1]) || (typeof image.block.mimeType === 'string' && mime !== image.block.mimeType)) { diagnostic(this.diagnostics, 'Saved image bytes are invalid or do not match their MIME type'); return undefined; }
    return `data:${mime};base64,${data}`;
  }

  async message(message: NativeMessage): Promise<void> {
    for (const image of visibleImages(message)) {
      const value = image.block;
      if (this.seen.has(value)) continue;
      this.seen.add(value);
      const hydrated = await this.blob(image.value, image.dataUrl);
      if (!hydrated) { if (this.deferred) value.deferred = true; continue; }
      if (value.type === 'image_generation_call') value.result = hydrated.data;
      else if (value.type === 'image_url' || value.type === 'input_image') {
        if (record(value.image_url)) value.image_url.url = hydrated.data;
        else value.image_url = hydrated.data;
      } else { value.data = hydrated.data; value.mimeType = hydrated.mime; }
    }
  }
  private async blob(reference: string, dataUrl: boolean): Promise<{ data: string; mime: string } | undefined> {
    this.deferred = false;
    if (!reference.startsWith('blob:')) return undefined;
    const match = BLOB.exec(reference);
    if (!match) { diagnostic(this.diagnostics, 'Invalid image blob reference; image unavailable'); return undefined; }
    let file: FileHandle | undefined;
    try {
      this.root ??= realpath(this.directory);
      const root = await this.root;
      const path = join(root, match[1]!);
      const resolved = await realpath(path);
      const child = relative(root, resolved);
      if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || resolved !== path) throw new Error('blob escapes its data root or is a symbolic link');
      file = await open(path, READ_FLAGS);
      const info = await file.stat({ bigint: true });
      const signature = revisionOf(info);
      if (info.size > BigInt(IMAGE_BYTES)) throw new Error('image hydration byte limit reached');
      if (info.size * 4n / 3n + 128n > BigInt(this.remaining)) { this.deferred = true; return undefined; }
      const bytes = await readBytes(file, 0, Number(info.size));
      await assertRevision(file, path, signature);
      if (await realpath(path) !== path) throw new Error('blob escapes its data root or is a symbolic link');
      let data: string;
      let mime: string | undefined;
      if (dataUrl) {
        data = bytes.toString('utf8');
        const url = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
        if (!url) throw new Error('unsupported image data URL');
        const decoded = Buffer.from(url[2]!, 'base64');
        mime = imageMime(decoded);
        if (decoded.toString('base64') !== url[2] || !mime || mime !== url[1]) throw new Error('image bytes do not match its MIME type');
      } else {
        mime = imageMime(bytes);
        if (!mime) throw new Error('unsupported image bytes');
        data = bytes.toString('base64');
      }
      this.remaining -= data.length;
      return { data, mime };
    } catch (error) {
      diagnostic(this.diagnostics, `Image ${match[1]!.slice(0, 12)} unavailable: ${error instanceof Error ? error.message : 'read failed'}`);
      return undefined;
    } finally { await file?.close(); }
  }
}

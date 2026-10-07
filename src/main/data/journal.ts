import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { HistoryMessage, HistoryRead, HistorySnapshot, HistoryTreeNode, HistoryTreeSnapshot, NativeMessage, SessionResourcePage, SessionSummary } from '../../shared/contracts';
import { parseNativeAsyncDelivery, parseNativeJobSnapshot, type NativeAsyncDelivery } from '../../shared/native-task-results';
import { record } from './io';
import { HistorySource, lineage, RecordMetadata, sourceKind } from './history-source';
import { parseSessionPrefix } from './history';
import { HistoryEntryIndex, type IndexedHistoryEntry as Entry } from './history-entry-index';
import { preflightArchiveFork, stageArchiveFork, type ForkSource } from './history-fork';
import { activitySignal, inferActivity, type ActivitySignal } from './session-observer';
import type { SessionAccess, ObservedActivity } from '../../shared/contracts';

const RECORD_BYTES = 16 * 1024 * 1024;
const PAGE_BYTES = 8 * 1024 * 1024;
const PAGE_MESSAGES = 200;
const IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TOTAL = 16 * 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const BLOB = /^blob:sha256:([a-f0-9]{64})$/;
type Row = Record<string, unknown>;
type Snapshot = Omit<HistorySnapshot, 'access'>;
export class HistoryRevisionChangedError extends Error {
  constructor() { super('Saved task history changed; refresh history'); this.name = 'HistoryRevisionChangedError'; }
}
interface Index {
  path: string; revision: string; session: SessionSummary; version: number; entries: HistoryEntryIndex; leafId: string | null; diagnostics: string[]; source: HistorySource; size: number; sourceMode: boolean; artifactRoots: string[];
  guard: string; extend(source: HistorySource, info: BigIntStats): Promise<void>;
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
    return record(message) && typeof message.role === 'string';
  }
  if (entry.type === 'custom_message') return typeof entry.content === 'string' || Array.isArray(entry.content);
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

  activity(path: string, leafId: string | null, access: SessionAccess, children?: { revision: string; lastGrowthAt?: number }): Promise<ObservedActivity> {
    return this.serial(async () => {
      const index = await this.load(path);
      function* signals(): Generator<ActivitySignal> {
        let current = leafId;
        const seen = new Set<string>();
        while (current !== null && !seen.has(current)) {
          seen.add(current);
          const entry = index.entries.get(current);
          if (!entry) break;
          if (entry.activity) { yield entry.activity; if (['request', 'stop', 'exit'].includes(entry.activity.kind)) break; }
          current = entry.parentId;
        }
      }
      return inferActivity(signals(), access, Date.parse(index.session.updatedAt), Date.now(), children);
    });
  }
  /** Transport cursor only: never identifies the native-selected history branch. */
  nativeEntriesCursor(path: string): Promise<{ sessionId: string; since?: string }> {
    return this.serial(async () => {
      const index = await this.load(path);
      const tail = index.leafId === null ? undefined : index.entries.get(index.leafId);
      // Complete indexed native identity is enough for transport; deferred detail is independent.
      // Native get_entries validates since and alone supplies the selected leaf.
      if (index.version === 1 || ((index.leafId !== null || index.sourceMode) && !tail?.entryId)) throw new Error('Native entries cursor requires an indexed native journal');
      await index.source.assert();
      return { sessionId: index.session.id, ...(tail?.entryId ? { since: tail.entryId } : {}) };
    });
  }

  /** Main-only lookup for an entry already selected on an authorized branch. Hidden metadata remains part of native ancestry. */
  entryPredecessor(options: { path: string; revision: string; entryId: string }): Promise<string | null | undefined> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      if (index.revision !== options.revision) throw new HistoryRevisionChangedError();
      const entry = index.entries.get(options.entryId);
      if (!entry) throw new Error('Selected initiating entry no longer exists');
      await index.source.assert();
      if (index.version === 1 || !entry.entryId) return undefined;
      return entry.parentId;
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(async () => {
      if (this.closed) throw new Error('History reader is closed');
      return operation();
    });
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Main-only metadata paging after source authorization; never hydrates unrelated transcript payloads. */
  readEvidence(options: HistoryRead & { revision?: string; forward?: boolean }): Promise<Snapshot> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      if (options.revision !== undefined && options.revision !== index.revision) throw new HistoryRevisionChangedError();
      const leaf = options.leafId === undefined ? index.leafId : options.leafId;
      if (leaf !== null && !index.entries.has(leaf)) throw new Error('Selected history entry no longer exists; refresh the tree');
      const diagnostics = index.diagnostics.filter(item => !/^Record at byte \d+ exceeds 16 MiB;/.test(item));
      for (const item of await index.entries.select(leaf)) diagnostic(diagnostics, item);
      let before: string | undefined;
      if (options.before !== undefined) {
        if (options.before.length > 4096) throw new Error('Invalid evidence page cursor');
        const cursor: unknown = JSON.parse(Buffer.from(options.before, 'base64url').toString('utf8'));
        if (!record(cursor) || cursor.revision !== index.revision || cursor.leaf !== leaf || cursor.forward !== options.forward || typeof cursor.id !== 'string') throw new HistoryRevisionChangedError();
        before = cursor.id;
      }
      const candidates = options.forward ? index.entries.forwardPage(before) : index.entries.page(before), selected = candidates.slice(0, PAGE_MESSAGES);
      if (!options.forward) selected.reverse();
      await index.source.assert();
      return { session: index.session, revision: index.revision, leafId: index.leafId, selectedLeafId: leaf, diagnostics,
        messages: selected.map(entry => ({ id: `${index.session.id}:${entry.id}`, ...(entry.entryId ? { entryId: entry.entryId } : {}), raw: entry.evidence ?? { role: entry.role || 'custom', historyResourceDeferred: true, historyEvidenceUnknown: true } })),
        hasMore: candidates.length > selected.length,
        ...(candidates.length > selected.length ? { nextBefore: Buffer.from(JSON.stringify({ revision: index.revision, leaf, forward: options.forward, id: (options.forward ? selected.at(-1)! : selected[0]!).id })).toString('base64url') } : {}),
      };
    });
  }

  matchEvidenceTool(options: { path: string; revision: string; leafId: string | null; startId: string; endId?: string; toolId: string; entryId: string; result?: boolean; late?: boolean }): Promise<{ count: number; result?: HistoryMessage; reused: boolean }> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      if (index.revision !== options.revision) throw new HistoryRevisionChangedError();
      await index.entries.select(options.leafId);
      const matched = index.entries.matchEvidenceTool(options);
      await index.source.assert();
      return { count: matched.count, reused: matched.reused, ...(matched.result ? { result: { id: `${index.session.id}:${matched.result.id}`, entryId: matched.result.entryId, raw: matched.result.evidence! } } : {}) };
    });
  }

  /** Hydrate only an already authorized indexed entry, without display/image resource work. */
  readEvidenceEntry(options: { path: string; revision: string; entryId: string }): Promise<{ raw: NativeMessage; bytes: number }> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      if (index.revision !== options.revision) throw new HistoryRevisionChangedError();
      const entry = index.entries.get(options.entryId);
      if (!entry?.visible) throw new Error('Selected evidence entry is unavailable');
      const row = await index.source.projectEvidence(entry.offset, entry.length, entry.evidence);
      const raw = project(row, entry, []), bytes = Buffer.byteLength(JSON.stringify(raw));
      await index.source.assert();
      return { raw, bytes };
    });
  }

  read(options: HistoryRead, blobsDir: string): Promise<Snapshot> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      const leaf = options.leafId === undefined ? index.leafId : options.leafId;
      if (leaf !== null && !index.entries.has(leaf)) throw new Error('Selected history entry no longer exists; refresh the tree');
      if (options.before && options.before.length > 4096) throw new Error('Invalid history page cursor');
      const key = JSON.stringify([index.revision, leaf, options.before, options.beforeEntryId, options.anchorId, blobsDir]);
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
      const entryId = (id: string) => id.startsWith(`${index.session.id}:`) ? id.slice(index.session.id.length + 1) : id;
      const selectors = [options.before, options.beforeEntryId, options.anchorId].filter(value => value !== undefined);
      if (selectors.length > 1) throw new Error('Select one history cursor or reading anchor');
      const candidates = index.entries.page(options.beforeEntryId === undefined ? before : entryId(options.beforeEntryId), options.anchorId === undefined ? undefined : entryId(options.anchorId));
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
      const selection: NonNullable<HistorySnapshot['selection']> = {};
      for (const entry of index.entries.selectionEntries()) {
        if (entry.oversized || entry.length > RECORD_BYTES) continue;
        const row: unknown = JSON.parse((await index.source.range(entry.offset, entry.length)).toString('utf8'));
        if (!record(row)) continue;
        if (entry.type === 'thinking_level_change') selection.thinkingLevel = typeof row.thinkingLevel === 'string' ? row.thinkingLevel : null;
        else if (record(row.message) && typeof row.message.provider === 'string' && typeof row.message.model === 'string') selection.model = { provider: row.message.provider, id: row.message.model };
      }
      await index.source.assert();
      const snapshot: Snapshot = {
        session: index.session, revision: index.revision, leafId: index.leafId, selectedLeafId: leaf, messages: pageMessages, hasMore, diagnostics,
        selection,
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

  async forkAvailability(path: string): Promise<{ canFork: boolean; reason?: string }> {
    try {
      const context = await this.resourceContext(path);
      if (context.session.sourceKind === 'journal') return { canFork: context.session.canFork };
      const revision = await this.revision(path);
      const present: string[] = [];
      for (const root of context.artifactRoots) {
        try { await lstat(root); present.push(root); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (present.length > 1) throw new Error('Archive fork has ambiguous persisted artifact roots');
      if (!present.length && context.session.previousSessionFiles?.length) throw new Error('Archive fork cannot preserve moved artifacts: no verified artifact root remains');
      await this.serial(async () => {
        const index = await this.load(path);
        if (index.revision !== revision) throw new Error('Archive changed during fork preflight');
        await preflightArchiveFork(index.source, present[0] ?? index.artifactRoots[0]!);
      });
      return { canFork: true, reason: 'Bounded source/artifact fork preflight passed; native materialization and copy verification are still required, and the source may change.' };
    } catch (error) { return { canFork: false, reason: error instanceof Error ? error.message : String(error) }; }
  }
  async canFork(path: string, sessionId?: string): Promise<boolean> {
    try {
      const source = await this.resourceContext(path);
      return source.session.canFork && (sessionId === undefined || source.session.id === sessionId) && (await this.forkAvailability(path)).canFork;
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
      let display: SessionResourcePage['display'];
      let images: NonNullable<SessionResourcePage['imageReferences']> = [];
      let size: number;
      if (entry && !entry.oversized && entry.length <= RECORD_BYTES) {
        const row: unknown = JSON.parse((await index.source.range(entry.offset, entry.length)).toString('utf8'));
        if (!record(row)) throw new Error('Invalid history entry');
        if (!entry.visible) throw new Error('This metadata entry has no displayable payload');
        const message = project(row, entry, diagnostics);
        // The readable preview is independent of the unchanged raw-data cursor.
        // 64 Ki UTF-16 units bound even four-byte text below 256 KiB.
        let readable = '', truncated = false;
        const append = (value: string) => {
          const separator = readable ? '\n\n' : '';
          const available = Math.max(0, 64 * 1024 - readable.length - separator.length);
          if (value.length > available) truncated = true;
          if (available) readable += separator + value.slice(0, available);
        };
        if (typeof message.content === 'string') append(message.content);
        else if (Array.isArray(message.content)) for (const block of message.content) {
          if (record(block) && block.type === 'text' && typeof block.text === 'string') append(block.text);
        }
        if (/[\uD800-\uDBFF]$/.test(readable)) { readable = readable.slice(0, -1); truncated = true; }
        const toolName = short(message.toolName, 128);
        if (readable || toolName) {
          let args: Row = {};
          let parent = entry.parentId, remaining = 1024 * 1024;
          // Only the selected result's ancestors can identify its producing call.
          for (let depth = 0; toolName && typeof message.toolCallId === 'string' && parent && depth < 64; depth++) {
            const candidate = index.entries.get(parent);
            if (!candidate) break;
            parent = candidate.parentId;
            if (candidate.role !== 'assistant' || candidate.oversized || candidate.length > remaining) continue;
            remaining -= candidate.length;
            const source: unknown = JSON.parse((await index.source.range(candidate.offset, candidate.length)).toString('utf8'));
            const content = record(source) && record(source.message) ? source.message.content : undefined;
            const call = Array.isArray(content) ? content.find(block => record(block) && block.type === 'toolCall' && block.id === message.toolCallId && block.name === toolName) : undefined;
            if (record(call)) { args = record(call.arguments) ? call.arguments : {}; break; }
          }
          const details = record(message.details) ? message.details : {};
          const patchPath = /^\[([^\]\r\n]+?)(?:#[A-Fa-f0-9]{4})?\]/.exec(short(args.input, 1024))?.[1];
          const fileTarget = short(args.path, 512) || short(details.resolvedPath, 512) || short(details.path, 512) || patchPath;
          const target = short(args.command, 512) || (fileTarget ? basename(fileTarget.replaceAll('\\', '/')) : '') || short(args.pattern, 512) || short(args.i, 512);
          const extension = /\.([A-Za-z0-9]+)(?::[\d:+-]+)?$/.exec(target)?.[1];
          display = { title: [toolName || short(message.role, 128), target].filter(Boolean).join(' · '), content: readable, ...(toolName === 'bash' ? { language: 'bash' } : extension ? { language: extension } : {}), ...(truncated ? { truncated: true } : {}) };
        }
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
      return { name: entry ? `Entry ${entry.id}` : 'Journal source', kind: 'text', content: data.toString('utf8', 0, length), sourceLabel: index.path, diagnostics, ...(display ? { display } : {}), ...(images.length ? { imageReferences: images } : {}), ...(next < size ? { nextCursor: Buffer.from(JSON.stringify({ revision: index.revision, id: options.entryId, offset: next })).toString('base64url') } : {}) };
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

  taskMetadata(options: { path: string; revision: string; entryIds: string[] }): Promise<{ records: { message?: NativeMessage; delivery?: NativeAsyncDelivery }[]; diagnostics: string[] }> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      if (index.revision !== options.revision) throw new HistoryRevisionChangedError();
      const records: { message?: NativeMessage; delivery?: NativeAsyncDelivery }[] = [];
      const diagnostics: string[] = [];
      for (let position = Math.min(options.entryIds.length, PAGE_MESSAGES) - 1; position >= 0; position--) {
        const id = options.entryIds[position]!;
        const entry = index.entries.get(id);
        if (!entry?.visible || !['message', 'custom_message'].includes(entry.type) || (entry.role && !['toolResult', 'custom'].includes(entry.role))) continue;
        const row: unknown = entry.oversized || entry.length > RECORD_BYTES ? await index.source.projectEvidence(entry.offset, entry.length, entry.evidence) : JSON.parse((await index.source.range(entry.offset, entry.length)).toString('utf8'));
        const message = record(row) ? (record(row.message) ? row.message : row.type === 'custom_message' || typeof row.role === 'string' ? row : undefined) : undefined;
        const parsedDelivery = parseNativeAsyncDelivery(message) ?? parseNativeJobSnapshot(message);
        const delivery = parsedDelivery && { ...parsedDelivery, content: undefined, residualContent: [], jobs: parsedDelivery.jobs.filter(job => job.type === 'task').map(job => ({ ...job, observedAt: record(row) ? row.timestamp : undefined, raw: undefined, content: undefined, meta: undefined, schema: undefined })) };
        if (delivery) {
          records.push({ delivery });
          continue;
        }
        if (!message || message.role !== 'toolResult' || message.toolName !== 'task' || typeof message.toolCallId !== 'string' || !record(message.details)) continue;
        const details: Row = {};
        for (const key of ['results', 'progress']) {
          const rows: Row[] = [];
          const values = message.details[key];
          if (Array.isArray(values)) for (const value of values) {
            if (!record(value)) continue;
            const item: Row = {};
            for (const field of ['id', 'index', 'exitCode', 'aborted', 'status', 'outputPath', 'agent', 'description', 'task', 'assignment', 'durationMs', 'tokens', 'requests', 'contextTokens', 'contextWindow', 'cost', 'toolCount', 'issueCount', 'lastIntent', 'currentTool', 'resolvedModel', 'modelRole', 'error', 'abortReason']) {
              const scalar = value[field];
              if (typeof scalar === 'string') item[field] = scalar.slice(0, 4096);
              else if (typeof scalar === 'boolean' || (typeof scalar === 'number' && Number.isFinite(scalar))) item[field] = scalar;
            }
            if (record(value.diagnostics)) item.issueCount = Array.isArray(value.diagnostics.errors) ? value.diagnostics.errors.length : 0;
            else if (Array.isArray(value.diagnostics)) item.issueCount = value.diagnostics.length;
            rows.push(item);
          }
          details[key] = rows;
        }
        records.push({ message: { role: 'toolResult', toolName: 'task', toolCallId: message.toolCallId, timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp), details } });
      }
      await index.source.assert();
      return { records: records.reverse(), diagnostics };
    });
  }

  /** Selected-branch declarations plus durable execution starts; no name-only or proximity-only ownership. */
  openTaskMetadata(options: { path: string; leafId: string | null; revision: string }): Promise<{ toolCallId: string; index: number; name?: string; agent?: string; task?: string; startedAt: number }[]> {
    return this.serial(async () => {
      const index = await this.load(options.path);
      if (index.revision !== options.revision) throw new HistoryRevisionChangedError();
      const settled = new Set<string>(), starts = new Map<string, number>(), seen = new Set<string>();
      const tasks: { toolCallId: string; index: number; name?: string; agent?: string; task?: string; startedAt: number }[] = [];
      let current = options.leafId;
      while (current !== null && !seen.has(current)) {
        seen.add(current); const entry = index.entries.get(current); if (!entry) break; current = entry.parentId;
        if (entry.activity?.kind === 'start') for (const call of entry.activity.calls ?? []) if (call.name === 'task' && !settled.has(call.toolCallId) && entry.activity.at !== undefined) starts.set(call.toolCallId, entry.activity.at);
        if (entry.type !== 'message' || !['assistant', 'toolResult'].includes(entry.role ?? '')) continue;
        const row: unknown = entry.oversized || entry.length > RECORD_BYTES ? await index.source.projectEvidence(entry.offset, entry.length, entry.evidence) : JSON.parse((await index.source.range(entry.offset, entry.length)).toString('utf8'));
        if (!record(row)) continue;
        const message = record(row.message) ? row.message : row;
        if (message.role === 'toolResult' && message.toolName === 'task' && typeof message.toolCallId === 'string') { settled.add(message.toolCallId); starts.delete(message.toolCallId); continue; }
        if (message.role !== 'assistant' || !Array.isArray(message.content) || !starts.size) continue;
        for (const call of message.content) {
          if (!record(call) || call.type !== 'toolCall' || call.name !== 'task' || typeof call.id !== 'string' || !starts.has(call.id) || !record(call.arguments)) continue;
          const values = Array.isArray(call.arguments.tasks) ? call.arguments.tasks : [call.arguments];
          for (let position = 0; position < values.length; position++) {
            const task = values[position]; if (!record(task)) continue;
            tasks.push({ toolCallId: call.id, index: position, name: typeof task.id === 'string' ? task.id : typeof task.name === 'string' ? task.name : undefined, agent: typeof task.agent === 'string' ? task.agent : undefined, task: typeof task.task === 'string' ? task.task.slice(0, 4096) : undefined, startedAt: starts.get(call.id)! });
          }
          starts.delete(call.id);
        }
      }
      await index.source.assert();
      return tasks;
    });
  }


  private async load(path: string): Promise<Index> {
    const revision = await this.revision(path);
    if (this.index?.path === path && this.index.revision === revision) return this.index;
    if (this.index?.path === path && !path.endsWith('.gz')) {
      const index = this.index;
      const info = await stat(path, { bigint: true });
      const identity = revision.split(':').slice(0, 2).join(':');
      if (identity === index.revision.split(':').slice(0, 2).join(':') && info.size > BigInt(index.size)) {
        const next = new HistorySource(path, revision);
        if (await next.appendGuard(index.size) === index.guard) {
          try {
            await index.extend(next, info);
            index.source.close(); index.source = next; index.revision = revision;
            index.guard = await next.appendGuard(index.size); this.page = undefined;
            return index;
          } catch (error) {
            next.close(); index.source.close(); index.entries.close(); this.index = undefined; this.page = undefined;
            throw error;
          }
        }
      }
    }
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
      let acceptedEof = -1;
      const consume = (bytes: Buffer, offset: number, eof: boolean, metadata?: Row, length = bytes.length): void => {
        if (offset === acceptedEof) return;
        if (!bytes.length && !metadata) return;
        const source = metadata ? '' : bytes.toString('utf8');
        if (!metadata && !source.trim()) return;
        let row: unknown;
        try { row = metadata ?? JSON.parse(source); } catch {
          diagnostic(diagnostics, eof ? `Incomplete tail withheld at byte ${offset}` : `Malformed journal record skipped at byte ${offset}`);
          return;
        }
        if (eof) acceptedEof = offset;
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
        const isVisible = visible(row);
        const message = record(row.message) ? row.message : undefined;
        const role = row.type === 'message' ? short(message?.role, 128) : row.type === 'custom_message' ? 'custom' : undefined;
        const hidden = row.type === 'custom_message' ? row.display !== true : !!message && (message.display === false || (['custom', 'hookMessage'].includes(String(message.role)) && message.display !== true));
        const text = isVisible && !hidden ? preview(message?.content ?? row.content ?? row.summary) : '';
        if (!firstPreview && role === 'user') firstPreview = text;
        if (row.type === 'title_change' && typeof row.title === 'string') titleChange = short(row.title, 500);
        if (row.type === 'label' && typeof row.targetId === 'string' && row.targetId.length <= 512) entries.setLabel(row.targetId, short(row.label, 512));
        if (entries.has(id)) diagnostic(diagnostics, `Duplicate entry ID ${id}; latest record wins`);
        if (!metadata && ((row.type === 'message' && !record(row.message)) || (row.type === 'custom_message' && typeof row.content !== 'string' && !Array.isArray(row.content)))) diagnostic(diagnostics, `Invalid message payload at ${id}`);
        const entry: Entry = { id, ...(legacy ? {} : { entryId: id }), parentId, type: row.type, timestamp: short(row.timestamp, 128), ...(role ? { role } : {}), preview: text, offset, length, visible: isVisible, activity: metadata ? undefined : activitySignal(row), ...(metadata ? { oversized: true } : {}), ...(row.type === 'compaction' ? { method: short(row.method, 128), firstKept: typeof row.firstKeptEntryId === 'string' ? short(row.firstKeptEntryId, 512) : typeof row.firstKeptEntryIndex === 'number' ? row.firstKeptEntryIndex : undefined, tokensBefore: typeof row.tokensBefore === 'number' ? row.tokensBefore : undefined } : {}) };
        if (isVisible) entry.evidence = evidenceMetadata(project(row, entry, []));
        entries.set(id, entry);
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
        if (!eof) { parts = []; pendingBytes = 0; metadata = new RecordMetadata(); }
      };
      const scan = async (source: HistorySource) => {
        for await (const chunk of source.chunks(offset)) {
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
      };
      await scan(sourceFile);
      const header = state.header;
      if (!header) throw new Error('Native journal header is missing or incomplete');
      for (const item of entries.finish()) diagnostic(diagnostics, item);
      await sourceFile.assert();
      const createdAt = typeof header.timestamp === 'string' && Number.isFinite(Date.parse(header.timestamp)) ? header.timestamp : undefined;
      const kind = sourceKind(path);
      if (kind === 'archive') diagnostic(diagnostics, 'Archive is read-only. Explicit fork stages a bounded private source and artifact snapshot before native creation.');
      const { artifactRoots, ...provenance } = lineage(header, path);
      const session: SessionSummary = { id: header.id as string, path, cwd: header.cwd as string, ...provenance, sourceKind: kind, writable: kind === 'journal', canFork: true, title: (titleSlot ?? titleChange ?? header.title as string) || firstPreview.slice(0, 100) || 'Untitled session', preview: firstPreview, updatedAt: new Date(Number(info.mtimeMs)).toISOString(), ...(createdAt ? { createdAt } : {}) };
      const index: Index = { path, revision, session, version, entries, leafId, diagnostics, source: sourceFile, size: offset, sourceMode, artifactRoots, guard: await sourceFile.appendGuard(offset), extend: async (source, nextInfo) => {
        await scan(source);
        index.leafId = leafId; index.size = offset; index.sourceMode = sourceMode;
        index.session = { ...index.session, title: (titleSlot ?? titleChange ?? header.title as string) || firstPreview.slice(0, 100) || 'Untitled session', preview: firstPreview, updatedAt: new Date(Number(nextInfo.mtimeMs)).toISOString() };
      } };
      if (this.closed) throw new Error('History reader is closed');
      this.index = index; this.page = undefined;
      return index;
    } catch (error) { sourceFile.close(); entries.close(); throw error; }
  }
}

/** Retain semantics and exact tool/file identities, not prose or endpoint bytes. */
function evidenceMetadata(message: NativeMessage): NativeMessage {
  const raw: NativeMessage = { role: message.role, content: [], historyEvidenceIndexed: true };
  for (const key of ['id', 'messageId', 'toolName', 'toolCallId', 'customType', 'display', 'attribution', 'steering', 'synthetic', 'userInitiated', 'timestamp', 'isError']) {
    const value = message[key];
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') raw[key] = value;
  }
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    const blocks = message.content.filter(record).filter(block => block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string');
    raw.content = blocks.flatMap(block => {
      const args = record(block.arguments) ? block.arguments : {}, identity: Row = {};
      for (const key of ['path', 'cwd', 'destination']) if (typeof args[key] === 'string') identity[key] = args[key];
      return [{ type: 'toolCall', id: block.id, name: block.name, arguments: identity }];
    });
  }
  if (message.role === 'toolResult' && record(message.details)) {
    const details: Row = {};
    for (const key of ['path', 'resolvedPath']) if (typeof message.details[key] === 'string') details[key] = message.details[key];
    raw.details = details;
  }
  if (message.role === 'toolResult' || message.role === 'user' || message.role === 'custom' || message.role === 'hookMessage' || Array.isArray(raw.content) && raw.content.length > 0) raw.historyResourceDeferred = true;
  return raw;
}

function deferredMessage(message: NativeMessage): NativeMessage {
  const result: NativeMessage = { role: message.role, historyResourceDeferred: true, content: '' };
  for (const key of ['toolName', 'toolCallId', 'customType', 'display', 'attribution', 'timestamp', 'isError']) {
    const value = message[key];
    if (typeof value === 'string') result[key] = value.slice(0, 512);
    else if (typeof value === 'boolean' || typeof value === 'number') result[key] = value;
  }
  // Persistence matching requires the complete native tuple. Never truncate an
  // identity field into a different valid identity, or carry unbounded metadata.
  const identityKeys = ['provider', 'model', 'responseId', 'stopReason'] as const;
  if (identityKeys.every(key => message[key] === undefined || (typeof message[key] === 'string' && Buffer.byteLength(message[key]) <= 512))) {
    for (const key of identityKeys) if (typeof message[key] === 'string') result[key] = message[key];
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
    if (row.message.display === false || (['custom', 'hookMessage'].includes(String(row.message.role)) && row.message.display !== true)) return { role: String(row.message.role), customType: row.message.customType, attribution: row.message.attribution, display: false, content: '', timestamp: typeof row.message.timestamp === 'number' ? row.message.timestamp : Date.parse(entry.timestamp) };
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
    return { role: 'custom', customType: row.customType, content: row.display === true ? row.content : '', display: row.display === true, ...(row.display === true ? { details: row.details } : {}), ...(row.attribution === 'user' || row.attribution === 'agent' ? { attribution: row.attribution } : {}), timestamp };
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
  if (message.role === 'fileMention' && Array.isArray(message.files)) {
    for (const file of message.files) {
      const block = record(file) ? file.image : undefined;
      if (!record(block) || block.type !== 'image' || typeof block.data !== 'string' || seen.has(block)) continue;
      seen.add(block);
      images.push({ block, value: block.data, dataUrl: block.data.startsWith('data:') });
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

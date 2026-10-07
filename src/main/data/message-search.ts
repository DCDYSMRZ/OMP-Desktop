import { constants, type ReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, type Gunzip } from 'node:zlib';
import type { MessageSearchHit, MessageSearchResult, SearchCoverageReason, SessionSummary } from '../../shared/contracts';
import type { ExecutionContext } from '../omp/cli';
import { parseSessionPrefix } from './history';
import { isMissing, readSmallFile, record } from './io';
import { sourceRevision } from './history-source';
import { resolveHistoryRoots } from './roots';

export interface MessageSearchRequest { query: string; limit?: number; path?: string }
const DEFAULT_LIMITS = { timeMs: 1500, files: 1000, bytes: 8 * 1024 * 1024 };

/** Read-only, request-scoped scan. Paths outside discovery require an existing desktop grant.
 * Byte limits apply to decompressed content too; no transcript index or cache is persisted. */
export class MessageSearch {
  private active?: AbortController;
  constructor(
    private readonly context: () => Promise<ExecutionContext>,
    private readonly approvePath: (path: string) => Promise<string>,
    private readonly limits = DEFAULT_LIMITS,
  ) {}
  cancel(): void { this.active?.abort('Message search was replaced'); }

  async search(request: MessageSearchRequest): Promise<MessageSearchResult> {
    this.cancel();
    if (typeof request.query !== 'string' || request.query.length > 1024) throw new TypeError('Search query must be at most 1024 characters');
    if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) throw new TypeError('Search limit must be between 1 and 100');
    const controller = new AbortController();
    this.active = controller;
    const { signal } = controller;
    const result: MessageSearchResult = { results: [], truncated: false, diagnostics: [], coverage: { complete: true, reasons: [], scannedFiles: 0, candidateFiles: 0, includesToolContent: true, excludes: ['attachments', 'sidecars', 'thinking'] } };
    const tokens = [...new Set(request.query.trim().split(/\s+/u).filter(Boolean))];
    if (!tokens.length) { this.active = undefined; return result; }
    // RegExp indices refer to original UTF-16 text, including case folds that change length.
    const patterns = tokens.map(token => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'));
    const deadline = performance.now() + this.limits.timeMs;
    const stopped = () => {
      if (!signal.aborted && performance.now() >= deadline) controller.abort('Message search reached its time budget');
      return signal.aborted;
    };
    const diagnostic = (message: string, reason: SearchCoverageReason = 'unreadable') => {
      result.truncated = true; result.coverage.complete = false;
      if (!result.coverage.reasons.includes(reason)) result.coverage.reasons.push(reason);
      if (result.diagnostics.length < 20 && !result.diagnostics.includes(message)) result.diagnostics.push(message);
    };
    const partial = (message: string, reason: SearchCoverageReason) => diagnostic(message, reason);
    const limit = request.limit ?? 50;
    const scan = async () => {
      const candidates = new Set<string>();
      if (request.path !== undefined) candidates.add(await this.approvePath(request.path));
      else {
        const roots = await resolveHistoryRoots(await this.context());
        let visited = 0;
        const add = (path: string) => {
          if (candidates.size < this.limits.files) candidates.add(path);
          else partial('Message search reached its file limit; narrow the search to a session', 'file');
        };
        const directory = async (path: string, visit: (name: string, directory: boolean, file: boolean) => Promise<void>) => {
          if (stopped()) return;
          try {
            const entries = await opendir(path);
            for await (const entry of entries) {
              if (stopped()) break;
              if (++visited > this.limits.files * 3) { partial('Message search reached its directory limit', 'directory'); break; }
              await visit(entry.name, entry.isDirectory(), entry.isFile());
            }
          } catch (error) { if (!isMissing(error)) diagnostic(`${path}: ${String(error)}`); }
        };
        for (const root of [roots.sessions, roots.archives]) {
          await directory(root, async (name, folder, file) => {
            if (file && /\.jsonl(?:\.gz)?$/.test(name)) add(join(root, name));
            if (folder) await directory(join(root, name), async (child, _folder, file) => {
              if (file && /\.jsonl(?:\.gz)?$/.test(child)) add(join(root, name, child));
            });
          });
        }
        await directory(roots.registry, async (name, _folder, file) => {
          if (!file || stopped()) return;
          const marker = join(roots.registry, name);
          try {
            const path = (await readSmallFile(marker, 8192))?.trim();
            if (!path || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('Invalid external-session registration');
            add(path);
          } catch (error) { diagnostic(`${marker}: ${String(error)}`); }
        });
      }
      result.coverage.candidateFiles = candidates.size;
      const files: { path: string; revision: string; modified: number }[] = [];
      const identities = new Set<string>();
      for (const candidate of candidates) {
        if (stopped()) return;
        try {
          const path = await realpath(candidate);
          if (identities.has(path)) continue;
          identities.add(path);
          const info = await stat(path, { bigint: true });
          files.push({ path, revision: sourceRevision(info), modified: Number(info.mtimeMs) });
        } catch (error) { diagnostic(`${candidate}: ${String(error)}`); }
      }
      files.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
      for (const { path, revision, modified } of files) {
        if (stopped()) return;
        let file: FileHandle | undefined;
        let input: ReadStream | undefined;
        let unzip: Gunzip | undefined;
        const hits: MessageSearchHit[] = [];
        try {
          file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          if (stopped()) return;
          if (sourceRevision(await file.stat({ bigint: true })) !== revision) throw new Error('Session changed before reading');
          input = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal });
          const stream = path.endsWith('.gz') ? input.pipe(unzip = createGunzip({ chunkSize: 64 * 1024 })) : input;
          if (unzip) input.on('error', error => unzip?.destroy(error));
          const decoder = new StringDecoder('utf8');
          let pending = ''; let bytes = 0; let header = ''; let summary: SessionSummary | undefined;
          let sawUser = false;
          let legacy = false; let ordinal = 0;
          let malformed = false; let capped = false;
          const line = (text: string) => {
            if (stopped() || !text.trim()) return;
            let entry: unknown;
            try { entry = JSON.parse(text); } catch { malformed = true; return; }
            if (!summary) {
              header += `${text}\n`;
              if (record(entry) && entry.type === 'title' && header.length === text.length + 1) return;
              summary = parseSessionPrefix(header, path, new Date(modified).toISOString());
              if (record(entry) && entry.type === 'session') {
                if (entry.version !== undefined && ![1, 2, 3].includes(entry.version as number)) throw new Error('Unsupported session version');
                legacy = entry.version === undefined || entry.version === 1;
              }
              if (!summary) throw new Error('Session header is missing');
              return;
            }
            if (!record(entry)) return;
            ordinal++;
            if (entry.type !== 'message' || !record(entry.message)) return;
            if (!legacy && (typeof entry.id !== 'string' || !entry.id || entry.id.length > 512 || !(entry.parentId === null || typeof entry.parentId === 'string' && entry.parentId.length <= 512))) { malformed = true; return; }
            const message = entry.message;
            if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') return;
            if (!sawUser && message.role === 'user') {
              sawUser = true;
              summary = parseSessionPrefix(header + text + '\n', path, new Date(modified).toISOString())!;
            }
            const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
              ? message.content.filter(record).map(block => block.type === 'text' && typeof block.text === 'string' ? block.text : block.type === 'toolCall' ? `${String(block.name ?? '')}\n${JSON.stringify(block.arguments ?? {})}` : '').filter(Boolean).join('\n') : '';
            const searchable = message.role === 'toolResult' ? [content, typeof message.output === 'string' ? message.output : '', message.details === undefined ? '' : JSON.stringify(message.details)].filter(Boolean).join('\n') : content;
            const matches = patterns.map(pattern => pattern.exec(searchable));
            if (matches.some(match => !match)) return;
            const first = matches.reduce((a, b) => a!.index <= b!.index ? a : b)!;
            const start = Math.max(0, first.index - 60);
            const end = Math.min(searchable.length, first.index + first[0].length + 60);
            const prefix = start ? '…' : '';
            const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : message.timestamp;
            const entryId = legacy ? `legacy-${ordinal}-${createHash('sha256').update(text).digest('hex').slice(0, 24)}` : entry.id as string;
            hits.push({ path, title: summary.title, cwd: summary.cwd, entryId, role: message.role, position: ordinal,
              ...(message.role === 'toolResult' && typeof message.toolName === 'string' && message.toolName.trim() ? { toolName: message.toolName.trim() } : {}),
              snippet: prefix + searchable.slice(start, end) + (end < searchable.length ? '…' : ''),
              match: [prefix.length + first.index - start, prefix.length + first.index - start + first[0].length],
              ...(typeof timestamp === 'number' && Number.isFinite(timestamp) ? { timestamp } : {}),
            });
          };
          for await (const chunk of stream) {
            if (stopped()) return;
            const available = this.limits.bytes - bytes;
            const take = Math.min(chunk.length, available);
            bytes += take;
            pending += decoder.write(chunk.subarray(0, take));
            let offset = 0; let newline: number;
            while ((newline = pending.indexOf('\n', offset)) !== -1) {
              line(pending.slice(offset, newline));
              offset = newline + 1;
              if (stopped() || result.results.length + hits.length >= limit) break;
            }
            pending = pending.slice(offset);
            if (stopped()) return;
            if (result.results.length + hits.length >= limit) break;
            if (bytes >= this.limits.bytes) { capped = true; break; }
          }
          if (!capped && result.results.length + hits.length < limit) line(pending + decoder.end());
          if (stopped()) return;
          if (sourceRevision(await stat(path, { bigint: true })) !== revision) throw new Error('Session changed during search; search again');
          result.results.push(...hits);
          if (capped) partial(`${path}: Message search reached its per-file byte limit`, 'bytes');
          if (malformed) diagnostic(`${path}: Some malformed message records were skipped`, 'malformed');
          if (!capped && result.results.length < limit) result.coverage.scannedFiles++;
          if (result.results.length >= limit) { partial('Message search reached its result limit', 'results'); return; }
        } catch (error) { if (!signal.aborted) diagnostic(`${path}: ${String(error)}`); }
        finally { unzip?.destroy(); input?.destroy(); await file?.close(); }
      }
    };
    const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<void>();
    const abortListener = () => { partial(String(signal.reason), String(signal.reason).includes('time budget') ? 'time' : 'cancelled'); resolveAborted(); };
    signal.addEventListener('abort', abortListener, { once: true });
    const timer = setTimeout(() => controller.abort('Message search reached its time budget'), this.limits.timeMs);
    try {
      await Promise.race([scan(), aborted]);
      return { results: [...result.results], truncated: result.truncated, diagnostics: [...result.diagnostics], coverage: { ...result.coverage, reasons: [...result.coverage.reasons] } };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortListener);
      if (this.active === controller) this.active = undefined;
    }
  }
}

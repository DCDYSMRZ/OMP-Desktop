import { opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { HistoryListing, HistorySourceDiagnostic, SessionSummary } from '../../shared/contracts';
import type { ExecutionContext } from '../omp/cli';
import { isMissing, readSmallFile, record } from './io';
import { resolveHistoryRoots } from './roots';
import { HistorySource, lineage, sourceKind, sourceRevision } from './history-source';

const MAX_FILES = 10000;
const PREFIX_BYTES = 64 * 1024;

async function directoryEntries(path: string, visit: (name: string, directory: boolean, file: boolean) => Promise<void>, budget: { count: number }): Promise<void> {
  let directory;
  try { directory = await opendir(path); } catch (error) { if (isMissing(error)) return; throw error; }
  for await (const entry of directory) {
    if (++budget.count > MAX_FILES * 3) break;
    await visit(entry.name, entry.isDirectory(), entry.isFile());
  }
}

/** Prefix only: this is metadata search, never native transcript replay. */
export function parseSessionPrefix(text: string, path: string, updatedAt: string): SessionSummary | undefined {
  const lines = text.split('\n');
  if (!text.endsWith('\n')) {
    try { JSON.parse(lines[lines.length - 1]!); } catch { lines.pop(); }
  }
  if (!lines.length) return undefined;
  let title: string | undefined;
  let header: Record<string, unknown> | undefined;
  let preview = '';
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch {
      if (!header) throw new Error(`Invalid native session header: ${path}`);
      continue;
    }
    if (!record(entry)) { if (!header) throw new Error(`Invalid native session header: ${path}`); continue; }
    if (!header && index === 0 && entry.type === 'title') {
      if (typeof entry.title === 'string') title = entry.title;
      continue;
    }
    if (!header) {
      if (entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id || typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd)) throw new Error(`Invalid native session header/cwd: ${path}`);
      header = entry;
      if (!title && typeof entry.title === 'string') title = entry.title;
      continue;
    }
    if (entry.type === 'message' && record(entry.message) && entry.message.role === 'user') {
      const content = entry.message.content;
      if (typeof content === 'string') preview = content;
      else if (Array.isArray(content)) preview = content.filter(record).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ');
      preview = preview.replace(/\s+/g, ' ').trim().slice(0, 500);
      if (preview) break;
    }
  }
  if (!header) return undefined;
  const createdAt = typeof header.timestamp === 'string' && Number.isFinite(Date.parse(header.timestamp)) ? header.timestamp : undefined;
  const kind = sourceKind(path);
  const { artifactRoots: _roots, ...provenance } = lineage(header, path);
  return { id: header.id as string, path, cwd: header.cwd as string, ...provenance, sourceKind: kind, writable: kind === 'journal', canFork: true, title: title?.trim().slice(0, 500) || preview.slice(0, 100) || 'Untitled session', preview, updatedAt, ...(createdAt ? { createdAt } : {}) };
}

export class HistoryIndex {
  async list(context: ExecutionContext, options: { cwd?: string; query?: string } = {}): Promise<HistoryListing> {
    if (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 500)) throw new Error('History query must be at most 500 characters');
    if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !isAbsolute(options.cwd) || options.cwd.includes('\0'))) throw new Error('History workspace must be an absolute path');
    const roots = await resolveHistoryRoots(context);
    const candidates = new Set<string>();
    const registered = new Set<string>();
    const diagnostics: HistorySourceDiagnostic[] = [];
    const budget = { count: 0 };
    const add = (path: string) => {
      if (candidates.size < MAX_FILES) candidates.add(path);
      else if (!diagnostics.some(item => item.kind === 'limit')) diagnostics.push({ path: roots.sessions, kind: 'limit', message: 'History listing reached 10000 sources; narrow the native profile or open a source explicitly.' });
    };
    for (const root of [roots.sessions, roots.archives]) {
      await directoryEntries(root, async (bucket, directory, file) => {
        if (file && /\.jsonl(?:\.gz)?$/.test(bucket)) add(join(root, bucket));
        if (!directory) return;
        const path = join(root, bucket);
        try {
          await directoryEntries(path, async (name, _directory, file) => {
            if (file && /\.jsonl(?:\.gz)?$/.test(name)) add(join(path, name));
          }, budget);
        } catch (error) { diagnostics.push({ path, kind: 'unavailable', message: error instanceof Error ? error.message : String(error) }); }
      }, budget);
    }
    await directoryEntries(roots.registry, async (name, _directory, file) => {
      if (!file) return;
      const marker = join(roots.registry, name);
      try {
        const text = await readSmallFile(marker, 8192);
        if (text === undefined) return;
        const path = text.trim();
        if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('Invalid native external-session registration');
        const target = resolve(path);
        registered.add(target);
        add(target);
      } catch (error) { diagnostics.push({ path: marker, kind: 'malformed', message: error instanceof Error ? error.message : String(error) }); }
    }, budget);
    if (budget.count > MAX_FILES * 3) diagnostics.push({ path: roots.sessions, kind: 'limit', message: 'History listing reached 30000 directory entries; retained results are partial. Open a source explicitly or narrow the profile.' });
    const results: SessionSummary[] = [];
    const query = options.query?.trim().toLocaleLowerCase();
    const workspaceIdentities = new Map<string, string>();
    async function canonicalWorkspace(cwd: string): Promise<string> {
      const cached = workspaceIdentities.get(cwd);
      if (cached !== undefined) return cached;
      let identity = cwd;
      try {
        const canonical = await realpath(cwd);
        if ((await stat(canonical)).isDirectory()) {
          identity = canonical;
          workspaceIdentities.set(canonical, canonical);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Historical workspaces can be removed, inaccessible, or have broken links.
        // Keep their recorded identity and row; never infer cwd from the bucket.
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(code ?? '')) throw error;
      }
      workspaceIdentities.set(cwd, identity);
      return identity;
    }
    const workspaceFilter = options.cwd ? resolve(await canonicalWorkspace(options.cwd)) : undefined;
    const sessionIdentities = new Set<string>();
    // Sequential bounded reads avoid opening thousands of files or retaining transcript bytes.
    for (const candidate of candidates) {
      let path = candidate;
      let summary: SessionSummary | undefined;
      try {
        path = await realpath(candidate);
        if (sessionIdentities.has(path)) continue;
        sessionIdentities.add(path);
        const metadata = await stat(path, { bigint: true });
        const source = new HistorySource(path, sourceRevision(metadata));
        try {
          const bytes = await source.range(0, PREFIX_BYTES);
          summary = parseSessionPrefix(bytes.toString('utf8'), path, new Date(Number(metadata.mtimeMs)).toISOString());
          if (!summary) throw new Error('Native session header is missing or exceeds the 64 KiB preview window');
        } finally { source.close(); }
      } catch (error) {
        // Native gc-cli.ts:353–370 skips unmaterialized/deleted registry targets.
        // Existing malformed or inaccessible sources still produce diagnostics.
        if (registered.has(candidate) && isMissing(error)) continue;
        diagnostics.push({ path, kind: 'unavailable', message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const recordedCwd = summary.cwd;
      summary.cwd = await canonicalWorkspace(recordedCwd);
      if (workspaceFilter && resolve(summary.cwd) !== workspaceFilter) continue;
      if (query && ![summary.title, summary.preview, summary.cwd, recordedCwd, summary.id, summary.path].some(value => value.toLocaleLowerCase().includes(query))) continue;
      results.push(summary);
    }
    return { sessions: results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path)), diagnostics };
  }
}

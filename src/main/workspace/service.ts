import { constants } from 'node:fs';
import { open, opendir, realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Attachment, FileContent, FileEntry, FileSearchResult, PreparedPrompt, PromptInput, WorkspaceDiff } from '../../shared/contracts';

const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const ATTACHMENT_TOTAL = 32 * 1024 * 1024;
const ATTACHMENT_TTL = 30 * 60 * 1000;
const MAX_ATTACHMENTS = 24;
const MAX_ENTRIES = 10000;
const MAX_SEARCH_RESULTS = 500;
const IMAGE_EXTENSIONS: Record<string, true> = { '.png': true, '.jpg': true, '.jpeg': true, '.gif': true, '.webp': true };
const LANGUAGES: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json', md: 'markdown', css: 'css', html: 'html', py: 'python', rs: 'rust', sh: 'bash', yml: 'yaml', yaml: 'yaml', go: 'go' };
const executeFile = promisify(execFile);

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function validatePath(value: string): void {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid file path');
}
function mimeFor(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
function textFor(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (/[\x01-\x08\x0e-\x1f]/.test(text)) return undefined;
    return text;
  } catch { return undefined; }
}
interface Grant { attachment: Attachment; cwd: string; data: Buffer; text?: string; mimeType?: string }

/** Workspace reads never inherit picker/drop or explicit clipboard-image attachment grants. */
export class WorkspaceService {
  private readonly attachments = new Map<string, Grant>();
  constructor() { setInterval(() => this.prune(), 60_000).unref(); }

  private prune(): void {
    const now = Date.now();
    for (const [id, grant] of this.attachments) if (grant.attachment.expiresAt <= now) this.attachments.delete(id);
  }

  async resolvePath(cwd: string, requested: string): Promise<string> {
    validatePath(cwd); validatePath(requested);
    const root = await realpath(cwd);
    const candidate = path.resolve(root, requested);
    if (!path.isAbsolute(requested) && !contained(root, candidate)) throw new Error('File path is outside the workspace');
    const resolved = await realpath(candidate);
    if (!contained(root, resolved)) throw new Error('File path is outside the workspace or symbolic link escapes the workspace');
    return resolved;
  }

  private async readBounded(absolute: string, root?: string): Promise<{ data?: Buffer; size: number }> {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Only regular files can be read');
      const current = await realpath(absolute);
      if (current !== absolute || (root && !contained(root, current))) throw new Error('File location changed during access');
      const currentInfo = await stat(current);
      if (currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) throw new Error('File changed during access');
      if (info.size > IMAGE_LIMIT) return { size: info.size };
      // Read at most the original size plus one byte, even if another process grows the file.
      const data = Buffer.alloc(info.size + 1);
      let bytes = 0;
      while (bytes < data.length) {
        const result = await handle.read(data, bytes, data.length - bytes, bytes);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      if (bytes > info.size) throw new Error('File grew during access; refresh and try again');
      return { data: data.subarray(0, bytes), size: bytes };
    } finally { await handle.close(); }
  }

  async readFile(cwd: string, requested: string): Promise<FileContent> {
    const root = await realpath(cwd);
    const absolute = await this.resolvePath(root, requested);
    const { data, size } = await this.readBounded(absolute, root);
    const common = { path: path.relative(root, absolute), name: path.basename(absolute), size };
    if (!data) return { ...common, kind: 'tooLarge' };
    const mime = mimeFor(data);
    if (mime) return { ...common, kind: 'image', dataUrl: `data:${mime};base64,${data.toString('base64')}` };
    if (size > TEXT_LIMIT) return { ...common, kind: 'tooLarge' };
    const text = textFor(data);
    if (text === undefined || IMAGE_EXTENSIONS[path.extname(absolute).toLowerCase()]) return { ...common, kind: 'binary' };
    return { ...common, kind: 'text', content: text, language: LANGUAGES[path.extname(absolute).slice(1).toLowerCase()] };
  }

  async authorizeAttachments(cwd: string, paths: string[]): Promise<Attachment[]> {
    this.prune();
    const root = await realpath(cwd);
    if (!Array.isArray(paths) || paths.length + this.attachments.size > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} pending attachments are allowed`);
    const pending: Grant[] = [];
    let total = [...this.attachments.values()].reduce((sum, grant) => sum + grant.data.length, 0);
    for (const requested of paths) {
      validatePath(requested);
      if (!path.isAbsolute(requested)) throw new Error('Attachment picker must provide an absolute path');
      const absolute = await realpath(requested);
      const { data, size } = await this.readBounded(absolute);
      if (!data) throw new Error(`${path.basename(absolute)} exceeds the 10 MiB image limit`);
      const mimeType = mimeFor(data);
      if (!mimeType && size > TEXT_LIMIT) throw new Error(`${path.basename(absolute)} exceeds the 2 MiB text limit`);
      const text = mimeType ? undefined : textFor(data);
      if (!mimeType && (text === undefined || IMAGE_EXTENSIONS[path.extname(absolute).toLowerCase()])) throw new Error(`${path.basename(absolute)} is binary or an unsupported image; use UTF-8 text, PNG, JPEG, GIF or WebP`);
      total += size;
      if (total > ATTACHMENT_TOTAL) throw new Error('Pending attachments exceed the 32 MiB total limit');
      const attachment: Attachment = { id: randomUUID(), name: path.basename(absolute), path: absolute, source: 'disk', expiresAt: Date.now() + ATTACHMENT_TTL, size, kind: mimeType ? 'image' : 'text', ...(mimeType ? { previewUrl: `data:${mimeType};base64,${data.toString('base64')}` } : {}) };
      pending.push({ attachment, cwd: root, data, text, mimeType });
    }
    // Commit the whole picker selection only after every file is accepted.
    this.prune();
    const committedBytes = [...this.attachments.values()].reduce((sum, grant) => sum + grant.data.length, 0);
    if (this.attachments.size + pending.length > MAX_ATTACHMENTS || committedBytes + pending.reduce((sum, grant) => sum + grant.data.length, 0) > ATTACHMENT_TOTAL) throw new Error('Pending attachment limit reached; remove attachments before adding more');
    for (const grant of pending) this.attachments.set(grant.attachment.id, grant);
    return pending.map(grant => grant.attachment);
  }

  async addImageAttachment(cwd: string, input: { name: string; mimeType: string; data: Uint8Array }): Promise<Attachment> {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 255 || input.name.includes('\0')) throw new Error('Clipboard image must have a valid name');
    if (!(input.data instanceof Uint8Array) || !input.data.byteLength) throw new Error('Clipboard image must contain image bytes');
    if (input.data.byteLength > IMAGE_LIMIT) throw new Error('Clipboard image exceeds the 10 MiB image limit');
    const root = await realpath(cwd);
    this.prune();
    if (this.attachments.size >= MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} pending attachments are allowed`);
    const total = [...this.attachments.values()].reduce((sum, grant) => sum + grant.data.length, 0);
    if (total + input.data.byteLength > ATTACHMENT_TOTAL) throw new Error('Pending attachments exceed the 32 MiB total limit');
    // Own the accepted snapshot; neither a renderer buffer nor a disk path is a grant.
    const data = Buffer.from(input.data);
    const mimeType = mimeFor(data);
    if (!mimeType || mimeType !== input.mimeType) throw new Error('Clipboard image bytes must match PNG, JPEG, GIF or WebP MIME type');
    const attachment: Attachment = { id: randomUUID(), name: path.basename(input.name), source: 'clipboard', expiresAt: Date.now() + ATTACHMENT_TTL, size: data.length, kind: 'image', previewUrl: `data:${mimeType};base64,${data.toString('base64')}` };
    this.attachments.set(attachment.id, { attachment, cwd: root, data, mimeType });
    return attachment;
  }

  async removeAttachment(id: string): Promise<void> { this.attachments.delete(id); }

  async preparePrompt(cwd: string, input: PromptInput): Promise<PreparedPrompt> {
    this.prune();
    const root = await realpath(cwd);
    if (typeof input.text !== 'string') throw new Error('Prompt text must be a string');
    const ids = input.attachmentIds ?? [];
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) throw new Error('Invalid attachment IDs');
    const texts = [input.text];
    const images: NonNullable<PreparedPrompt['images']> = [];
    for (const id of ids) {
      const grant = this.attachments.get(id);
      if (!grant || grant.attachment.expiresAt <= Date.now() || grant.cwd !== root) throw new Error('Attachment expired, was removed, or belongs to another workspace; attach it again');
      if (grant.mimeType) images.push({ type: 'image', data: grant.data.toString('base64'), mimeType: grant.mimeType });
      else texts.push(`\nAttached UTF-8 file ${JSON.stringify(grant.attachment.name)} (${grant.data.length} bytes):\n${grant.text}`);
    }
    return { message: texts.join('\n'), ...(images.length ? { images } : {}) };
  }

  async listFiles(cwd: string, relativePath = ''): Promise<FileEntry[]> {
    const root = await realpath(cwd);
    const directory = await this.resolvePath(root, relativePath);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_ENTRIES) throw new Error(`Directory exceeds ${MAX_ENTRIES} entries`);
    const result: FileEntry[] = [];
    for (const entry of entries) {
      // Symlinks are intentionally omitted from the tree; direct reads still validate realpath.
      if (!entry.isFile() && !entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      const resolved = await this.resolvePath(root, candidate);
      const info = await stat(resolved);
      if (!info.isFile() && !info.isDirectory()) continue;
      result.push({ name: entry.name, path: path.relative(root, candidate), kind: info.isDirectory() ? 'directory' : 'file', size: info.size });
    }
    return result.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  }

  async searchFiles(cwd: string, query: string): Promise<FileSearchResult> {
    if (typeof query !== 'string' || query.length > 256 || query.includes('\0')) throw new Error('File search must be at most 256 characters without null bytes');
    const root = await realpath(cwd);
    const search = query.trim();
    const slash = search.lastIndexOf('/');
    const scope = slash < 0 ? '' : search.slice(0, slash + 1);
    const needle = search.slice(slash + 1).toLowerCase();
    const scopeRoot = path.resolve(root, scope);
    const results: FileSearchResult = { entries: [], truncated: false, diagnostics: [] };
    const queue = [scope];
    let visited = 0;
    let failures = 0;
    const incomplete = (message: string) => {
      results.truncated = true;
      if (results.diagnostics.length < 20) results.diagnostics.push(message);
      else failures++;
    };
    searchDirectories: for (let index = 0; index < queue.length; index++) {
      const relative = queue[index];
      try {
        const directory = await this.resolvePath(root, relative);
        // Stream directory entries: a single huge folder must not discard earlier matches.
        const entries = await opendir(directory);
        for await (const entry of entries) {
          if (++visited > MAX_ENTRIES) {
            incomplete('Search stopped after 10,000 entries. Use a folder prefix such as src/ to narrow the search.');
            break searchDirectories;
          }
          if (!entry.isFile() && !entry.isDirectory()) continue;
          const candidate = path.join(directory, entry.name);
          const entryPath = path.relative(root, candidate);
          if (entry.isDirectory()) {
            if (search && !['.git', 'node_modules', '.venv'].includes(entry.name)) queue.push(entryPath);
          } else if (path.relative(scopeRoot, candidate).toLowerCase().includes(needle)) {
            try {
              const resolved = await this.resolvePath(root, candidate);
              const info = await stat(resolved);
              if (!info.isFile()) continue;
              if (results.entries.length === MAX_SEARCH_RESULTS) {
                incomplete('More than 500 files match. Showing the first 500; narrow the search with a folder prefix or file name.');
                break searchDirectories;
              }
              results.entries.push({ name: entry.name, path: entryPath, kind: 'file', size: info.size });
            } catch (error) { incomplete(`Could not inspect ${entryPath}: ${error instanceof Error ? error.message : String(error)}`); }
          }
        }
      } catch (error) { incomplete(`Could not search ${relative || '.'}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (failures) results.diagnostics.push(`${failures} additional paths could not be inspected.`);
    if (!search) results.diagnostics.push('Showing workspace root files. Type a name to search descendants, or a folder prefix such as src/.');
    results.entries.sort((a, b) => a.path.localeCompare(b.path));
    return results;
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await executeFile('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
      return stdout;
    } catch (cause) {
      const error = cause as Error & { stderr?: string };
      throw new Error(error.stderr?.trim() || error.message);
    }
  }

  async gitDiff(cwd: string, requested?: string): Promise<WorkspaceDiff> {
    const root = await realpath(cwd);
    try {
      if ((await this.git(root, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return { available: false, reason: 'This directory is not a Git working tree', files: [] };
    } catch (error) {
      if (error instanceof Error && /not a git repository/i.test(error.message)) return { available: false, reason: 'This directory is not a Git repository', files: [] };
      throw error;
    }
    const filters: string[] = [];
    if (requested !== undefined) {
      validatePath(requested);
      const candidate = path.resolve(root, requested);
      if (!contained(root, candidate)) throw new Error('Diff path is outside the workspace');
      // Deleted tracked paths have no realpath. Validate the nearest surviving ancestor.
      let ancestor = candidate;
      while (true) {
        try { await this.resolvePath(root, ancestor); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) throw error;
          ancestor = parent;
        }
      }
      filters.push(path.relative(root, candidate));
    }
    const files: WorkspaceDiff['files'] = [];
    let patchBytes = 0;
    for (const staged of [false, true]) {
      const stage = staged ? ['--cached'] : [];
      const names = (await this.git(root, ['diff', ...stage, '--relative', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', '--', ...(filters.length ? filters : ['.'])])).split('\0');
      for (let index = 0; index + 1 < names.length; index += 2) {
        const status = names[index]; const name = names[index + 1];
        if (!status || !name) continue;
        if (files.length >= 200) throw new Error('More than 200 changed files; select an individual file');
        const patch = await this.git(root, ['diff', ...stage, '--relative', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--', name]);
        patchBytes += Buffer.byteLength(patch, 'utf8');
        if (patchBytes > 4 * 1024 * 1024) throw new Error('Combined Git diff exceeds 4 MiB; select an individual file');
        files.push({ path: name, status: `${staged ? 'staged' : 'unstaged'} ${status}`, patch });
      }
    }
    const untracked = (await this.git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...(filters.length ? filters : ['.'])])).split('\0').filter(Boolean);
    if (files.length + untracked.length > 200) throw new Error('More than 200 changed files; select an individual file');
    for (const name of untracked) files.push({ path: name, status: 'untracked ?', patch: 'Untracked file: not part of the Git index. Open the file to inspect its contents.' });
    return { available: true, files };
  }
}

import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseSessionPrefix } from './history';
import { HistorySource, SOURCE_CHUNK, sourceRevision } from './history-source';

export interface ForkSource { path: string; verify?(destinationPath: string): Promise<void>; cleanup?(): Promise<void> }
export interface ArchiveForkSource extends ForkSource { verify(destinationPath: string): Promise<void>; cleanup(): Promise<void> }
const BYTE_LIMIT = 512 * 1024 * 1024;
const FILE_LIMIT = 10000;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
interface Artifact { relative: string; info: BigIntStats; digest?: string }

function revision(info: BigIntStats): string { return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
async function canonicalLeaf(path: string): Promise<string> { return join(await realpath(dirname(path)), basename(path)); }
async function checked(path: string): Promise<BigIntStats> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error(`Archive fork path contains a symbolic link: ${path}`);
  if (!info.isDirectory() && !info.isFile()) throw new Error(`Unsupported archive fork file type: ${path}`);
  return info;
}
async function writeAll(output: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await output.write(bytes, offset, bytes.length - offset);
    if (!result.bytesWritten) throw new Error('Archive staging write made no progress');
    offset += result.bytesWritten;
  }
}
async function fingerprint(path: string, info: BigIntStats, buffer: Buffer, output?: FileHandle): Promise<string> {
  const file = await open(path, READ_FLAGS);
  try {
    if (sourceRevision(await file.stat({ bigint: true })) !== sourceRevision(info)) throw new Error(`Archive artifact changed before reading: ${path}`);
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < Number(info.size)) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, Number(info.size) - offset), offset);
      if (!result.bytesRead) throw new Error(`Archive artifact truncated while reading: ${path}`);
      const bytes = buffer.subarray(0, result.bytesRead);
      hash.update(bytes);
      if (output) await writeAll(output, bytes);
      offset += result.bytesRead;
    }
    if (revision(await file.stat({ bigint: true })) !== revision(info) || revision(await checked(path)) !== revision(info)) throw new Error(`Archive artifact changed while reading: ${path}`);
    return hash.digest('hex');
  } finally { await file.close(); }
}

/** Read-only readiness check, not a reservation or substitute for staging verification. */
export async function preflightArchiveFork(source: HistorySource, artifactRoot: string): Promise<void> {
  const sourcePath = await canonicalLeaf(source.path);
  if (source.path !== sourcePath) source = new HistorySource(sourcePath, source.revision);
  if (sourceRevision(await checked(source.path)) !== source.revision) throw new Error('Archive changed before fork preflight');
  let journalBytes = 0;
  for await (const chunk of source.chunks()) {
    journalBytes += chunk.length;
    if (journalBytes > BYTE_LIMIT) throw new Error('Archive fork exceeds the 512 MiB decompressed source staging limit');
  }
  artifactRoot = await canonicalLeaf(artifactRoot);
  let rootExists = true;
  try { if (!(await checked(artifactRoot)).isDirectory()) throw new Error('Archive artifact root must be a real directory'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') rootExists = false; else throw error; }
  const pending = rootExists ? [artifactRoot] : [];
  const observed: { path: string; revision: string }[] = [];
  let entries = pending.length;
  let bytes = 0;
  while (pending.length) {
    const path = pending.pop()!;
    const info = await checked(path);
    observed.push({ path, revision: revision(info) });
    if (info.isDirectory()) {
      for await (const entry of await opendir(path)) {
        if (++entries > FILE_LIMIT) throw new Error('Archive fork exceeds the 10000 artifact entry staging limit');
        pending.push(join(path, entry.name));
      }
    } else {
      bytes += Number(info.size);
      if (bytes > BYTE_LIMIT) throw new Error('Archive fork exceeds the 512 MiB artifact staging limit');
      const file = await open(path, READ_FLAGS);
      try { if (revision(await file.stat({ bigint: true })) !== revision(info)) throw new Error('Archive artifact changed during preflight'); }
      finally { await file.close(); }
    }
  }
  for (const item of observed) if (revision(await checked(item.path)) !== item.revision) throw new Error('Archive artifact changed during preflight');
  if (!rootExists) {
    try { await lstat(artifactRoot); throw new Error('Archive artifact root appeared during preflight'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await source.assert();
}

/**
 * Explicit-action only: a private source.jsonl plus sibling source/ is the native
 * --fork layout. The native process alone creates the durable session identity.
 * Bounds are independently 512 MiB for decompressed journal and artifacts, and
 * 10000 artifact entries. No persistent cache or native source writes occur.
 * Call verify after native initialization, before exposing the new runtime. On
 * failure the caller must close its new runtime and report its retained path;
 * cleanup only removes this helper's staging, never the durable destination.
 */
export async function stageArchiveFork(source: HistorySource, artifactRoot: string, sourceId: string): Promise<ArchiveForkSource> {
  if (!sourceId) throw new Error('Archive fork requires the validated native source identity');
  const sourcePath = await canonicalLeaf(source.path);
  if (sourceRevision(await checked(sourcePath)) !== source.revision) throw new Error('Archive changed before fork staging');
  if (source.path !== sourcePath) source = new HistorySource(sourcePath, source.revision);
  artifactRoot = await canonicalLeaf(artifactRoot);
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'omp-desktop-fork-'));
  const owner = await lstat(directory, { bigint: true });
  const path = join(directory, 'source.jsonl');
  const artifacts = join(directory, 'source');
  const manifest: Artifact[] = [];
  const buffer = Buffer.allocUnsafe(SOURCE_CHUNK);
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    let current: BigIntStats;
    try { current = await lstat(directory, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { cleaned = true; manifest.length = 0; return; } throw error; }
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error('Private archive fork staging was replaced; refusing to remove an unowned path');
    await rm(directory, { recursive: true, force: true });
    cleaned = true;
    manifest.length = 0;
  };
  try {
    const output = await open(path, 'wx', 0o600);
    try {
      let size = 0;
      for await (const chunk of source.chunks()) {
        size += chunk.length;
        if (size > BYTE_LIMIT) throw new Error('Archive fork exceeds the 512 MiB decompressed source staging limit');
        await writeAll(output, chunk);
      }
    } finally { await output.close(); }
    const stagedRevision = sourceRevision(await checked(path));
    let rootExists = true;
    try { if (!(await checked(artifactRoot)).isDirectory()) throw new Error('Archive artifact root must be a real directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') rootExists = false; else throw error; }
    let bytes = 0;
    let entries = rootExists ? 1 : 0;
    const pending = rootExists ? [''] : [];
    while (pending.length) {
      const relative = pending.pop()!;
      const original = join(artifactRoot, relative);
      const info = await checked(original);
      const destination = join(artifacts, relative);
      if (info.isDirectory()) {
        await mkdir(destination, { mode: 0o700 });
        manifest.push({ relative, info });
        // Close each directory before descending, so depth cannot exhaust handles.
        for await (const entry of await opendir(original)) {
          if (++entries > FILE_LIMIT) throw new Error('Archive fork exceeds the 10000 artifact entry staging limit');
          pending.push(join(relative, entry.name));
        }
      } else {
        bytes += Number(info.size);
        if (bytes > BYTE_LIMIT) throw new Error('Archive fork exceeds the 512 MiB artifact staging limit');
        const output = await open(destination, 'wx', 0o600);
        try {
          // .gz artifacts are opaque bytes; only HistorySource decompresses journals.
          const digest = await fingerprint(original, info, buffer, output);
          await output.chmod(Number(info.mode & 0o777n));
          manifest.push({ relative, info, digest });
        } finally { await output.close(); }
      }
    }
    const assertOriginals = async () => {
      if (sourceRevision(await checked(source.path)) !== source.revision) throw new Error('Archive changed during fork preparation or initialization');
      if (!rootExists) {
        try { await lstat(artifactRoot); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        throw new Error('Archive artifact root appeared during fork preparation or initialization');
      }
      for (const item of manifest) {
        if (revision(await checked(join(artifactRoot, item.relative))) !== revision(item.info)) throw new Error(`Archive artifact changed during fork preparation or initialization: ${item.relative || artifactRoot}`);
      }
    };
    await assertOriginals();
    return { path, cleanup, async verify(destinationPath) {
      if (cleaned) throw new Error('Archive fork staging has already been cleaned');
      await assertOriginals();
      if (sourceRevision(await checked(path)) !== stagedRevision) throw new Error('Private archive source changed during native initialization');
      if (!isAbsolute(destinationPath) || !destinationPath.endsWith('.jsonl')) throw new Error('Native fork did not return an absolute JSONL destination');
      const destination = await canonicalLeaf(destinationPath);
      if (destination === source.path || destination.startsWith(`${directory}${sep}`) || destination === directory || destination.startsWith(`${artifactRoot}${sep}`) || destination === artifactRoot) throw new Error('Native fork did not create a distinct durable destination');
      const destinationInfo = await checked(destination);
      const destinationSource = new HistorySource(destination, sourceRevision(destinationInfo));
      try {
        const prefix = await destinationSource.range(0, 64 * 1024);
        const session = parseSessionPrefix(prefix.toString('utf8'), destination, new Date(Number(destinationInfo.mtimeMs)).toISOString());
        if (!session || session.id === sourceId || session.parentSession !== sourceId) throw new Error('Native fork did not preserve the parent identity in a new durable session');
        const root = destination.slice(0, -6);
        const verified: { path: string; revision: string }[] = [];
        for (const item of manifest) {
          const target = join(root, item.relative);
          const info = await checked(target);
          if (item.info.isDirectory()) {
            if (!info.isDirectory()) throw new Error(`Native fork did not preserve archive artifact directory: ${item.relative}`);
          } else {
            if (!info.isFile() || info.size !== item.info.size || (info.dev === item.info.dev && info.ino === item.info.ino)) throw new Error(`Native fork did not preserve an independent archive artifact: ${item.relative}`);
            if ((info.mode & 0o777n) !== (item.info.mode & 0o777n) || await fingerprint(target, info, buffer) !== item.digest) throw new Error(`Native fork failed to preserve archive artifact: ${item.relative}`);
          }
          verified.push({ path: target, revision: revision(info) });
        }
        for (const item of verified) if (revision(await checked(item.path)) !== item.revision) throw new Error(`Native fork artifact changed during verification: ${item.path}`);
        await destinationSource.assert();
        await assertOriginals();
      } finally { destinationSource.close(); }
    } };
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Archive fork preparation and private staging cleanup failed'); }
    throw error;
  }
}

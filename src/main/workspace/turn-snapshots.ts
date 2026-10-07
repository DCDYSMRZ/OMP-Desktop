import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Dir } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import path from 'node:path';
import type { ChangeEndpointPair, ChangeFileEndpoint } from '../../shared/turn-change-types';

const MiB = 1024 * 1024;
export const TURN_SNAPSHOT_DEFAULTS = Object.freeze({
  deadlineMs: 30_000, maxEntries: 100_000, maxDepth: 64, maxHashBytes: Number.MAX_SAFE_INTEGER,
  maxTextBytes: 2 * MiB, chunkBytes: 64 * 1024, maxMetadataBytes: 32 * MiB, maxInFlightBytes: 8 * MiB,
  minBudgetBytes: 32 * MiB, maxBudgetBytes: 512 * MiB, reserveBytes: 256 * MiB,
  growthDelayMs: 5_000, growthRatio: 1.25,
});
export const TURN_SNAPSHOT_EXCLUDED_DIRECTORIES = Object.freeze([
  '.git', '.hg', '.svn', 'node_modules', '.pnpm', '.yarn', '__pycache__', '.venv',
  'venv', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.cache', 'target',
]);
export type SnapshotLimits = { -readonly [K in keyof typeof TURN_SNAPSHOT_DEFAULTS]: number };
export interface SnapshotMemorySample { totalBytes: number; availableBytes: number }
export interface SnapshotHostMemory {
  totalBytes: number; freeBytes: number; availableBytes?: number;
  electron?: { free?: number; available?: number; purgeable?: number };
}

/** Electron fields are KiB. Count only one quarter of explicitly purgeable memory,
 * never file-backed pages generally; explicit available=0 remains pressure. */
export function normalizeSnapshotMemory(input: SnapshotHostMemory): SnapshotMemorySample {
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
  const totalBytes = valid(input.totalBytes) ? input.totalBytes : 0;
  let availableBytes: number;
  if (valid(input.electron?.available)) availableBytes = input.electron.available * 1024;
  else if (valid(input.electron?.free)) {
    const purgeable = valid(input.electron?.purgeable) ? input.electron.purgeable : 0;
    availableBytes = (input.electron.free + purgeable / 4) * 1024;
  } else availableBytes = valid(input.availableBytes) ? input.availableBytes : valid(input.freeBytes) ? input.freeBytes : 0;
  return { totalBytes, availableBytes: Math.min(totalBytes, availableBytes) };
}
export interface TurnSnapshotStoreOptions {
  memorySample?: () => SnapshotMemorySample;
  clock?: () => number;
  limits?: Partial<SnapshotLimits>;
  excludedDirectories?: readonly string[];
}
export interface WorkspaceSnapshot {
  readonly id: string; readonly root: string; readonly startedAt: number;
  completedAt: number; complete: boolean; excluded: string[]; reasons: string[];
}
interface Content { text: string; bytes: number }
interface RetainedResult { bytes: number; evict: () => void; owner: TurnSnapshotStore }
interface Manifest {
  snapshot: WorkspaceSnapshot; files: Map<string, ChangeFileEndpoint>;
  directories: Map<string, Set<string>>; content: Map<string, Content>;
  metadataBytes: number; released: boolean; pending: boolean;
}

// One pool across all stores/runtimes. Metadata is conservatively charged (UTF-16
// keys + container overhead); transient buffers and decoder copies are separate
// reservations. Pressure drops text, never an already-recorded hash.
const pool = { contentBytes: 0, metadataBytes: 0, inFlightBytes: 0,
  manifests: new Set<Manifest>(), stores: new Set<TurnSnapshotStore>(), results: new Set<RetainedResult>() };
function systemMemory(): SnapshotMemorySample {
  const host = process as typeof process & { availableMemory?: () => number; getSystemMemoryInfo?: () => { free?: number; available?: number; purgeable?: number } };
  return normalizeSnapshotMemory({ totalBytes: totalmem(), freeBytes: freemem(), availableBytes: host.availableMemory?.(), electron: host.getSystemMemoryInfo?.() });
}
function stable(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function cost(value: string): number { return 160 + value.length * 2; }

export class TurnSnapshotStore {
  private readonly limits: SnapshotLimits;
  private readonly sample: () => SnapshotMemorySample;
  private readonly clock: () => number;
  private readonly excluded: Set<string>;
  private readonly snapshots = new Map<string, Manifest>();
  private readonly active = new Set<() => void>();
  private budget = 0;
  private growthSince: number | undefined;
  private disposed = false;

  constructor(options: TurnSnapshotStoreOptions = {}) {
    this.limits = { ...TURN_SNAPSHOT_DEFAULTS, ...options.limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid snapshot limit: ${name}`);
    }
    this.limits.chunkBytes = Math.max(1, Math.floor(this.limits.chunkBytes));
    this.sample = options.memorySample ?? systemMemory;
    this.clock = options.clock ?? Date.now;
    this.excluded = new Set(options.excludedDirectories ?? TURN_SNAPSHOT_EXCLUDED_DIRECTORIES);
    pool.stores.add(this);
    this.refresh(true);
  }

  private refresh(initial = false): number {
    const sample = this.sample();
    const hardware = Math.min(this.limits.maxBudgetBytes, Math.max(this.limits.minBudgetBytes, sample.totalBytes / 64));
    const target = Math.max(0, Math.min(hardware, (sample.availableBytes - this.limits.reserveBytes) / 4));
    const now = this.clock();
    if (initial || target < this.budget) { this.budget = target; this.growthSince = undefined; }
    else if (target >= this.budget * this.limits.growthRatio && target > this.budget) {
      this.growthSince ??= now;
      if (now - this.growthSince >= this.limits.growthDelayMs) { this.budget = target; this.growthSince = undefined; }
    } else this.growthSince = undefined;
    const budget = this.globalBudget();
    this.evict(Math.max(0, budget - pool.metadataBytes - pool.inFlightBytes));
    return budget;
  }

  private globalBudget(): number {
    return Math.min(...Array.from(pool.stores, store => store.budget));
  }

  private evict(target: number): void {
    for (const manifest of pool.manifests) {
      for (const [key, content] of manifest.content) {
        if (pool.contentBytes <= target) return;
        manifest.content.delete(key); pool.contentBytes -= content.bytes;
      }
    }
    for (const result of pool.results) {
      if (pool.contentBytes <= target) return;
      pool.results.delete(result); pool.contentBytes -= result.bytes; result.evict();
    }
  }

  private metadata(manifest: Manifest, bytes: number): boolean {
    const cap = Math.min(...Array.from(pool.stores, store => store.limits.maxMetadataBytes));
    this.refresh();
    if (pool.metadataBytes + bytes > cap) return false;
    this.evict(Math.max(0, this.globalBudget() - pool.metadataBytes - pool.inFlightBytes - bytes));
    if (manifest.released) return false;
    pool.metadataBytes += bytes; manifest.metadataBytes += bytes;
    return true;
  }

  private reserve(bytes: number, essential = false): boolean {
    const budget = this.refresh();
    this.evict(Math.max(0, budget - pool.metadataBytes - pool.inFlightBytes - bytes));
    const cap = Math.min(...Array.from(pool.stores, store => store.limits.maxInFlightBytes));
    if (pool.inFlightBytes + bytes > cap || (!essential && pool.metadataBytes + pool.inFlightBytes + bytes > budget)) return false;
    pool.inFlightBytes += bytes; return true;
  }

  /** Reserve a final cache entry; eviction must synchronously drop its references. */
  retainResult(bytes: number, onEvict: () => void): (() => void) | undefined {
    if (this.disposed || !Number.isFinite(bytes) || bytes < 0) return undefined;
    const budget = this.refresh();
    this.evict(Math.max(0, budget - pool.metadataBytes - pool.inFlightBytes - bytes));
    if (pool.contentBytes + pool.metadataBytes + pool.inFlightBytes + bytes > budget) return undefined;
    const result: RetainedResult = { bytes, evict: onEvict, owner: this };
    pool.results.add(result); pool.contentBytes += bytes;
    return () => { if (pool.results.delete(result)) pool.contentBytes -= bytes; };
  }

  async capture(cwd: string, options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<WorkspaceSnapshot> {
    if (this.disposed) throw new Error('Snapshot store is disposed');
    const startedAt = this.clock();
    const snapshot: WorkspaceSnapshot = { id: randomUUID(), root: path.resolve(cwd), startedAt,
      completedAt: startedAt, complete: false, excluded: [], reasons: [] };
    const manifest: Manifest = { snapshot, files: new Map(), directories: new Map(), content: new Map(), metadataBytes: 0, released: false, pending: true };
    this.snapshots.set(snapshot.id, manifest); pool.manifests.add(manifest);
    let stopped = false;
    let entries = 0;
    let hashBytes = 0;
    let finish!: () => void;
    const interrupted = new Promise<void>(resolve => { finish = resolve; });
    const reason = (message: string) => {
      if (stopped || snapshot.reasons.includes(message)) return;
      // Diagnostics are bounded independently, even after the metadata cap.
      if (snapshot.reasons.length < 32) snapshot.reasons.push(message.slice(0, 240));
    };
    const stop = (message: string) => { reason(message); stopped = true; finish(); };
    const onAbort = () => stop('Capture cancelled');
    const onDispose = () => stop('Snapshot store disposed');
    this.active.add(onDispose);
    const duration = Math.max(0, Math.min(options.deadlineMs ?? this.limits.deadlineMs, 60_000));
    const timer = setTimeout(() => stop('Capture deadline reached'), duration);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const alive = () => !stopped && !manifest.released && !this.disposed;
    const charge = (bytes: number) => {
      if (!alive()) return false;
      if (this.metadata(manifest, bytes)) return true;
      stop('Manifest metadata limit reached'); return false;
    };
    const excludedPath = (file: string, why?: string) => {
      if (charge(cost(file))) snapshot.excluded.push(file);
      if (why) reason(why);
    };

    const readFile = async (file: string, initial: BigIntStats, ancestors: readonly [string, BigIntStats][]) => {
      let handle: FileHandle | undefined;
      let scratchBytes = 0;
      let textReservation = 0;
      // A known existing path remains known even if its bytes are unavailable.
      const endpoint: ChangeFileEndpoint = { exists: true, size: Number(initial.size), mode: Number(initial.mode) };
      manifest.files.set(file, endpoint);
      const validParents = async () => {
        for (const [directory, stat] of ancestors) {
          const current = await lstat(directory, { bigint: true });
          if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino) return false;
        }
        return await realpath(file) === file;
      };
      try {
        if (!await validParents() || !alive()) { reason(`Unsafe file path: ${file}`); return; }
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || !stable(initial, opened) || !await validParents() || !alive()) {
          reason(`File changed before read: ${file}`); return;
        }
        scratchBytes = this.limits.chunkBytes;
        if (!this.reserve(scratchBytes, true)) { scratchBytes = 0; reason('Hash scratch memory limit reached'); return; }
        const buffer = Buffer.allocUnsafe(scratchBytes);
        const size = Number(opened.size);
        // Reserve raw bytes plus worst-case UTF-16 and decoding/join overlap.
        if (size <= this.limits.maxTextBytes && this.reserve(size * 5 + 128)) textReservation = size * 5 + 128;
        let raw: Buffer | undefined = textReservation ? Buffer.allocUnsafe(size) : undefined;
        const hash = createHash('sha256');
        let offset = 0;
        let binary = false;
        while (alive() && offset < size) {
          const length = Math.min(buffer.length, size - offset);
          if (hashBytes + length > this.limits.maxHashBytes) { reason('Hash byte limit reached'); return; }
          const { bytesRead } = await handle.read(buffer, 0, length, null);
          if (!alive()) return;
          if (bytesRead === 0) break;
          hashBytes += bytesRead;
          const bytes = buffer.subarray(0, bytesRead);
          hash.update(bytes); binary ||= bytes.includes(0);
          if (raw && offset + bytesRead <= raw.length && !binary) bytes.copy(raw, offset);
          else raw = undefined;
          offset += bytesRead;
          this.refresh();
        }
        if (!alive()) return;
        const final = await handle.stat({ bigint: true });
        const named = await lstat(file, { bigint: true });
        if (!stable(opened, final) || !stable(final, named) || offset !== size || !await validParents()) {
          reason(`File changed during read: ${file}`); return;
        }
        if (!alive()) return;
        endpoint.hash = hash.digest('hex'); endpoint.binary = binary;
        if (raw) {
          try {
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
            const bytes = text.length * 2 + 128;
            if (this.refresh() >= pool.metadataBytes + pool.inFlightBytes + pool.contentBytes + bytes) {
              manifest.content.set(file, { text, bytes }); pool.contentBytes += bytes;
            }
          } catch { endpoint.binary = true; }
        }
      } catch { reason(`File could not be read safely: ${file}`); }
      finally {
        // A deadline returns immediately, but reservations stay charged until an
        // outstanding OS read completes and its buffers really become unreachable.
        await handle?.close().catch(() => undefined);
        pool.inFlightBytes -= scratchBytes + textReservation;
      }
    };

    const walk = async (directory: string, depth: number, ancestors: readonly [string, BigIntStats][]): Promise<void> => {
      if (!alive()) return;
      if (depth > this.limits.maxDepth) { excludedPath(directory, 'Directory depth limit reached'); return; }
      let iterator: Dir | undefined;
      try {
        const initial = await lstat(directory, { bigint: true });
        if (!initial.isDirectory() || await realpath(directory) !== directory || !alive()) { reason(`Unsafe directory: ${directory}`); return; }
        if (!charge(cost(directory))) return;
        const names = new Set<string>();
        iterator = await opendir(directory, { bufferSize: 1 });
        if (!alive()) return;
        while (alive()) {
          const entry = await iterator.read();
          if (!alive()) return;
          if (!entry) break;
          if (++entries > this.limits.maxEntries) { stop('Directory entry limit reached'); return; }
          const file = path.join(directory, entry.name);
          if (!inside(snapshot.root, file) || !charge(cost(file) + cost(entry.name))) return;
          names.add(entry.name);
          const stat = await lstat(file, { bigint: true }).catch(() => undefined);
          if (!alive()) return;
          if (!stat) { reason(`Entry disappeared during scan: ${file}`); continue; }
          if (stat.isSymbolicLink()) { excludedPath(file); continue; }
          if (stat.isDirectory()) {
            if (this.excluded.has(entry.name)) { excludedPath(file); continue; }
            await walk(file, depth + 1, [...ancestors, [directory, initial]]);
          } else if (stat.isFile()) await readFile(file, stat, [...ancestors, [directory, initial]]);
          else excludedPath(file);
        }
        if (!alive()) return;
        const final = await lstat(directory, { bigint: true });
        if (stable(initial, final) && await realpath(directory) === directory && alive()) manifest.directories.set(directory, names);
        else reason(`Directory changed during scan: ${directory}`);
      } catch { reason(`Directory could not be scanned safely: ${directory}`); }
      finally { await iterator?.close().catch(() => undefined); }
    };

    const scan = (async () => {
      try {
        if (!charge(cost(snapshot.root) + 16_384)) return;
        const root = await realpath(snapshot.root);
        if (!alive()) return;
        // Canonical cwd is the sole authority; a symlink cwd is resolved once.
        Object.assign(snapshot, { root });
        await walk(root, 0, []);
      } catch { reason('Workspace root is unavailable'); }
      finally {
        manifest.pending = false;
        if (manifest.released) pool.metadataBytes -= manifest.metadataBytes;
      }
    })();
    await Promise.race([scan, interrupted]);
    clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); this.active.delete(onDispose);
    snapshot.completedAt = this.clock();
    snapshot.complete = !stopped && snapshot.reasons.length === 0;
    stopped = true;
    return snapshot;
  }

  pairs(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ChangeEndpointPair[] {
    this.refresh();
    const old = this.snapshots.get(before.id);
    const next = this.snapshots.get(after.id);
    if (!old || !next || old.released || next.released || before.root !== after.root) return [];
    const endpoint = (manifest: Manifest, file: string): ChangeFileEndpoint | undefined => {
      const value = manifest.files.get(file);
      if (value) return { ...value, ...(manifest.content.has(file) ? { text: manifest.content.get(file)!.text } : {}) };
      const relative = path.relative(manifest.snapshot.root, file);
      if (!inside(manifest.snapshot.root, file)) return undefined;
      let directory = manifest.snapshot.root;
      for (const name of relative.split(path.sep)) {
        const children = manifest.directories.get(directory);
        if (!children) return undefined;
        if (!children.has(name)) return { exists: false };
        directory = path.join(directory, name);
      }
      return undefined;
    };
    return Array.from(new Set([...old.files.keys(), ...next.files.keys()]), file => ({
      path: file, before: endpoint(old, file), after: endpoint(next, file),
    }));
  }

  releaseContent(snapshot: WorkspaceSnapshot): void {
    const manifest = this.snapshots.get(snapshot.id);
    if (!manifest) return;
    for (const content of manifest.content.values()) pool.contentBytes -= content.bytes;
    manifest.content.clear();
  }

  release(snapshot: WorkspaceSnapshot): void {
    const manifest = this.snapshots.get(snapshot.id);
    if (!manifest) return;
    manifest.released = true;
    this.releaseContent(snapshot);
    if (!manifest.pending) pool.metadataBytes -= manifest.metadataBytes;
    manifest.files.clear(); manifest.directories.clear();
    pool.manifests.delete(manifest); this.snapshots.delete(snapshot.id);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const cancel of this.active) cancel();
    this.disposed = true;
    for (const manifest of this.snapshots.values()) this.release(manifest.snapshot);
    for (const result of pool.results) {
      if (result.owner !== this) continue;
      pool.results.delete(result); pool.contentBytes -= result.bytes; result.evict();
    }
    pool.stores.delete(this);
  }

  usage(): { contentBytes: number; metadataBytes: number; budgetBytes: number } {
    const budgetBytes = this.refresh();
    // In-flight bytes are included in non-content usage, not double-counted.
    return { contentBytes: pool.contentBytes, metadataBytes: pool.metadataBytes + pool.inFlightBytes, budgetBytes };
  }
}

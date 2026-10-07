import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, existsSync, watch, type FSWatcher } from 'node:fs';
import { readdir, realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import type { ObservedActivity, PresenceEvent, SessionAccess } from '../../shared/contracts';

export const PRESENCE_TIMEOUT_MS = 300;
export const presenceRoot = () => join(process.env.HOME || homedir(), process.env.PI_CONFIG_DIR || process.env.OMP_CONFIG_DIR || '.omp', 'run/omp-desktop-presence/v1');
export const presenceFallbackDirectory = () => `/tmp/omp-presence-${process.getuid?.() ?? -1}`;
export interface PresenceSession { sessionFile: string | null; sessionId: string; cwd: string; state: 'idle' | 'running'; since: number; requestStartedAt?: number; currentTool?: ObservedActivity['currentTool'] }
export interface PresenceProcess { pid: number; processStartMs: number; socketPath: string; mode?: string; sessions?: PresenceSession[]; responsive: boolean }
export interface PresenceDiscovery { processes: PresenceProcess[]; complete: boolean }
type Row = Record<string, unknown>;

/** Each request has an absolute deadline, including peers that accept but never answer. */
export function presenceRequest(socketPath: string, request: Row, timeout = PRESENCE_TIMEOUT_MS): Promise<Row> {
  const { promise, resolve, reject } = Promise.withResolvers<Row>();
    const socket = createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('Presence response timed out')), timeout);
    const finish = (error?: Error, row?: Row) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(row!); };
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return finish(new Error('Presence response too large'));
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const row = JSON.parse(line) as Row; if (row.id === request.id) return row.ok === true ? finish(undefined, row) : finish(new Error('Presence request rejected')); } catch { return finish(new Error('Malformed presence response')); }
      }
    });
  return promise;
}

const discoveryInFlight = new Map<string, Promise<PresenceDiscovery>>();
/** All sessions in one observation event share one socket census; no stale result is cached. */
export function discoverPresence(root = presenceRoot()): Promise<PresenceDiscovery> {
  const existing = discoveryInFlight.get(root);
  if (existing) return existing;
  const pending = scanPresence(root).finally(() => discoveryInFlight.delete(root));
  discoveryInFlight.set(root, pending);
  return pending;
}
async function scanPresence(root: string): Promise<PresenceDiscovery> {
  let complete = true;
  const directories = [join(root, 'procs'), presenceFallbackDirectory()];
  const groups = await Promise.all(directories.map(async directory => {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) { complete = false; return []; }
      const names = await readdir(directory);
      return names.flatMap(name => {
        const match = /^(\d+)-(\d+)\.sock$/.exec(name);
        if (!match) return [];
        const pid = Number(match[1]);
        try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return []; }
        return [{ pid, processStartMs: Number(match[2]), socketPath: join(directory, name), responsive: false } as PresenceProcess];
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false; return []; }
  }));
  const candidates = groups.flat();
  const processes = await Promise.all(candidates.map(async candidate => {
    try {
      const [hello, status] = await Promise.all([presenceRequest(candidate.socketPath, { id: 1, type: 'hello' }), presenceRequest(candidate.socketPath, { id: 2, type: 'status' })]);
      if (hello.protocol !== 1 || hello.pid !== candidate.pid || hello.processStartMs !== candidate.processStartMs || !Array.isArray(status.sessions)) return candidate;
      return { ...candidate, responsive: true, mode: String(hello.mode), sessions: status.sessions as PresenceSession[] };
    } catch { return candidate; }
  }));
  const identities = new Map<string, PresenceProcess>();
  for (const proc of processes) {
    const key = `${proc.pid}:${proc.processStartMs}`;
    if (!identities.has(key) || proc.responsive) identities.set(key, proc);
  }
  return { processes: [...identities.values()], complete };
}

export type PresenceLock = 'free' | 'held' | 'unknown';
export async function probePresenceLock(path: string, root = presenceRoot()): Promise<PresenceLock> {
  if (process.platform !== 'darwin') return 'unknown';
  const canonical = await realpath(path).catch(() => path);
  const lock = join(root, 'sessions', createHash('sha256').update(canonical).digest('hex') + '.lock');
  try { const fd = openSync(lock, constants.O_RDWR | 0x20 | 0x4 | 0x01000000); closeSync(fd); return 'free'; }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === 'ENOENT' ? 'free' : code === 'EAGAIN' || code === 'EWOULDBLOCK' ? 'held' : 'unknown'; }
}
export async function presenceHolders(path: string, discovery: PresenceDiscovery): Promise<PresenceProcess[]> {
  const canonical = await realpath(path).catch(() => path);
  return discovery.processes.filter(proc => proc.sessions?.some(session => session.sessionFile === canonical));
}
export function presenceAccess(lock: PresenceLock, holders: PresenceProcess[], ownedPids: readonly number[], checkedAt = Date.now()): SessionAccess | undefined {
  if (lock === 'unknown') return { status: 'unknown', occupancySource: 'presence', confidence: 'exact', checkedAt, reason: 'Presence lock could not be inspected.' };
  if (lock === 'free') return;
  const owned = holders.length > 0 && holders.every(holder => ownedPids.includes(holder.pid));
  return { status: owned ? 'owned' : 'external', occupancySource: 'presence', confidence: 'exact', checkedAt, reason: owned ? undefined : holders.length ? 'Another omp process has this session open.' : 'A presence lock holder is not responding.' };
}

/** One selected session; reconnects and re-subscribes without ever treating silence as idle. */
export class PresenceSubscription {
  private socket?: Socket;
  private retry?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private stopped = false;
  constructor(private socketPath: string, private sessionFile: string, private receive: (event: PresenceEvent) => void, private unavailable: () => void, private retryMs = 500) { this.connect(); }
  close() { this.stopped = true; clearTimeout(this.retry); clearTimeout(this.deadline); this.socket?.destroy(); }
  private connect() {
    if (this.stopped) return;
    const socket = this.socket = createConnection(this.socketPath);
    let buffer = '', ready = false;
    this.deadline = setTimeout(() => socket.destroy(), PRESENCE_TIMEOUT_MS);
    socket.on('connect', () => socket.write(JSON.stringify({ id: 3, type: 'subscribe', sessionFile: this.sessionFile }) + '\n'));
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return socket.destroy();
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const row = JSON.parse(line);
          if (row.id === 3) { if (row.ok !== true) return socket.destroy(); ready = true; clearTimeout(this.deadline); }
          else if (ready && typeof row.event === 'string') this.receive(row as PresenceEvent);
        } catch { return socket.destroy(); }
      }
    });
    socket.on('close', () => {
      clearTimeout(this.deadline);
      if (this.stopped) return;
      this.unavailable(); this.retry = setTimeout(() => this.connect(), this.retryMs); this.retry.unref();
    });
  }
}

export async function getPresenceProcessCounts(): Promise<{ participating: number; nonParticipating: number }> {
  const discovery = await discoverPresence();
  const pids = new Set(discovery.processes.map(proc => proc.pid));
  const pending = Promise.withResolvers<string>();
  execFile('/bin/ps', ['-A', '-ww', '-o', 'uid=,pid=,comm=,args='], { timeout: 1000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? pending.reject(error) : pending.resolve(stdout));
  const output = await pending.promise;
  let nonParticipating = 0;
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) !== process.getuid?.() || pids.has(Number(match[2]))) continue;
    if (/(?:^|\/)(?:omp|pi)$/.test(match[3]) || /^(?:\S*\/)?(?:bun|node|nodejs)$/.test(match[3]) && /(?:^|\s)\S*(?:\/omp|coding-agent\/(?:src\/cli\.ts|dist\/cli\.js))(?:\s|$)/.test(match[4])) nonParticipating++;
  }
  return { participating: pids.size, nonParticipating };
}

/** Filesystem hints cover peer creation, lock creation and peer shutdown. */
export function watchPresenceChanges(changed: () => void, directories: readonly string[] = [presenceRoot(), presenceFallbackDirectory()]): () => void {
  const watchers: FSWatcher[] = [];
  let pending: NodeJS.Timeout | undefined;
  const notify = () => { clearTimeout(pending); pending = setTimeout(changed, 40); };
  for (const directory of directories) {
    // The selected journal can precede the first native process. Watch an
    // existing ancestor so creation/replacement of the presence root is seen.
    let ancestor = dirname(directory);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    try {
      const watcher = watch(ancestor, { recursive: true }, (_event, filename) => {
        const path = filename ? resolve(ancestor, String(filename)) : undefined;
        if (!path || path === directory || path.startsWith(directory + sep) || directory.startsWith(path + sep)) notify();
      });
      watcher.on('error', notify); watchers.push(watcher);
    } catch { /* Focus refresh remains available if the ancestor cannot be watched. */ }
  }
  return () => { clearTimeout(pending); for (const watcher of watchers) watcher.close(); };
}

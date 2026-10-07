import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { SessionAccess } from '../../shared/contracts';
import { relevantLsofDiagnostics } from './lsof-diagnostics';
import { discoverPresence, probePresenceLock, presenceHolders, presenceAccess, type PresenceDiscovery, type PresenceLock } from './presence';

export interface OccupancyOptions {
  terminalDirectory: string;
  executable: string;
  ownedPids: readonly number[];
  ownedSessionPaths: readonly string[];
  /** Backend-validated new/fork identities, revoked when the native session changes. */
  allocatedSessionPaths?: readonly string[];
  desktopPid?: number;
  ownedFacts?(): readonly { pid: number; sessionPath?: string; allocated?: boolean }[];
}

interface ProbeResult { code: number; stdout: string; stderr: string }
/** Internal deterministic probe seam; never exposed through IPC. File evidence is always read-only. */
export interface OccupancyProbe {
  platform: string;
  uid: number;
  now(): number;
  run(executable: string, args: string[], timeoutMs: number): Promise<ProbeResult>;
  presence?(path: string): Promise<{ lock: PresenceLock; discovery: PresenceDiscovery }>;
}

const PS_FIELDS = 'uid=,pid=,ppid=,pgid=,tty=,state=,lstart=,comm=';
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_CANDIDATES = 64;
const MAX_CRUMB = 16 * 1024;
const DEADLINE_MS = 5_000;

class Uncertain extends Error {}
function uncertain(reason: string): never { throw new Uncertain(reason); }

function capture(executable: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<ProbeResult>();
  // timeout/maxBuffer terminate only this probe child, never a discovered process.
  execFile(executable, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C' },
  }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== 'number')) {
      reject(new Uncertain('The process probe failed or exceeded its observation limit.'));
    } else resolveResult({ code: (error?.code as number | undefined) ?? 0, stdout, stderr });
  });
  return promise;
}

interface ProcessRow { uid: number; pid: number; parent: number; start: number; identity: string; command: string; state: string }
interface Descriptor { pid: number; fd: string; access?: string; type?: string; device?: string; inode?: string; name?: string }
interface FileIdentity { path: string; device: string; inode: string }
interface Breadcrumb { path: string; identity: string; modified: number }

function processes(result: ProbeResult): Map<number, ProcessRow> {
  if (result.code !== 0 || result.stderr.trim() || !result.stdout.trim()) uncertain('The process inventory was unavailable.');
  const rows = new Map<number, ProcessRow>();
  for (const line of result.stdout.trimEnd().split('\n')) {
    const match = /^\s*(-?\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) uncertain('The process inventory was incomplete.');
    const [, uid, pid, parent, group, tty, state, started, command] = match!;
    const start = Date.parse(started);
    if (!Number.isFinite(start) || rows.has(Number(pid))) uncertain('The process identity was ambiguous.');
    rows.set(Number(pid), { uid: Number(uid), pid: Number(pid), parent: Number(parent), start, state, command,
      identity: [uid, pid, parent, group, tty, started, command].join('\0') });
    if (rows.size > 16_384) uncertain('The process inventory exceeded its observation limit.');
  }
  return rows;
}

function descriptors(result: ProbeResult, observedPids?: Set<number>, target?: string): Descriptor[] {
  if ((target ? relevantLsofDiagnostics(result.stderr, target, !!observedPids) : result.stderr.trim()) || (result.code !== 0 && result.code !== 1)) uncertain('Open-file evidence was unavailable.');
  // lsof's clean exit 1 is only a no-match observation, never an idle verdict.
  if (!result.stdout) {
    if (result.code !== 1) uncertain('Open-file evidence was incomplete.');
    return [];
  }
  if ((result.code !== 0 && !observedPids) || !result.stdout.endsWith('\0\n')) uncertain('Open-file evidence was incomplete.');
  const files: Descriptor[] = [];
  let pid: number | undefined;
  let file: Descriptor | undefined;
  for (const raw of result.stdout.split('\0')) {
    const field = raw.replace(/^\n/, '');
    if (!field) continue;
    const value = field.slice(1);
    switch (field[0]) {
      case 'p':
        if (!/^[1-9]\d*$/.test(value)) uncertain('Open-file process identity was invalid.');
        pid = Number(value); observedPids?.add(pid); file = undefined; break;
      case 'u':
        if (!pid || !/^\d+$/.test(value)) uncertain('Open-file user identity was invalid.');
        break;
      case 'f':
        if (!pid || !value) uncertain('Open-file descriptor identity was invalid.');
        file = { pid: pid!, fd: value }; files.push(file); break;
      case 'a': case 't': case 'D': case 'i': case 'n': {
        if (!file) uncertain('Open-file evidence was malformed.');
        const key = { a: 'access', t: 'type', D: 'device', i: 'inode', n: 'name' }[field[0]] as 'access';
        if (file![key] !== undefined) uncertain('Open-file evidence contained duplicate fields.');
        file![key] = value; break;
      }
      default: uncertain('Open-file evidence contained unsupported fields.');
    }
  }
  return files;
}

async function identity(path: string): Promise<FileIdentity> {
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Native RPC sessions may not materialize their journal until the first prompt.
    return { path: join(await realpath(resolve(path, '..')), basename(path)), device: '', inode: '' };
  }
  const info = await stat(canonical, { bigint: true });
  if (!info.isFile()) uncertain('The selected session is not a regular file.');
  return { path: canonical, device: info.dev.toString(), inode: info.ino.toString() };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

function matchesFile(file: Descriptor, target: FileIdentity): boolean {
  if (!file.device || !file.inode) uncertain('A writable descriptor lacked file identity.');
  try { return BigInt(file.device!) === BigInt(target.device) && BigInt(file.inode!) === BigInt(target.inode); }
  catch { return uncertain('A writable descriptor had invalid file identity.'); }
}

async function breadcrumb(directory: string, tty: string): Promise<Breadcrumb | undefined> {
  let handle;
  try { handle = await open(join(directory, tty), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_CRUMB) uncertain('Terminal session evidence exceeded its observation limit.');
    const bytes = Buffer.alloc(MAX_CRUMB + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      uncertain('Terminal session evidence changed during observation.');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    const [cwd, session, ...extras] = text.split('\n');
    if (!cwd || !isAbsolute(cwd) || !session || !text.endsWith('\n') || text.includes('\0') ||
      extras.some(line => line !== '' && line !== 'fresh' && !/^cwdstat \d+ \d+$/.test(line))) {
      uncertain('Terminal session evidence was malformed.');
    }
    const path = resolve(cwd, session);
    let canonical: string;
    try { canonical = await realpath(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !extras.includes('fresh')) throw error;
      canonical = join(await realpath(resolve(path, '..')), basename(path));
    }
    return { path: canonical, modified: before.mtimeMs, identity: `${before.dev}:${before.ino}:${before.mtimeMs}:${before.ctimeMs}:${text}` };
  } finally { await handle.close(); }
}

async function sessionCwd(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    for (const line of bytes.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 2)) {
      const entry = JSON.parse(line);
      if (entry.type === 'session' && typeof entry.cwd === 'string' && isAbsolute(entry.cwd)) return await realpath(entry.cwd).catch(() => resolve(entry.cwd));
    }
  } catch { /* Missing metadata cannot exclude a candidate. */ }
  finally { await file?.close(); }
  return undefined;
}

function cwdBuckets(cwd: string): string[] {
  const encode = (value: string) => value.replace(/[/\\:]/g, '-');
  const buckets = [`--${encode(cwd.replace(/^[/\\]/, ''))}--`];
  for (const [root, prefix] of [[homedir(), '-'], [tmpdir(), '-tmp']] as const) {
    const value = relative(root, cwd);
    if (!value.startsWith('..') && !isAbsolute(value)) buckets.push(value ? `${prefix}${prefix.endsWith('-') ? '' : '-'}${encode(value)}` : prefix);
  }
  return buckets;
}

function nativeCandidate(row: ProcessRow, executable: string): boolean {
  const name = basename(row.command);
  return row.command === executable || name === basename(executable) || name === 'omp' || name === 'pi';
}

const legacyAccess = new Map<string, { expires: number; pending: Promise<SessionAccess> }>();

/**
 * Observational terminal/file guard, not an exclusive all-client lease. A healthy
 * headless client with no target evidence is not an identified terminal owner;
 * uncooperative clients can still open or switch to this file after inspection.
 */
export async function inspectSessionAccess(path: string, options: OccupancyOptions): Promise<SessionAccess> {
  const [lock, discovery] = await Promise.all([probePresenceLock(path), discoverPresence()]);
  const exact = presenceAccess(lock, await presenceHolders(path, discovery), options.ownedPids);
  if (exact && (lock !== 'held' || exact.status === 'owned' || !options.ownedSessionPaths.includes(path))) return exact;
  const key = JSON.stringify([path, options.executable, options.ownedPids]);
  const cached = legacyAccess.get(key);
  if (cached && cached.expires > Date.now()) return cached.pending;
  const pending = inspectSessionAccessWithProbe(path, options, { platform: process.platform, uid: process.getuid?.() ?? -1, now: Date.now, run: capture, presence: async () => ({ lock, discovery }) });
  legacyAccess.set(key, { expires: Date.now() + 10_000, pending });
  // Bound the cache independently of the number of journals browsed.
  if (legacyAccess.size > 64) legacyAccess.delete(legacyAccess.keys().next().value!);
  return pending;
}

/** @internal Keeps deterministic probe failures and identity races testable without launching native code. */
export async function inspectSessionAccessWithProbe(path: string, options: OccupancyOptions, probe: OccupancyProbe): Promise<SessionAccess> {
  const result = (status: SessionAccess['status'], reason?: string): SessionAccess => ({ status, reason, checkedAt: probe.now() });
  if (probe.platform !== 'darwin' || probe.uid < 0) return result('unknown', 'Session occupancy inspection is only supported on macOS.');
  const deadline = probe.now() + DEADLINE_MS;
  const run = async (executable: string, args: string[]): Promise<ProbeResult> => {
    const remaining = deadline - probe.now();
    if (remaining <= 0) uncertain('Session occupancy inspection timed out.');
    const observed = await probe.run(executable, args, Math.min(remaining, 2_000));
    if (Buffer.byteLength(observed.stdout) + Buffer.byteLength(observed.stderr) > MAX_OUTPUT) uncertain('The process probe exceeded its observation limit.');
    return observed;
  };
  try {
    if (!isAbsolute(path) || !isAbsolute(options.terminalDirectory) || !isAbsolute(options.executable)) uncertain('Session occupancy paths must be absolute.');
    const presence = await probe.presence?.(path);
    if (presence) {
      const holders = await presenceHolders(path, presence.discovery);
      const access = presenceAccess(presence.lock, holders, options.ownedPids, probe.now());
      if (presence.lock === 'unknown') return access!;
      if (presence.lock === 'held' && (holders.length > 0 || !options.ownedSessionPaths.includes(path) || presence.discovery.processes.some(proc => !proc.responsive && !options.ownedPids.includes(proc.pid)))) return access!;
      if (!presence.discovery.complete) return result('unknown', 'Presence discovery was unavailable.');
    }
    const participants = new Set(presence?.discovery.processes.map(proc => proc.pid));
    const [target, executable, first] = await Promise.all([
      identity(path), realpath(options.executable), run('/bin/ps', ['-A', '-ww', '-o', PS_FIELDS]).then(processes),
    ]);
    for (const participant of presence?.discovery.processes ?? []) {
      const row = first.get(participant.pid);
      if (!row || Math.abs(row.start - participant.processStartMs) > 2000) participants.delete(participant.pid);
    }
    // Open-file probes below are reserved for non-participating processes.
    const owned = new Set(options.ownedPids);
    let unresolved: string | undefined;
    const ambiguousWrappers = new Set<number>();
    for (const pid of owned) {
      const row = first.get(pid);
      if (!Number.isSafeInteger(pid) || !row || row.uid !== probe.uid || /Z|X/.test(row.state)) uncertain('A desktop child changed during occupancy inspection.');
    }
    const refreshOwnership = (snapshot: Map<number, ProcessRow>) => {
      owned.clear();
      const facts = options.ownedFacts?.();
      for (const pid of facts ? facts.map(fact => fact.pid) : options.ownedPids) {
        const row = snapshot.get(pid);
        if (row && row.uid === probe.uid && !/Z|X/.test(row.state) && (facts || row.identity === first.get(pid)?.identity)) owned.add(pid);
      }
      if (options.desktopPid === undefined) return;
      for (const row of snapshot.values()) {
        if (row.uid !== probe.uid || /Z|X/.test(row.state)) continue;
        let ancestor = row;
        for (let depth = 0; depth < snapshot.size; depth++) {
          if (ancestor.parent === options.desktopPid) { owned.add(row.pid); break; }
          const parent = snapshot.get(ancestor.parent);
          if (!parent || parent.uid !== probe.uid || parent.pid === ancestor.pid) break;
          ancestor = parent;
        }
      }
    };
    refreshOwnership(first);
    const presenceOwnedPaths = presence ? await Promise.all(options.ownedSessionPaths.map(ownedPath => realpath(ownedPath).catch(() => resolve(ownedPath)))) : [];
    const presenceOwnedTarget = owned.size > 0 && presenceOwnedPaths.includes(target.path);
    if (presence?.lock === 'held' && !presenceOwnedTarget) return { ...result('external', 'A presence lock holder is not responding.'), occupancySource: 'presence', confidence: 'exact' };
    // comm alone cannot identify an interpreted CLI. Read argv only for interpreters,
    // use it solely to identify the launcher, and discard it before returning.
    const wrapperCandidates = async (snapshot: Map<number, ProcessRow>): Promise<Set<number>> => {
      refreshOwnership(snapshot);
      const interpreters = [...snapshot.values()].filter(row => row.uid === probe.uid && !owned.has(row.pid) && !participants.has(row.pid) && !/Z|X/.test(row.state) && /^(?:bun|node|nodejs)$/.test(basename(row.command)));
      if (interpreters.length > MAX_CANDIDATES) uncertain('Too many interpreter processes to inspect safely.');
      const native = new Set<number>();
      if (!interpreters.length) return native;
      let args: ProbeResult = { code: 1, stdout: '', stderr: '' };
      for (let attempt = 0; attempt < 3; attempt++) {
        const remaining = interpreters.filter(row => snapshot.get(row.pid)?.identity === row.identity);
        if (!remaining.length) return native;
        args = await run('/bin/ps', ['-p', remaining.map(row => row.pid).join(','), '-ww', '-o', 'pid=,args=']);
        if (![0, 1].includes(args.code) || args.stderr.trim()) uncertain('Interpreter process identity was unavailable.');
        const found = new Set(args.stdout.trim().split('\n').map(line => Number(/^\s*(\d+)/.exec(line)?.[1])));
        const missing = remaining.filter(row => !found.has(row.pid));
        if (!missing.length) break;
        const current = processes(await run('/bin/ps', ['-A', '-ww', '-o', PS_FIELDS]));
        for (const row of missing) {
          if (current.get(row.pid)?.identity !== row.identity || /Z|X/.test(current.get(row.pid)?.state ?? 'X')) snapshot.delete(row.pid);
        }
        if (attempt === 2 && missing.some(row => snapshot.has(row.pid))) uncertain('A live interpreter lacked launch evidence.');
      }
      const expected = new Set(interpreters.filter(row => snapshot.has(row.pid)).map(row => row.pid));
      for (const line of args.stdout.trimEnd().split('\n').filter(line => line.trim())) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match || !expected.delete(Number(match[1]))) uncertain('Interpreter process identity was incomplete.');
        const pid = Number(match[1]);
        const invocation = match[2];
        const tokens = invocation.trim().split(/\s+/);
        const nativeEntry = (token: string): boolean => token === executable || token === options.executable || /^(?:omp|pi)$/.test(basename(token)) || /(?:^|\/)(?:coding-agent|@oh-my-pi\/pi-coding-agent)\/(?:src\/cli\.ts|dist\/cli\.js)$/.test(token);
        let index = 1;
        if (/^(?:bun|node|nodejs)$/.test(basename(tokens[0]))) {
          while (['--no-env-file', '--smol', '--watch', '--hot', '--no-warnings', '--enable-source-maps', '--experimental-strip-types'].includes(tokens[index])) index++;
          // Eval/print payloads are application data, not a native entry script.
          if (/^(?:--eval|--print)(?:=|$)|^-[ep]+$/.test(tokens[index] ?? '')) continue;
          if (tokens[index] === 'run') index++;
          const entry = tokens[index];
          if (entry && !entry.startsWith('-')) {
            if (nativeEntry(entry)) native.add(pid);
            // A definite non-native entry must not become a candidate merely because
            // its user arguments mention a native executable or a history path.
            else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry)) continue;
            else if (tokens.some(nativeEntry)) { native.add(pid); ambiguousWrappers.add(pid); }
            continue;
          }
        }
        if (tokens.some(nativeEntry) || /(?:coding-agent|@oh-my-pi\/pi-coding-agent)\/(?:src\/cli\.ts|dist\/cli\.js)/.test(invocation)) { native.add(pid); ambiguousWrappers.add(pid); }
      }
      if (expected.size) uncertain('A live interpreter lacked launch evidence.');
      return native;
    };
    const wrappers = await wrapperCandidates(first);
    let candidates = [...first.values()].filter(row => row.uid === probe.uid && (nativeCandidate(row, executable) || wrappers.has(row.pid)) && !owned.has(row.pid) && !participants.has(row.pid) && !/Z|X/.test(row.state));
    if (presence && !candidates.length) {
      return { ...result(presenceOwnedTarget ? 'owned' : 'idle'), occupancySource: 'presence', confidence: 'exact' };
    }
    const help = await run('/usr/sbin/lsof', ['-h']);
    const helpText = help.stdout + help.stderr;
    if ((help.code !== 0 && help.code !== 1) || !/lsof/i.test(helpText) || !/(?:usage|help|list open files)/i.test(helpText)) uncertain('The open-file probe capabilities were unavailable.');
    const lsofArgs = ['-nP', '-l', ...(/(?:^|\s)-D/.test(helpText) ? ['-Di'] : []), '-F0pufatDin'];
    if (candidates.length > MAX_CANDIDATES) uncertain('Too many native processes to inspect safely.');
    const exitedCandidates = new Set<number>();
    let candidateRecheck: Map<number, ProcessRow> | undefined;
    const candidateDescriptors = async (): Promise<Descriptor[]> => {
      let pending = candidates.filter(row => !exitedCandidates.has(row.pid));
      for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
        const observed = await run('/usr/sbin/lsof', [...lsofArgs, '-a', '-p', pending.map(row => row.pid).join(',')]);
        if (observed.stderr.trim()) {
          const current = processes(await run('/bin/ps', ['-A', '-ww', '-o', PS_FIELDS]));
          candidateRecheck = current;
          for (const row of pending) if (current.get(row.pid)?.identity !== row.identity || /Z|X/.test(current.get(row.pid)?.state ?? 'X')) exitedCandidates.add(row.pid);
          const live = pending.filter(row => !exitedCandidates.has(row.pid));
          if (live.length !== pending.length) { pending = live; continue; }
        }
        const observedPids = new Set<number>();
        const files = descriptors(observed, observedPids, target.path);
        const missing = pending.filter(row => !observedPids.has(row.pid));
        if (!missing.length) {
          if (observed.code !== 0) uncertain('Open-file evidence was incomplete.');
          return files;
        }
        const current = processes(await run('/bin/ps', ['-A', '-ww', '-o', PS_FIELDS]));
        candidateRecheck = current;
        for (const row of missing) {
          if (current.get(row.pid)?.identity !== row.identity || /Z|X/.test(current.get(row.pid)?.state ?? 'X')) exitedCandidates.add(row.pid);
        }
        pending = pending.filter(row => !exitedCandidates.has(row.pid));
        if (missing.every(row => exitedCandidates.has(row.pid)) || attempt === 2) return files;
      }
      return [];
    };
    const [targetFiles, candidateFiles, ownedPaths, allocatedPaths] = await Promise.all([
      target.inode ? run('/usr/sbin/lsof', [...lsofArgs, '--', target.path]).then(result => descriptors(result, undefined, target.path)) : Promise.resolve([] as Descriptor[]),
      candidateDescriptors(),
      Promise.all(options.ownedSessionPaths.map(async ownedPath => (await identity(ownedPath)).path)),
      Promise.all((options.allocatedSessionPaths ?? []).map(async allocatedPath => (await identity(allocatedPath)).path)),
    ]);
    candidates = candidates.filter(row => !exitedCandidates.has(row.pid));
    const allocated = owned.size > 0 && ownedPaths.includes(target.path) && allocatedPaths.includes(target.path);
    const targetCwd = await sessionCwd(target.path);
    const candidateCwds = new Map<number, string>();
    await Promise.all(candidateFiles.filter(file => file.fd === 'cwd' && file.type === 'DIR' && file.name).map(async file => {
      candidateCwds.set(file.pid, await realpath(file.name!).catch(() => resolve(file.name!)));
    }));
    const candidateIssues = new Map<number, string>();
    const targetHints = new Set<number>();
    const plausible = (pid: number): boolean => {
      if (targetHints.has(pid) || targetFiles.some(file => file.pid === pid)) return true;
      const cwd = candidateCwds.get(pid);
      // omp session-paths.ts:71–96 buckets normal sessions by cwd; main.ts:1152–1194
      // permits cross-cwd resume. Hence cwd only excludes *unattributed* candidates:
      // exact descriptors, launch targets and even stale target breadcrumbs override it.
      // Fresh breadcrumbs (session-paths.ts:308–335) remain authoritative below.
      if (!cwd || !targetCwd) return true;
      return cwd === targetCwd || cwdBuckets(cwd).includes(basename(dirname(target.path)));
    };
    const noteCandidate = (pid: number, reason: string) => { if (plausible(pid)) candidateIssues.set(pid, reason); };
    for (const pid of ambiguousWrappers) noteCandidate(pid, 'A relevant native interpreter uses an unsupported launch form.');
    const externalPids = new Set<number>();
    const relevant = new Set([...owned, ...candidates.map(row => row.pid)]);
    const provenWriters = new Set<number>();
    for (const file of targetFiles) {
      if (participants.has(file.pid)) continue;
      if (!/^\d+$/.test(file.fd)) continue;
      if (!file.type || !file.access || !['r', 'w', 'u'].includes(file.access)) uncertain('An open descriptor had incomplete access evidence.');
      if (file.type !== 'REG' || file.access === 'r') continue;
      if (!matchesFile(file, target)) uncertain('The session file changed during open-file inspection.');
      const row = first.get(file.pid);
      if (!row || /Z|X/.test(row.state)) uncertain('A session writer changed during occupancy inspection.');
      relevant.add(file.pid);
      if (!owned.has(file.pid)) externalPids.add(file.pid);
      provenWriters.add(file.pid);
    }
    const terminals = new Map<number, string>();
    const headless = new Map<number, Descriptor>();
    for (const row of candidates) {
      if (provenWriters.has(row.pid)) continue;
      const stdin = candidateFiles.filter(file => file.pid === row.pid && file.fd === '0');
      if (stdin.length === 1 && (['PIPE', 'FIFO', 'unix', 'IPv4', 'IPv6', 'REG'].includes(stdin[0].type ?? '') || (stdin[0].type === 'CHR' && stdin[0].name === '/dev/null'))) {
        headless.set(row.pid, stdin[0]);
        continue;
      }
      if (stdin.length !== 1 || stdin[0].type !== 'CHR' || !/^\/dev\/ttys[\w-]+$/.test(stdin[0].name ?? '')) {
        noteCandidate(row.pid, 'A native process has no resolvable terminal session association.');
        continue;
      }
      terminals.set(row.pid, basename(stdin[0].name!));
    }
    // Cross-cwd explicit resume is relevant even without a usable breadcrumb.
    const launchPids = new Set([...headless.keys(), ...terminals.keys()]);
    if (launchPids.size) {
      const args = await run('/bin/ps', ['-p', [...launchPids].join(','), '-ww', '-o', 'pid=,args=']);
      if (![0, 1].includes(args.code) || args.stderr.trim()) uncertain('Native process launch identity was unavailable.');
      const expected = new Set(launchPids);
      for (const line of args.stdout.trimEnd().split('\n').filter(line => line.trim())) {
        const row = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!row || !expected.delete(Number(row[1]))) uncertain('Native process launch identity was incomplete.');
        const pid = Number(row[1]);
        // Launch argv is deliberately one-way evidence: a matching explicit target
        // blocks conservatively, but a different path never proves current ownership.
        for (const flag of row[2].matchAll(/(?:^|\s)(?:--resume|--session|-r)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
          const value = flag[1] ?? flag[2] ?? flag[3];
          const cwd = candidateFiles.find(file => file.pid === pid && file.fd === 'cwd' && file.type === 'DIR')?.name;
          if (!isAbsolute(value) && (!cwd || (!value.includes('/') && !value.endsWith('.jsonl')))) continue;
          const candidate = isAbsolute(value) ? value : resolve(cwd!, value);
          if (candidate === target.path || candidate === path) targetHints.add(pid);
          else {
            try { if ((await identity(candidate)).path === target.path) targetHints.add(pid); }
            catch { /* An unrelated launch path is not current-session evidence. */ }
          }
        }
      }
      if (expected.size) {
        const current = processes(await run('/bin/ps', ['-A', '-ww', '-o', PS_FIELDS]));
        for (const pid of expected) {
          if (current.get(pid)?.identity !== first.get(pid)?.identity || /Z|X/.test(current.get(pid)?.state ?? 'X')) exitedCandidates.add(pid);
          else noteCandidate(pid, 'A live native process lacked launch evidence.');
        }
      }
      for (const pid of headless.keys()) if (targetHints.has(pid)) externalPids.add(pid);
    }
    const crumbs = new Map<string, { terminal: string; directory: string; crumb: Breadcrumb }>();
    for (const row of candidates) {
      if (provenWriters.has(row.pid)) continue;
      const terminal = terminals.get(row.pid);
      if (!terminal) continue;
      if ([...terminals.values()].filter(value => value === terminal).length !== 1) {
        noteCandidate(row.pid, 'Multiple native processes share a terminal.');
        continue;
      }
      // An observed native journal FD reveals another profile's adjacent state
      // directory without reading conversation bodies, configuration or environments.
      const directories = new Set([options.terminalDirectory]);
      for (const file of candidateFiles) {
        if (file.pid !== row.pid || !/^\d+$/.test(file.fd) || file.type !== 'REG' || !['w', 'u'].includes(file.access ?? '')) continue;
        const journal = /^(.*)\/sessions\/[^/]+\/[^/]+\.jsonl$/.exec(file.name ?? '');
        if (journal && isAbsolute(journal[1])) directories.add(join(journal[1], 'terminal-sessions'));
      }
      if (directories.size > 16) { noteCandidate(row.pid, 'A native process has too many possible session roots.'); continue; }
      const associations: { terminal: string; directory: string; crumb: Breadcrumb }[] = [];
      for (const directory of directories) {
        try {
          const crumb = await breadcrumb(directory, terminal);
          if (crumb?.path === target.path && crumb.modified < row.start) candidateIssues.set(row.pid, 'A native terminal has stale target session evidence.');
          // ps start times have one-second precision. Older crumbs cannot associate a new PID.
          if (crumb && crumb.modified >= row.start) associations.push({ terminal, directory, crumb });
        } catch { noteCandidate(row.pid, 'A native terminal has unavailable session evidence.'); }
      }
      if (!associations.length) {
        if (targetHints.has(row.pid)) externalPids.add(row.pid);
        else if (!allocated || candidateIssues.has(row.pid)) noteCandidate(row.pid, 'A native terminal has missing or stale session evidence.');
        continue;
      }
      if (new Set(associations.map(value => value.crumb.path)).size !== 1) {
        noteCandidate(row.pid, 'A native terminal has conflicting session associations.');
        continue;
      }
      for (const association of associations) crumbs.set(join(association.directory, terminal), association);
      if (associations[0].crumb.path === target.path) externalPids.add(row.pid);
    }
    candidateRecheck = undefined;
    const [observedLast, current, currentCrumbs, currentStdin] = await Promise.all([
      run('/bin/ps', ['-A', '-ww', '-o', PS_FIELDS]).then(processes), identity(path),
      Promise.all([...crumbs.values()].map(({ directory, terminal }) => breadcrumb(directory, terminal).catch(() => undefined))),
      candidateDescriptors(),
    ]);
    // Recovery observes identities after the parallel final inventory was started.
    const last = candidateRecheck ?? observedLast;
    for (const pid of exitedCandidates) {
      if (!provenWriters.has(pid)) externalPids.delete(pid);
    }
    for (const [pid, before] of headless) {
      if (exitedCandidates.has(pid)) continue;
      const stdin = currentStdin.filter(file => file.pid === pid && file.fd === '0');
      if (stdin.length !== 1 || stdin[0].type !== before.type || stdin[0].name !== before.name) {
        noteCandidate(pid, 'A native process changed input identity during occupancy inspection.');
        externalPids.delete(pid);
      }
    }
    for (const [pid, terminal] of terminals) {
      if (exitedCandidates.has(pid)) continue;
      const stdin = currentStdin.filter(file => file.pid === pid && file.fd === '0');
      if (stdin.length !== 1 || stdin[0].type !== 'CHR' || stdin[0].name !== `/dev/${terminal}`) {
        noteCandidate(pid, 'A native process changed terminals during occupancy inspection.');
        if (!provenWriters.has(pid)) externalPids.delete(pid);
      }
    }
    if (!sameFile(target, current)) uncertain('The session file changed during occupancy inspection.');
    const lastWrappers = await wrapperCandidates(last);
    const wrapperChanges = new Set([...wrappers, ...lastWrappers].filter(pid => wrappers.has(pid) !== lastWrappers.has(pid)));
    let changed = [...last.values()].filter(row => !owned.has(row.pid) && !participants.has(row.pid) && !/Z|X/.test(row.state) &&
      (relevant.has(row.pid) || row.uid === probe.uid && (nativeCandidate(row, executable) || lastWrappers.has(row.pid))) &&
      (first.get(row.pid)?.identity !== row.identity || wrapperChanges.has(row.pid)));
    if (changed.length > MAX_CANDIDATES) uncertain('Too many changed native processes to inspect safely.');
    const checkedChanges = new Set(changed.map(row => row.pid));
    // The final census is not a machine-wide veto. Read only cwd/stdin and exact
    // target descriptors for new/reused identities, then bind that evidence to a
    // surviving identity. A process that exits during these reads holds nothing.
    for (let attempt = 0; changed.length && attempt < 3; attempt++) {
      const pids = changed.map(row => row.pid).join(',');
      const [cwdResult, targetResult] = await Promise.all([
        run('/usr/sbin/lsof', [...lsofArgs, '-a', '-p', pids, '-d', 'cwd,0']),
        target.inode ? run('/usr/sbin/lsof', [...lsofArgs, '-a', '-p', pids, '--', target.path]) : Promise.resolve({ code: 1, stdout: '', stderr: '' }),
      ]);
      const stable = processes(await run('/bin/ps', ['-A', '-ww', '-o', PS_FIELDS]));
      refreshOwnership(stable);
      const alive = changed.filter(row => { const current = stable.get(row.pid); return current && !owned.has(row.pid) && !/Z|X/.test(current.state); });
      for (const row of changed) {
        externalPids.delete(row.pid); candidateIssues.delete(row.pid);
        if (!alive.some(current => current.pid === row.pid)) exitedCandidates.add(row.pid);
      }
      if (!alive.length) { changed = []; break; }
      if (alive.length !== changed.length && (cwdResult.stderr.trim() || targetResult.stderr.trim())) {
        changed = alive.map(row => stable.get(row.pid)!);
        continue;
      }
      const cwdFiles = descriptors(cwdResult, new Set<number>(), target.path);
      const exactFiles = descriptors(targetResult, undefined, target.path);
      const retry: ProcessRow[] = [];
      for (const row of alive) {
        const current = stable.get(row.pid)!;
        if (current.identity !== row.identity) { retry.push(current); continue; }
        const cwdName = cwdFiles.find(file => file.pid === row.pid && file.fd === 'cwd' && file.type === 'DIR')?.name;
        const cwd = cwdName ? await realpath(cwdName).catch(() => resolve(cwdName)) : undefined;
        const exact = exactFiles.filter(file => file.pid === row.pid && /^\d+$/.test(file.fd));
        let writer = false;
        for (const file of exact) {
          if (file.type !== 'REG' || !['r', 'w', 'u'].includes(file.access ?? '') || !matchesFile(file, target)) uncertain('Changed-process target evidence was incomplete.');
          if (file.access !== 'r') writer = true;
        }
        const stdin = cwdFiles.find(file => file.pid === row.pid && file.fd === '0' && file.type === 'CHR' && /^\/dev\/ttys[\w-]+$/.test(file.name ?? ''));
        let crumb: Breadcrumb | undefined;
        if (stdin) {
          try { crumb = await breadcrumb(options.terminalDirectory, basename(stdin.name!)); }
          catch { /* Missing attribution is uncertain only inside the target scope below. */ }
        }
        if (writer || crumb?.path === target.path && crumb.modified >= row.start) {
          externalPids.add(row.pid);
          if (writer) provenWriters.add(row.pid);
        } else if (exact.length || crumb?.path === target.path || !cwd || !targetCwd || cwd === targetCwd || cwdBuckets(cwd).includes(basename(dirname(target.path)))) {
          unresolved ??= 'A target-relevant process changed during occupancy inspection.';
        }
      }
      changed = retry;
    }
    if (changed.length) uncertain('A process identity could not be stabilized during occupancy inspection.');
    for (const pid of relevant) {
      const after = last.get(pid);
      if (!after || /Z|X/.test(after.state)) {
        if (owned.has(pid)) unresolved ??= 'A desktop child changed during occupancy inspection.';
        externalPids.delete(pid); candidateIssues.delete(pid); continue;
      }
      if (checkedChanges.has(pid)) continue;
      if (first.get(pid)?.identity !== after.identity) {
        if (owned.has(pid) || plausible(pid)) unresolved ??= 'A target-relevant process changed during occupancy inspection.';
        externalPids.delete(pid);
      }
    }
    for (const [index, { terminal, crumb }] of [...crumbs.values()].entries()) {
      const currentCrumb = currentCrumbs[index];
      if (crumb.identity === currentCrumb?.identity) continue;
      for (const [pid, tty] of terminals) {
        if (tty !== terminal || exitedCandidates.has(pid) || checkedChanges.has(pid)) continue;
        if (!provenWriters.has(pid)) externalPids.delete(pid);
        if (currentCrumb?.path === target.path && currentCrumb.modified >= (last.get(pid)?.start ?? Infinity)) externalPids.add(pid);
        else if (crumb.path === target.path || currentCrumb?.path === target.path || plausible(pid)) unresolved ??= 'A target-relevant terminal changed sessions during occupancy inspection.';
      }
    }
    if (probe.now() > deadline) uncertain('Session occupancy inspection timed out.');
    for (const [pid, reason] of candidateIssues) {
      if (!exitedCandidates.has(pid) && last.get(pid)?.identity === first.get(pid)?.identity) unresolved ??= reason;
    }
    refreshOwnership(last);
    const finalOwnedPaths = options.ownedFacts ? await Promise.all(options.ownedFacts().flatMap(fact => fact.sessionPath ? [identity(fact.sessionPath).then(file => file.path)] : [])) : ownedPaths;
    if (externalPids.size) return result('external', 'An external process holds this session or identifies it as a session target.');
    if (unresolved) return result('unknown', unresolved);
    if (finalOwnedPaths.includes(target.path)) {
      if (!owned.size) uncertain('The desktop session has no live owned child.');
      return result('owned');
    }
    return result('idle', 'No terminal owner or target-file writer was identified; this is not an exclusive lease.');
  } catch (error) {
    // Never expose raw process output, argv, filesystem paths or environment in UI errors.
    return result('unknown', error instanceof Uncertain ? error.message : 'Session occupancy could not be established from read-only process evidence.');
  }
}

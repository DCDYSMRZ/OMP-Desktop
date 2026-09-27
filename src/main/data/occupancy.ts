import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { SessionAccess } from '../../shared/contracts';

export interface OccupancyOptions {
  terminalDirectory: string;
  executable: string;
  ownedPids: readonly number[];
  ownedSessionPaths: readonly string[];
  /** Backend-validated new/fork identities, revoked when the native session changes. */
  allocatedSessionPaths?: readonly string[];
}

interface ProbeResult { code: number; stdout: string; stderr: string }
/** Internal deterministic probe seam; never exposed through IPC. File evidence is always read-only. */
export interface OccupancyProbe {
  platform: string;
  uid: number;
  now(): number;
  run(executable: string, args: string[], timeoutMs: number): Promise<ProbeResult>;
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

interface ProcessRow { uid: number; pid: number; start: number; identity: string; command: string; state: string }
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
    rows.set(Number(pid), { uid: Number(uid), pid: Number(pid), start, state, command,
      identity: [uid, pid, parent, group, tty, started, command].join('\0') });
    if (rows.size > 16_384) uncertain('The process inventory exceeded its observation limit.');
  }
  return rows;
}

function descriptors(result: ProbeResult): Descriptor[] {
  if (result.stderr.trim() || (result.code !== 0 && result.code !== 1)) uncertain('Open-file evidence was unavailable.');
  // lsof's clean exit 1 is only a no-match observation, never an idle verdict.
  if (!result.stdout) {
    if (result.code !== 1) uncertain('Open-file evidence was incomplete.');
    return [];
  }
  if (result.code !== 0 || !result.stdout.endsWith('\0\n')) uncertain('Open-file evidence was incomplete.');
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
        pid = Number(value); file = undefined; break;
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

function nativeCandidate(row: ProcessRow, executable: string): boolean {
  const name = basename(row.command);
  return row.command === executable || name === basename(executable) || name === 'omp' || name === 'pi';
}

/**
 * Observational terminal/file guard, not an exclusive all-client lease. A healthy
 * headless client with no target evidence is not an identified terminal owner;
 * uncooperative clients can still open or switch to this file after inspection.
 */
export async function inspectSessionAccess(path: string, options: OccupancyOptions): Promise<SessionAccess> {
  return inspectSessionAccessWithProbe(path, options, { platform: process.platform, uid: process.getuid?.() ?? -1, now: Date.now, run: capture });
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
    const [target, executable, first, help] = await Promise.all([
      identity(path), realpath(options.executable), run('/bin/ps', ['-A', '-ww', '-o', PS_FIELDS]).then(processes),
      run('/usr/sbin/lsof', ['-h']),
    ]);
    // HASDCACHE builds advertise -D in help. Never run a potentially cache-writing default.
    const helpText = help.stdout + help.stderr;
    if ((help.code !== 0 && help.code !== 1) || !/lsof/i.test(helpText) || !/(?:usage|help|list open files)/i.test(helpText)) uncertain('The open-file probe capabilities were unavailable.');
    const lsofArgs = ['-nP', '-l', ...( /(?:^|\s)-D/.test(helpText) ? ['-Di'] : []), '-F0pufatDin'];
    const owned = new Set(options.ownedPids);
    let unresolved: string | undefined;
    for (const pid of owned) {
      const row = first.get(pid);
      if (!Number.isSafeInteger(pid) || !row || row.uid !== probe.uid || /Z|X/.test(row.state)) uncertain('A desktop child changed during occupancy inspection.');
    }
    // comm alone cannot identify an interpreted CLI. Read argv only for interpreters,
    // use it solely to identify the launcher, and discard it before returning.
    const wrapperCandidates = async (snapshot: Map<number, ProcessRow>): Promise<Set<number>> => {
      const interpreters = [...snapshot.values()].filter(row => row.uid === probe.uid && !owned.has(row.pid) && !/Z|X/.test(row.state) && /^(?:bun|node|nodejs)$/.test(basename(row.command)));
      if (interpreters.length > MAX_CANDIDATES) uncertain('Too many interpreter processes to inspect safely.');
      const native = new Set<number>();
      if (!interpreters.length) return native;
      const args = await run('/bin/ps', ['-p', interpreters.map(row => row.pid).join(','), '-ww', '-o', 'pid=,args=']);
      if (args.code !== 0 || args.stderr.trim()) uncertain('Interpreter process identity was unavailable.');
      const expected = new Set(interpreters.map(row => row.pid));
      for (const line of args.stdout.trimEnd().split('\n')) {
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
            else if (tokens.some(nativeEntry)) unresolved ??= 'A relevant native interpreter uses an unsupported launch form.';
            continue;
          }
        }
        if (tokens.some(nativeEntry) || /(?:coding-agent|@oh-my-pi\/pi-coding-agent)\/(?:src\/cli\.ts|dist\/cli\.js)/.test(invocation)) unresolved ??= 'A relevant native interpreter uses an unsupported launch form.';
      }
      if (expected.size) uncertain('An interpreter changed during occupancy inspection.');
      return native;
    };
    const wrappers = await wrapperCandidates(first);
    const candidates = [...first.values()].filter(row => row.uid === probe.uid && (nativeCandidate(row, executable) || wrappers.has(row.pid)) && !owned.has(row.pid) && !/Z|X/.test(row.state));
    if (candidates.length > MAX_CANDIDATES) uncertain('Too many native processes to inspect safely.');
    const [targetFiles, candidateFiles, ownedPaths, allocatedPaths] = await Promise.all([
      target.inode ? run('/usr/sbin/lsof', [...lsofArgs, '--', target.path]).then(descriptors) : Promise.resolve([] as Descriptor[]),
      candidates.length ? run('/usr/sbin/lsof', [...lsofArgs, '-a', '-p', candidates.map(row => row.pid).join(',')]).then(descriptors) : Promise.resolve([] as Descriptor[]),
      Promise.all(options.ownedSessionPaths.map(async ownedPath => (await identity(ownedPath)).path)),
      Promise.all((options.allocatedSessionPaths ?? []).map(async allocatedPath => (await identity(allocatedPath)).path)),
    ]);
    const allocated = owned.size > 0 && ownedPaths.includes(target.path) && allocatedPaths.includes(target.path);
    const externalPids = new Set<number>();
    const relevant = new Set([...owned, ...candidates.map(row => row.pid)]);
    const provenWriters = new Set<number>();
    for (const file of targetFiles) {
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
        unresolved ??= 'A native process has no resolvable terminal session association.';
        continue;
      }
      terminals.set(row.pid, basename(stdin[0].name!));
    }
    // For independently allocated desktop identities, inspect terminal launch targets
    // too: a missing profile-local breadcrumb must not conceal an explicit competitor.
    const launchPids = new Set([...headless.keys(), ...(allocated ? terminals.keys() : [])]);
    if (launchPids.size) {
      const args = await run('/bin/ps', ['-p', [...launchPids].join(','), '-ww', '-o', 'pid=,args=']);
      if (args.code !== 0 || args.stderr.trim()) uncertain('Native process launch identity was unavailable.');
      const expected = new Set(launchPids);
      for (const line of args.stdout.trimEnd().split('\n')) {
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
          if (candidate === target.path || candidate === path) externalPids.add(pid);
          else {
            try { if ((await identity(candidate)).path === target.path) externalPids.add(pid); }
            catch { /* An unrelated launch path is not current-session evidence. */ }
          }
        }
      }
      if (expected.size) uncertain('A native process changed during occupancy inspection.');
    }
    const crumbs = new Map<string, { terminal: string; directory: string; crumb: Breadcrumb }>();
    for (const row of candidates) {
      if (provenWriters.has(row.pid)) continue;
      const terminal = terminals.get(row.pid);
      if (!terminal) continue;
      if ([...terminals.values()].filter(value => value === terminal).length !== 1) {
        unresolved ??= 'Multiple native processes share a terminal.';
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
      if (directories.size > 16) { unresolved ??= 'A native process has too many possible session roots.'; continue; }
      const associations: { terminal: string; directory: string; crumb: Breadcrumb }[] = [];
      for (const directory of directories) {
        try {
          const crumb = await breadcrumb(directory, terminal);
          // ps start times have one-second precision. Older crumbs cannot associate a new PID.
          if (crumb && crumb.modified >= row.start) associations.push({ terminal, directory, crumb });
        } catch { unresolved ??= 'A native terminal has unavailable session evidence.'; }
      }
      if (!associations.length) {
        // A terminal elsewhere is not an owner of an independently allocated
        // desktop session merely because this profile has no breadcrumb for it.
        // Resumed/existing sources still require the conservative association.
        if (!allocated) unresolved ??= 'A native terminal has missing or stale session evidence.';
        continue;
      }
      if (new Set(associations.map(value => value.crumb.path)).size !== 1) {
        unresolved ??= 'A native terminal has conflicting session associations.';
        continue;
      }
      for (const association of associations) crumbs.set(join(association.directory, terminal), association);
      if (associations[0].crumb.path === target.path) externalPids.add(row.pid);
    }
    const [last, current, currentCrumbs, currentStdin] = await Promise.all([
      run('/bin/ps', ['-A', '-ww', '-o', PS_FIELDS]).then(processes), identity(path),
      Promise.all([...crumbs.values()].map(({ directory, terminal }) => breadcrumb(directory, terminal))),
      candidates.length ? run('/usr/sbin/lsof', [...lsofArgs, '-a', '-p', candidates.map(row => row.pid).join(',')]).then(descriptors) : Promise.resolve([] as Descriptor[]),
    ]);
    for (const [pid, before] of headless) {
      const stdin = currentStdin.filter(file => file.pid === pid && file.fd === '0');
      if (stdin.length !== 1 || stdin[0].type !== before.type || stdin[0].name !== before.name) {
        unresolved ??= 'A native process changed input identity during occupancy inspection.';
        externalPids.delete(pid);
      }
    }
    for (const [pid, terminal] of terminals) {
      const stdin = currentStdin.filter(file => file.pid === pid && file.fd === '0');
      if (stdin.length !== 1 || stdin[0].type !== 'CHR' || stdin[0].name !== `/dev/${terminal}`) {
        unresolved ??= 'A native process changed terminals during occupancy inspection.';
        if (!provenWriters.has(pid)) externalPids.delete(pid);
      }
    }
    if (!sameFile(target, current)) uncertain('The session file changed during occupancy inspection.');
    const lastWrappers = await wrapperCandidates(last);
    if (wrappers.size !== lastWrappers.size || [...wrappers].some(pid => !lastWrappers.has(pid))) unresolved ??= 'A native interpreter changed during occupancy inspection.';
    for (const row of last.values()) {
      if (row.uid === probe.uid && (nativeCandidate(row, executable) || lastWrappers.has(row.pid)) && !/Z|X/.test(row.state)) relevant.add(row.pid);
    }
    for (const pid of relevant) {
      if (!first.has(pid) || first.get(pid)?.identity !== last.get(pid)?.identity || /Z|X/.test(last.get(pid)?.state ?? 'X')) {
        unresolved ??= 'A process changed during occupancy inspection.';
        externalPids.delete(pid);
      }
    }
    for (const [index, { terminal, crumb }] of [...crumbs.values()].entries()) {
      if (crumb.identity !== currentCrumbs[index]?.identity) {
        unresolved ??= 'A terminal changed sessions during occupancy inspection.';
        for (const [pid, tty] of terminals) if (tty === terminal && !provenWriters.has(pid)) externalPids.delete(pid);
      }
    }
    if (probe.now() > deadline) uncertain('Session occupancy inspection timed out.');
    if (externalPids.size) return result('external', 'An external process holds this session or identifies it as a session target.');
    if (unresolved) return result('unknown', unresolved);
    if (ownedPaths.includes(target.path)) {
      if (!owned.size) uncertain('The desktop session has no live owned child.');
      return result('owned');
    }
    return result('idle', 'No terminal owner or target-file writer was identified; this is not an exclusive lease.');
  } catch (error) {
    // Never expose raw process output, argv, filesystem paths or environment in UI errors.
    return result('unknown', error instanceof Uncertain ? error.message : 'Session occupancy could not be established from read-only process evidence.');
  }
}

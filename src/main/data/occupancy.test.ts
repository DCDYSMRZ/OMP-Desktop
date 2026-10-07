import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSessionAccessWithProbe, type OccupancyOptions, type OccupancyProbe } from './occupancy';

const empty = { code: 1, stdout: '', stderr: '' };
const processRow = (pid: number, command: string, start = 'Thu Jan  1 00:00:00 2026', parent = 1) => `501 ${pid} ${parent} ${pid} ttys001 S ${start} ${command}\n`;
const fields = (...values: string[]) => `${values.join('\0')}\0\n`;
const tty = (pid: number, name = '/dev/ttys001') => fields(`p${pid}`, 'u501', 'f0', 'ar', 'tCHR', `n${name}`);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omp-occupancy-'));
  const target = join(root, 'session.jsonl');
  const other = join(root, 'other.jsonl');
  const executable = join(root, 'omp');
  const terminalDirectory = join(root, 'terminals');
  await mkdir(terminalDirectory);
  await Promise.all([writeFile(target, '{}\n'), writeFile(other, '{}\n'), writeFile(executable, '')]);
  const options: OccupancyOptions = { terminalDirectory, executable, ownedPids: [], ownedSessionPaths: [] };
  let inventory = processRow(10, '/sbin/launchd');
  let nextInventory: string | undefined;
  let psCount = 0;
  let stdinCount = 0;
  let stdin = empty;
  let nextStdin: typeof empty | undefined;
  let files = empty;
  let failure: 'ps' | 'lsof' | 'timeout' | undefined;
  let interpreterArgs = '';
  let duringFileScan: (() => Promise<void>) | undefined;
  const probe: OccupancyProbe = {
    platform: 'darwin', uid: 501, now: () => Date.parse('2026-09-27T00:00:00Z'),
    async run(binary, args) {
      if (failure === 'timeout') throw new Error('private probe output must not escape');
      if (binary === '/bin/ps') {
        if (args.includes('pid=,args=')) {
          const selected = new Set(args[args.indexOf('-p') + 1].split(','));
          const overrides = new Map(interpreterArgs.split('\n').filter(Boolean).map(line => [line.trim().split(/\s+/)[0], line]));
          const launchers = inventory.trimEnd().split('\n').map(line => line.trim().split(/\s+/)).filter(columns => selected.has(columns[1])).map(columns => overrides.get(columns[1]) ?? `${columns[1]} ${columns.slice(11).join(' ')}`).join('\n');
          return { code: 0, stdout: `${launchers}\n`, stderr: '' };
        }
        if (failure === 'ps') return { code: 1, stdout: '', stderr: 'private ps output' };
        psCount++;
        return { code: 0, stdout: psCount > 1 ? nextInventory ?? inventory : inventory, stderr: '' };
      }
      if (args.includes('-h')) return { code: 0, stdout: '', stderr: 'lsof 4.99 usage: list open files' };
      if (failure === 'lsof') return { code: 1, stdout: '', stderr: 'permission denied' };
      if (args.includes('-p')) { stdinCount++; return stdinCount > 1 ? nextStdin ?? stdin : stdin; }
      await duringFileScan?.();
      return files;
    },
  };
  return { root, target, other, options, probe,
    close: () => rm(root, { recursive: true, force: true }),
    inspect: () => inspectSessionAccessWithProbe(target, options, probe),
    processes(value: string, next?: string) { inventory = processRow(10, '/sbin/launchd') + value; nextInventory = next === undefined ? undefined : processRow(10, '/sbin/launchd') + next; },
    stdin(value: string, next?: string) { stdin = { code: 0, stdout: value, stderr: '' }; nextStdin = next === undefined ? undefined : { code: 0, stdout: next, stderr: '' }; },
    files(value: string) { files = { code: 0, stdout: value, stderr: '' }; },
    fail(value: typeof failure) { failure = value; },
    interpreterArgs(value: string) { interpreterArgs = value; },
    duringFileScan(callback: () => Promise<void>) { duringFileScan = callback; },
    async crumb(path: string, terminal = 'ttys001', old = false) {
      const crumb = join(terminalDirectory, terminal);
      await writeFile(crumb, `${root}\n${path}\ncwdstat 1 2\n`);
      if (old) await utimes(crumb, new Date('2025-01-01'), new Date('2025-01-01'));
    },
    async writer(pid: number, access = 'w', inode?: string) {
      const info = await stat(target, { bigint: true });
      return fields(`p${pid}`, 'u501', 'f7', `a${access}`, 'tREG', `D0x${info.dev.toString(16)}`, `i${inode ?? info.ino}`, `n${target}`);
    },
  };
}

test('a live terminal remains external without an append descriptor', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(42, f.options.executable));
    f.stdin(tty(42));
    await f.crumb(f.target);
    assert.equal((await f.inspect()).status, 'external');
  } finally { await f.close(); }
});

test('stale breadcrumbs alone do not block after the native process exits', async () => {
  const f = await fixture();
  try { await f.crumb(f.target, 'ttys001', true); assert.equal((await f.inspect()).status, 'idle'); }
  finally { await f.close(); }
});

test('known other-session terminals are not confused with unresolved candidates', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(42, f.options.executable));
    f.stdin(tty(42));
    await f.crumb(f.other);
    assert.equal((await f.inspect()).status, 'idle');
  } finally { await f.close(); }
  const unresolved = await fixture();
  try {
    unresolved.processes(processRow(42, unresolved.options.executable));
    unresolved.stdin(tty(42));
    assert.equal((await unresolved.inspect()).status, 'unknown');
  } finally { await unresolved.close(); }
});

test('canonical terminal aliases block the same session after inode replacement', async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, 'alias.jsonl');
    await symlink(f.target, alias);
    f.processes(processRow(42, f.options.executable));
    f.stdin(tty(42));
    await f.crumb(alias);
    // No descriptor for the current inode is required for the terminal association.
    await rm(f.target);
    await writeFile(f.target, '{"replacement":true}\n');
    assert.equal((await f.inspect()).status, 'external');
  } finally { await f.close(); }
});

test('an exact writable descriptor blocks even a non-native writer; read-only descriptors do not', async () => {
  for (const access of ['r', 'w', 'u']) {
    const f = await fixture();
    try {
      f.processes(processRow(42, '/usr/bin/editor'));
      f.files(await f.writer(42, access));
      assert.equal((await f.inspect()).status, access === 'r' ? 'idle' : 'external');
    } finally { await f.close(); }
  }
});

test('a positively observed native writer needs no terminal breadcrumb', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(42, f.options.executable));
    f.files(await f.writer(42));
    assert.equal((await f.inspect()).status, 'external');
  } finally { await f.close(); }
});

test('owned canonical sessions exclude only exact live children, not descendants', async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, 'alias.jsonl');
    await symlink(f.target, alias);
    f.options.ownedPids = [42];
    f.options.ownedSessionPaths = [alias];
    f.processes(processRow(42, f.options.executable));
    f.files(await f.writer(42));
    assert.equal((await f.inspect()).status, 'owned');
  } finally { await f.close(); }
  const descendant = await fixture();
  try {
    descendant.options.ownedPids = [42];
    descendant.options.ownedSessionPaths = [await realpath(descendant.target)];
    descendant.processes(processRow(42, descendant.options.executable) + processRow(43, '/usr/bin/editor', undefined, 42));
    descendant.files(await descendant.writer(43));
    assert.equal((await descendant.inspect()).status, 'external');
  } finally { await descendant.close(); }
});

test('unresolved external natives override desktop ownership', async () => {
  const f = await fixture();
  try {
    f.options.ownedPids = [42];
    f.options.ownedSessionPaths = [f.target];
    f.processes(processRow(42, f.options.executable) + processRow(43, f.options.executable));
    assert.equal((await f.inspect()).status, 'unknown');
  } finally { await f.close(); }
});

test('PID reuse and native process arrival during a probe are unknown', async () => {
  for (const arrives of [false, true]) {
    const f = await fixture();
    try {
      const original = processRow(42, f.options.executable);
      f.processes(arrives ? '' : original, processRow(42, f.options.executable, 'Fri Jan  2 00:00:00 2026'));
      f.stdin(tty(42));
      await f.crumb(f.other);
      assert.equal((await f.inspect()).status, 'unknown');
    } finally { await f.close(); }
  }
});

test('partial candidate scans accept confirmed exits and preserve the surviving verdict', async () => {
  for (const scan of [1, 2]) {
    for (const verdict of ['idle', 'owned', 'external'] as const) {
      const f = await fixture();
      try {
        const survivor = processRow(42, f.options.executable);
        const owned = verdict === 'owned' ? processRow(44, f.options.executable) : '';
        if (owned) { f.options.ownedPids = [44]; f.options.ownedSessionPaths = [f.target]; }
        f.processes(survivor + owned);
        f.stdin(tty(42));
        await f.crumb(verdict === 'external' ? f.target : f.other);
        await f.crumb(f.other, 'ttys002');
        const baseline = await f.inspect();
        assert.equal(baseline.status, verdict);
        const original = survivor + owned + processRow(43, f.options.executable);
        const run = f.probe.run;
        let candidateScans = 0;
        let departed = false;
        f.probe.run = async (binary, args, timeout) => {
          if (binary === '/bin/ps' && args.includes('-A')) {
            return { code: 0, stdout: processRow(10, '/sbin/launchd') + (departed ? survivor + owned : original), stderr: '' };
          }
          if (binary === '/usr/sbin/lsof' && args.includes('-p')) {
            if (++candidateScans === scan) { departed = true; return { code: 1, stdout: tty(42), stderr: '' }; }
            return { code: 0, stdout: tty(42) + (departed ? '' : tty(43, '/dev/ttys002')), stderr: '' };
          }
          return run(binary, args, timeout);
        };
        assert.deepEqual(await f.inspect(), baseline, `${verdict}, scan ${scan}`);
      } finally { await f.close(); }
    }
  }
});

test('partial candidate scans require every absent identity to have exited', async () => {
  for (const replacement of ['same', 'other', 'native', 'one-still-alive'] as const) {
    const f = await fixture();
    try {
      const survivor = processRow(42, f.options.executable);
      const missing = processRow(43, f.options.executable);
      const extra = replacement === 'one-still-alive' ? processRow(44, f.options.executable) : '';
      const next = replacement === 'same' || replacement === 'one-still-alive' ? missing :
        processRow(43, replacement === 'native' ? f.options.executable : '/usr/bin/editor', 'Fri Jan  2 00:00:00 2026');
      f.processes(survivor + missing + extra, survivor + next);
      f.stdin(tty(42));
      await f.crumb(f.other);
      const run = f.probe.run;
      let scans = 0;
      f.probe.run = async (binary, args, timeout) => {
        const result = await run(binary, args, timeout);
        return binary === '/usr/sbin/lsof' && args.includes('-p') && ++scans === 1 ? { ...result, code: 1 } : result;
      };
      assert.equal((await f.inspect()).status, replacement === 'other' ? 'idle' : 'unknown', replacement);
    } finally { await f.close(); }
  }
});

test('a replacement native found by the final candidate recheck cannot be hidden by an earlier inventory', async () => {
  const f = await fixture();
  try {
    const original = processRow(42, f.options.executable) + processRow(43, f.options.executable);
    const replacement = processRow(42, f.options.executable) + processRow(43, f.options.executable, 'Fri Jan  2 00:00:00 2026');
    f.processes(original);
    f.stdin(tty(42) + tty(43, '/dev/ttys002'));
    await f.crumb(f.other);
    await f.crumb(f.other, 'ttys002');
    const run = f.probe.run;
    let scans = 0;
    f.probe.run = async (binary, args, timeout) => {
      if (binary === '/usr/sbin/lsof' && args.includes('-p') && ++scans === 2) {
        f.processes(replacement);
        return { code: 1, stdout: tty(42), stderr: '' };
      }
      return run(binary, args, timeout);
    };
    assert.equal((await f.inspect()).status, 'unknown');
  } finally { await f.close(); }
});

test('candidate exit recovery never relaxes malformed, diagnostic or target-path evidence', async () => {
  for (const failure of ['stderr', 'termination', 'field', 'all-present', 'target', 'inventory', 'deadline'] as const) {
    const f = await fixture();
    try {
      const survivor = processRow(42, f.options.executable);
      f.processes(survivor + processRow(43, f.options.executable), survivor);
      f.stdin(tty(42));
      await f.crumb(f.other);
      const run = f.probe.run;
      const now = f.probe.now();
      let scanned = false;
      f.probe.run = async (binary, args, timeout) => {
        if (failure === 'inventory' && scanned && binary === '/bin/ps' && args.includes('-A')) return empty;
        if (binary === '/usr/sbin/lsof' && args.includes(failure === 'target' ? '--' : '-p')) {
          scanned = true;
          if (failure === 'deadline') f.probe.now = () => now + 5_001;
          return { code: 1, stdout: failure === 'termination' ? tty(42).slice(0, -2) :
            failure === 'field' ? fields('p42', 'f0', 'xinvalid') :
            tty(42) + (failure === 'all-present' ? tty(43) : ''), stderr: failure === 'stderr' ? 'denied' : '' };
        }
        return run(binary, args, timeout);
      };
      assert.equal((await f.inspect()).status, 'unknown', failure);
    } finally { await f.close(); }
  }
});

test('shared terminals, stale reused crumbs and changed fd0 are ambiguous', async () => {
  for (const scenario of ['shared', 'stale', 'changed']) {
    const f = await fixture();
    try {
      f.processes(processRow(42, f.options.executable) + (scenario === 'shared' ? processRow(43, f.options.executable) : ''));
      f.stdin(tty(42) + (scenario === 'shared' ? tty(43) : ''), scenario === 'changed' ? tty(42, '/dev/ttys002') : undefined);
      await f.crumb(f.other, 'ttys001', scenario === 'stale');
      assert.equal((await f.inspect()).status, 'unknown', scenario);
    } finally { await f.close(); }
  }
});

test('partial evidence, probe errors and unsupported platforms fail closed without leaking output', async () => {
  for (const scenario of ['ps', 'lsof', 'timeout', 'partial', 'platform'] as const) {
    const f = await fixture();
    try {
      if (scenario === 'partial') f.files('p42\0f7\0aw');
      else if (scenario === 'platform') f.probe.platform = 'linux';
      else f.fail(scenario);
      const access = await f.inspect();
      assert.equal(access.status, 'unknown', scenario);
      assert.equal(access.reason?.includes('private'), false);
      assert.equal(access.checkedAt, f.probe.now());
    } finally { await f.close(); }
  }
});

test('descriptor inode disagreement and missing live owned child never admit a write', async () => {
  for (const scenario of ['inode', 'child']) {
    const f = await fixture();
    try {
      if (scenario === 'inode') { f.processes(processRow(42, '/usr/bin/editor')); f.files(await f.writer(42, 'w', '0')); }
      else { f.options.ownedPids = [42]; f.options.ownedSessionPaths = [f.target]; }
      assert.equal((await f.inspect()).status, 'unknown');
    } finally { await f.close(); }
  }
});

test('replacement during observation is unknown even with a clean no-match scan', async () => {
  const f = await fixture();
  try {
    const replacement = join(f.root, 'replacement.jsonl');
    await writeFile(replacement, '{"replaced":true}\n');
    f.duringFileScan(() => rename(replacement, f.target));
    assert.equal((await f.inspect()).status, 'unknown');
  } finally { await f.close(); }
});

test('unmaterialized owned sessions retain live child ownership before their first prompt', async () => {
  const f = await fixture();
  try {
    await rm(f.target);
    f.options.ownedPids = [42];
    f.options.ownedSessionPaths = [f.target];
    f.processes(processRow(42, f.options.executable));
    assert.equal((await f.inspect()).status, 'owned');
  } finally { await f.close(); }
});

test('native script wrappers use current terminal evidence, not stale resume arguments', async () => {
  for (const session of ['target', 'other'] as const) {
    const f = await fixture();
    try {
      f.processes(processRow(42, '/usr/local/bin/bun'));
      f.interpreterArgs(`42 bun /checkout/packages/coding-agent/src/cli.ts --resume ${f.target}\n`);
      f.stdin(tty(42));
      await f.crumb(session === 'target' ? f.target : f.other);
      assert.equal((await f.inspect()).status, session === 'target' ? 'external' : 'idle');
    } finally { await f.close(); }
  }
});

test('unrelated interpreters mentioning native paths in application arguments are not owners', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(42, '/usr/local/bin/node'));
    f.interpreterArgs(`42 node /tools/server.js --example ${f.options.executable}\n`);
    assert.equal((await f.inspect()).status, 'idle');
  } finally { await f.close(); }
});

test('relevant unsupported interpreter syntax is unknown without exposing private arguments', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(42, '/usr/local/bin/bun'));
    f.interpreterArgs('42 bun --unknown-launch-mode /checkout/packages/coding-agent/src/cli.ts private-secret\n');
    const access = await f.inspect();
    assert.equal(access.status, 'unknown');
    assert.equal(access.reason?.includes('private-secret'), false);
  } finally { await f.close(); }
});

test('Darwin signed system UIDs do not poison an otherwise complete idle inventory', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(77, '/usr/libexec/system-service').replace(/^501 /, '-2 '));
    assert.equal((await f.inspect()).status, 'idle');
  } finally { await f.close(); }
});

test('malformed relevant process identity still fails closed', async () => {
  const f = await fixture();
  try {
    f.processes(`501 42 1 42 ?? S unavailable ${f.options.executable}\n`);
    assert.equal((await f.inspect()).status, 'unknown');
  } finally { await f.close(); }
});

test('verified target terminal evidence wins over an earlier unresolved native candidate', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(41, f.options.executable) + processRow(42, f.options.executable));
    f.stdin(fields('p41', 'u501', 'f0', 'au', 'tunix', 'nsocket') + tty(42));
    await f.crumb(f.target);
    assert.equal((await f.inspect()).status, 'external');
  } finally { await f.close(); }
});

test('a verified exact writer wins over an unresolved unrelated native terminal', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(41, f.options.executable) + processRow(42, '/usr/bin/editor'));
    f.files(await f.writer(42));
    assert.equal((await f.inspect()).status, 'external');
  } finally { await f.close(); }
});

test('another profile is excluded only through its actual journal-root terminal association', async () => {
  const f = await fixture();
  try {
    const profile = join(f.root, 'different-profile', 'agent');
    const directory = join(profile, 'terminal-sessions');
    const journal = join(profile, 'sessions', 'workspace', 'other.jsonl');
    await mkdir(directory, { recursive: true });
    await mkdir(join(profile, 'sessions', 'workspace'), { recursive: true });
    await writeFile(journal, '{}\n');
    await writeFile(join(directory, 'ttys001'), `${f.root}\n${journal}\n`);
    const info = await stat(journal, { bigint: true });
    f.processes(processRow(42, f.options.executable));
    f.stdin(tty(42) + fields('p42', 'u501', 'f7', 'aw', 'tREG', `D0x${info.dev.toString(16)}`, `i${info.ino}`, `n${journal}`));
    assert.equal((await f.inspect()).status, 'idle');
  } finally { await f.close(); }
});

test('an unrelated headless native writer is not a terminal owner of the selected session', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(42, f.options.executable));
    f.stdin(fields('p42', 'u501', 'f0', 'au', 'tunix', 'nsocket') + fields('p42', 'u501', 'f7', 'aw', 'tREG', 'D0x1', 'i2', `n${f.root}/agent/sessions/workspace/other.jsonl`));
    assert.equal((await f.inspect()).status, 'idle');
  } finally { await f.close(); }
});

test('interpreter eval data and desktop name prefixes are not native session launchers', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(41, '/Applications/OMP-Desktop') + processRow(42, '/Applications/omp-desktop') + processRow(43, '/usr/local/bin/bun'));
    f.interpreterArgs(`43 bun --eval const executable = ${f.options.executable} ;\n`);
    assert.equal((await f.inspect()).status, 'idle');
  } finally { await f.close(); }
});

test('unsupported wrapper ambiguity cannot conceal a verified target terminal', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(41, '/usr/local/bin/bun') + processRow(42, f.options.executable));
    f.interpreterArgs('41 bun --unknown-launch-mode /checkout/packages/coding-agent/src/cli.ts\n');
    f.stdin(tty(42));
    await f.crumb(f.target);
    assert.equal((await f.inspect()).status, 'external');
  } finally { await f.close(); }
});

test('healthy headless natives without target evidence do not override owned sessions', async () => {
  const f = await fixture();
  try {
    f.options.ownedPids = [42];
    f.options.ownedSessionPaths = [f.target];
    f.processes(processRow(41, f.options.executable) + processRow(42, f.options.executable));
    f.stdin(fields('p41', 'u501', 'f0', 'au', 'tunix', 'nsocket'));
    assert.equal((await f.inspect()).status, 'owned');
  } finally { await f.close(); }
});

test('explicit headless target paths block conservatively without treating other argv paths as ownership', async () => {
  for (const matches of [false, true]) {
    const f = await fixture();
    try {
      f.processes(processRow(42, f.options.executable));
      f.stdin(fields('p42', 'u501', 'f0', 'au', 'tunix', 'nsocket'));
      f.interpreterArgs(`42 ${f.options.executable} --mode rpc-ui --resume ${matches ? f.target : f.other}\n`);
      assert.equal((await f.inspect()).status, matches ? 'external' : 'idle');
    } finally { await f.close(); }
  }
});

test('a healthy unrelated headless process alone does not block, but its matching writable FD does', async () => {
  for (const holdsTarget of [false, true]) {
    const f = await fixture();
    try {
      f.processes(processRow(42, f.options.executable));
      f.stdin(fields('p42', 'u501', 'f0', 'au', 'tunix', 'nsocket'));
      if (holdsTarget) f.files(await f.writer(42));
      assert.equal((await f.inspect()).status, holdsTarget ? 'external' : 'idle');
    } finally { await f.close(); }
  }
});

test('desktop allocations remain writable across first persistence despite an unrelated profile terminal', async () => {
  const f = await fixture();
  try {
    await rm(f.target);
    const alias = join(f.root, 'alias');
    await symlink(f.root, alias, 'dir');
    f.options.ownedPids = [42];
    f.options.ownedSessionPaths = [f.target];
    f.options.allocatedSessionPaths = [join(alias, 'session.jsonl')];
    f.processes(processRow(42, f.options.executable) + processRow(43, f.options.executable));
    f.stdin(tty(43));
    assert.equal((await f.inspect()).status, 'owned');
    await writeFile(f.target, '{}\n');
    assert.equal((await f.inspect()).status, 'owned');
    f.options.allocatedSessionPaths = [];
    assert.equal((await f.inspect()).status, 'unknown', 'resumed identities must not inherit allocation provenance');
  } finally { await f.close(); }
});

test('allocation provenance does not authorize a different or no-longer-owned session', async () => {
  const f = await fixture();
  try {
    f.options.ownedPids = [42];
    f.options.ownedSessionPaths = [f.target];
    f.options.allocatedSessionPaths = [f.other];
    f.processes(processRow(42, f.options.executable) + processRow(43, f.options.executable));
    f.stdin(tty(43));
    assert.equal((await f.inspect()).status, 'unknown');
    f.options.allocatedSessionPaths = [f.target];
    f.options.ownedSessionPaths = [f.other];
    assert.equal((await f.inspect()).status, 'unknown');
  } finally { await f.close(); }
});

test('allocated sessions still reject same-target terminal aliases and explicit launch targets', async () => {
  for (const evidence of ['breadcrumb', 'argv', 'descriptor'] as const) {
    const f = await fixture();
    try {
      const alias = join(f.root, 'alias.jsonl');
      await symlink(f.target, alias);
      f.options.ownedPids = [42];
      f.options.ownedSessionPaths = [f.target];
      f.options.allocatedSessionPaths = [f.target];
      f.processes(processRow(42, f.options.executable) + processRow(43, f.options.executable));
      f.stdin(tty(43));
      if (evidence === 'breadcrumb') await f.crumb(alias);
      if (evidence === 'argv') f.interpreterArgs(`43 ${f.options.executable} --resume ${alias}\n`);
      if (evidence === 'descriptor') f.files(await f.writer(43));
      assert.equal((await f.inspect()).status, 'external', evidence);
    } finally { await f.close(); }
  }
});

test('allocation cannot conceal failed probes, malformed evidence or disappearing children', async () => {
  for (const failure of ['probe', 'child', 'malformed'] as const) {
    const f = await fixture();
    try {
      f.options.ownedPids = [42];
      f.options.ownedSessionPaths = [f.target];
      f.options.allocatedSessionPaths = [f.target];
      f.processes(processRow(42, f.options.executable) + processRow(43, f.options.executable), failure === 'child' ? processRow(43, f.options.executable) : undefined);
      f.stdin(tty(43));
      if (failure === 'probe') f.fail('lsof');
      if (failure === 'malformed') await writeFile(join(f.options.terminalDirectory, 'ttys001'), 'invalid');
      assert.equal((await f.inspect()).status, 'unknown', failure);
    } finally { await f.close(); }
  }
});

test('interpreter and candidate exits are dropped after a confirming inventory', async () => {
  for (const interpreter of [false, true]) {
    const f = await fixture();
    try {
      f.processes(processRow(42, interpreter ? '/usr/local/bin/bun' : f.options.executable), '');
      const run = f.probe.run;
      f.probe.run = (binary, args, timeout) => binary === '/bin/ps' && args.includes('pid=,args=') ? Promise.resolve(empty) : run(binary, args, timeout);
      assert.equal((await f.inspect()).status, 'idle');
    } finally { await f.close(); }
  }
});

test('cwd scopes missing terminal breadcrumbs but never overrides target evidence', async () => {
  for (const scenario of ['other', 'same', 'writer', 'resume', 'breadcrumb'] as const) {
    const f = await fixture();
    try {
      await writeFile(f.target, `${JSON.stringify({ type: 'session', id: 'target', cwd: f.root })}\n`);
      f.processes(processRow(42, f.options.executable));
      f.stdin(tty(42) + fields('p42', 'fcwd', 'tDIR', `n${scenario === 'same' ? f.root : '/unrelated/workspace'}`));
      if (scenario === 'writer') f.files(await f.writer(42));
      if (scenario === 'resume') f.interpreterArgs(`42 ${f.options.executable} --resume ${f.target}`);
      if (scenario === 'breadcrumb') await f.crumb(f.target);
      assert.equal((await f.inspect()).status, scenario === 'other' ? 'idle' : scenario === 'same' ? 'unknown' : 'external', scenario);
    } finally { await f.close(); }
  }
});

test('unrelated mount warning is benign only for an exact target scan', async () => {
  for (const scenario of ['other', 'target', 'candidate', 'unknown'] as const) {
    const f = await fixture();
    try {
      const run = f.probe.run;
      if (scenario === 'candidate') { f.processes(processRow(42, f.options.executable)); f.stdin(tty(42)); await f.crumb(f.other); }
      f.probe.run = async (binary, args, timeout) => {
        const result = await run(binary, args, timeout);
        if (binary !== '/usr/sbin/lsof' || args.includes('-h')) return result;
        const stderr = scenario === 'unknown' ? 'permission denied' : `lsof: WARNING: can't stat() apfs file system ${scenario === 'target' ? f.root : '/unrelated-mount'}\n      Output information may be incomplete.\n`;
        return { ...result, stderr };
      };
      assert.equal((await f.inspect()).status, scenario === 'other' ? 'idle' : 'unknown');
    } finally { await f.close(); }
  }
});

test('unsupported launch forms are scoped by cwd, and dead diagnostic candidates are dropped', async () => {
  for (const scenario of ['unrelated', 'exited'] as const) {
    const f = await fixture();
    try {
      await writeFile(f.target, `${JSON.stringify({ type: 'session', id: 'target', cwd: f.root })}\n`);
      f.processes(processRow(42, scenario === 'unrelated' ? '/usr/local/bin/bun' : f.options.executable), scenario === 'exited' ? '' : undefined);
      if (scenario === 'unrelated') {
        f.interpreterArgs('42 bun --unsupported /checkout/packages/coding-agent/src/cli.ts');
        f.stdin(tty(42) + fields('p42', 'fcwd', 'tDIR', 'n/unrelated/workspace'));
      } else {
        const run = f.probe.run;
        f.probe.run = (binary, args, timeout) => binary === '/usr/sbin/lsof' && args.includes('-p') ? Promise.resolve({ code: 1, stdout: '', stderr: 'process disappeared' }) : run(binary, args, timeout);
      }
      assert.equal((await f.inspect()).status, 'idle', scenario);
    } finally { await f.close(); }
  }
});

test('new and reused native identities only affect plausible targets', async () => {
  for (const reused of [false, true]) for (const wrapper of [false, true]) for (const scenario of ['other', 'same', 'writer', 'breadcrumb', 'exited'] as const) {
    const f = await fixture();
    try {
      await writeFile(f.target, `${JSON.stringify({ type: 'session', id: 'target', cwd: f.root })}\n`);
      if (scenario === 'breadcrumb') await f.crumb(f.target);
      const writer = await f.writer(42);
      const run = f.probe.run;
      let inventories = 0;
      f.probe.run = async (binary, args, timeout) => {
        if (binary === '/bin/ps' && args.includes('-A')) {
          inventories++;
          return { code: 0, stdout: processRow(10, '/sbin/launchd') + ((reused || inventories > 1) && !(scenario === 'exited' && inventories > 2) ? processRow(42, wrapper ? '/usr/local/bin/bun' : f.options.executable, inventories === 1 ? 'Thu Jan  1 00:00:00 2026' : 'Fri Jan  2 00:00:00 2026') : ''), stderr: '' };
        }
        if (binary === '/bin/ps' && args.includes('pid=,args=')) return { code: 0, stdout: `42 ${wrapper ? 'bun /checkout/packages/coding-agent/src/cli.ts' : f.options.executable}\n`, stderr: '' };
        if (binary === '/usr/sbin/lsof' && args.includes('-p')) {
          if (args.includes('--')) return scenario === 'writer' ? { code: 0, stdout: writer, stderr: '' } : empty;
          return { code: 0, stdout: tty(42) + fields('p42', 'fcwd', 'tDIR', `n${scenario === 'same' ? f.root : '/unrelated/workspace'}`), stderr: '' };
        }
        return run(binary, args, timeout);
      };
      assert.equal((await f.inspect()).status, scenario === 'same' ? 'unknown' : scenario === 'writer' || scenario === 'breadcrumb' ? 'external' : 'idle', `${wrapper}:${scenario}`);
    } finally { await f.close(); }
  }
});

test('an unrelated terminal switching sessions remains idle unless it switches to the target', async () => {
  for (const target of [false, true]) {
    const f = await fixture();
    try {
      await writeFile(f.target, `${JSON.stringify({type:'session',id:'target',cwd:f.root})}\n`);
      const other = join(f.root, 'third.jsonl');
      await writeFile(other, '{}\n');
      await f.crumb(f.other);
      f.processes(processRow(42, f.options.executable));
      f.stdin(tty(42) + fields('p42', 'fcwd', 'tDIR', 'n/unrelated/workspace'));
      const run = f.probe.run;
      let inventories = 0;
      f.probe.run = async (binary, args, timeout) => {
        if (binary === '/bin/ps' && args.includes('-A') && ++inventories === 2) writeFileSync(join(f.options.terminalDirectory, 'ttys001'), `${f.root}\n${target ? f.target : other}\n`);
        return run(binary, args, timeout);
      };
      assert.equal((await f.inspect()).status, target ? 'external' : 'idle');
    } finally { await f.close(); }
  }
});

test('presence participants never enter legacy heuristics, but older terminals still do', async () => {
  const f = await fixture();
  try {
    f.processes(processRow(42, f.options.executable));
    f.probe.presence = async () => ({ lock: 'free', discovery: { complete: true, processes: [{ pid: 42, processStartMs: Date.parse('Thu Jan  1 00:00:00 2026'), socketPath: '/p', responsive: true, sessions: [] }] } });
    f.fail('lsof');
    const idle = await f.inspect();
    assert.equal(idle.status, 'idle'); assert.equal(idle.confidence, 'exact');
    f.fail(undefined);
    f.processes(processRow(42, f.options.executable) + processRow(43, f.options.executable));
    f.stdin(tty(43)); await f.crumb(f.target);
    assert.equal((await f.inspect()).status, 'external');
  } finally { await f.close(); }
});

test('empty participant and legacy inventories return exact idle without lsof', async () => {
  const f = await fixture();
  try {
    f.probe.presence = async () => ({ lock: 'free', discovery: { complete: true, processes: [] } });
    f.fail('lsof');
    const access = await f.inspect();
    assert.equal(access.status, 'idle'); assert.equal(access.confidence, 'exact'); assert.equal(access.occupancySource, 'presence');
  } finally { await f.close(); }
});

test('a live desktop target stays owned without a socket or with a slow owned socket', async () => {
  for (const slow of [false, true]) {
    const f = await fixture();
    try {
      f.options.ownedPids = [42]; f.options.ownedSessionPaths = [f.target];
      f.processes(processRow(42, f.options.executable));
      f.probe.presence = async () => ({ lock: 'held', discovery: { complete: true, processes: slow ? [{ pid: 42, processStartMs: Date.parse('Thu Jan  1 00:00:00 2026'), socketPath: '/slow', responsive: false }] : [] } });
      f.fail('lsof');
      assert.equal((await f.inspect()).status, 'owned');
    } finally { await f.close(); }
  }
});

test('external holders and unresolved non-owned sockets override desktop lock knowledge', async () => {
  for (const responsive of [false, true]) {
    const f = await fixture();
    try {
      f.options.ownedPids = [42]; f.options.ownedSessionPaths = [f.target];
      f.processes(processRow(42, f.options.executable) + processRow(43, f.options.executable));
      const canonical = await realpath(f.target);
      f.probe.presence = async () => ({ lock: 'held', discovery: { complete: true, processes: [{ pid: 43, processStartMs: Date.parse('Thu Jan  1 00:00:00 2026'), socketPath: '/external', responsive, ...(responsive ? { sessions: [{ sessionFile: canonical, sessionId: 'external', cwd: f.root, state: 'idle' as const, since: 1 }] } : {}) }] } });
      assert.equal((await f.inspect()).status, 'external');
    } finally { await f.close(); }
  }
});

test('desktop lock recovery still rejects a plausible legacy terminal', async () => {
  const f = await fixture();
  try {
    f.options.ownedPids = [42]; f.options.ownedSessionPaths = [f.target];
    f.processes(processRow(42, f.options.executable) + processRow(43, f.options.executable));
    f.probe.presence = async () => ({ lock: 'held', discovery: { complete: true, processes: [] } });
    f.stdin(tty(43));
    assert.equal((await f.inspect()).status, 'unknown');
  } finally { await f.close(); }
});

test('desktop children appearing during a probe never become uncertain external candidates', async () => {
  for (const indirect of [false, true]) {
    const f = await fixture();
    try {
      f.options.desktopPid = 10;
      f.options.ownedPids = [42]; f.options.ownedSessionPaths = [f.target];
      const initial = processRow(42, f.options.executable) + processRow(90, f.options.executable);
      const arrived = processRow(43, f.options.executable, undefined, indirect ? 44 : 10) + (indirect ? processRow(44, '/bin/helper', undefined, 10) : '');
      f.processes(initial, initial + arrived);
      f.stdin(tty(90)); await f.crumb(f.other);
      assert.equal((await f.inspect()).status, 'owned');
    } finally { await f.close(); }
  }
});

test('the final census refreshes desktop runtime facts instead of freezing admission ownership', async () => {
  const f = await fixture();
  try {
    let arrived = false;
    f.options.ownedPids = [42]; f.options.ownedSessionPaths = [f.target];
    f.options.ownedFacts = () => [{ pid: 42, sessionPath: f.target }, ...(arrived ? [{ pid: 43, sessionPath: f.other }] : [])];
    const initial = processRow(42, f.options.executable) + processRow(90, f.options.executable);
    f.processes(initial, initial + processRow(43, f.options.executable));
    f.stdin(tty(90)); await f.crumb(f.other);
    f.duringFileScan(async () => { arrived = true; });
    assert.equal((await f.inspect()).status, 'owned');
  } finally { await f.close(); }
});

test('a verified desktop presence holder ignores unrelated process churn without subprocesses', async () => {
  const f = await fixture();
  try {
    const canonical = await realpath(f.target);
    f.options.ownedPids = [42]; f.options.ownedSessionPaths = [f.target];
    f.probe.presence = async () => ({ lock: 'held', discovery: { complete: true, processes: [{ pid: 42, processStartMs: 1, socketPath: '/owned', responsive: true, sessions: [{ sessionFile: canonical, sessionId: 'owned', cwd: f.root, state: 'idle', since: 1 }] }] } });
    f.probe.run = async () => { throw new Error('Admission must not probe processes'); };
    assert.equal((await f.inspect()).status, 'owned');
  } finally { await f.close(); }
});

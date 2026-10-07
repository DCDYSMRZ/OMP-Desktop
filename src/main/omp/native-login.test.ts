import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { nativeLoginScript, openNativeLogin, clearNativeLoginScripts } from './native-login';

test('native login preserves resolved path, profile and credential home without shell injection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-login-args-'));
  try {
    const bin = join(directory, "quoted ' executable");
    await mkdir(bin);
    const executable = join(bin, 'omp');
    await writeFile(executable, '#!/bin/sh\nprintf \'%s\\n\' "$HOME" "$PI_CODING_AGENT_DIR" "$@"\n', { mode: 0o700 });
    const context = { executable, cwd: directory, profile: `profile'; touch '${directory}/injected'; #`, env: { HOME: "/tmp/home ' quoted", PI_CODING_AGENT_DIR: '/tmp/isolated/agent', PATH: '/usr/bin:/bin', SECRET_API_KEY: 'must-not-persist' } };
    const run = (profile?: string) => execFileSync('/bin/sh', ['-c', nativeLoginScript({ ...context, profile })], { encoding: 'utf8' }).trimEnd().split('\n');
    assert.deepEqual(run(context.profile), [context.env.HOME, context.env.PI_CODING_AGENT_DIR, '--profile', context.profile, 'login']);
    assert.deepEqual(run(), [context.env.HOME, context.env.PI_CODING_AGENT_DIR, 'login']);
    assert.ok(!nativeLoginScript(context).includes('must-not-persist'));
    await assert.rejects(stat(join(directory, 'injected')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('login opens only its private executable script and stale scripts are removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-login-'));
  try {
    const root = join(directory, 'native-login');
    let opened = '';
    const context = { executable: '/usr/local/bin/omp', cwd: '/tmp', env: { HOME: '/tmp/isolated-home' } };
    await openNativeLogin(root, context, async path => { opened = path; return ''; });
    assert.equal(opened, join(root, 'omp-login.command'));
    assert.equal((await stat(opened)).mode & 0o777, 0o700);
    assert.equal(await readFile(opened, 'utf8'), nativeLoginScript(context));
    await assert.rejects(openNativeLogin(root, context, async () => 'Terminal could not open'), /Terminal could not open/);
    await clearNativeLoginScripts(root);
    await assert.rejects(stat(opened), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

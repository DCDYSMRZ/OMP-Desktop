import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncPresenceInstallation, getPresenceInstallation, presenceResourcePath } from './presence-install';

test('presence installation updates and removes only managed regular files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'presence-install-'));
  const context = { executable: '/bin/false', cwd: home, env: { HOME: home } };
  const source = join(home, 'source.ts');
  const managed = (version: string) => `// omp-desktop-presence v${version} (managed by OMP-Desktop)\nexport default () => {};\n`;
  try {
    await writeFile(source, managed('1.0.0'));
    const first = await syncPresenceInstallation(context, true, source);
    assert.equal(first.installedVersion, '1.0.0');
    assert.equal(await readFile(first.path, 'utf8'), managed('1.0.0'));
    await writeFile(source, managed('1.1.0'));
    assert.equal((await syncPresenceInstallation(context, true, source)).installedVersion, '1.1.0');
    await syncPresenceInstallation(context, false, source);
    assert.equal((await getPresenceInstallation(context)).installedVersion, null);
    await writeFile(first.path, '// user extension\n');
    await assert.rejects(syncPresenceInstallation(context, true, source), /unmanaged/);
    await assert.rejects(syncPresenceInstallation(context, false, source), /unmanaged/);
    assert.equal(await readFile(first.path, 'utf8'), '// user extension\n');
    await rm(first.path); await symlink(source, first.path);
    await assert.rejects(syncPresenceInstallation(context, false, source));
    assert.equal(await readFile(source, 'utf8'), managed('1.1.0'));
    const profile = await syncPresenceInstallation({ ...context, profile: 'work' }, true, source);
    assert.equal(profile.path, join(home, '.omp/profiles/work/agent/extensions/omp-desktop-presence.ts'));
    const custom = join(home, 'custom'); await mkdir(custom);
    assert.equal((await syncPresenceInstallation({ ...context, env: { HOME: home, PI_CODING_AGENT_DIR: custom } }, true, source)).path, join(custom, 'extensions/omp-desktop-presence.ts'));
    assert.equal(presenceResourcePath(true, '/app/Contents/Resources', '/app/Contents/Resources/app.asar/out/main'), '/app/Contents/Resources/omp-desktop-presence.ts');
    assert.equal(presenceResourcePath(false, '/electron', '/repo/out/main'), '/repo/resources/omp-desktop-presence.ts');
  } finally { await rm(home, { recursive: true, force: true }); }
});

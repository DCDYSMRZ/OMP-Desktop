import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfiguredModel } from './configured-model';

test('configured preview follows native global, project and overlay role precedence without claiming authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-preview-'));
  const agent = join(root, 'agent'), cwd = join(root, 'workspace');
  await mkdir(agent); await mkdir(join(cwd, '.omp'), { recursive: true });
  const context = { executable: '/unused', cwd, env: { HOME: root, PI_CODING_AGENT_DIR: agent } };
  try {
    await writeFile(join(agent, 'config.yml'), 'modelRoles:\n  default: provider/global\n');
    assert.equal(await readConfiguredModel(context), 'provider/global');
    await writeFile(join(cwd, '.omp/settings.json'), JSON.stringify({ modelRoles: { default: 'provider/legacy' } }));
    await writeFile(join(cwd, '.omp/config.yml'), 'modelRoles:\n  default: provider/project\n');
    assert.equal(await readConfiguredModel(context), 'provider/project');
    await writeFile(join(cwd, '.omp/config.yml'), 'modelRoles:\n  default: null\n');
    assert.equal(await readConfiguredModel(context), 'provider/global');
    await writeFile(join(root, 'overlay.yml'), 'modelRoles:\n  default: unauthenticated/configured\n');
    assert.equal(await readConfiguredModel({ ...context, env: { ...context.env, PI_CONFIG_FILES: join(root, 'overlay.yml') } }), 'unauthenticated/configured');
    await writeFile(join(root, 'overlay.yml'), 'modelRoles:\n  default: \"@other-role\"\n');
    assert.equal(await readConfiguredModel({ ...context, env: { ...context.env, PI_CONFIG_FILES: join(root, 'overlay.yml') } }), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

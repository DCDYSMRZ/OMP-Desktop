import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryIndex } from './history';

test('history publishes one canonical session identity across aliased roots and registry paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-desktop-history-identity-'));
  try {
    const agent = join(directory, 'agent');
    const alias = join(directory, 'agent-alias');
    const bucket = join(agent, 'sessions', 'workspace');
    const registry = join(agent, 'custom-session-files');
    await mkdir(bucket, { recursive: true });
    await mkdir(registry);
    await symlink(agent, alias, 'dir');
    const session = join(bucket, 'session.jsonl');
    await writeFile(session, `${JSON.stringify({ type: 'session', id: 'canonical-session', cwd: directory })}\n`);
    await writeFile(join(registry, 'direct'), session);
    await writeFile(join(registry, 'alias'), join(alias, 'sessions', 'workspace', 'session.jsonl'));
    const index = new HistoryIndex();
    const { sessions: rows } = await index.list({ executable: '/unused', cwd: directory, env: { HOME: directory, PI_CODING_AGENT_DIR: alias } });
    assert.deepEqual(rows.map(row => ({ id: row.id, path: row.path })), [{ id: 'canonical-session', path: await realpath(session) }]);
    const { sessions: directRows } = await index.list({ executable: '/unused', cwd: directory, env: { HOME: directory, PI_CODING_AGENT_DIR: agent } });
    assert.deepEqual(directRows.map(row => row.path), rows.map(row => row.path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

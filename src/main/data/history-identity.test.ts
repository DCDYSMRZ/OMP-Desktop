import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

test('stale registered allocations are skipped while unreadable and malformed sources remain diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-registry-history-'));
  try {
    const agent = join(directory, 'agent');
    const registry = join(agent, 'custom-session-files');
    await mkdir(registry, { recursive: true });
    const invalid = join(directory, 'invalid.jsonl');
    const denied = join(directory, 'denied.jsonl');
    await writeFile(invalid, 'not a journal');
    await writeFile(denied, JSON.stringify({type:'session',id:'denied',cwd:directory})+'\n');
    await chmod(denied, 0);
    for (const [name, path] of [['missing', join(directory, 'missing-parent', 'never-written.jsonl')], ['invalid', invalid], ['denied', denied]]) await writeFile(join(registry, name), path);
    const result = await new HistoryIndex().list({ executable: '/unused', cwd: directory, env: { HOME: directory, PI_CODING_AGENT_DIR: agent } });
    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.diagnostics.map(item => item.path).sort(), [await realpath(denied), await realpath(invalid)].sort());
    await chmod(denied, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

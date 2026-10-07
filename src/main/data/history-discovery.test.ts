import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HistoryListing } from '../../shared/contracts';
import { HistoryIndex } from './history';
import { HistoryDiscovery } from './history-discovery';

async function journal(path: string, cwd: string, id: string) {
  await writeFile(path, [
    { type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() },
    { type: 'message', id: 'request', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: id } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('an already-open discovery sees a journal in a newly created project directory', { timeout: 6000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omp-discovery-')));
  const index = new HistoryIndex();
  const context = { executable: '', cwd: root, env: { HOME: root, PI_CODING_AGENT_DIR: root } };
  const appeared = Promise.withResolvers<HistoryListing>();
  const discovery = new HistoryDiscovery({ roots: async () => [join(root, 'sessions')], list: () => index.list(context), publish: listing => { if (listing.sessions.some(session => session.id === 'external')) appeared.resolve(listing); }, onError: appeared.reject });
  try {
    await discovery.start();
    const directory = join(root, 'sessions', 'new-project');
    await mkdir(directory, { recursive: true });
    await journal(join(directory, 'external.jsonl'), root, 'external');
    // Await real filesystem publication; the test timeout bounds unavailable platform hints.
    const listing = await appeared.promise;
    assert.deepEqual(listing.sessions.map(session => session.id), ['external']);
    assert.equal(listing.sessions[0].cwd, root);
  } finally { discovery.close(); await rm(root, { recursive: true, force: true }); }
});

test('reconciliation recovers additions, renames and removals independently of watch delivery', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omp-discovery-reconcile-')));
  const directory = join(root, 'sessions', 'project');
  const index = new HistoryIndex();
  let latest: HistoryListing | undefined;
  const discovery = new HistoryDiscovery({ roots: async () => [join(root, 'sessions')], list: () => index.list({ executable: '', cwd: root, env: { HOME: root, PI_CODING_AGENT_DIR: root } }), publish: listing => { latest = listing; }, onError: error => { throw error; } });
  try {
    await mkdir(directory, { recursive: true });
    await journal(join(directory, 'one.jsonl'), root, 'one');
    await discovery.reconcile();
    assert.deepEqual(latest?.sessions.map(session => session.id), ['one']);
    await rename(join(directory, 'one.jsonl'), join(directory, 'renamed.jsonl'));
    await journal(join(directory, 'two.jsonl'), root, 'two');
    await discovery.reconcile();
    assert.deepEqual(latest?.sessions.map(session => session.path).sort(), [join(directory, 'renamed.jsonl'), join(directory, 'two.jsonl')]);
    await rm(join(directory, 'renamed.jsonl'));
    await discovery.reconcile();
    assert.deepEqual(latest?.sessions.map(session => session.id), ['two']);
  } finally { discovery.close(); await rm(root, { recursive: true, force: true }); }
});

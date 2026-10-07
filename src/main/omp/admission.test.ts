import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionAdmissions, SessionHistoryGrants, requireWritable } from './admission';
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSessionPath } from './service';
import { HistoryReader } from '../data/journal';

test('same-session admissions cannot overlap while independent sessions remain available', async () => {
  const admissions = new SessionAdmissions();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = admissions.run('/session', async () => { order.push('first'); entered.resolve(); await release.promise; order.push('released'); });
  await entered.promise;
  const second = admissions.run('/session', async () => { order.push('second'); });
  await admissions.run('/other', async () => { order.push('other'); });
  assert.deepEqual(order, ['first', 'other']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'other', 'released', 'second']);
});

test('failed admission releases queue and later admission checks fresh ownership', async () => {
  const admissions = new SessionAdmissions();
  let status: 'idle' | 'external' | 'unknown' = 'external';
  let writes = 0;
  const send = () => admissions.run('/session', async () => { requireWritable({ status, checkedAt: Date.now() }); writes++; });
  await assert.rejects(send(), /another native process/);
  status = 'unknown';
  await assert.rejects(send(), /could not be verified/);
  assert.equal(writes, 0);
  status = 'idle';
  await send();
  assert.equal(writes, 1);
  requireWritable({ status: 'owned', checkedAt: Date.now() });
  assert.throws(() => requireWritable({ status: 'idle', pending: true, checkedAt: 0 }), /could not be verified/);
  assert.throws(() => requireWritable({ status: 'owned', pending: true, checkedAt: 0 }), /could not be verified/);
});

test('existing and not-yet-persisted session aliases share one admission identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-desktop-admission-'));
  try {
    const sessions = join(directory, 'sessions');
    const alias = join(directory, 'alias');
    await mkdir(sessions);
    await symlink(sessions, alias, 'dir');
    const native = join(sessions, 'original.jsonl');
    await writeFile(native, '{}\n');
    assert.equal(await canonicalSessionPath(join(alias, 'original.jsonl')), await realpath(native));
    assert.equal(await canonicalSessionPath(join(alias, 'new.jsonl')), join(await realpath(sessions), 'new.jsonl'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('allocated native history remains readable after persistence and disconnect without granting other files', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-history-grants-')));
  const grants = new SessionHistoryGrants();
  const reader = new HistoryReader();
  const path = join(directory, 'native.jsonl'), other = join(directory, 'unlisted.jsonl'), alias = join(directory, 'alias.jsonl');
  try {
    grants.grantSource({ status: 'unpersisted', sessionId: 'owned', path });
    await assert.rejects(grants.approve(path), { code: 'ENOENT' });
    const timestamp = '2026-01-01T00:00:00.000Z';
    const journal = [{ type: 'session', version: 3, id: 'owned', cwd: directory, timestamp }, { type: 'message', id: 'prompt', parentId: null, timestamp, message: { role: 'user', content: 'Saved before disconnect' } }, { type: 'message', id: 'answer', parentId: 'prompt', timestamp, message: { role: 'assistant', provider: 'local', model: 'recorded', content: 'Saved answer' } }].map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(path, journal); await writeFile(other, journal);
    await symlink(path, alias);
    // Both watch and resume use this same capability check, independent of a child PID.
    const watched = await reader.read({ path: await grants.approve(alias) }, directory);
    assert.equal(watched.session.id, 'owned');
    assert.equal(watched.selection?.model?.id, 'recorded');
    assert.equal(await grants.approve(path), path);
    await assert.rejects(grants.approve(other), /Choose a native session/);
    await unlink(alias); await symlink(other, alias);
    await assert.rejects(grants.approve(alias), /Choose a native session/);
    grants.grantSource({ status: 'unavailable', sessionId: 'foreign', path: other, reason: 'Identity mismatch' });
    await assert.rejects(grants.approve(other), /Choose a native session/);
    grants.delete(path);
    await assert.rejects(grants.approve(path), /Choose a native session/);
  } finally { reader.close(); await rm(directory, { recursive: true, force: true }); }
});

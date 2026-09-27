import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionAdmissions, requireWritable } from './admission';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSessionPath } from './service';

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

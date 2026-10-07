import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { RuntimeShutdownOutcome, SessionRemovalTarget } from '../../shared/contracts';
import { removeSession, type SessionRemovalDependencies } from '../data/session-removal';
import { SessionAdmissions } from './admission';
import { withRemovalRuntimeAdmission } from './removal-admission';

async function fixture(outcome: RuntimeShutdownOutcome, run: (f: { path: string; root: string; bytes: string; resources: string; trash: string; removed: string[]; closed: string[]; dependencies: SessionRemovalDependencies }) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omp-removal-admission-')));
  const path = join(root, 'owned.jsonl'), resources = join(root, 'owned'), trash = join(root, 'fixture-trash');
  const roots = { sessions: join(root, 'sessions'), archives: join(root, 'archives'), registry: join(root, 'registry') };
  const workspace = join(root, 'workspace');
  const bytes = `${JSON.stringify({ type: 'session', version: 3, id: 'session', cwd: workspace, timestamp: '2026-09-26T12:00:00.000Z' })}\n`;
  const removed: string[] = [], closed: string[] = [];
  let remembered: RuntimeShutdownOutcome | undefined;
  const admissions = new SessionAdmissions();
  const catalog = {
    identities: () => [{ runtimeId: 'owned', sessionId: 'session', path }, { runtimeId: 'unrelated', sessionId: 'unrelated', path: join(root, 'unrelated.jsonl') }],
    close: async (runtimeId: string): Promise<RuntimeShutdownOutcome> => { closed.push(runtimeId); assert.equal(runtimeId, 'owned'); return remembered ??= outcome; },
  };
  const dependencies: SessionRemovalDependencies = {
    withAdmission: async (target, operation) => {
      const source = { status: 'persisted' as const, sessionId: target.sessionId, path: target.kind === 'saved' ? target.path : path };
      return withRemovalRuntimeAdmission(admissions, target, source, catalog, lifecycle => operation({ sessionId: source.sessionId, source, initialEmpty: false, affectedRuntimeIds: lifecycle.runtimeIds, roots, close: lifecycle.close, revalidate: async () => lifecycle.revalidate(), inspectWriters: async () => ({ safe: true }) }));
    },
    // Fixture-local rename models the effect boundary without using the operating-system Trash.
    trashItem: async target => { removed.push(target); await rename(target, join(trash, basename(target))); },
  };
  try {
    for (const directory of [resources, trash, workspace, ...Object.values(roots)]) await mkdir(directory, { recursive: true });
    await writeFile(path, bytes);
    await writeFile(join(resources, 'output.txt'), 'owned resource');
    await writeFile(join(root, 'unrelated.jsonl'), 'unrelated source bytes');
    await run({ path, root, bytes, resources, trash, removed, closed, dependencies });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('direct saved-target removal cannot bypass a remembered failed owned shutdown', async t => {
  const outcomes: RuntimeShutdownOutcome[] = [{ clean: false, forced: true, exitCode: 0 }, { clean: false, forced: false, exitCode: 1 }, { clean: true, forced: false, exitCode: 0, error: 'Persistence flush failed' }];
  for (const outcome of outcomes) await t.test(JSON.stringify(outcome), () => fixture(outcome, async f => {
    const runtimeTarget: SessionRemovalTarget = { kind: 'runtime', runtimeId: 'owned', sessionId: 'session' };
    const first = await removeSession(runtimeTarget, f.dependencies);
    assert.equal(first.sourceRemoved, false);
    assert.equal(first.disposition, 'retained');
    const saved = await removeSession({ kind: 'saved', path: f.path, sessionId: 'session' }, f.dependencies);
    assert.equal(saved.sourceRemoved, false);
    assert.equal(saved.disposition, 'retained');
    assert.deepEqual(saved.affectedRuntimeIds, ['owned']);
    assert.match(saved.errors.join('\n'), /shutdown was not clean/);
    assert.deepEqual(f.removed, []);
    assert.equal(await readFile(f.path, 'utf8'), f.bytes);
    assert.equal(await readFile(join(f.resources, 'output.txt'), 'utf8'), 'owned resource');
    assert.equal(await readFile(join(f.root, 'unrelated.jsonl'), 'utf8'), 'unrelated source bytes');
    assert.equal(f.closed.includes('unrelated'), false);
  }));
});

test('a genuinely saved-only binding does not inherit another path’s failed shutdown', async () => fixture({ clean: false, forced: true, exitCode: 1 }, async f => {
  const savedPath = join(f.root, 'saved-only.jsonl');
  await writeFile(savedPath, f.bytes);
  const result = await removeSession({ kind: 'saved', path: savedPath, sessionId: 'session' }, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.deepEqual(result.affectedRuntimeIds, []);
  assert.deepEqual(f.closed, []);
  assert.equal(await readFile(join(f.trash, basename(savedPath)), 'utf8'), f.bytes);
  assert.equal(await readFile(f.path, 'utf8'), f.bytes);
}));

test('a new matching runtime while waiting for the source barrier requires fresh admission', async () => {
  const admissions = new SessionAdmissions();
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const barrier = admissions.run('/source.jsonl', async () => { entered.resolve(); await held.promise; });
  await entered.promise;
  const identities: { runtimeId: string; sessionId: string; path: string }[] = [];
  const removal = withRemovalRuntimeAdmission(admissions, { kind: 'saved', sessionId: 'session', path: '/source.jsonl' }, { sessionId: 'session', path: '/source.jsonl' }, { identities: () => identities, close: async () => { throw new Error('A newly observed runtime must not be closed under the existing path admission'); } }, async () => { throw new Error('A changed ownership set must not reach mutation'); });
  const rejected = assert.rejects(removal, /Owned source bindings changed/);
  identities.push({ runtimeId: 'new-owner', sessionId: 'session', path: '/source.jsonl' });
  held.resolve();
  await Promise.all([barrier, rejected]);
});

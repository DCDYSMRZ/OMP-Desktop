import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CollectedTurnEvidence } from '../../shared/turn-change-types';
import { TurnSnapshotStore } from './turn-snapshots';
import { TurnChangeCoordinator, type CaptureRuntimeState } from './turn-change-coordinator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(inspect?: () => Promise<CaptureRuntimeState>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-turn-lifecycle-')));
  const store = new TurnSnapshotStore({ memorySample: () => ({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 }) });
  const owner: CaptureRuntimeState = { sessionId: 'session', sourcePath: '/sessions/one.jsonl', state: { sessionId: 'session', isStreaming: false, isSettled: true }, children: [] };
  const evidence: CollectedTurnEvidence = { id: 'turn', sessionId: 'session', cwd: root, sourcePath: owner.sourcePath, startEntryId: 'user', exactInterval: true, operations: [], toolCallIds: [], complete: true, reasons: [], pending: false };
  const observers = new Set<() => void>();
  const coordinator = new TurnChangeCoordinator({ store, inspect: inspect ?? (async () => owner), publish: () => { for (const observer of observers) observer(); } });
  const frame = (type: string, fields: Record<string, unknown> = {}) => coordinator.observe({ runtimeId: 'runtime', kind: 'frame', frame: { type, ...fields } });
  const observed = () => new Promise<void>(resolve => {
    const observer = () => { if (coordinator.result(evidence).observedAt !== undefined) { observers.delete(observer); resolve(); } };
    observers.add(observer); observer();
  });
  const prepare = async (extra: { sourcePath?: string; beforeEntryId?: string | null } = {}) => {
    const id = await coordinator.prepare({ runtimeId: 'runtime', sessionId: 'session', cwd: root, sourcePath: owner.sourcePath, idle: true, mode: 'prompt', ...extra });
    coordinator.accepted(id, {}); return id;
  };
  const user = () => { frame('message_start', { messageId: 'user', message: { role: 'user' } }); frame('message_end', { messageId: 'user', message: { role: 'user' } }); };
  return { root, store, owner, evidence, coordinator, frame, observed, prepare, user, observers, async close() { coordinator.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test('accepted tool-less turns match native user identity and immutable final membership', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'file'), 'before\n'); await f.prepare(); f.user();
    await writeFile(path.join(f.root, 'file'), 'after\n');
    const ready = f.observed(); f.frame('session_settled'); await ready;
    const result = f.coordinator.result(f.evidence);
    assert.equal(result.coverage.snapshot, 'complete'); assert.match(result.files[0]?.patch ?? '', /\+after/);
    f.coordinator.observe({ runtimeId: 'runtime', kind: 'exit', exitCode: 0 });
    f.frame('message_start', { messageId: 'later', message: { role: 'user' } });
    f.frame('tool_execution_start', { toolCallId: 'later-tool' });
    const later = f.coordinator.result(f.evidence);
    assert.deepEqual(later.files, result.files); assert.deepEqual(later.coverage, result.coverage);
    assert.equal(f.coordinator.result({ ...f.evidence, sourcePath: '/sessions/other.jsonl' }).coverage.snapshot, 'unavailable');
  } finally { await f.close(); }
});

test('durable pre-send branch boundary binds ID-less zero-tool turns but not a different boundary', async () => {
  const f = await fixture();
  try {
    f.evidence.startEntryId = undefined; f.evidence.beforeEntryId = 'leaf';
    await f.prepare({ beforeEntryId: 'leaf' });
    f.frame('message_start', { message: { role: 'user' } }); f.frame('message_end', { message: { role: 'user' } });
    await writeFile(path.join(f.root, 'created'), 'new\n');
    const ready = f.observed(); f.frame('session_settled'); await ready;
    assert.equal(f.coordinator.result(f.evidence).files[0]?.op, 'create');
    assert.equal(f.coordinator.result({ ...f.evidence, beforeEntryId: 'other' }).coverage.snapshot, 'unavailable');
  } finally { await f.close(); }
});

test('a new settlement signal during an old final inspection is drained rather than lost', async () => {
  const blocked = deferred<void>(), resume = deferred<void>();
  let inspections = 0;
  const owner: CaptureRuntimeState = { sessionId: 'session', sourcePath: '/sessions/one.jsonl', state: { sessionId: 'session', isStreaming: false, isSettled: true }, children: [] };
  const f = await fixture(async () => { if (++inspections === 2) { blocked.resolve(); await resume.promise; } return owner; });
  try {
    await writeFile(path.join(f.root, 'file'), 'before\n'); await f.prepare(); f.user();
    await writeFile(path.join(f.root, 'file'), 'first\n'); f.frame('session_settled'); await blocked.promise;
    await writeFile(path.join(f.root, 'file'), 'final\n');
    f.frame('tool_execution_end', { toolCallId: 'last' });
    const ready = f.observed(); f.frame('session_settled'); resume.resolve(); await ready;
    const result = f.coordinator.result(f.evidence);
    assert.match(result.files[0]?.patch ?? '', /\+final/); assert.doesNotMatch(result.files[0]?.patch ?? '', /\+first/);
    f.coordinator.forget(['runtime']); assert.equal(f.store.usage().metadataBytes, 0);
  } finally { resume.resolve(); await f.close(); }
});

test('forget during second inspection cannot resurrect an endpoint and frees provisional snapshots', async () => {
  const blocked = deferred<void>(), resume = deferred<void>();
  let inspections = 0;
  const owner: CaptureRuntimeState = { sessionId: 'session', sourcePath: '/sessions/one.jsonl', state: { sessionId: 'session', isStreaming: false, isSettled: true }, children: [] };
  const f = await fixture(async () => { if (++inspections === 2) { blocked.resolve(); await resume.promise; } return owner; });
  try {
    await f.prepare(); f.user(); await writeFile(path.join(f.root, 'file'), 'changed');
    f.frame('session_settled'); await blocked.promise; f.coordinator.forget(['runtime']); resume.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.coordinator.result(f.evidence).coverage.snapshot, 'unavailable');
    assert.equal(f.store.usage().metadataBytes, 0); assert.equal(f.store.usage().contentBytes, 0);
  } finally { resume.resolve(); await f.close(); }
});

test('failed second inspection releases its provisional final snapshot', async () => {
  let inspections = 0;
  const owner: CaptureRuntimeState = { sessionId: 'session', sourcePath: '/sessions/one.jsonl', state: { sessionId: 'session', isStreaming: false, isSettled: true }, children: [] };
  const f = await fixture(async () => { if (++inspections === 2) throw new Error('runtime closed'); return owner; });
  try {
    await f.prepare(); f.user(); await writeFile(path.join(f.root, 'file'), 'changed');
    const failed = deferred<void>();
    f.observers.add(() => { if (f.coordinator.result(f.evidence).coverage.reasons.some(reason => reason.includes('Final observation unavailable'))) failed.resolve(); });
    f.frame('session_settled'); await failed.promise; f.coordinator.forget(['runtime']);
    assert.equal(f.store.usage().metadataBytes, 0); assert.equal(f.store.usage().contentBytes, 0);
  } finally { await f.close(); }
});

test('possible-send rejection retains preimage for a bounded interrupted endpoint', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'file'), 'before\n'); const id = await f.prepare(); f.user();
    await writeFile(path.join(f.root, 'file'), 'after\n');
    const ready = f.observed(); f.coordinator.rejected(id, true); await ready;
    const result = f.coordinator.result(f.evidence);
    assert.equal(result.state, 'partial'); assert.match(result.files[0]?.patch ?? '', /-before/); assert.match(result.files[0]?.patch ?? '', /\+after/);
  } finally { await f.close(); }
});

test('same-session persisted source changes revoke capture rather than rebinding it', async () => {
  const f = await fixture();
  try {
    await f.prepare(); f.user();
    f.frame('state_snapshot', { state: { sessionId: 'session', sessionFile: '/sessions/replaced.jsonl' } });
    assert.equal(f.coordinator.result(f.evidence).coverage.snapshot, 'unavailable');
    assert.equal(f.store.usage().metadataBytes, 0);
  } finally { await f.close(); }
});

test('capture admission has a hard bound even when every retained interval is active', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 24; index++) assert.ok(await f.coordinator.prepare({ runtimeId: `run-${index}`, sessionId: `session-${index}`, cwd: f.root, idle: true, mode: 'prompt' }));
    const before = f.store.usage().metadataBytes;
    assert.equal(await f.coordinator.prepare({ runtimeId: 'overflow', sessionId: 'overflow', cwd: f.root, idle: true, mode: 'prompt' }), undefined);
    assert.equal(f.store.usage().metadataBytes, before);
    f.coordinator.forget(Array.from({ length: 24 }, (_, index) => `run-${index}`));
    assert.equal(f.store.usage().metadataBytes, 0);
  } finally { await f.close(); }
});

test('authorized symlink cwd fuses canonical hashes with native evidence and unreported shell changes', async () => {
  const f = await fixture();
  const alias = `${f.root}-alias`;
  try {
    await symlink(f.root, alias);
    await writeFile(path.join(f.root, 'restored'), 'original\n');
    f.evidence.cwd = alias;
    f.evidence.operations = [{ id: 'write', path: path.join(alias, 'restored'), operation: 'update', applied: 'confirmed', sequence: 1, before: 'original\n', after: 'intermediate\n', origin: { sessionId: 'session', toolId: 'write' } }];
    const id = await f.coordinator.prepare({ runtimeId: 'runtime', sessionId: 'session', cwd: alias, sourcePath: f.owner.sourcePath, idle: true, mode: 'prompt' });
    f.coordinator.accepted(id, {}); f.user();
    await writeFile(path.join(alias, 'shell'), 'unreported shell result\n');
    const ready = f.observed(); f.frame('session_settled'); await ready;
    const result = f.coordinator.result(f.evidence);
    assert.equal(result.coverage.snapshot, 'complete');
    assert.deepEqual(result.files.map(file => file.path), ['shell']);
    assert.equal(result.files[0]?.op, 'create');
    assert.match(result.files[0]?.patch ?? '', /\+unreported shell result/);
  } finally { await rm(alias, { force: true }); await f.close(); }
});

test('macOS native system-root spelling matches a canonical admitted cwd without widening source identity', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const nativeCwd = f.root.replace(/^\/private\/(?=(?:tmp|var|etc)(?:\/|$))/, '/');
    await writeFile(path.join(f.root, 'restored'), 'original\n');
    await f.prepare(); f.user();
    f.evidence.cwd = nativeCwd;
    f.evidence.operations = [{ id: 'write', path: path.join(nativeCwd, 'restored'), operation: 'update', applied: 'confirmed', sequence: 1, before: 'original\n', after: 'intermediate\n', origin: { sessionId: 'session', toolId: 'write' } }];
    await writeFile(path.join(f.root, 'shell'), 'shell result\n');
    const ready = f.observed(); f.frame('session_settled'); await ready;
    const result = f.coordinator.result(f.evidence);
    assert.equal(result.coverage.snapshot, 'complete');
    assert.deepEqual(result.files.map(file => file.path), ['shell']);
    assert.match(result.files[0]?.patch ?? '', /\+shell result/);
    assert.equal(f.coordinator.result({ ...f.evidence, cwd: `${nativeCwd}-other` }).coverage.snapshot, 'unavailable');
    assert.equal(f.coordinator.result({ ...f.evidence, sourcePath: '/sessions/other.jsonl' }).coverage.snapshot, 'unavailable');
  } finally { await f.close(); }
});

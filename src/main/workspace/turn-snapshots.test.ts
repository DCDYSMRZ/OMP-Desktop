import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSnapshotMemory, TurnSnapshotStore } from './turn-snapshots';

const plentiful = () => ({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 });

test('no-Git captures provide create, delete, update and equality endpoints', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-snapshots-')));
  const store = new TurnSnapshotStore({ memorySample: plentiful });
  try {
    await writeFile(path.join(root, 'same'), 'stable\n');
    await writeFile(path.join(root, 'edit'), 'before\n');
    await writeFile(path.join(root, 'delete'), 'gone\n');
    const before = await store.capture(root);
    await writeFile(path.join(root, 'edit'), 'after\n');
    await writeFile(path.join(root, 'create'), 'new\n');
    await rm(path.join(root, 'delete'));
    const after = await store.capture(root);
    assert.equal(before.complete, true); assert.equal(after.complete, true);
    const pairs = new Map(store.pairs(before, after).map(pair => [path.basename(pair.path), pair]));
    assert.deepEqual(pairs.get('create')?.before, { exists: false });
    assert.equal(pairs.get('create')?.after?.text, 'new\n');
    assert.deepEqual(pairs.get('delete')?.after, { exists: false });
    assert.equal(pairs.get('delete')?.before?.text, 'gone\n');
    assert.equal(pairs.get('same')?.before?.hash, pairs.get('same')?.after?.hash);
    assert.notEqual(pairs.get('edit')?.before?.hash, pairs.get('edit')?.after?.hash);
    assert.equal(pairs.get('edit')?.before?.text, 'before\n');
    assert.equal(pairs.get('edit')?.after?.text, 'after\n');
    store.releaseContent(before); store.releaseContent(after);
    const released = new Map(store.pairs(before, after).map(pair => [path.basename(pair.path), pair]));
    assert.equal(released.get('edit')?.before?.text, undefined);
    assert.equal(released.get('edit')?.before?.hash, pairs.get('edit')?.before?.hash);
    assert.equal(store.usage().contentBytes, 0);
  } finally { store.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('global pressure evicts text and result caches but preserves hash equality with delayed growth', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-snapshots-pressure-')));
  let availableBytes = 4 * 1024 ** 3;
  let now = 0;
  const options = { memorySample: () => ({ totalBytes: 8 * 1024 ** 3, availableBytes }), clock: () => now };
  const store = new TurnSnapshotStore(options);
  const sibling = new TurnSnapshotStore(options);
  try {
    await writeFile(path.join(root, 'file'), 'retained text');
    const before = await store.capture(root);
    const after = await store.capture(root);
    let evicted = false;
    const releaseResult = sibling.retainResult(1024, () => { evicted = true; });
    assert.ok(releaseResult);
    assert.equal(store.pairs(before, after)[0].before?.text, 'retained text');
    availableBytes = 0;
    const usage = sibling.usage();
    assert.equal(usage.contentBytes, 0); assert.equal(usage.budgetBytes, 0);
    assert.equal(evicted, true);
    const pair = store.pairs(before, after)[0];
    assert.equal(pair.before?.text, undefined); assert.equal(pair.after?.text, undefined);
    assert.match(pair.before?.hash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(pair.before?.hash, pair.after?.hash);
    const pressured = await store.capture(root);
    const hashOnly = store.pairs(before, pressured)[0];
    assert.equal(pressured.complete, true);
    assert.equal(hashOnly.after?.text, undefined);
    assert.equal(hashOnly.before?.hash, hashOnly.after?.hash);
    store.release(pressured);
    availableBytes = 4 * 1024 ** 3;
    assert.equal(store.usage().budgetBytes, 0); sibling.usage();
    now = 4999; assert.equal(store.usage().budgetBytes, 0);
    now = 5000; sibling.usage(); assert.ok(store.usage().budgetBytes > 0);
    releaseResult?.();
    store.release(before); store.release(after);
    assert.equal(store.usage().metadataBytes, 0);
  } finally { sibling.dispose(); store.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('incomplete or cancelled scans never fabricate deletion, while complete parent coverage proves it', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-snapshots-coverage-')));
  const store = new TurnSnapshotStore({ memorySample: plentiful, limits: { maxEntries: 1 } });
  try {
    await writeFile(path.join(root, 'one'), 'one');
    const before = await store.capture(root);
    await rm(path.join(root, 'one'));
    await writeFile(path.join(root, 'two'), 'two');
    await writeFile(path.join(root, 'three'), 'three');
    const incomplete = await store.capture(root);
    assert.equal(incomplete.complete, false);
    assert.equal(store.pairs(before, incomplete).find(pair => pair.path === path.join(root, 'one'))?.after, undefined);
    const controller = new AbortController(); controller.abort();
    const cancelled = await store.capture(root, { signal: controller.signal });
    assert.equal(cancelled.complete, false);
    assert.equal(store.pairs(before, cancelled)[0].after, undefined);
    await rm(path.join(root, 'two')); await rm(path.join(root, 'three'));
    const empty = await store.capture(root);
    assert.deepEqual(store.pairs(before, empty)[0].after, { exists: false });
  } finally { store.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('symlinks and generated paths are explicit scope gaps, never invented deletions', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-snapshots-links-')));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-snapshots-outside-')));
  const store = new TurnSnapshotStore({ memorySample: plentiful });
  try {
    await writeFile(path.join(root, 'file'), 'inside');
    await writeFile(path.join(outside, 'secret'), 'outside');
    const before = await store.capture(root);
    await rm(path.join(root, 'file'));
    await symlink(path.join(outside, 'secret'), path.join(root, 'file'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'node_modules', 'generated'), 'excluded');
    const after = await store.capture(root);
    assert.equal(after.complete, true);
    assert.ok(after.excluded.includes(path.join(root, 'file')));
    assert.ok(after.excluded.includes(path.join(root, 'node_modules')));
    assert.equal(store.pairs(before, after)[0].after, undefined);
  } finally { store.dispose(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('an opened file replaced by an escaping symlink does not publish stale or external bytes', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-snapshots-race-')));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-snapshots-race-out-')));
  let armed = false;
  let samples = 0;
  const file = path.join(root, 'file');
  const store = new TurnSnapshotStore({ memorySample: () => {
    // Deterministically replace the name at the scratch reservation, after open.
    if (armed && ++samples === 4) { renameSync(file, path.join(root, 'moved')); symlinkSync(path.join(outside, 'secret'), file); }
    return plentiful();
  } });
  try {
    await writeFile(file, 'inside'); await writeFile(path.join(outside, 'secret'), 'external secret');
    const before = await store.capture(root);
    armed = true;
    const after = await store.capture(root);
    assert.equal(after.complete, false);
    const endpoint = store.pairs(before, after).find(pair => pair.path === file)?.after;
    assert.equal(endpoint?.exists, true);
    assert.equal(endpoint?.hash, undefined); assert.equal(endpoint?.text, undefined);
    assert.ok(after.reasons.some(reason => reason.includes('changed during read')));
  } finally { store.dispose(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('oversized text is streamed to a hash without retaining content', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-snapshots-large-')));
  const store = new TurnSnapshotStore({ memorySample: plentiful, limits: { maxTextBytes: 8, chunkBytes: 4 } });
  try {
    await writeFile(path.join(root, 'large'), 'larger than eight bytes');
    const before = await store.capture(root);
    const after = await store.capture(root);
    const pair = store.pairs(before, after)[0];
    assert.equal(pair.before?.text, undefined);
    assert.match(pair.before?.hash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(pair.before?.hash, pair.after?.hash);
    assert.equal(store.usage().contentBytes, 0);
  } finally { store.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('Darwin memory samples count conservative purgeable headroom without forcing a floor', () => {
  const totalBytes = 8 * 1024 ** 3;
  assert.deepEqual(normalizeSnapshotMemory({ totalBytes, freeBytes: 0, electron: { free: 128, purgeable: 512 } }), { totalBytes, availableBytes: 256 * 1024 });
  assert.equal(normalizeSnapshotMemory({ totalBytes, freeBytes: 0, electron: { available: 0, free: 128, purgeable: 512 } }).availableBytes, 0);
  assert.equal(normalizeSnapshotMemory({ totalBytes, freeBytes: 0, electron: { free: 128, purgeable: -512 } }).availableBytes, 128 * 1024);
  assert.equal(normalizeSnapshotMemory({ totalBytes, freeBytes: 0, availableBytes: 64 * 1024, electron: { free: 128, purgeable: 512 } }).availableBytes, 256 * 1024);
});

test('missing or unsupported memory fields fall back without treating invalid values as headroom', () => {
  const totalBytes = 1024 ** 3;
  assert.equal(normalizeSnapshotMemory({ totalBytes, freeBytes: 4096, availableBytes: 8192, electron: {} }).availableBytes, 8192);
  assert.equal(normalizeSnapshotMemory({ totalBytes, freeBytes: 4096, availableBytes: Number.NaN }).availableBytes, 4096);
  assert.equal(normalizeSnapshotMemory({ totalBytes, freeBytes: 4096, availableBytes: 0 }).availableBytes, 0);
  assert.equal(normalizeSnapshotMemory({ totalBytes, freeBytes: -1, electron: { free: Number.NaN, purgeable: Number.POSITIVE_INFINITY } }).availableBytes, 0);
  assert.equal(normalizeSnapshotMemory({ totalBytes, freeBytes: 2 * totalBytes }).availableBytes, totalBytes);
});

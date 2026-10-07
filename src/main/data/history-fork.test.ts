import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { preflightArchiveFork, stageArchiveFork, type ArchiveForkSource } from './history-fork';
import { HistorySource, sourceRevision } from './history-source';

const jsonl = (...rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
const sourceId = 'original-native-session';
interface Fixture { root: string; path: string; artifacts: string; source: HistorySource; original: Buffer; transcript: string }
async function fixture(run: (value: Fixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omp-fork-test-')));
  const path = join(root, 'saved.jsonl.gz');
  const artifacts = join(root, 'saved');
  const transcript = jsonl({ type: 'session', version: 3, id: sourceId, cwd: root }, { type: 'message', id: 'one', parentId: null, message: { role: 'user', content: 'saved conversation' } });
  const original = gzipSync(transcript);
  await writeFile(path, original);
  const source = new HistorySource(path, sourceRevision(await stat(path, { bigint: true })));
  try {
    await mkdir(join(artifacts, 'nested'), { recursive: true });
    await mkdir(join(artifacts, 'empty'));
    await writeFile(join(artifacts, 'nested', 'result.gz'), gzipSync('opaque compressed artifact'));
    await writeFile(join(artifacts, 'run.sh'), '#!/bin/sh\necho preserved\n');
    await chmod(join(artifacts, 'run.sh'), 0o750);
    await run({ root, path, artifacts, source, original, transcript });
  } finally { source.close(); await rm(root, { recursive: true, force: true }); }
}

// Model the files returned by native initialization, not a substitute native runtime.
// The parent separately exercises the real --fork startup.
async function destination(fork: ArchiveForkSource, root: string): Promise<string> {
  const path = join(root, 'forked.jsonl');
  await writeFile(path, jsonl({ type: 'session', version: 3, id: 'new-native-session', parentSession: sourceId, cwd: root }));
  await cp(fork.path.slice(0, -6), path.slice(0, -6), { recursive: true });
  return path;
}

test('private staging preserves opaque artifacts and usable verification requires a new native identity', async () => fixture(async ({ root, path, artifacts, source, original, transcript }) => {
  const fork = await stageArchiveFork(source, artifacts, sourceId);
  const stage = dirname(fork.path);
  let created: string | undefined;
  try {
    assert.equal((await lstat(stage)).mode & 0o777, 0o700);
    assert.equal((await lstat(fork.path)).mode & 0o777, 0o600);
    assert.equal(await readFile(fork.path, 'utf8'), transcript);
    assert.deepEqual(await readFile(join(fork.path.slice(0, -6), 'nested', 'result.gz')), await readFile(join(artifacts, 'nested', 'result.gz')));
    created = await destination(fork, root);
    await fork.verify(created);
    assert.equal((await lstat(join(created.slice(0, -6), 'run.sh'))).mode & 0o777, 0o750);
    assert.equal((await lstat(join(created.slice(0, -6), 'empty'))).isDirectory(), true);
    assert.deepEqual(await readFile(path), original);
    assert.equal(sourceRevision(await stat(path, { bigint: true })), source.revision);
    assert.equal(await readFile(join(artifacts, 'run.sh'), 'utf8'), '#!/bin/sh\necho preserved\n');
  } finally { await fork.cleanup(); }
  await fork.cleanup();
  await assert.rejects(lstat(stage), { code: 'ENOENT' });
  await assert.rejects(fork.verify(created!), /already been cleaned/);
  assert.equal(await readFile(join(created!.slice(0, -6), 'run.sh'), 'utf8'), '#!/bin/sh\necho preserved\n');
}));

test('silently missing, altered, or linked native artifact copies cannot become usable', async t => {
  for (const damage of ['missing-file', 'same-size-corruption', 'missing-directory', 'escaping-link'] as const) {
    await t.test(damage, async () => fixture(async ({ root, artifacts, source, path, original }) => {
      const fork = await stageArchiveFork(source, artifacts, sourceId);
      let created: string | undefined;
      try {
        created = await destination(fork, root);
        const copied = join(created.slice(0, -6), 'nested', 'result.gz');
        if (damage === 'missing-file') await rm(copied);
        if (damage === 'same-size-corruption') { const bytes = await readFile(copied); bytes[0] = bytes[0]! ^ 0xff; await writeFile(copied, bytes); }
        if (damage === 'missing-directory') await rm(join(created.slice(0, -6), 'empty'), { recursive: true });
        if (damage === 'escaping-link') { await rm(copied); await symlink(join(artifacts, 'nested', 'result.gz'), copied); }
        await assert.rejects(fork.verify(created));
      } finally { await fork.cleanup(); }
      assert.deepEqual(await readFile(path), original);
      assert.equal(JSON.parse((await readFile(created!, 'utf8')).trim()).id, 'new-native-session');
    }));
  }
});

test('a reused identity, unrelated parent, or private temporary destination is not a native cutover', async () => fixture(async ({ root, artifacts, source }) => {
  const fork = await stageArchiveFork(source, artifacts, sourceId);
  try {
    const created = await destination(fork, root);
    await writeFile(created, jsonl({ type: 'session', id: sourceId, parentSession: sourceId, cwd: root }));
    await assert.rejects(fork.verify(created), /new durable session/);
    await writeFile(created, jsonl({ type: 'session', id: 'new-native-session', parentSession: 'unrelated', cwd: root }));
    await assert.rejects(fork.verify(created), /parent identity/);
    await assert.rejects(fork.verify(fork.path), /distinct durable destination/);
  } finally { await fork.cleanup(); }
}));

test('archive and nested artifact revisions must remain unchanged through native initialization', async t => {
  for (const changed of ['source', 'nested-file', 'directory-membership'] as const) {
    await t.test(changed, async () => fixture(async ({ root, path, artifacts, source, transcript }) => {
      const fork = await stageArchiveFork(source, artifacts, sourceId);
      try {
        const created = await destination(fork, root);
        if (changed === 'source') await writeFile(path, gzipSync(`${transcript}\n`));
        if (changed === 'nested-file') await writeFile(join(artifacts, 'nested', 'result.gz'), 'changed externally');
        if (changed === 'directory-membership') await writeFile(join(artifacts, 'added'), 'new source artifact');
        await assert.rejects(fork.verify(created), /changed during fork/);
      } finally { await fork.cleanup(); }
    }));
  }
});

test('escaping source symlinks and oversized sparse artifacts are rejected before native startup', async t => {
  await t.test('symlink', async () => fixture(async ({ root, artifacts, source, path, original }) => {
    const external = join(root, 'external');
    await writeFile(external, 'not authorized as an artifact');
    await symlink(external, join(artifacts, 'escape'));
    await assert.rejects(stageArchiveFork(source, artifacts, sourceId), /symbolic link/);
    assert.equal(await readFile(external, 'utf8'), 'not authorized as an artifact');
    assert.deepEqual(await readFile(path), original);
  }));
  await t.test('byte bound', async () => fixture(async ({ artifacts, source, path, original }) => {
    const file = await open(join(artifacts, 'huge'), 'wx');
    try { await file.truncate(512 * 1024 * 1024 + 1); } finally { await file.close(); }
    await assert.rejects(stageArchiveFork(source, artifacts, sourceId), /512 MiB artifact staging limit/);
    assert.equal((await stat(join(artifacts, 'huge'))).size, 512 * 1024 * 1024 + 1);
    assert.deepEqual(await readFile(path), original);
  }));
  await t.test('preflight byte bound', async () => fixture(async ({ artifacts, source, path, original }) => {
    const file = await open(join(artifacts, 'huge'), 'wx');
    try { await file.truncate(512 * 1024 * 1024 + 1); } finally { await file.close(); }
    await assert.rejects(preflightArchiveFork(source, artifacts), /512 MiB artifact staging limit/);
    assert.deepEqual(await readFile(path), original);
  }));
  await t.test('preflight symlink', async () => fixture(async ({ root, artifacts, source }) => {
    const outside = join(root, 'outside');
    await writeFile(outside, 'PRIVATE');
    await symlink(outside, join(artifacts, 'escape'));
    await assert.rejects(preflightArchiveFork(source, artifacts), /symbolic link/);
    assert.equal(await readFile(outside, 'utf8'), 'PRIVATE');
  }));
});

test('a previously absent artifact root cannot appear unnoticed during native initialization', async () => fixture(async ({ root, artifacts, source }) => {
  await rm(artifacts, { recursive: true });
  const fork = await stageArchiveFork(source, artifacts, sourceId);
  try {
    const created = join(root, 'forked.jsonl');
    await writeFile(created, jsonl({ type: 'session', id: 'new-native-session', parentSession: sourceId, cwd: root }));
    await fork.verify(created);
    await mkdir(artifacts);
    await writeFile(join(artifacts, 'late'), 'appeared externally');
    await assert.rejects(fork.verify(created), /artifact root appeared/);
  } finally { await fork.cleanup(); }
  assert.equal(await readFile(join(artifacts, 'late'), 'utf8'), 'appeared externally');
}));

test('cleanup refuses a replaced staging directory and never deletes unrelated replacement contents', async () => fixture(async ({ root, artifacts, source, path, original }) => {
  const fork = await stageArchiveFork(source, artifacts, sourceId);
  const stage = dirname(fork.path);
  const retained = join(root, 'retained-staging');
  await rename(stage, retained);
  try {
    await mkdir(stage);
    await writeFile(join(stage, 'unrelated'), 'replacement contents');
    await assert.rejects(fork.cleanup(), /unowned path/);
    assert.equal(await readFile(join(stage, 'unrelated'), 'utf8'), 'replacement contents');
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rename(retained, stage);
    await fork.cleanup();
  }
  assert.deepEqual(await readFile(path), original);
}));

test('canonical parent aliases remain usable without authorizing leaf symlinks', async () => fixture(async ({ root, path, artifacts, source }) => {
  const alias = join(root, 'alias');
  await symlink(root, alias);
  const aliasSource = new HistorySource(join(alias, 'saved.jsonl.gz'), source.revision);
  const fork = await stageArchiveFork(aliasSource, join(alias, 'saved'), sourceId);
  try {
    const created = await destination(fork, root);
    await fork.verify(join(alias, 'forked.jsonl'));
    assert.equal(JSON.parse((await readFile(created, 'utf8')).trim()).parentSession, sourceId);
  } finally { aliasSource.close(); await fork.cleanup(); }
  const linked = join(root, 'linked.jsonl.gz');
  await symlink(path, linked);
  const linkedSource = new HistorySource(linked, source.revision);
  try { await assert.rejects(stageArchiveFork(linkedSource, artifacts, sourceId), /symbolic link/); }
  finally { linkedSource.close(); }
}));

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { SessionRemovalTarget } from '../../shared/contracts';
import { removeSession, requireRemovalAccess, type RemovalAuthorization, type SessionRemovalDependencies } from './session-removal';

const timestamp = '2026-09-26T12:00:00.000Z';
const id = 'owned-session';
interface Fixture { root: string; path: string; resources: string; bytes: string; auth: RemovalAuthorization; dependencies: SessionRemovalDependencies; saved: SessionRemovalTarget; runtime: SessionRemovalTarget; moved: string[]; trash: string }
async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omp-removal-test-')));
  const roots = { sessions: join(root, 'sessions'), archives: join(root, 'archive', 'sessions'), registry: join(root, 'custom-session-files') };
  const bucket = join(roots.sessions, '--workspace--');
  const path = join(bucket, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const resources = path.slice(0, -6);
  const trash = join(root, 'fixture-trash');
  const bytes = `${JSON.stringify({ type: 'session', version: 3, id, cwd: root, timestamp })}\n`;
  const moved: string[] = [];
  const auth: RemovalAuthorization = { sessionId: id, source: { status: 'persisted', path }, initialEmpty: false, affectedRuntimeIds: ['runtime'], roots, revalidate: async () => {}, inspectWriters: async () => ({ safe: true }) };
  // Real renames inside the fixture model successful Trash without executing OS Trash.
  const dependencies: SessionRemovalDependencies = { withAdmission: async (_target, callback) => callback(auth), trashItem: async target => { await rename(target, join(trash, basename(target))); moved.push(target); } };
  try {
    for (const directory of [bucket, roots.archives, roots.registry, resources, trash]) await mkdir(directory, { recursive: true });
    await writeFile(path, bytes);
    await writeFile(join(resources, 'result.txt'), 'owned tool output');
    await run({ root, path, resources, bytes, auth, dependencies, saved: { kind: 'saved', path, sessionId: id }, runtime: { kind: 'runtime', runtimeId: 'runtime', sessionId: id }, moved, trash });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('source moves before exclusive resources, own backup and exact registration; unrelated data survives', async () => fixture(async f => {
  const backup = `${f.path}.0123456789abcdef.bak`;
  const unrelated = join(dirname(f.path), 'unrelated.jsonl.rewrite.bak');
  const marker = join(f.auth.roots.registry, 'exact-marker');
  const other = join(f.root, 'custom-other');
  const otherMarker = join(f.auth.roots.registry, 'other-marker');
  await writeFile(backup, f.bytes);
  await writeFile(unrelated, 'unrelated backup');
  await writeFile(marker, f.path);
  await writeFile(other, `${JSON.stringify({ type: 'session', id: 'other', cwd: f.root })}\n`);
  await writeFile(otherMarker, other);
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'trashed');
  assert.equal(result.sourceRemoved, true);
  assert.deepEqual(f.moved, [f.path, f.resources, backup, marker]);
  assert.equal(await readFile(join(f.trash, basename(f.path)), 'utf8'), f.bytes);
  assert.equal(await readFile(join(f.trash, basename(f.resources), 'result.txt'), 'utf8'), 'owned tool output');
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated backup');
  assert.equal(await readFile(otherMarker, 'utf8'), other);
}));

test('primary Trash failure retains every source and resource byte', async () => fixture(async f => {
  f.dependencies.trashItem = async () => { throw new Error('Trash unavailable'); };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'retained');
  assert.equal(result.sourceRemoved, false);
  assert.equal(await readFile(f.path, 'utf8'), f.bytes);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.deepEqual(result.trashed, []);
  assert.ok(result.errors.some(error => error.includes('Trash unavailable')));
}));

test('ancillary failure is partial and does not pretend to restore the removed source', async () => fixture(async f => {
  const move = f.dependencies.trashItem;
  f.dependencies.trashItem = async path => { if (path === f.resources) throw new Error('Tree Trash denied'); await move(path); };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'partial');
  assert.equal(result.sourceRemoved, true);
  await assert.rejects(lstat(f.path), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('Tree Trash denied')));
}));

test('foreign and unknown admission never close the runtime or touch its data', async t => {
  for (const access of ['foreign', 'unknown']) await t.test(access, async () => fixture(async f => {
    let closed = false;
    f.auth.revalidate = async () => { throw new Error(`${access} occupancy`); };
    f.auth.close = async () => { closed = true; return { clean: true, forced: false, exitCode: 0 }; };
    const result = await removeSession(f.runtime, f.dependencies);
    assert.equal(result.disposition, 'retained');
    assert.equal(closed, false);
    assert.equal(await readFile(f.path, 'utf8'), f.bytes);
    assert.deepEqual(f.moved, []);
  }));
});

test('forced, nonzero and persistence-error shutdown outcomes retain source and resources', async t => {
  for (const outcome of [{ clean: false, forced: true, exitCode: 0 }, { clean: false, forced: false, exitCode: 1 }, { clean: true, forced: false, exitCode: 0, error: 'flush failed' }]) await t.test(JSON.stringify(outcome), async () => fixture(async f => {
    f.auth.close = async () => outcome;
    const result = await removeSession(f.runtime, f.dependencies);
    assert.equal(result.disposition, 'retained');
    assert.deepEqual(result.affectedRuntimeIds, ['runtime']);
    assert.equal(await readFile(f.path, 'utf8'), f.bytes);
    assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  }));
});

test('only exact initial absence is discard, and shutdown materialization follows persisted removal', async t => {
  for (const materialize of [false, true]) await t.test(String(materialize), async () => fixture(async f => {
    await rm(f.path);
    f.auth.source.status = 'unpersisted';
    f.auth.initialEmpty = true;
    f.auth.close = async () => { if (materialize) await writeFile(f.path, f.bytes); return { clean: true, forced: false, exitCode: 0 }; };
    const result = await removeSession(f.runtime, f.dependencies);
    assert.equal(result.disposition, materialize ? 'trashed' : 'discarded');
    assert.equal(result.sourceRemoved, true);
    assert.deepEqual(f.moved, materialize ? [f.path, f.resources] : []);
    if (!materialize) assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  }));
  await t.test('missing persisted source', async () => fixture(async f => {
    await rm(f.path);
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.disposition, 'retained');
    assert.equal(result.sourceRemoved, false);
  }));
});

test('identity mismatches, symlinks and shutdown replacement never gain deletion authority', async t => {
  for (const kind of ['identity', 'symlink', 'replacement']) await t.test(kind, async () => fixture(async f => {
    const original = join(f.root, 'original');
    if (kind === 'identity') f.auth.sessionId = 'different';
    if (kind === 'symlink') { await rename(f.path, original); await symlink(original, f.path); }
    f.auth.close = async () => {
      if (kind === 'replacement') { await rename(f.path, original); await writeFile(f.path, f.bytes); }
      return { clean: true, forced: false, exitCode: 0 };
    };
    const result = await removeSession(f.runtime, f.dependencies);
    assert.equal(result.disposition, 'retained');
    assert.equal(await readFile(f.path, 'utf8'), f.bytes);
    assert.deepEqual(f.moved, []);
  }));
});

test('same-stem gzip, moved aliases, fork references and archive/custom sources retain uncertain roots', async t => {
  for (const boundary of ['gzip', 'move', 'fork', 'reference', 'archive', 'custom']) await t.test(boundary, async () => fixture(async f => {
    let sourcePath = f.path;
    let retainedRoot = f.resources;
    if (boundary === 'gzip') await writeFile(`${f.path}.gz`, gzipSync(f.bytes));
    if (boundary === 'move' || boundary === 'fork') {
      const header = JSON.parse(f.bytes);
      if (boundary === 'move') header.previousSessionFiles = [join(f.root, 'older.jsonl')];
      else header.parentSession = 'original-parent';
      await writeFile(f.path, `${JSON.stringify(header)}\n`);
    }
    if (boundary === 'reference') await writeFile(join(dirname(f.path), 'fork.jsonl'), `${JSON.stringify({ type: 'session', id: 'fork', cwd: f.root, parentSession: id })}\n`);
    if (boundary === 'archive' || boundary === 'custom') {
      sourcePath = boundary === 'archive' ? join(f.auth.roots.archives, basename(f.path)) : join(f.root, 'custom-conversation');
      await rename(f.path, sourcePath);
      if (boundary === 'archive') { retainedRoot = sourcePath.slice(0, -6); await rename(f.resources, retainedRoot); }
      else retainedRoot = f.root;
      f.auth.source.path = sourcePath;
    }
    const result = await removeSession({ kind: 'saved', path: sourcePath, sessionId: id }, f.dependencies);
    assert.equal(result.sourceRemoved, true);
    assert.equal(result.disposition, 'partial');
    assert.ok(result.retained.some(item => item.path === retainedRoot));
    if (boundary === 'reference') assert.ok(result.retained.some(item => item.path === retainedRoot && item.kind === 'companion' && item.reasonCode === 'shared'));
    assert.equal((await lstat(retainedRoot)).isDirectory(), true);
    if (boundary === 'gzip') assert.deepEqual(await readFile(`${f.path}.gz`), gzipSync(f.bytes));
  }));
});

test('linked resources and active artifact writers retain the whole tree without suppressing source removal', async t => {
  for (const reason of ['symlink', 'writer']) await t.test(reason, async () => fixture(async f => {
    const unrelated = join(f.root, 'workspace-output');
    await writeFile(unrelated, 'workspace is not ours');
    if (reason === 'symlink') await symlink(unrelated, join(f.resources, 'external'));
    else f.auth.inspectWriters = async (_path, tree) => tree ? { safe: false, reason: 'foreign artifact writer' } : { safe: true };
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.disposition, 'partial');
    assert.equal(result.sourceRemoved, true);
    assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
    assert.equal(await readFile(unrelated, 'utf8'), 'workspace is not ours');
  }));
});

test('a new referencing journal after primary Trash invalidates the resource plan', async () => fixture(async f => {
  const move = f.dependencies.trashItem;
  f.dependencies.trashItem = async path => {
    await move(path);
    if (path === f.path) await writeFile(join(dirname(f.path), 'concurrent-fork.jsonl'), `${JSON.stringify({ type: 'session', id: 'new-fork', parentSession: id, cwd: f.root })}\n`);
  };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'partial');
  assert.equal(result.sourceRemoved, true);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.ok(result.retained.some(item => item.reason.includes('discovery changed')));
}));

test('a replaced source during final access observation is never trashed', async () => fixture(async f => {
  const original = join(f.root, 'original');
  f.auth.inspectWriters = async (path, tree) => {
    if (path === f.path && !tree) { await rename(f.path, original); await writeFile(f.path, f.bytes); }
    return { safe: true };
  };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'retained');
  assert.equal(await readFile(f.path, 'utf8'), f.bytes);
  assert.equal(await readFile(original, 'utf8'), f.bytes);
  assert.deepEqual(f.moved, []);
}));

test('clean shutdown may flush the same journal before its final identity-bound removal', async () => fixture(async f => {
  const flushed = `${f.bytes}${JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'final persisted answer' } })}\n`;
  f.auth.close = async () => { await writeFile(f.path, flushed); return { clean: true, forced: false, exitCode: 0 }; };
  const result = await removeSession(f.runtime, f.dependencies);
  assert.equal(result.disposition, 'trashed');
  assert.deepEqual(result.affectedRuntimeIds, ['runtime']);
  assert.equal(await readFile(join(f.trash, basename(f.path)), 'utf8'), flushed);
}));

test('a recorded workspace inside the apparent resource tree is never removed', async () => fixture(async f => {
  await writeFile(f.path, `${JSON.stringify({ ...JSON.parse(f.bytes), cwd: f.resources })}\n`);
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'partial');
  assert.equal(result.sourceRemoved, true);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('workspace')));
}));

test('source recreation after Trash retains resources for the new writer', async () => fixture(async f => {
  const move = f.dependencies.trashItem;
  f.dependencies.trashItem = async path => { await move(path); if (path === f.path) await writeFile(path, f.bytes); };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'partial');
  assert.equal(await readFile(f.path, 'utf8'), f.bytes);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('reappeared')));
}));

test('external workspace aliases protect selected and other session workspaces', async t => {
  for (const owner of ['selected', 'other']) await t.test(owner, async () => fixture(async f => {
    const alias = join(f.root, 'workspace-alias');
    await symlink(f.resources, alias);
    if (owner === 'selected') await writeFile(f.path, `${JSON.stringify({ ...JSON.parse(f.bytes), cwd: alias })}\n`);
    else await writeFile(join(dirname(f.path), 'other.jsonl'), `${JSON.stringify({ type: 'session', id: 'other', cwd: alias })}\n`);
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.sourceRemoved, true);
    assert.equal(result.disposition, 'partial');
    assert.equal(await readFile(join(alias, 'result.txt'), 'utf8'), 'owned tool output');
    assert.ok(result.retained.some(item => item.path === f.resources && /workspace/i.test(item.reason)));
  }));
});

test('workspace aliases are identity-bound again after asynchronous writer inspection', async () => fixture(async f => {
  const alias = join(f.root, 'workspace-alias');
  const safeWorkspace = join(f.root, 'separate-workspace');
  await mkdir(safeWorkspace);
  await symlink(safeWorkspace, alias);
  await writeFile(f.path, `${JSON.stringify({ ...JSON.parse(f.bytes), cwd: alias })}\n`);
  let probes = 0;
  f.auth.inspectWriters = async (_path, tree) => {
    if (tree && ++probes === 2) { await rm(alias); await symlink(f.resources, alias); }
    return { safe: true };
  };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'partial');
  assert.equal(result.sourceRemoved, true);
  assert.equal(await readFile(join(alias, 'result.txt'), 'utf8'), 'owned tool output');
  assert.ok(result.retained.some(item => item.path === f.resources && /workspace/i.test(item.reason)));
}));

test('missing recorded workspaces do not retain exclusive companion files', async t => {
  for (const owner of ['selected', 'other']) await t.test(owner, async () => fixture(async f => {
    const cwd = join(f.root, 'deleted-workspace', 'nested');
    if (owner === 'selected') await writeFile(f.path, `${JSON.stringify({ ...JSON.parse(f.bytes), cwd })}\n`);
    else await writeFile(join(dirname(f.path), 'other.jsonl'), `${JSON.stringify({ type: 'session', id: 'other', cwd })}\n`);
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.disposition, 'trashed');
    assert.deepEqual(f.moved, [f.path, f.resources]);
    assert.equal(await readFile(join(f.trash, basename(f.resources), 'result.txt'), 'utf8'), 'owned tool output');
  }));
});

test('dangling workspace aliases remain uncertain rather than proving absence', async t => {
  for (const nested of [false, true]) await t.test(String(nested), async () => fixture(async f => {
    const alias = join(f.root, 'dangling-workspace');
    await symlink(join(f.root, 'missing-target'), alias);
    await writeFile(f.path, `${JSON.stringify({ ...JSON.parse(f.bytes), cwd: nested ? join(alias, 'nested') : alias })}\n`);
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.disposition, 'partial');
    assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  }));
});

test('a missing workspace that reappears as a resource alias cannot authorize removal', async () => fixture(async f => {
  const cwd = join(f.root, 'missing-workspace');
  await writeFile(f.path, `${JSON.stringify({ ...JSON.parse(f.bytes), cwd })}\n`);
  f.auth.inspectWriters = async (_path, tree) => { if (tree) await symlink(f.resources, cwd); return { safe: true }; };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'partial');
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
}));

test('source recreation during the second resource writer probe vetoes tree removal', async () => fixture(async f => {
  let treeProbes = 0;
  f.auth.inspectWriters = async (_path, tree) => {
    if (tree && ++treeProbes === 2) await writeFile(f.path, f.bytes);
    return { safe: true };
  };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'partial');
  assert.equal(result.sourceRemoved, true);
  assert.equal(await readFile(f.path, 'utf8'), f.bytes);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.deepEqual(f.moved, [f.path]);
  assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('reappeared')));
}));

test('registered same-ID backup-shaped sources and their markers survive removal', async t => {
  for (const suffix of ['rewrite', '0123456789abcdef']) await t.test(suffix, async () => fixture(async f => {
    const backup = `${f.path}.${suffix}.bak`;
    const marker = join(f.auth.roots.registry, 'separate-source');
    await writeFile(backup, f.bytes);
    await writeFile(marker, backup);
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.sourceRemoved, true);
    assert.equal(result.disposition, 'partial');
    assert.equal(await readFile(backup, 'utf8'), f.bytes);
    assert.equal(await readFile(marker, 'utf8'), backup);
    assert.ok(result.retained.some(item => item.path === backup));
    assert.equal(result.trashed.includes(backup), false);
  }));
});

test('native-named backup referenced by a different source remains outside removal authority', async () => fixture(async f => {
  const backup = `${f.path}.0123456789abcdef.bak`;
  const other = join(dirname(f.path), 'other.jsonl');
  await writeFile(backup, f.bytes);
  await writeFile(other, `${JSON.stringify({ type: 'session', id: 'other', cwd: f.root, previousSessionFiles: [backup] })}\n`);
  const otherBytes = await readFile(other);
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.equal(result.disposition, 'partial');
  assert.equal(await readFile(backup, 'utf8'), f.bytes);
  assert.deepEqual(await readFile(other), otherBytes);
  assert.ok(result.retained.some(item => item.path === backup && item.reason.includes('referenced')));
}));

test('new registration during backup writer inspection invalidates ancillary ownership', async () => fixture(async f => {
  const backup = `${f.path}.0123456789abcdef.bak`;
  const marker = join(f.auth.roots.registry, 'new-custom-source');
  await writeFile(backup, f.bytes);
  let backupProbes = 0;
  f.auth.inspectWriters = async path => {
    if (path === backup && ++backupProbes === 2) await writeFile(marker, backup);
    return { safe: true };
  };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.equal(result.disposition, 'partial');
  assert.equal(await readFile(backup, 'utf8'), f.bytes);
  assert.equal(await readFile(marker, 'utf8'), backup);
  assert.ok(result.retained.some(item => item.path === backup && item.reason.includes('registered')));
}));

test('gzip framing cannot exceed the compressed-input discovery budget', async () => fixture(async f => {
  const archive = join(f.auth.roots.archives, 'framing.jsonl.gz');
  const header = gzipSync(`${JSON.stringify({ type: 'session', id: 'archive', cwd: f.root })}\n`);
  const emptyMember = gzipSync('');
  const framing = Buffer.concat([header, ...Array<Buffer>(60000).fill(emptyMember)]);
  await writeFile(archive, framing);
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.equal(result.disposition, 'partial');
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.deepEqual(await readFile(archive), framing);
  assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('Compressed header input')));
}));

test('backup references at and beyond the display-lineage limit cannot disappear from removal authority', async t => {
  for (const precedingAliases of [999, 1000]) await t.test(String(precedingAliases), async () => fixture(async f => {
    const backup = `${f.path}.0123456789abcdef.bak`;
    const other = join(dirname(f.path), 'long-lineage.jsonl');
    const aliases = [...Array<string>(precedingAliases).fill('/missing'), backup];
    const header = `${JSON.stringify({ type: 'session', id: 'other', cwd: f.root, previousSessionFiles: aliases })}\n`;
    assert.ok(Buffer.byteLength(header) < 64 * 1024);
    await writeFile(backup, f.bytes);
    await writeFile(other, header);
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.sourceRemoved, true);
    assert.equal(result.disposition, 'partial');
    assert.equal(await readFile(backup, 'utf8'), f.bytes);
    assert.equal(await readFile(other, 'utf8'), header);
    assert.equal(result.trashed.includes(backup), false);
    assert.ok(result.retained.some(item => item.path === backup && (precedingAliases === 999 ? item.reason.includes('referenced') : item.reason.includes('provenance'))));
  }));
});

test('trusted configured root aliases preserve canonical source, tree, backup and registration authority', async t => {
  for (const kind of ['parent-alias', 'root-alias']) await t.test(kind, async () => fixture(async f => {
    const actualRoots = { ...f.auth.roots };
    if (kind === 'parent-alias') {
      const alias = join(f.root, 'configured-profile');
      await symlink(f.root, alias);
      f.auth.roots = { sessions: join(alias, 'sessions'), archives: join(alias, 'archive', 'sessions'), registry: join(alias, 'custom-session-files') };
    } else {
      for (const category of ['sessions', 'archives', 'registry'] as const) {
        const alias = join(f.root, `configured-${category}`);
        await symlink(actualRoots[category], alias);
        f.auth.roots[category] = alias;
      }
    }
    const backup = `${f.path}.0123456789abcdef.bak`;
    const marker = join(actualRoots.registry, 'owned-source');
    await writeFile(backup, f.bytes);
    await writeFile(marker, f.path);
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.disposition, 'trashed');
    assert.equal(result.sourceRemoved, true);
    assert.deepEqual(f.moved, [f.path, f.resources, backup, marker]);
    assert.equal(await readFile(join(f.trash, basename(f.path)), 'utf8'), f.bytes);
    assert.equal(await readFile(join(f.trash, basename(f.resources), 'result.txt'), 'utf8'), 'owned tool output');
    assert.equal(await readFile(join(f.trash, basename(backup)), 'utf8'), f.bytes);
    assert.equal(await readFile(join(f.trash, basename(marker)), 'utf8'), f.path);
  }));
});

test('retargeting a trusted configured alias after writer inspection retains original ancillary data', async () => fixture(async f => {
  const actualRoots = { ...f.auth.roots };
  const alias = join(f.root, 'configured-profile');
  const alternate = join(f.root, 'alternate-profile');
  const alternateFile = join(alternate, 'untouched');
  await mkdir(alternate);
  await writeFile(alternateFile, 'other profile');
  await symlink(f.root, alias);
  f.auth.roots = { sessions: join(alias, 'sessions'), archives: join(alias, 'archive', 'sessions'), registry: join(alias, 'custom-session-files') };
  const backup = `${f.path}.0123456789abcdef.bak`;
  const marker = join(actualRoots.registry, 'owned-source');
  await writeFile(backup, f.bytes);
  await writeFile(marker, f.path);
  let probes = 0;
  f.auth.inspectWriters = async (_path, tree) => {
    if (tree && ++probes === 2) { await rm(alias); await symlink(alternate, alias); }
    return { safe: true };
  };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.equal(result.disposition, 'partial');
  assert.deepEqual(f.moved, [f.path]);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.equal(await readFile(backup, 'utf8'), f.bytes);
  assert.equal(await readFile(marker, 'utf8'), f.path);
  assert.equal(await readFile(alternateFile, 'utf8'), 'other profile');
  assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('Configured discovery root')));
}));

test('replacing a configured directory at the same canonical path revokes ancillary authority', async () => fixture(async f => {
  const registry = f.auth.roots.registry;
  const originalRegistry = join(f.root, 'original-registry');
  const backup = `${f.path}.0123456789abcdef.bak`;
  await writeFile(backup, f.bytes);
  let probes = 0;
  f.auth.inspectWriters = async (_path, tree) => {
    if (tree && ++probes === 2) { await rename(registry, originalRegistry); await mkdir(registry); }
    return { safe: true };
  };
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.equal(result.disposition, 'partial');
  assert.deepEqual(f.moved, [f.path]);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.equal(await readFile(backup, 'utf8'), f.bytes);
  assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('Configured discovery root')));
}));

test('path-valued parent and move provenance through configured aliases preserve shared resources', async t => {
  for (const field of ['parentSession', 'previousSessionFiles']) await t.test(field, async () => fixture(async f => {
    const alias = join(f.root, 'configured-profile');
    await symlink(f.root, alias);
    f.auth.roots = { sessions: join(alias, 'sessions'), archives: join(alias, 'archive', 'sessions'), registry: join(alias, 'custom-session-files') };
    const reference = join(f.auth.roots.sessions, basename(dirname(f.path)), basename(f.path));
    const other = join(dirname(f.path), 'referring-session.jsonl');
    const otherBytes = `${JSON.stringify({ type: 'session', id: 'different-session', cwd: f.root, [field]: field === 'parentSession' ? reference : [reference] })}\n`;
    await writeFile(other, otherBytes);
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.sourceRemoved, true);
    assert.equal(result.disposition, 'partial');
    assert.deepEqual(f.moved, [f.path]);
    assert.equal(await readFile(other, 'utf8'), otherBytes);
    assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
    assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('reference')));
  }));
});

test('uncertain path provenance retains the resource tree instead of treating absence as nonsharing', async t => {
  for (const kind of ['dangling-alias', 'missing-parent']) await t.test(kind, async () => fixture(async f => {
    const missingParent = join(f.root, 'unavailable-parent');
    const alias = join(f.root, 'unresolved-provenance');
    if (kind === 'dangling-alias') await symlink(missingParent, alias);
    const reference = join(kind === 'dangling-alias' ? alias : missingParent, basename(f.path));
    const other = join(dirname(f.path), 'uncertain-session.jsonl');
    const otherBytes = `${JSON.stringify({ type: 'session', id: 'different-session', cwd: f.root, parentSession: reference })}\n`;
    await writeFile(other, otherBytes);
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.sourceRemoved, true);
    assert.equal(result.disposition, 'partial');
    assert.deepEqual(f.moved, [f.path]);
    assert.equal(await readFile(other, 'utf8'), otherBytes);
    assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
    assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('provenance')));
  }));
});

test('provenance retargeted to the removed primary remains a veto after writer inspection', async t => {
  for (const field of ['parentSession', 'previousSessionFiles']) await t.test(field, async () => fixture(async f => {
    const independent = join(f.root, 'independent');
    const alias = join(f.root, 'provenance-alias');
    await mkdir(independent);
    const independentSource = join(independent, basename(f.path));
    const independentBytes = `${JSON.stringify({ type: 'session', id: 'unrelated', cwd: f.root })}\n`;
    await writeFile(independentSource, independentBytes);
    await symlink(independent, alias);
    const reference = join(alias, basename(f.path));
    const other = join(dirname(f.path), 'retargeted-session.jsonl');
    const otherBytes = `${JSON.stringify({ type: 'session', id: 'different-session', cwd: f.root, [field]: field === 'parentSession' ? reference : [reference] })}\n`;
    await writeFile(other, otherBytes);
    let probes = 0;
    f.auth.inspectWriters = async (_path, tree) => {
      if (tree && ++probes === 2) { await rm(alias); await symlink(dirname(f.path), alias); }
      return { safe: true };
    };
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.sourceRemoved, true);
    assert.equal(result.disposition, 'partial');
    assert.deepEqual(f.moved, [f.path]);
    await assert.rejects(lstat(f.path), { code: 'ENOENT' });
    assert.equal(await readFile(other, 'utf8'), otherBytes);
    assert.equal(await readFile(independentSource, 'utf8'), independentBytes);
    assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
    assert.ok(result.retained.some(item => item.path === f.resources && item.reason.includes('provenance')));
  }));
});

test('stable aliased primary references remain bound after primary Trash while independent own backups are removed', async () => fixture(async f => {
  const alias = join(f.root, 'source-parent-alias');
  await symlink(dirname(f.path), alias);
  const other = join(dirname(f.path), 'stable-reference.jsonl');
  const otherBytes = `${JSON.stringify({ type: 'session', id: 'different-session', cwd: f.root, parentSession: join(alias, basename(f.path)) })}\n`;
  const backup = `${f.path}.0123456789abcdef.bak`;
  await writeFile(other, otherBytes);
  await writeFile(backup, f.bytes);
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.equal(result.disposition, 'partial');
  assert.deepEqual(f.moved, [f.path, backup]);
  assert.equal(await readFile(other, 'utf8'), otherBytes);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.equal(await readFile(join(f.trash, basename(backup)), 'utf8'), f.bytes);
}));

test('native registered parent aliases and canonical duplicate enumeration preserve exact cleanup authority', async () => fixture(async f => {
  const actualRoots = { ...f.auth.roots };
  const alias = join(f.root, 'configured-profile');
  await symlink(f.root, alias);
  f.auth.roots = { sessions: join(alias, 'sessions'), archives: join(alias, 'archive', 'sessions'), registry: join(alias, 'custom-session-files') };
  const other = join(dirname(f.path), 'other-native.jsonl');
  const otherBytes = `${JSON.stringify({ type: 'session', id: 'other-native', cwd: f.root })}\n`;
  const otherAlias = join(f.auth.roots.sessions, basename(dirname(f.path)), basename(other));
  const ownAlias = join(f.auth.roots.sessions, basename(dirname(f.path)), basename(f.path));
  const aliasMarker = join(actualRoots.registry, 'other-alias');
  const canonicalMarker = join(actualRoots.registry, 'other-canonical');
  const ownMarker = join(actualRoots.registry, 'own-alias');
  const backup = `${f.path}.0123456789abcdef.bak`;
  await writeFile(other, otherBytes);
  await writeFile(aliasMarker, otherAlias);
  await writeFile(canonicalMarker, other);
  await writeFile(ownMarker, ownAlias);
  await writeFile(backup, f.bytes);
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'trashed');
  assert.equal(result.sourceRemoved, true);
  assert.deepEqual(f.moved, [f.path, f.resources, backup, ownMarker]);
  assert.equal(await readFile(join(f.trash, basename(f.resources), 'result.txt'), 'utf8'), 'owned tool output');
  assert.equal(await readFile(join(f.trash, basename(backup)), 'utf8'), f.bytes);
  assert.equal(await readFile(join(f.trash, basename(ownMarker)), 'utf8'), ownAlias);
  assert.equal(await readFile(other, 'utf8'), otherBytes);
  assert.equal(await readFile(aliasMarker, 'utf8'), otherAlias);
  assert.equal(await readFile(canonicalMarker, 'utf8'), other);
}));

test('registered aliases and registration rewrites are rebound after writer inspection', async t => {
  for (const change of ['alias-retarget', 'marker-rewrite']) await t.test(change, async () => fixture(async f => {
    const first = join(f.root, 'registered-first');
    const second = join(f.root, 'registered-second');
    const alias = join(f.root, 'registered-alias');
    await mkdir(first);
    await mkdir(second);
    const firstSource = join(first, 'native.jsonl');
    const secondSource = join(second, 'native.jsonl');
    const registeredBytes = `${JSON.stringify({ type: 'session', id: 'registered', cwd: f.root })}\n`;
    await writeFile(firstSource, registeredBytes);
    await writeFile(secondSource, registeredBytes);
    await symlink(first, alias);
    const reference = join(alias, 'native.jsonl');
    const marker = join(f.auth.roots.registry, 'registered');
    const backup = `${f.path}.0123456789abcdef.bak`;
    await writeFile(marker, reference);
    await writeFile(backup, f.bytes);
    let probes = 0;
    f.auth.inspectWriters = async (_path, tree) => {
      if (tree && ++probes === 2) {
        if (change === 'alias-retarget') { await rm(alias); await symlink(second, alias); }
        else await writeFile(marker, secondSource);
      }
      return { safe: true };
    };
    const result = await removeSession(f.saved, f.dependencies);
    assert.equal(result.sourceRemoved, true);
    assert.equal(result.disposition, 'partial');
    assert.deepEqual(f.moved, [f.path]);
    assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
    assert.equal(await readFile(backup, 'utf8'), f.bytes);
    assert.equal(await readFile(firstSource, 'utf8'), registeredBytes);
    assert.equal(await readFile(secondSource, 'utf8'), registeredBytes);
    assert.equal(await readFile(marker, 'utf8'), change === 'alias-retarget' ? reference : secondSource);
  }));
});

test('registered source parent aliases do not authorize a symbolic-link leaf', async () => fixture(async f => {
  const target = join(f.root, 'registered-real.jsonl');
  const leaf = join(f.root, 'registered-link.jsonl');
  const alias = join(f.root, 'registered-parent');
  const bytes = `${JSON.stringify({ type: 'session', id: 'unrelated', cwd: f.root })}\n`;
  await writeFile(target, bytes);
  await symlink(target, leaf);
  await symlink(f.root, alias);
  const marker = join(f.auth.roots.registry, 'linked-source');
  const reference = join(alias, basename(leaf));
  await writeFile(marker, reference);
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.equal(result.disposition, 'partial');
  assert.deepEqual(f.moved, [f.path]);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.equal(await readFile(target, 'utf8'), bytes);
  assert.equal((await lstat(leaf)).isSymbolicLink(), true);
  assert.equal(await readFile(marker, 'utf8'), reference);
}));

test('a native backup registered through a parent alias remains a separate source', async () => fixture(async f => {
  const alias = join(f.root, 'native-bucket-alias');
  await symlink(dirname(f.path), alias);
  const backup = `${f.path}.0123456789abcdef.bak`;
  const reference = join(alias, basename(backup));
  const marker = join(f.auth.roots.registry, 'independent-backup');
  await writeFile(backup, f.bytes);
  await writeFile(marker, reference);
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.equal(result.disposition, 'partial');
  assert.deepEqual(f.moved, [f.path]);
  assert.equal(await readFile(backup, 'utf8'), f.bytes);
  assert.equal(await readFile(marker, 'utf8'), reference);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
}));

test('unknown occupancy needs explicit Trash consent while proven holders never allow it', async () => {
  for (const status of ['unknown', 'external'] as const) for (const allowUncertain of [false, true]) await fixture(async f => {
    f.auth.revalidate = async () => requireRemovalAccess({ status, checkedAt: 0, reason: 'Scoped evidence unavailable' }, allowUncertain);
    const result = await removeSession({ ...f.saved, allowUncertain }, f.dependencies);
    assert.equal(result.sourceRemoved, status === 'unknown' && allowUncertain);
    if (!result.sourceRemoved) assert.equal(result.occupancy?.status, status);
  });
});

test('consent permits only uncertain source observation, never ancillary or proven descriptor holders', async () => {
  for (const uncertain of [false, true]) await fixture(async f => {
    f.auth.inspectWriters = async () => ({ safe: false, uncertain, reason: 'Open-file evidence' });
    const result = await removeSession({ ...f.saved, allowUncertain: true }, f.dependencies);
    assert.equal(result.sourceRemoved, uncertain);
    assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
    if (uncertain) assert.deepEqual(f.moved, [f.path]);
    else assert.equal(result.occupancy?.status, 'external');
  });
});

test('an absent owned allocation discards without inspecting writers', async () => fixture(async f => {
  await rm(f.path);
  f.auth.source.status = 'unpersisted'; f.auth.initialEmpty = true;
  f.auth.close = async () => ({ clean: true, forced: false, exitCode: 0 });
  f.auth.inspectWriters = async () => { throw new Error('No occupancy inspection is allowed for absent allocations'); };
  assert.equal((await removeSession(f.runtime, f.dependencies)).disposition, 'discarded');
}));

test('unrelated stale markers do not obstruct own marker and resource cleanup', async () => fixture(async f => {
  const own = join(f.auth.roots.registry, 'own');
  const stale = join(f.auth.roots.registry, 'stale');
  const absentParent = join(f.auth.roots.registry, 'absent-parent');
  await writeFile(own, f.path);
  await writeFile(stale, join(f.root, 'never-persisted.jsonl'));
  await writeFile(absentParent, join(f.root, 'gone-parent', 'trashed.jsonl'));
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.disposition, 'trashed');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.retained, []);
  assert.deepEqual(f.moved, [f.path, f.resources, own]);
  assert.equal(await readFile(stale, 'utf8'), join(f.root, 'never-persisted.jsonl'));
  assert.equal(await readFile(absentParent, 'utf8'), join(f.root, 'gone-parent', 'trashed.jsonl'));
}));

test('an invalid other registered source retains ambiguous resources but not the own marker', async () => fixture(async f => {
  const own = join(f.auth.roots.registry, 'own');
  const invalid = join(f.root, 'invalid.jsonl');
  await writeFile(own, f.path);
  await writeFile(invalid, 'not a journal');
  await writeFile(join(f.auth.roots.registry, 'other'), invalid);
  const result = await removeSession(f.saved, f.dependencies);
  assert.equal(result.sourceRemoved, true);
  assert.deepEqual(f.moved, [f.path, own]);
  assert.equal(await readFile(join(f.resources, 'result.txt'), 'utf8'), 'owned tool output');
  assert.equal(await readFile(invalid, 'utf8'), 'not a journal');
}));

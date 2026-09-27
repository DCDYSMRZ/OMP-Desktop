import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HistoryIndex } from './history';
import { HistoryReader } from './journal';
import { SessionResources } from './session-resources';

const jsonl = (...rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
test('archive discovery retains readable siblings and original recorded workspace identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-archive-index-'));
  try {
    const agent = join(root, 'agent');
    const archives = join(agent, 'archive', 'sessions', 'bucket');
    await mkdir(archives, { recursive: true });
    const original = gzipSync(jsonl({ type: 'session', id: 'saved', cwd: '/removed-workspace', parentSession: 'ancestor', previousSessionFiles: ['/old/saved.jsonl'] }));
    const path = join(archives, 'saved.jsonl.gz');
    await writeFile(path, original);
    await writeFile(join(archives, 'broken.jsonl.gz'), 'not gzip');
    await writeFile(join(archives, 'legacy.jsonl'), jsonl({ type: 'session', id: 'legacy', cwd: root }));
    const result = await new HistoryIndex().list({ executable: '/unused', cwd: root, env: { HOME: root, PI_CODING_AGENT_DIR: agent } });
    assert.deepEqual(result.sessions.map(item => item.id).sort(), ['legacy', 'saved']);
    const saved = result.sessions.find(item => item.id === 'saved')!;
    assert.equal(saved.sourceKind, 'archive');
    assert.equal(saved.writable, false);
    assert.equal(saved.recordedCwd, '/removed-workspace');
    assert.equal(saved.parentSession, 'ancestor');
    assert.deepEqual(saved.previousSessionFiles, ['/old/saved.jsonl']);
    assert.deepEqual(result.diagnostics.map(item => item.path), [await realpath(join(archives, 'broken.jsonl.gz'))]);
    assert.deepEqual(await readFile(path), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('move aliases never concatenate transcripts or authorize another session artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-lineage-'));
  const reader = new HistoryReader();
  try {
    await mkdir(join(root, 'old'));
    const alias = join(root, 'old', 'same.jsonl');
    const path = join(root, 'same.jsonl');
    await writeFile(alias, jsonl({ type: 'session', version: 3, id: 'unrelated', cwd: root }, { type: 'message', id: 'secret', parentId: null, message: { role: 'user', content: 'unrelated' } }));
    await writeFile(path, jsonl({ type: 'session', version: 3, id: 'current', cwd: root, previousSessionFiles: [alias] }, { type: 'message', id: 'shown', parentId: null, message: { role: 'user', content: 'selected' } }));
    const context = await reader.resourceContext(path);
    assert.deepEqual(context.artifactRoots, [path.slice(0, -6)]);
    await mkdir(alias.slice(0, -6));
    await writeFile(join(alias.slice(0, -6), '7.read.log'), 'UNAUTHORIZED');
    const resource = await new SessionResources(reader, async () => root).readSessionArtifact({ parentPath: path, reference: 'artifact://7' });
    assert.equal(resource.content, undefined);
    assert.equal(JSON.stringify(resource).includes('UNAUTHORIZED'), false);
    assert.deepEqual((await reader.read({ path }, root)).messages.map(item => item.raw.content), ['selected']);
  } finally { reader.close(); await rm(root, { recursive: true, force: true }); }
});

test('large histories preserve latest messages, early ancestry and branch selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-complete-history-'));
  const reader = new HistoryReader();
  try {
    const path = join(root, 'large.jsonl');
    const rows = Array.from({ length: 100001 }, (_, index) => ({ type: 'message', id: `m${index}`, parentId: index ? `m${index - 1}` : null, message: { role: 'user', content: String(index) } }));
    const side = { type: 'message', id: 'side', parentId: 'm7', message: { role: 'user', content: 'Side branch' } };
    const latest = { type: 'message', id: 'latest', parentId: 'm100000', message: { role: 'assistant', content: 'Latest reply' } };
    await writeFile(path, jsonl({ type: 'session', version: 3, id: 'large', cwd: root }) + rows.map(row => JSON.stringify(row)).join('\n') + '\n' + jsonl(side, latest));
    const page = await reader.read({ path }, root);
    assert.equal(page.leafId, 'latest');
    assert.equal(page.messages.at(-1)?.raw.content, 'Latest reply');
    assert.equal(page.messages.at(-2)?.entryId, 'm100000');
    assert.equal(page.sourceReference, undefined);
    const earlier = await reader.read({ path, before: page.nextBefore }, root);
    assert.equal(earlier.messages.at(-1)?.entryId, `m${Number(page.messages[0]!.entryId!.slice(1)) - 1}`);
    assert.equal((await reader.read({ path, leafId: 'm100000' }, root)).messages.at(-1)?.raw.content, '100000');
    const branch = await reader.read({ path, leafId: 'side' }, root);
    assert.deepEqual(branch.messages.map(item => item.entryId), [...Array.from({ length: 8 }, (_, index) => `m${index}`), 'side']);
    assert.deepEqual((await reader.read({ path, leafId: 'm0' }, root)).messages.map(item => item.raw.content), ['0']);
    let tree = await reader.tree(path);
    assert.equal(tree.leafId, 'latest');
    assert.ok(tree.nodes.some(node => node.id === 'm100000'));
    assert.equal(tree.nodes.find(node => node.id === 'side')?.parentId, 'm7');
    while (tree.hasMore) tree = await reader.tree(path, tree.nextBefore);
    assert.equal(tree.nodes[0]?.id, 'm0');
  } finally { reader.close(); await rm(root, { recursive: true, force: true }); }
});

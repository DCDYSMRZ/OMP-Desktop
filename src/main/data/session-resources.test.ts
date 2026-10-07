import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HistoryReader, HistoryRevisionChangedError } from './journal';
import { SessionResources } from './session-resources';
import { SessionUsageReader } from './session-usage';
import type { SavedSubagentEdge } from '../../shared/contracts';
import { markdownSessionResourceReference } from '../../renderer/lib/markdown-link-destinations';
import { sessionResourceReferences } from '../../renderer/chat/message-details';
import { evidenceOf } from '../../shared/subagent-evidence';

const timestamp = '2026-01-01T00:00:00.000Z';
const header = { type: 'session', version: 3, id: 'parent', cwd: '/workspace', timestamp };
const jsonl = (...rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
function task(id: string, parentId: string | null, toolCallId: string, results: unknown[], progress: unknown[] = []) {
  return { type: 'message', id, parentId, timestamp, message: { role: 'toolResult', toolName: 'task', toolCallId, content: [{ type: 'text', text: 'Saved task' }], details: { results, progress } } };
}
async function fixture(run: (resources: SessionResources, parentPath: string, artifacts: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'omp-resources-'));
  const reader = new HistoryReader();
  const parentPath = join(root, 'parent.jsonl');
  const artifacts = join(root, 'parent');
  const blobs = join(root, 'blobs');
  await mkdir(artifacts); await mkdir(blobs);
  await writeFile(parentPath, jsonl(header));
  try { await run(new SessionResources(reader, async () => blobs), parentPath, artifacts, root); }
  finally { reader.close(); await rm(root, { recursive: true, force: true }); }
}

test('mixed task accounting adds only uniquely resolved children without aggregate usage', async () => fixture(async (resources, parentPath, artifacts) => {
  const usage = (cost: number) => ({ input: 10, output: 2, cacheRead: 20, cacheWrite: 3, totalTokens: 35, cost: { total: cost } });
  const request = (id: string, parentId: string | null, cost: number) => ({ type: 'message', id, parentId, timestamp, message: { role: 'assistant', content: [], usage: usage(cost) } });
  const aggregated = task('aggregate', 'main', 'covered', [{ id: 'covered-child', index: 0, exitCode: 0 }]);
  await writeFile(parentPath, jsonl(header, request('main', null, 1), { ...aggregated, message: { ...aggregated.message, details: { ...aggregated.message.details, usage: usage(2) } } }, task('fallback', 'aggregate', 'missing', [], [{ id: 'child', index: 0 }, { id: 'gone', index: 1 }])));
  await writeFile(join(artifacts, 'child.jsonl'), jsonl({ ...header, id: 'child' }, request('child-request', null, 3)));
  await writeFile(join(artifacts, 'covered-child.jsonl'), jsonl({ ...header, id: 'covered-child' }, request('already-counted', null, 100)));
  const reader = new SessionUsageReader(options => resources.resolveUsageChildren(options));
  const result = await reader.read(parentPath);
  assert.equal(result.mainCost, 1); assert.equal(result.subagentCost, 5); assert.equal(result.cost, 6);
  assert.equal(result.total, 105); assert.equal(result.unrecordedSubagents, 1);
  // Parent journal is unchanged: a growing fallback child still invalidates its own usage.
  await appendFile(join(artifacts, 'child.jsonl'), jsonl(request('child-next', 'child-request', 4)));
  assert.equal((await reader.read(parentPath)).cost, 10);
  // A different selected context branch must not lose whole-session child spend.
  await appendFile(parentPath, jsonl(request('other-branch', null, 5)));
  assert.equal((await reader.read(parentPath)).cost, 15);
}));

test('saved child identities belong to their parent task and selected ancestry, not dotted native IDs', async () => fixture(async (resources, parentPath) => {
  await writeFile(parentPath, jsonl(header,
    task('first', null, 'call-a', [{ id: 'worker.1', index: 0, agent: 'task', task: 'First', exitCode: 0 }]),
    task('second', 'first', 'call-b', [{ id: 'worker.1', index: 0, agent: 'task', task: 'Second', exitCode: 1 }]),
    task('other', null, 'call-other', [{ index: 0, agent: 'review', task: 'No native ID', exitCode: 0 }])));
  const selected = await resources.listHistorySubagents({ path: parentPath, leafId: 'second' });
  assert.equal(selected.subagents.length, 2);
  assert.notEqual(selected.subagents[0]!.id, selected.subagents[1]!.id);
  assert.deepEqual(selected.subagents.map(child => child.parentToolCallId).sort(), ['call-a', 'call-b']);
  assert.deepEqual(selected.subagents.map(child => child.nativeId), ['worker.1', 'worker.1']);
  const other = await resources.listHistorySubagents({ path: parentPath });
  assert.equal(other.subagents[0]!.nativeId, undefined);
  await assert.rejects(resources.readHistorySubagent({ parentPath, subagentId: selected.subagents[0]!.id }), /selected parent/);
  const missing = await resources.readHistorySubagent({ parentPath, subagentId: other.subagents[0]!.id });
  assert.match(missing.diagnostics.join(' '), /no native child journal identity/);
  assert.equal(missing.session.canFork, false);
  assert.equal(other.subagents[0]!.task, 'No native ID');
}));

test('child journal pages stay separate from parent leaf and never mutate saved journals', async () => fixture(async (resources, parentPath, artifacts) => {
  await appendFile(parentPath, jsonl(task('task-entry', null, 'call', [{ id: 'child', index: 0, exitCode: 0 }])));
  const childPath = join(artifacts, 'child.jsonl');
  const messages = Array.from({ length: 240 }, (_, index) => ({ type: 'message', id: `child-${index}`, parentId: index ? `child-${index - 1}` : null, timestamp, message: { role: 'user', content: `Child message ${index}` } }));
  await writeFile(childPath, jsonl({ ...header, id: 'child-session' }, ...messages));
  const originalParent = await readFile(parentPath);
  const originalChild = await readFile(childPath);
  const child = (await resources.listHistorySubagents({ path: parentPath })).subagents[0]!;
  const latest = await resources.readHistorySubagent({ parentPath, subagentId: child.id, leafId: 'task-entry' });
  assert.equal(latest.selectedLeafId, 'child-239');
  assert.equal(latest.session.writable, false);
  const older = await resources.readHistorySubagent({ parentPath, subagentId: child.id, leafId: 'task-entry', before: latest.nextBefore });
  assert.deepEqual([...older.messages, ...latest.messages].map(message => message.entryId), messages.map(message => message.id));
  const anchor = { beforeEntryId: latest.messages[0]!.id, childLeafId: latest.selectedLeafId, childRevision: latest.revision };
  const anchored = await resources.readHistorySubagent({ parentPath, subagentId: child.id, leafId: 'task-entry', ...anchor });
  assert.deepEqual(anchored.messages.map(message => message.entryId), older.messages.map(message => message.entryId));
  const restored = await resources.readHistorySubagent({ parentPath, subagentId: child.id, leafId: 'task-entry', childLeafId: latest.selectedLeafId, childRevision: latest.revision });
  assert.deepEqual(restored.messages.map(message => message.entryId), latest.messages.map(message => message.entryId));
  await assert.rejects(resources.readHistorySubagent({ parentPath, subagentId: child.id, ...anchor, before: latest.nextBefore }), /one child cursor/);
  await assert.rejects(resources.readHistorySubagent({ parentPath, subagentId: child.id, ...anchor, childRevision: 'stale' }), /anchor is stale/);
  await assert.rejects(resources.readHistorySubagent({ parentPath, subagentId: child.id, beforeEntryId: anchor.beforeEntryId }), /selected branch and revision/);
  await assert.rejects(resources.readHistorySubagent({ parentPath, subagentId: child.id, ...anchor, beforeEntryId: 'foreign-session:compact' }), /selected branch/);
  assert.deepEqual(await readFile(parentPath), originalParent);
  assert.deepEqual(await readFile(childPath), originalChild);
}));

test('saved progress survives absent child files while settled results take precedence', async () => fixture(async (resources, parentPath) => {
  await appendFile(parentPath, jsonl(task('entry', null, 'call', [{ id: 'gone', index: 0, exitCode: 1, task: 'Recover metadata' }], [{ id: 'gone', index: 0, status: 'running' }])));
  const saved = (await resources.listHistorySubagents({ path: parentPath })).subagents[0]!;
  assert.equal(saved.status, 'failed');
  assert.equal(saved.task, 'Recover metadata');
  assert.match((await resources.readHistorySubagent({ parentPath, subagentId: saved.id })).diagnostics.join(' '), /unavailable.*metadata/);
}));

test('artifact pages preserve multibyte boundaries and reject stale or cross-resource cursors', async () => fixture(async (resources, parentPath, artifacts) => {
  const path = join(artifacts, '3.bash.log');
  const original = `First\n${'界🙂'.repeat(22000)}\nLast\n`;
  await writeFile(path, original);
  let page = await resources.readSessionArtifact({ parentPath, reference: 'artifact://3' });
  const cursor = page.nextCursor!;
  let content = page.content!;
  let count = 1;
  while (page.nextCursor) {
    page = await resources.readSessionArtifact({ parentPath, reference: 'artifact://3', cursor: page.nextCursor });
    assert.ok(Buffer.byteLength(page.content!) <= 64 * 1024);
    content += page.content;
    assert.ok(++count < 10);
  }
  assert.equal(content, original);
  await assert.rejects(resources.readSessionArtifact({ parentPath, reference: 'artifact://3:2', cursor }), /stale or invalid/);
  await appendFile(path, 'Changed');
  await assert.rejects(resources.readSessionArtifact({ parentPath, reference: 'artifact://3', cursor }), /stale or invalid/);
}));

test('recovery regions and native line selectors display only the requested text', async () => fixture(async (resources, parentPath, artifacts) => {
  await writeFile(join(artifacts, '7.shake.log'), '### region 1 (tool, ~10 tok)\n\nFirst recovery\n\n### region 2 (tool, ~20 tok)\n\nSecond recovery\n\n### region 3 (tool, ~30 tok)\n\nThird recovery\n');
  const region = await resources.readSessionArtifact({ parentPath, reference: 'artifact://7 (region 2)' });
  assert.match(region.content!, /Second recovery/);
  assert.doesNotMatch(region.content!, /First recovery|Third recovery|region 3/);
  const lines = await resources.readSessionArtifact({ parentPath, reference: 'artifact://7:raw:3,7' });
  assert.equal(lines.content, 'First recovery\nSecond recovery\n');
  const missing = await resources.readSessionArtifact({ parentPath, reference: 'artifact://7 (region 8)' });
  assert.match(missing.diagnostics.join(' '), /region 8 was not found/);
}));

test('artifact and child references cannot escape their parent artifact roots', async () => fixture(async (resources, parentPath, artifacts, root) => {
  const outside = join(root, 'outside.jsonl');
  await writeFile(outside, jsonl({ ...header, id: 'outside' }, { type: 'message', id: 'secret', parentId: null, timestamp, message: { role: 'user', content: 'PRIVATE' } }));
  await symlink(outside, join(artifacts, '4.read.log'));
  await symlink(outside, join(artifacts, 'escape.jsonl'));
  await appendFile(parentPath, jsonl(task('entry', null, 'call', [{ id: 'escape', index: 0, exitCode: 0 }, { id: '../outside', index: 1, exitCode: 0, outputPath: outside }])));
  const artifact = await resources.readSessionArtifact({ parentPath, reference: 'artifact://4' });
  assert.equal(artifact.content, undefined);
  assert.match(artifact.diagnostics.join(' '), /Unsafe|missing/);
  for (const child of (await resources.listHistorySubagents({ path: parentPath })).subagents) {
    const page = await resources.readHistorySubagent({ parentPath, subagentId: child.id });
    assert.deepEqual(page.messages, []);
    assert.equal(JSON.stringify(page).includes('PRIVATE'), false);
  }
  await assert.rejects(resources.readSessionArtifact({ parentPath, reference: outside }), /native artifact/);
  await assert.rejects(resources.readSessionArtifact({ parentPath, reference: 'artifact://../outside' }), /native artifact/);
}));

test('ambiguous artifact IDs are never resolved by directory enumeration order', async () => fixture(async (resources, parentPath, artifacts) => {
  await writeFile(join(artifacts, '1.bash.log'), 'One');
  await writeFile(join(artifacts, '1.read.log'), 'Different');
  const page = await resources.readSessionArtifact({ parentPath, reference: 'artifact://1' });
  assert.equal(page.content, undefined);
  assert.match(page.diagnostics.join(' '), /ambiguous/);
}));

test('compressed saved parents derive sibling artifact roots without materializing into native storage', async () => fixture(async (resources, parentPath, artifacts) => {
  const archived = `${parentPath}.gz`;
  await writeFile(archived, gzipSync(jsonl(header, task('entry', null, 'call', [{ id: 'child', index: 0, exitCode: 0 }]))));
  await writeFile(join(artifacts, '0.bash.log'), 'Archived artifact');
  const original = await readFile(archived);
  assert.equal((await resources.listHistorySubagents({ path: archived })).subagents[0]!.nativeId, 'child');
  assert.equal((await resources.readSessionArtifact({ parentPath: archived, reference: 'artifact://0' })).content, 'Archived artifact');
  assert.deepEqual(await readFile(archived), original);
}));

test('native tail selectors count final newlines correctly and page long selected lines', async () => fixture(async (resources, parentPath, artifacts) => {
  await writeFile(join(artifacts, '8.bash.log'), 'First\nSecond\nThird\n');
  assert.equal((await resources.readSessionArtifact({ parentPath, reference: 'artifact://8:-2' })).content, 'Second\nThird\n');
  await writeFile(join(artifacts, '9.bash.log'), 'First\nSecond\nThird');
  assert.equal((await resources.readSessionArtifact({ parentPath, reference: 'artifact://9:-2:raw' })).content, 'Second\nThird');
}));

test('recovery region headers crossing scan chunks are recognized as boundaries', async () => fixture(async (resources, parentPath, artifacts) => {
  await writeFile(join(artifacts, '10.shake.log'), `${'x'.repeat(65532)}\n### region 2 (tool, ~2 tok)\nWanted\n### region 3 (tool, ~2 tok)\nUnwanted\n`);
  const page = await resources.readSessionArtifact({ parentPath, reference: 'artifact://10 (region 2)' });
  assert.equal(page.content, '### region 2 (tool, ~2 tok)\nWanted\n');
}));

test('child entry resources resolve against the authorized child, not identically named parent entries', async () => fixture(async (resources, parentPath, artifacts) => {
  await appendFile(parentPath, jsonl(task('shared-entry', null, 'parent-call', [{ id: 'child', index: 0, exitCode: 0 }])));
  await writeFile(join(artifacts, 'child.jsonl'), jsonl({ ...header, id: 'child-session' }, { type: 'message', id: 'shared-entry', parentId: null, timestamp, message: { role: 'user', content: 'CHILD DETAIL' } }));
  await writeFile(join(artifacts, '11.read.log'), 'Shared native artifact');
  const child = (await resources.listHistorySubagents({ path: parentPath })).subagents[0]!;
  const reference = `desktop-entry:${Buffer.from('shared-entry').toString('base64url')}`;
  const detail = await resources.readSessionArtifact({ parentPath, subagentId: child.id, leafId: 'shared-entry', reference });
  assert.match(detail.content!, /CHILD DETAIL/);
  assert.doesNotMatch(detail.content!, /parent-call/);
  assert.equal((await resources.readSessionArtifact({ parentPath, subagentId: child.id, reference: 'artifact://11' })).content, 'Shared native artifact');
  await assert.rejects(resources.readSessionArtifact({ parentPath, subagentId: 'saved-forged', reference }), /selected parent/);
}));

test('large persisted task text does not hide saved child metadata or its journal', async () => fixture(async (resources, parentPath, artifacts) => {
  const entry = task('large-task', null, 'large-call', [{ id: 'child', index: 0, task: 'Read retained child', exitCode: 0 }]);
  entry.message.content[0]!.text = 'x'.repeat(2 * 1024 * 1024);
  await appendFile(parentPath, jsonl(entry));
  await writeFile(join(artifacts, 'child.jsonl'), jsonl({ ...header, id: 'child-session' }, { type: 'message', id: 'answer', parentId: null, message: { role: 'assistant', content: 'Saved answer' } }));
  const child = (await resources.listHistorySubagents({ path: parentPath })).subagents[0]!;
  assert.equal(child.nativeId, 'child');
  assert.equal(child.task, 'Read retained child');
  assert.equal((await resources.readHistorySubagent({ parentPath, subagentId: child.id })).messages[0]?.raw.content, 'Saved answer');
}));

test('native move records retain confined artifacts and children after the old journal is renamed away', async () => fixture(async (resources, _parentPath, _artifacts, root) => {
  const filename = `${timestamp.replace(/[:.]/g, '-')}_${header.id}.jsonl`;
  const oldBucket = join(root, 'agent', 'sessions', 'old');
  const newBucket = join(root, 'agent', 'sessions', 'new');
  const oldPath = join(oldBucket, filename);
  const parentPath = join(newBucket, filename);
  const oldArtifacts = oldPath.slice(0, -6);
  await mkdir(oldArtifacts, { recursive: true });
  await mkdir(newBucket, { recursive: true });
  await writeFile(oldPath, jsonl({ ...header, previousSessionFiles: [oldPath] }, task('task', null, 'call', [{ id: 'child', index: 0, exitCode: 0 }])));
  await rename(oldPath, parentPath);
  await writeFile(join(oldArtifacts, '7.bash.log'), 'Retained output');
  await writeFile(join(oldArtifacts, 'child.jsonl'), jsonl({ ...header, id: 'child' }, { type: 'message', id: 'answer', parentId: null, message: { role: 'assistant', content: 'Retained child answer' } }));
  assert.equal((await resources.readSessionArtifact({ parentPath, reference: 'artifact://7' })).content, 'Retained output');
  const child = (await resources.listHistorySubagents({ path: parentPath })).subagents[0]!;
  assert.equal((await resources.readHistorySubagent({ parentPath, subagentId: child.id })).messages[0]?.raw.content, 'Retained child answer');
  // Duplicate IDs across independently valid roots are ambiguous, never first-match wins.
  await mkdir(parentPath.slice(0, -6));
  await writeFile(join(parentPath.slice(0, -6), '7.bash.log'), 'Different output');
  assert.equal((await resources.readSessionArtifact({ parentPath, reference: 'artifact://7' })).content, undefined);
  // An unrelated replacement at the old identity invalidates that root.
  await writeFile(oldPath, jsonl({ ...header, id: 'unrelated' }));
  assert.deepEqual((await resources.readHistorySubagent({ parentPath, subagentId: child.id })).messages, []);
  // A matching filename in another profile is not authority granted by a header.
  const unrelated = join(root, 'other-agent', 'sessions', 'old', filename);
  await mkdir(unrelated.slice(0, -6), { recursive: true });
  await writeFile(join(unrelated.slice(0, -6), '9.read.log'), 'PRIVATE');
  await writeFile(parentPath, jsonl({ ...header, previousSessionFiles: [unrelated] }));
  const unauthorized = await resources.readSessionArtifact({ parentPath, reference: 'artifact://9' });
  assert.equal(unauthorized.content, undefined);
  assert.equal(JSON.stringify(unauthorized).includes('PRIVATE'), false);
  assert.ok(unauthorized.diagnostics.length > 0);
}));

test('saved image routes reject corrupt, escaping, hidden and cross-source payloads', async () => fixture(async (resources, parentPath, artifacts, root) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const hashes = ['a', 'b', 'c', 'd'].map(value => value.repeat(64));
  const blobs = join(root, 'blobs');
  await writeFile(join(blobs, hashes[0]!), png);
  await writeFile(join(blobs, hashes[1]!), 'CORRUPT');
  await writeFile(join(root, 'outside-image'), png);
  await symlink(join(root, 'outside-image'), join(blobs, hashes[2]!));
  await writeFile(join(blobs, hashes[3]!), png);
  const content = hashes.slice(0, 3).map(hash => ({ type: 'image', data: `blob:sha256:${hash}`, mimeType: 'image/png' }));
  await appendFile(parentPath, jsonl(task('task', null, 'call', [{ id: 'child', index: 0, exitCode: 0 }]), { type: 'message', id: 'images', parentId: 'task', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }, ...content], providerPayload: { content: [{ type: 'image', data: `blob:sha256:${hashes[3]}`, mimeType: 'image/png' }] } } }));
  const detail = await resources.readSessionEntry({ parentPath, entryId: 'images' });
  assert.deepEqual(detail.imageReferences?.map(image => image.name), ['Image 1', 'Image 2', 'Image 3']);
  const references = detail.imageReferences!;
  assert.equal((await resources.readSessionArtifact({ parentPath, reference: references[0]!.reference })).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  for (const image of references.slice(1)) assert.equal((await resources.readSessionArtifact({ parentPath, reference: image.reference })).dataUrl, undefined);
  const handle = JSON.parse(Buffer.from(references[0]!.reference.slice('desktop-image:'.length), 'base64url').toString('utf8'));
  const hidden = `desktop-image:${Buffer.from(JSON.stringify({ ...handle, index: 3 })).toString('base64url')}`;
  await assert.rejects(resources.readSessionArtifact({ parentPath, reference: hidden }));
  await writeFile(join(artifacts, 'child.jsonl'), jsonl({ ...header, id: 'child' }, { type: 'message', id: 'images', parentId: null, message: { role: 'user', content } }));
  const child = (await resources.listHistorySubagents({ path: parentPath })).subagents[0]!;
  await assert.rejects(resources.readSessionArtifact({ parentPath, subagentId: child.id, reference: references[0]!.reference }));
}));

function delivered(id: string, parentId: string, jobs: { jobId: string; type: string; durationMs?: number }[], content: string) {
  return { type: 'custom_message', id, parentId, timestamp, customType: 'async-result', display: true, details: { jobs }, content };
}
function resultEnvelope(id: string, status: string, error?: string) {
  return `<task-result id="${id}" agent="task" status="${status}" duration="1m35s">\n${error ? `<error>${error}</error>\n` : ''}<output>\n${error || `${id} result`}\n</output>\n</task-result>`;
}

test('readonly native pending tasks settle from later deliveries across pages and preserve assignments and failure details', async () => fixture(async (resources, parentPath) => {
  const pending = task('spawn', null, 'call', [], ['SmokeA', 'SmokeB', 'SmokeC'].map((id, index) => ({ id, index, agent: 'task', status: 'pending', durationMs: 0, task: 'Complete assignment thoroughly: wrapped', assignment: `Assignment ${id}` })));
  const between = Array.from({ length: 220 }, (_, index) => ({ type: 'message', id: `between-${index}`, parentId: index ? `between-${index - 1}` : 'spawn', timestamp, message: { role: 'assistant', content: 'Working' } }));
  const complete = delivered('done-ab', 'between-219', [{ jobId: 'SmokeB', type: 'task', durationMs: 97 }, { jobId: 'SmokeA', type: 'task', durationMs: 97 }], `<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job SmokeB ──\n${resultEnvelope('SmokeB', 'completed')}\n── Job SmokeA ──\n${resultEnvelope('SmokeA', 'completed')}\n</system-notice>`);
  const failed = delivered('done-c', 'done-ab', [{ jobId: 'SmokeC', type: 'task', durationMs: 95015 }], `<system-notice>Background job SmokeC has completed.\n${resultEnvelope('SmokeC', 'failed (exit 1)', 'Subagent exited without calling yield after 3 reminders.')}\n</system-notice>`);
  await writeFile(parentPath, jsonl(header, pending, ...between, complete, failed));
  const original = await readFile(parentPath);
  for (const path of [parentPath, `${parentPath}.gz`]) {
    if (path !== parentPath) await writeFile(path, gzipSync(original));
    const saved = await resources.listHistorySubagents({ path });
    assert.deepEqual(saved.subagents.map(child => [child.nativeId, child.status, child.task]), [['SmokeA', 'completed', 'Assignment SmokeA'], ['SmokeB', 'completed', 'Assignment SmokeB'], ['SmokeC', 'failed', 'Assignment SmokeC']]);
    assert.equal(saved.subagents[0]!.progress!.durationMs, 95000);
    assert.equal(saved.subagents[0]!.progress!.deliveryDurationMs, 97);
    assert.equal(saved.subagents[2]!.progress!.durationMs, 95000);
    assert.equal(saved.subagents[2]!.progress!.deliveryDurationMs, 95015);
    assert.equal(saved.subagents[2]!.progress!.error, 'Subagent exited without calling yield after 3 reminders.');
    assert.equal(saved.subagents[2]!.assignment, 'Assignment SmokeC');
  }
  assert.deepEqual(await readFile(parentPath), original);
}));

test('selected branches use their newest delivery, including unknown conflicts, without granting foreign child access', async () => fixture(async (resources, parentPath, artifacts) => {
  const jobs = [{ jobId: 'child', type: 'task', durationMs: 40 }];
  await writeFile(parentPath, jsonl(header,
    task('spawn', null, 'call', [], [{ id: 'child', index: 0, status: 'pending' }, { id: 'unrelated', index: 1, status: 'pending' }]),
    delivered('success', 'spawn', jobs, resultEnvelope('child', 'completed')),
    delivered('failure', 'success', jobs, resultEnvelope('child', 'failed (exit 1)', 'Later failure')),
    delivered('ambiguous', 'failure', jobs, resultEnvelope('child', 'completed') + resultEnvelope('child', 'failed (exit 1)')),
    delivered('foreign', 'spawn', [{ jobId: 'foreign', type: 'task' }, { jobId: '../outside', type: 'task' }], resultEnvelope('child', 'completed') + resultEnvelope('foreign', 'completed')),
  ));
  await writeFile(join(artifacts, 'foreign.jsonl'), jsonl({ ...header, id: 'foreign' }, { type: 'message', id: 'private', parentId: null, message: { role: 'user', content: 'FOREIGN' } }));
  for (const [leafId, status] of [['spawn', 'pending'], ['success', 'completed'], ['failure', 'failed'], ['ambiguous', 'unknown'], ['foreign', 'pending']]) {
    const saved = await resources.listHistorySubagents({ path: parentPath, leafId });
    assert.deepEqual(saved.subagents.map(child => [child.nativeId, child.status]), [['child', status], ['unrelated', 'pending']]);
    if (leafId === 'ambiguous') {
      assert.equal(saved.subagents[0]!.progress!.error, undefined);
    }
  }
  await assert.rejects(resources.readHistorySubagent({ parentPath, subagentId: 'foreign', leafId: 'foreign' }), /selected parent/);
}));

test('deliveries cannot settle a later spawn or disambiguate reused native task IDs', async () => fixture(async (resources, parentPath) => {
  const jobs = [{ jobId: 'child', type: 'task' }];
  await writeFile(parentPath, jsonl(header,
    task('first', null, 'call-a', [], [{ id: 'child', index: 0, status: 'pending' }]),
    delivered('early', 'first', jobs, resultEnvelope('child', 'completed')),
    task('second', 'early', 'call-b', [], [{ id: 'child', index: 0, status: 'pending' }]),
    delivered('late', 'second', jobs, resultEnvelope('child', 'failed (exit 1)')),
  ));
  const saved = await resources.listHistorySubagents({ path: parentPath });
  assert.deepEqual(saved.subagents.map(child => child.status), ['unknown', 'unknown']);
  assert.ok(saved.diagnostics.some(reason => reason.includes('multiple saved children')));
  await writeFile(parentPath, jsonl(header,
    delivered('before-spawn', 'missing', jobs, resultEnvelope('child', 'completed')),
    task('new-spawn', 'before-spawn', 'call-new', [], [{ id: 'child', index: 0, status: 'pending' }]),
  ));
  assert.equal((await resources.listHistorySubagents({ path: parentPath })).subagents[0]!.status, 'pending');
}));

test('job-manager suffixes settle only the envelope agent and reused job IDs do not cross task owners', async () => fixture(async (resources, parentPath) => {
  await writeFile(parentPath, jsonl(header,
    task('spawn', null, 'call', [], [{ id: 'child', index: 0, status: 'pending' }, { id: 'child-2', index: 1, status: 'pending' }]),
    delivered('first', 'spawn', [{ jobId: 'child-2', type: 'task' }], resultEnvelope('child', 'completed')),
    delivered('second', 'first', [{ jobId: 'child-2', type: 'task' }], resultEnvelope('child-2', 'failed (exit 1)', 'Other child failure')),
  ));
  const first = await resources.listHistorySubagents({ path: parentPath, leafId: 'first' });
  assert.deepEqual(first.subagents.map(child => [child.nativeId, child.status]), [['child', 'completed'], ['child-2', 'pending']]);
  const latest = await resources.listHistorySubagents({ path: parentPath });
  assert.deepEqual(latest.subagents.map(child => [child.nativeId, child.status]), [['child', 'completed'], ['child-2', 'failed']]);
}));

test('owned native forks retain copied children across generations without granting ancestry or notification path authority', async () => fixture(async (resources, _parentPath, _artifacts, root) => {
  const forkPath = join(root, `${timestamp.replace(/[:.]/g, '-')}_fork.jsonl`);
  const forkArtifacts = forkPath.slice(0, -6);
  const originalPath = join(root, `${timestamp.replace(/[:.]/g, '-')}_original.jsonl`);
  const childPath = join(forkArtifacts, 'child.jsonl');
  await mkdir(forkArtifacts);
  await writeFile(forkPath, jsonl({ ...header, id: 'fork', parentSession: 'intermediate-fork' },
    task('spawn', null, 'call', [], [{ id: 'child', index: 0, status: 'pending' }]),
    delivered('done', 'spawn', [{ jobId: 'child', type: 'task' }, { jobId: 'foreign', type: 'task' }], `<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job child ──\n${resultEnvelope('child', 'completed')}\n── Job foreign ──\n${resultEnvelope('foreign', 'completed')}\n</system-notice>`),
    task('other-branch', null, 'other', [{ id: 'other', index: 0, exitCode: 0 }])));
  const childHeader = { ...header, id: 'child-session', parentSession: originalPath };
  const childMessage = { type: 'message', id: 'answer', parentId: null, message: { role: 'assistant', content: 'Copied child answer artifact://7' } };
  await writeFile(childPath, jsonl(childHeader, childMessage));
  await writeFile(join(forkArtifacts, '7.read.log'), 'Copied native output');
  const parentBytes = await readFile(forkPath);
  const childBytes = await readFile(childPath);
  const saved = (await resources.listHistorySubagents({ path: forkPath, leafId: 'done' })).subagents[0]!;
  assert.equal(saved.status, 'completed');
  const options = { parentPath: forkPath, leafId: 'done', subagentId: saved.id };
  const detail = await resources.readHistorySubagent(options);
  assert.equal(detail.messages[0]?.raw.content, childMessage.message.content);
  assert.equal(detail.session.writable, false);
  assert.equal(detail.session.canFork, false);
  assert.equal((await resources.readSessionArtifact({ ...options, reference: 'artifact://7' })).content, 'Copied native output');
  assert.deepEqual(await readFile(forkPath), parentBytes);
  assert.deepEqual(await readFile(childPath), childBytes);
  await assert.rejects(resources.readHistorySubagent({ ...options, leafId: 'other-branch' }), /selected parent/);
  // Neither the original nor the intermediate parent exists: copied roots alone
  // retain source authority, while ancestry/notification paths grant none.
  const foreignRoot = originalPath.slice(0, -6);
  await mkdir(foreignRoot);
  await writeFile(join(foreignRoot, 'foreign.jsonl'), jsonl(childHeader, { ...childMessage, message: { role: 'assistant', content: 'PRIVATE' } }));
  await writeFile(join(foreignRoot, '9.read.log'), 'PRIVATE');
  assert.deepEqual((await resources.listHistorySubagents({ path: forkPath, leafId: 'done' })).subagents.map(child => child.nativeId), ['child']);
  await assert.rejects(resources.readHistorySubagent({ ...options, subagentId: 'foreign' }), /selected parent/);
  assert.equal((await resources.readSessionArtifact({ ...options, reference: 'artifact://9' })).content, undefined);
  await rm(childPath);
  await writeFile(join(foreignRoot, 'child.jsonl'), childBytes);
  assert.deepEqual((await resources.readHistorySubagent(options)).messages, []);
  assert.equal((await resources.readSessionArtifact({ ...options, reference: 'artifact://7' })).content, 'Copied native output');
  await assert.rejects(resources.readSessionArtifact({ ...options, reference: `desktop-entry:${Buffer.from('answer').toString('base64url')}` }), /unavailable/);
  await assert.rejects(resources.readSessionArtifact({ ...options, leafId: 'other-branch', reference: 'artifact://7' }), /selected parent/);
  assert.equal((await resources.readSessionArtifact({ ...options, reference: 'artifact://9' })).content, undefined);
}));

test('native agent output and structured paths retain selected ownership, Unicode paging and absent old fork locations', async () => fixture(async (resources, parentPath, artifacts, root) => {
  await writeFile(parentPath, jsonl({ ...header, parentSession: 'missing-original' },
    task('selected', null, 'call', [{ id: 'Worker', index: 0, exitCode: 0, outputPath: join(root, 'missing-original', 'Worker.md') }]),
    task('other', null, 'other-call', [{ id: 'Foreign', index: 0, exitCode: 0 }])));
  await writeFile(join(artifacts, 'Worker.md'), 'Readable native deliverable');
  const report = '界🙂'.repeat(15000);
  await writeFile(join(artifacts, 'Worker.json'), JSON.stringify({ reports: [{ data: report }], 'a/b': null }));
  const options = { parentPath, leafId: 'selected' };
  assert.equal((await resources.readSessionArtifact({ ...options, reference: 'agent://Worker' })).content, 'Readable native deliverable');
  const reference = 'agent://Worker/reports/0/data';
  let page = await resources.readSessionArtifact({ ...options, reference });
  const cursor = page.nextCursor!;
  let content = page.content!;
  while (page.nextCursor) { page = await resources.readSessionArtifact({ ...options, reference, cursor: page.nextCursor }); content += page.content; }
  assert.equal(content, report);
  assert.equal((await resources.readSessionArtifact({ ...options, reference: 'agent://Worker/a%2Fb' })).content, 'null');
  await assert.rejects(resources.readSessionArtifact({ ...options, reference: 'agent://Worker/missing' }), /path is missing/);
  await assert.rejects(resources.readSessionArtifact({ ...options, reference: 'agent://Worker/toString' }), /path is missing/);
  await assert.rejects(resources.readSessionArtifact({ ...options, reference: 'agent://Worker/a%2Fb', cursor }), /stale or invalid/);
  await assert.rejects(resources.readSessionArtifact({ parentPath, leafId: 'other', reference }), /does not belong/);
  await assert.rejects(resources.readSessionArtifact({ ...options, reference: 'agent://Foreign' }), /does not belong/);
}));

test('nested agent outputs require persisted edges and unique confined files, not dotted spelling', async () => fixture(async (resources, parentPath, artifacts) => {
  await appendFile(parentPath, jsonl(task('task', null, 'call', [{ id: 'Parent', index: 0, exitCode: 0 }])));
  const childPath = join(artifacts, 'Parent.jsonl');
  await writeFile(childPath, jsonl({ ...header, id: 'old-child-session', parentSession: '/missing/original.jsonl' }, task('nested', null, 'nested-call', [{ id: 'Parent.Child', index: 0, exitCode: 0 }])));
  const nested = join(artifacts, 'Parent');
  await mkdir(nested);
  await writeFile(join(nested, 'Parent.Child.md'), 'Nested native output');
  const options = { parentPath, reference: 'agent://Parent.Child' };
  assert.equal((await resources.readSessionArtifact(options)).content, 'Nested native output');
  await writeFile(join(nested, 'Parent.Unrelated.md'), 'PRIVATE');
  await assert.rejects(resources.readSessionArtifact({ parentPath, reference: 'agent://Parent.Unrelated' }), /does not belong/);
  await writeFile(join(artifacts, 'Parent.Child.md'), 'Ambiguous output');
  const ambiguous = await resources.readSessionArtifact(options);
  assert.equal(ambiguous.content, undefined);
  assert.match(ambiguous.diagnostics.join(' '), /ambiguous/);
  await rm(join(artifacts, 'Parent.Child.md'));
  await rm(childPath);
  await assert.rejects(resources.readSessionArtifact(options), /journal is unavailable/);
}));

test('agent outputs reject reused native identities, forged references and symlink escapes', async () => fixture(async (resources, parentPath, artifacts, root) => {
  await appendFile(parentPath, jsonl(task('first', null, 'first-call', [{ id: 'Worker', index: 0 }]), task('second', 'first', 'second-call', [{ id: 'Worker', index: 0 }])));
  await writeFile(join(artifacts, 'Worker.md'), 'Deliverable');
  await assert.rejects(resources.readSessionArtifact({ parentPath, reference: 'agent://Worker' }), /ambiguous/);
  const outside = join(root, 'outside.md');
  await writeFile(outside, 'PRIVATE');
  await rm(join(artifacts, 'Worker.md'));
  await symlink(outside, join(artifacts, 'Worker.md'));
  assert.equal((await resources.readSessionArtifact({ parentPath, leafId: 'first', reference: 'agent://Worker' })).content, undefined);
  for (const reference of ['agent://../outside', 'agent://%2e%2e/outside', 'agent://Worker:raw', 'file:///private']) await assert.rejects(resources.readSessionArtifact({ parentPath, reference }));
}));

test('owned runtime resources use native identity and confined durable child projection before saved task metadata', async () => fixture(async (resources, parentPath, artifacts, root) => {
  const childPath = join(artifacts, 'Live.jsonl');
  await writeFile(childPath, jsonl({ ...header, id: 'live-session' },
    { type: 'message', id: 'before', parentId: null, message: { role: 'user', content: 'Before compaction' } },
    { type: 'compaction', id: 'compact', parentId: 'before', summary: 'Native summary', firstKeptEntryId: 'before', tokensBefore: 200 },
    { type: 'custom_message', id: 'after', parentId: 'compact', customType: 'delivery', display: true, content: 'Native delivery' }));
  const page = await resources.readRuntimeSubagent({ parentPath, childPath, subagentId: 'Live' });
  assert.deepEqual(page.messages.map(message => message.entryId), ['before', 'compact', 'after']);
  assert.equal(page.session.writable, false);
  const anchor = { beforeEntryId: page.messages[1]!.id, childLeafId: page.selectedLeafId, childRevision: page.revision };
  const preceding = await resources.readRuntimeSubagent({ parentPath, childPath, subagentId: 'Live', ...anchor });
  assert.deepEqual(preceding.messages.map(message => message.entryId), ['before']);
  const restored = await resources.readRuntimeSubagent({ parentPath, childPath, subagentId: 'Live', childLeafId: page.selectedLeafId, childRevision: page.revision });
  assert.deepEqual(restored.messages.map(message => message.entryId), ['before', 'compact', 'after']);
  await assert.rejects(resources.readRuntimeSubagent({ parentPath, childPath, subagentId: 'Live', ...anchor, childLeafId: 'before' }), /selected branch/);
  await assert.rejects(resources.readRuntimeSubagent({ parentPath, childPath, subagentId: 'Live', ...anchor, childRevision: 'stale' }), /anchor is stale/);
  await writeFile(join(artifacts, 'Live.md'), 'Live deliverable');
  const nativeSubagents = [{ id: 'Live', sessionFile: childPath }];
  assert.equal((await resources.readRuntimeArtifact({ parentPath, reference: 'agent://Live', nativeSubagents })).content, 'Live deliverable');
  await assert.rejects(resources.readRuntimeArtifact({ parentPath, reference: 'agent://Live', nativeSubagents: [] }), /does not belong/);
  await assert.rejects(resources.readRuntimeSubagent({ parentPath, childPath, subagentId: 'Other' }), /native identity/);
  const outside = join(root, 'Live.jsonl');
  await writeFile(outside, jsonl({ ...header, id: 'private' }));
  await assert.rejects(resources.readRuntimeSubagent({ parentPath, childPath: outside, subagentId: 'Live' }), /escapes/);
}));

test('long recorded history preserves saved recovery without granting foreign-source authority', async () => fixture(async (resources, parentPath, artifacts, root) => {
  const rows: unknown[] = [header, task('old', null, 'old-call', [{ id: 'SavedOnly', index: 0 }])];
  for (let index = 0; index < 100000; index++) rows.push({ type: 'message', id: `m${index}`, parentId: index ? `m${index - 1}` : 'old', message: { role: 'user', content: 'History' } });
  rows.push(task('latest', 'm99999', 'live-call', [{ id: 'Worker', index: 0 }]));
  await writeFile(parentPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const nested = join(artifacts, 'nested');
  await mkdir(nested);
  const childPath = join(nested, 'Worker.jsonl');
  await writeFile(childPath, jsonl({ ...header, id: 'worker-session' }));
  await writeFile(join(artifacts, 'Worker.md'), 'Owned deliverable');
  await writeFile(join(artifacts, 'SavedOnly.md'), 'Saved-only deliverable');
  const nativeSubagents = [{ id: 'roster-worker', nativeId: 'Worker', sessionFile: childPath }];
  const options = { parentPath, leafId: 'latest', reference: 'agent://Worker' };
  assert.equal((await resources.readRuntimeArtifact({ ...options, nativeSubagents })).content, 'Owned deliverable');
  assert.equal((await resources.readSessionArtifact(options)).content, 'Owned deliverable');
  assert.equal((await resources.readRuntimeArtifact({ ...options, nativeSubagents, reference: 'agent://SavedOnly' })).content, 'Saved-only deliverable');
  await assert.rejects(resources.readRuntimeArtifact({ ...options, nativeSubagents: [...nativeSubagents, { id: 'Worker' }] }), /ambiguous/);
  await writeFile(join(nested, 'Worker.md'), 'Conflicting output');
  const ambiguous = await resources.readRuntimeArtifact({ ...options, nativeSubagents });
  assert.equal(ambiguous.content, undefined);
  assert.match(ambiguous.diagnostics.join(' '), /ambiguous/);
  const outside = join(root, 'Worker.jsonl');
  await writeFile(outside, jsonl({ ...header, id: 'foreign' }));
  await assert.rejects(resources.readRuntimeArtifact({ ...options, nativeSubagents: [{ id: 'Worker', sessionFile: outside }] }), /escapes/);
}));

test('Markdown and resource chips select distinct percent and slash keys with one backend decode', async () => fixture(async (resources, parentPath, artifacts) => {
  await appendFile(parentPath, jsonl(task('task', null, 'call', [{ id: 'Worker', index: 0 }])));
  await writeFile(join(artifacts, 'Worker.md'), 'Structured deliverable');
  await writeFile(join(artifacts, 'Worker.json'), JSON.stringify({ 'a%2Fb': 'Percent key', 'a/b': 'Slash key', a: { b: 'Nested key' }, '%ZZ': 'Literal malformed-looking key' }));
  for (const [path, expected] of [['a%252Fb', 'Percent key'], ['a%2Fb', 'Slash key'], ['a/b', 'Nested key'], ['%25ZZ', 'Literal malformed-looking key']]) {
    const reference = `agent://Worker/${path}`;
    const chip = sessionResourceReferences(`[result](${reference})`)[0]!;
    for (const selected of [markdownSessionResourceReference(reference), chip]) {
      assert.equal((await resources.readSessionArtifact({ parentPath, reference: selected })).content, expected);
    }
  }
  for (const path of ['%', '%ZZ', '%E0%A4%A']) {
    const reference = `agent://Worker/${path}`;
    for (const selected of [markdownSessionResourceReference(reference), sessionResourceReferences(reference)[0]!]) {
      await assert.rejects(resources.readSessionArtifact({ parentPath, reference: selected }), /Invalid agent output JSON-path encoding/);
    }
  }
  await writeFile(join(artifacts, '9.output.log'), '### region 1 (tool, ~10 tok)\nfirst\n### region 2 (tool, ~20 tok)\nsecond\n');
  const region = await resources.readSessionArtifact({ parentPath, reference: markdownSessionResourceReference('artifact://9%20(region%202)') });
  assert.match(region.content!, /second/);
  assert.doesNotMatch(region.content!, /first/);
}));

test('parent provenance resolves only already granted sources and keeps location aliases distinct from ancestry', async () => fixture(async (resources, parentPath, _artifacts, root) => {
  const original = join(root, 'original.jsonl');
  const duplicate = join(root, 'duplicate.jsonl');
  await writeFile(parentPath, jsonl({ ...header, parentSession: 'original' }));
  await writeFile(original, jsonl({ ...header, id: 'original', previousSessionFiles: [join(root, 'old-location.jsonl')] }));
  await writeFile(duplicate, jsonl({ ...header, id: 'original' }));
  const reader = new HistoryReader();
  try {
    const source = (await reader.resourceContext(original)).session;
    const other = (await reader.resourceContext(duplicate)).session;
    assert.equal((await resources.resolveParentSession({ path: parentPath, sources: [] })).status, 'missing');
    const found = await resources.resolveParentSession({ path: parentPath, sources: [source] });
    assert.equal(found.status, 'resolved');
    if (found.status === 'resolved') assert.equal(found.session.path, original);
    assert.equal((await resources.resolveParentSession({ path: parentPath, sources: [source, other] })).status, 'ambiguous');
    assert.equal((await resources.resolveParentSession({ path: original, sources: [source, other] })).status, 'none');
    await writeFile(parentPath, jsonl({ ...header, parentSession: join(root, 'old-location.jsonl') }));
    assert.equal((await resources.resolveParentSession({ path: parentPath, sources: [source] })).status, 'resolved');
  } finally { reader.close(); }
}));

test('structured outputs use same-root sidecars, explicit missing paths and safe Markdown JSON fallback', async () => fixture(async (resources, parentPath, artifacts, root) => {
  await appendFile(parentPath, jsonl(task('task', null, 'call', [{ id: 'Worker', index: 0 }])));
  await writeFile(join(artifacts, 'Worker.md'), JSON.stringify({ report: 'Native JSON fallback', list: ['First'] }));
  await writeFile(join(artifacts, 'Worker.json'), '{partial');
  const options = { parentPath, reference: 'agent://Worker/report' };
  const fallback = await resources.readSessionArtifact(options);
  assert.equal(fallback.content, 'Native JSON fallback');
  assert.match(fallback.diagnostics.join(' '), /not valid JSON/);
  assert.equal((await resources.readSessionArtifact({ parentPath, reference: 'agent://Worker/list/00' })).content, 'First');
  await assert.rejects(resources.readSessionArtifact({ parentPath, reference: 'agent://Worker/list/length' }), /path is missing/);
  await rm(join(artifacts, 'Worker.json'));
  const outside = join(root, 'private.json');
  await writeFile(outside, JSON.stringify({ report: 'PRIVATE' }));
  await symlink(outside, join(artifacts, 'Worker.json'));
  await assert.rejects(resources.readSessionArtifact(options), /safely resolved/);
}));

test('eight saved levels retain original copied or archived root authority and verified back navigation', async () => fixture(async (resources, parentPath, artifacts, root) => {
  await writeFile(parentPath, jsonl({ ...header, parentSession: '/missing/original.jsonl' }, task('selected', null, 'root-call', [{ id: 'Level1', index: 0 }]), task('foreign', null, 'foreign-call', [{ id: 'Foreign', index: 0 }])));
  for (let level = 1; level <= 8; level++) {
    const id = Array.from({ length: level }, (_, index) => `Level${index + 1}`).join('.');
    const rows: unknown[] = [{ ...header, id, parentSession: '/missing/original.jsonl' }, { type: 'message', id: 'answer', parentId: null, message: { role: 'assistant', content: `Durable level ${level}` } }];
    if (level < 8) rows.push(task('child', 'answer', `call-${level}`, [{ id: `${id}.Level${level + 1}`, index: 0, agent: `Level${level + 1}` }]));
    await writeFile(join(artifacts, `${id}.jsonl`), jsonl(...rows));
    await writeFile(join(artifacts, `${id}.md`), `Output level ${level}`);
  }
  await writeFile(join(artifacts, '11.read.log'), 'Original authorized shared artifact');
  const archive = join(root, 'parent.jsonl.gz');
  await writeFile(archive, gzipSync(await readFile(parentPath)));
  for (const source of [parentPath, archive]) {
    const options = { parentPath: source, leafId: 'selected' };
    let child = (await resources.listHistorySubagents({ path: source, leafId: 'selected' })).subagents[0]!;
    let ancestry: SavedSubagentEdge[] = [];
    const visits: { subagentId: string; ancestry: typeof ancestry }[] = [];
    for (let level = 1; level <= 8; level++) {
      const selection = { ...options, subagentId: child.id, ancestry };
      visits.push(selection);
      const page = await resources.readHistorySubagent(selection);
      assert.equal(page.messages[0]?.raw.content, `Durable level ${level}`);
      assert.deepEqual(page.navigation!.ancestors.map(agent => agent.id), visits.slice(0, -1).map(visit => visit.subagentId));
      assert.equal((await resources.readSessionArtifact({ ...selection, reference: 'artifact://11' })).content, 'Original authorized shared artifact');
      assert.match((await resources.readSessionArtifact({ ...selection, reference: `desktop-entry:${Buffer.from('answer').toString('base64url')}` })).content!, new RegExp(`Durable level ${level}`));
      assert.equal((await resources.readSessionArtifact({ ...selection, reference: `agent://${child.nativeId}` })).content, `Output level ${level}`);
      ancestry = page.navigation!.childAncestry;
      child = page.navigation!.children[0]!;
    }
    for (let index = visits.length - 1; index >= 0; index--) assert.equal((await resources.readHistorySubagent({ ...options, ...visits[index]! })).messages[0]?.raw.content, `Durable level ${index + 1}`);
    await assert.rejects(resources.readHistorySubagent({ ...options, ...visits[7]!, leafId: 'foreign' }), /selected parent/);
  }
}));

test('saved descendant selectors reject foreign roots, header-only edges, escapes and changed branches', async () => fixture(async (resources, parentPath, artifacts, root) => {
  await appendFile(parentPath, jsonl(task('root', null, 'root-call', [{ id: 'Parent', index: 0 }])));
  const parentChild = join(artifacts, 'Parent.jsonl');
  await writeFile(parentChild, jsonl({ ...header, id: 'parent-child' }, task('edge', null, 'edge-call', [{ id: 'Undotted', index: 0 }])));
  await writeFile(join(artifacts, 'Undotted.jsonl'), jsonl({ ...header, id: 'nested', parentSession: 'unrelated-header' }, { type: 'message', id: 'answer', parentId: null, message: { role: 'assistant', content: 'Verified undotted edge' } }));
  const first = (await resources.listHistorySubagents({ path: parentPath })).subagents[0]!;
  const page = await resources.readHistorySubagent({ parentPath, subagentId: first.id });
  const selected = { parentPath, subagentId: page.navigation!.children[0]!.id, ancestry: page.navigation!.childAncestry };
  assert.equal((await resources.readHistorySubagent(selected)).messages[0]?.raw.content, 'Verified undotted edge');
  await assert.rejects(resources.readHistorySubagent({ parentPath, subagentId: selected.subagentId }), /selected parent/);
  await writeFile(join(artifacts, 'Undotted.md'), 'Verified undotted output');
  assert.equal((await resources.readSessionArtifact({ ...selected, reference: 'agent://Undotted' })).content, 'Verified undotted output');
  await writeFile(join(artifacts, 'Parent.HeaderOnly.jsonl'), jsonl({ ...header, id: 'Parent.HeaderOnly', parentSession: parentChild }, { type: 'message', id: 'private', parentId: null, message: { role: 'assistant', content: 'HEADER ONLY PRIVATE' } }));
  const foreign = join(root, 'foreign.jsonl');
  await writeFile(foreign, jsonl({ ...header, id: 'foreign', parentSession: parentPath }));
  await assert.rejects(resources.readHistorySubagent({ ...selected, parentPath: foreign }), /selected parent/);
  await assert.rejects(resources.readHistorySubagent({ ...selected, subagentId: 'Parent.HeaderOnly' }), /selected parent/);
  await assert.rejects(resources.readHistorySubagent({ ...selected, subagentId: '../foreign' }), /selected parent/);
  await rm(join(artifacts, 'Undotted.jsonl'));
  await symlink(foreign, join(artifacts, 'Undotted.jsonl'));
  await assert.rejects(resources.readHistorySubagent(selected), /unavailable/);
  await assert.rejects(resources.readSessionArtifact({ ...selected, reference: `desktop-entry:${Buffer.from('answer').toString('base64url')}` }), /unavailable/);
  await appendFile(parentChild, jsonl({ type: 'message', id: 'changed', parentId: 'edge', message: { role: 'assistant', content: 'Changed branch' } }));
  await assert.rejects(resources.readHistorySubagent(selected), /selected branch changed/);
}));

test('saved descendant navigation rejects cycles and reused journal identity', async () => fixture(async (resources, parentPath, artifacts) => {
  await appendFile(parentPath, jsonl(task('root', null, 'root-call', [{ id: 'Parent', index: 0 }])));
  const childPath = join(artifacts, 'Parent.jsonl');
  await writeFile(childPath, jsonl({ ...header, id: 'child' }, task('cycle', null, 'cycle-call', [{ id: 'Parent', index: 0 }])));
  const first = (await resources.listHistorySubagents({ path: parentPath })).subagents[0]!;
  let page = await resources.readHistorySubagent({ parentPath, subagentId: first.id });
  await assert.rejects(resources.readHistorySubagent({ parentPath, subagentId: page.navigation!.children[0]!.id, ancestry: page.navigation!.childAncestry }), /cycle/);
  await writeFile(childPath, jsonl({ ...header, id: 'child' }, task('one', null, 'one-call', [{ id: 'Nested', index: 0 }]), task('two', 'one', 'two-call', [{ id: 'Nested', index: 0 }])));
  page = await resources.readHistorySubagent({ parentPath, subagentId: first.id });
  await assert.rejects(resources.readHistorySubagent({ parentPath, subagentId: page.navigation!.children[0]!.id, ancestry: page.navigation!.childAncestry }), /ambiguous/);
}));

test('single and batch wait recovery settles actual members independently of the primary async job', async () => fixture(async (resources, parentPath) => {
  const ids = ['DocsConsolidate', 'Primary', 'PanelFilesDiff'];
  const spawn = task('spawn', null, 'call', [], ids.map((id, index) => ({ id, index, status: 'pending', tokens: 0 })));
  const wait = { type: 'message', id: 'wait', parentId: 'spawn', timestamp, message: { role: 'toolResult', toolName: 'wait', toolCallId: 'wait-call', details: { jobs: [{ id: 'DocsConsolidate', agentUrlId: 'DocsConsolidate', type: 'task', status: 'completed', resultText: resultEnvelope('DocsConsolidate', 'completed') }, { id: 'Primary', agentUrlId: 'Primary', type: 'task', status: 'running' }, { id: 'PanelFilesDiff-2', agentUrlId: 'PanelFilesDiff', type: 'task', status: 'completed', resultText: resultEnvelope('PanelFilesDiff', 'completed') }] } } };
  await writeFile(parentPath, jsonl(header, spawn, wait));
  const result = await resources.listHistorySubagents({ path: parentPath });
  assert.deepEqual(result.subagents.map(agent => [agent.nativeId, agent.status]), [['DocsConsolidate', 'completed'], ['Primary', 'running'], ['PanelFilesDiff', 'completed']]);
}));

test('authorized child yields and measured metrics refresh without a parent append, while later invalidation reopens', async () => fixture(async (resources, parentPath, artifacts) => {
  await writeFile(parentPath, jsonl(header, task('spawn', null, 'call', [], [{ id: 'child', status: 'pending', tokens: 0, cost: 0, toolCount: 0, durationMs: 0 }])));
  const childPath = join(artifacts, 'child.jsonl');
  const yieldCall = { type: 'message', id: 'call-yield', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', usage: { input: 10, output: 3, cacheWrite: 2, cacheRead: 100, cost: { total: 0.1 } }, content: [{ type: 'toolCall', id: 'yield', name: 'yield', arguments: { data: { done: true } } }] } };
  await writeFile(childPath, jsonl({ ...header, id: 'child' }, yieldCall));
  assert.equal((await resources.listHistorySubagents({ path: parentPath })).subagents[0].status, 'unknown');
  await appendFile(childPath, jsonl({ type: 'message', id: 'accepted', parentId: 'call-yield', timestamp: '2026-01-01T00:00:02Z', message: { role: 'toolResult', toolName: 'yield', toolCallId: 'yield', details: { status: 'success' } } }));
  const done = (await resources.listHistorySubagents({ path: parentPath })).subagents[0];
  assert.equal(done.status, 'completed');
  assert.equal(done.progress?.tokens, 15);
  assert.equal(done.progress?.toolCount, 1);
  assert.equal(done.progress?.cost, 0.1);
  await appendFile(childPath, jsonl({ type: 'custom_message', id: 'invalidation', parentId: 'accepted', timestamp: '2026-01-01T00:00:03Z', customType: 'async-result', content: 'A later completion' }));
  const resumed = (await resources.listHistorySubagents({ path: parentPath })).subagents[0];
  assert.equal(resumed.status, 'unknown');
  assert.match(evidenceOf(resumed).reason!, /invalidated/);
}));

test('saved discovery retries a revision change and retains complete evidence under continued growth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-discovery-revision-'));
  const path = join(root, 'parent.jsonl');
  class GrowingReader extends HistoryReader {
    remaining = 1;
    changes = 0;
    override async taskMetadata(options: { path: string; revision: string; entryIds: string[] }) {
      if (this.remaining > 0) {
        this.remaining--; this.changes++;
        await appendFile(path, jsonl(task(`growth-${this.changes}`, this.changes === 1 ? 'initial' : `growth-${this.changes - 1}`, `call-${this.changes}`, [{ id: `child-${this.changes}`, index: 0, exitCode: 0 }])));
      }
      return super.taskMetadata(options);
    }
  }
  const reader = new GrowingReader();
  const resources = new SessionResources(reader, async () => root);
  try {
    await writeFile(path, jsonl(header, task('initial', null, 'initial-call', [{ id: 'initial-child', index: 0, exitCode: 0 }])));
    const recovered = await resources.listHistorySubagents({ path });
    assert.deepEqual(recovered.subagents.map(child => child.nativeId).sort(), ['child-1', 'initial-child']);
    assert.equal(reader.changes, 1);
    reader.remaining = 10;
    const retained = await resources.listHistorySubagents({ path });
    assert.deepEqual(retained.subagents.map(child => child.nativeId).sort(), ['child-1', 'initial-child']);
    assert.equal(reader.changes, 4);
    assert.ok(retained.diagnostics.some(message => message.includes('still changing')));
    const fresh = new SessionResources(reader, async () => root);
    const incomplete = await fresh.listHistorySubagents({ path });
    assert.deepEqual(incomplete.subagents, []);
    assert.ok(incomplete.diagnostics.some(message => message.includes('still changing')));
    assert.equal(reader.changes, 7);
    const stale = await reader.read({ path }, root);
    await appendFile(path, jsonl(task('last', 'growth-7', 'last-call', [])));
    await assert.rejects(reader.openTaskMetadata({ path, leafId: stale.selectedLeafId, revision: stale.revision }), HistoryRevisionChangedError);
  } finally { reader.close(); await rm(root, { recursive: true, force: true }); }
});

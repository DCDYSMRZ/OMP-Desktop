import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HistoryReader } from './journal';
import { SessionResources } from './session-resources';

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
  const complete = delivered('done-ab', 'between-219', [{ jobId: 'SmokeB', type: 'task', durationMs: 97 }, { jobId: 'SmokeA', type: 'task', durationMs: 97 }], `<system-notice>2 background jobs have completed.\n${resultEnvelope('SmokeB', 'completed')}\n${resultEnvelope('SmokeA', 'completed')}\n</system-notice>`);
  const failed = delivered('done-c', 'done-ab', [{ jobId: 'SmokeC', type: 'task', durationMs: 95015 }], `<system-notice>Background job SmokeC has completed.\n${resultEnvelope('SmokeC', 'failed (exit 1)', 'Subagent exited without calling yield after 3 reminders.')}\n</system-notice>`);
  await writeFile(parentPath, jsonl(header, pending, ...between, complete, failed));
  const original = await readFile(parentPath);
  for (const path of [parentPath, `${parentPath}.gz`]) {
    if (path !== parentPath) await writeFile(path, gzipSync(original));
    const saved = await resources.listHistorySubagents({ path });
    assert.deepEqual(saved.subagents.map(child => [child.nativeId, child.status, child.task]), [['SmokeA', 'completed', 'Assignment SmokeA'], ['SmokeB', 'completed', 'Assignment SmokeB'], ['SmokeC', 'failed', 'Assignment SmokeC']]);
    assert.equal(saved.subagents[0]!.progress!.durationMs, 97);
    assert.equal(saved.subagents[2]!.progress!.durationMs, 95015);
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
      assert.ok(saved.diagnostics.some(reason => reason.includes('Duplicate')));
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

test('owned native forks retain copied children across generations without granting ancestry or notification path authority', async () => fixture(async (resources, _parentPath, _artifacts, root) => {
  const forkPath = join(root, `${timestamp.replace(/[:.]/g, '-')}_fork.jsonl`);
  const forkArtifacts = forkPath.slice(0, -6);
  const originalPath = join(root, `${timestamp.replace(/[:.]/g, '-')}_original.jsonl`);
  const childPath = join(forkArtifacts, 'child.jsonl');
  await mkdir(forkArtifacts);
  await writeFile(forkPath, jsonl({ ...header, id: 'fork', parentSession: 'intermediate-fork' },
    task('spawn', null, 'call', [], [{ id: 'child', index: 0, status: 'pending' }]),
    delivered('done', 'spawn', [{ jobId: 'child', type: 'task' }, { jobId: 'foreign', type: 'task' }], resultEnvelope('child', 'completed') + resultEnvelope('foreign', 'completed')),
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
  assert.equal((await resources.readSessionArtifact({ ...options, reference: 'artifact://7' })).content, undefined);
}));

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryReader } from './journal';
import { SessionResources } from './session-resources';
import { TurnChangeEvidenceReader } from './turn-change-evidence';
import type { NativeMessage } from '../../shared/contracts';
import { resolveFinalChanges } from '../../shared/change-net';

const timestamp = '2026-01-01T00:00:00.000Z';
const header = (id: string, cwd = '/workspace') => ({ type: 'session', version: 3, id, cwd, timestamp });
const jsonl = (...rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
function journal(id: string, messages: NativeMessage[], cwd = '/workspace'): string {
  return jsonl(header(id, cwd), ...messages.map((message, index) => ({ type: 'message', id: `e${index}`, parentId: index ? `e${index - 1}` : null, timestamp, message: { timestamp: Date.parse(timestamp) + index, ...message } })));
}
const call = (id: string, name: string, args: unknown): NativeMessage => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] });
const result = (id: string, name: string, details: unknown = {}): NativeMessage => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [], details });
const yieldRows = (): NativeMessage[] => [call('yield', 'yield', { data: { done: true } }), result('yield', 'yield', { status: 'success' })];
const editRows = (id: string, paths: string[]): NativeMessage[] => [call(id, 'edit', { input: paths.map(path => `[${path}#1234]\nPUT 1.=1:\n+new`).join('\n') }), result(id, 'edit', { snapshotsPruned: true, perFileResults: paths.map(path => ({ path, diff: '@@ -1 +1 @@\n-old\n+new', isError: false })) })];
async function fixture(run: (collector: TurnChangeEvidenceReader, parent: string, artifacts: string, resources: SessionResources, reader: HistoryReader) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omp-turn-evidence-')), parent = join(root, 'parent.jsonl'), artifacts = join(root, 'parent');
  await mkdir(artifacts); await mkdir(join(root, 'blobs'));
  const reader = new HistoryReader(), resources = new SessionResources(reader, async () => join(root, 'blobs'));
  try { await run(new TurnChangeEvidenceReader(reader, resources), parent, artifacts, resources, reader); }
  finally { reader.close(); await rm(root, { recursive: true, force: true }); }
}

test('late original-task child-only multi-file edits survive pruned snapshots but later assignments do not leak', async () => fixture(async (collector, parent, artifacts) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Original task' }, call('task-a', 'task', { tasks: [{ task: 'Fix files' }] }), { role: 'user', content: 'Later parent request' }, result('task-a', 'task', { results: [{ id: 'child', index: 0, exitCode: 0 }] })]));
  await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [{ role: 'user', attribution: 'agent', content: 'Fix files' }, ...editRows('edit', ['one.ts', 'two.ts']), ...yieldRows(), { role: 'user', attribution: 'agent', content: 'Different assignment' }, ...editRows('later-edit', ['later.ts']), ...yieldRows()], '/child-workspace'));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'parent:e0' });
  assert.deepEqual(evidence.operations.map(operation => operation.path).sort(), ['/child-workspace/one.ts', '/child-workspace/two.ts']);
  assert.deepEqual(evidence.toolCallIds, ['task-a']);
  assert.equal(evidence.operations[0]!.origin.parentToolCallId, 'task-a');
  assert.equal(evidence.operations[0]!.origin.sessionId, 'child-session');
}));

test('native agent steering before work preserves child edits and accepted yield without admitting rejected edits', async () => fixture(async (collector, parent, artifacts, resources) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Delegate' }, call('task-a', 'task', {}), result('task-a', 'task', { results: [{ id: 'child', index: 0, exitCode: 0 }] })]));
  const rejected = editRows('rejected-edit', ['rejected.ts']);
  rejected[1] = { ...rejected[1]!, isError: true, details: { error: 'Anchor is unavailable' } };
  await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [
    { role: 'user', attribution: 'agent', content: 'Original assignment' },
    { role: 'user', attribution: 'agent', steering: true, content: 'Parent coordination before work' },
    { role: 'assistant', content: [] },
    { role: 'user', attribution: 'agent', steering: true, content: 'Parent coordination before edits' },
    ...rejected, ...editRows('accepted-edit', ['reducer.ts', 'projection.ts']), ...yieldRows(),
  ]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.equal(evidence.pending, false);
  assert.deepEqual(evidence.reasons, []);
  assert.deepEqual(evidence.operations.filter(operation => operation.applied === 'confirmed').map(operation => operation.path).sort(), ['/workspace/projection.ts', '/workspace/reducer.ts']);
  assert.deepEqual(resolveFinalChanges(evidence.operations).map(change => change.path).sort(), ['/workspace/projection.ts', '/workspace/reducer.ts']);
  const child = (await resources.listHistorySubagents({ path: parent })).subagents[0]!;
  const selected = await collector.collect({ context: { kind: 'saved', parentPath: parent, subagentId: child.id }, anchorId: 'e8' });
  assert.equal(selected.startEntryId, 'e0');
  assert.deepEqual(resolveFinalChanges(selected.operations).map(change => change.path).sort(), ['/workspace/projection.ts', '/workspace/reducer.ts']);
}));

test('genuine later assignments end original child ownership even before a terminal yield', async () => {
  for (const next of [
    { role: 'user', attribution: 'agent', content: 'New assignment' },
    { role: 'user', attribution: 'user', steering: true, content: 'New user request' },
  ]) await fixture(async (collector, parent, artifacts) => {
    await writeFile(parent, journal('parent', [{ role: 'user', content: 'Delegate' }, call('task-a', 'task', {}), result('task-a', 'task', { results: [{ id: 'child', index: 0, exitCode: 0 }] })]));
    await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [
      { role: 'user', attribution: 'agent', content: 'Original assignment' },
      { role: 'user', attribution: 'agent', steering: true, content: 'Coordination' },
      ...editRows('original-edit', ['original.ts']), next, ...editRows('unrelated-edit', ['unrelated.ts']), ...yieldRows(),
    ]));
    const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
    assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/original.ts']);
    assert.equal(evidence.pending, true);
    assert.match(evidence.reasons.join(' '), /no accepted terminal yield/);
  });
});

test('post-yield agent steering neither revokes completion nor authorizes revived child work', async () => {
  for (const revived of [false, true]) await fixture(async (collector, parent, artifacts) => {
    await writeFile(parent, journal('parent', [{ role: 'user', content: 'Delegate' }, call('task-a', 'task', {}), result('task-a', 'task', { results: [{ id: 'child', index: 0, exitCode: 0 }] })]));
    await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [
      { role: 'user', attribution: 'agent', content: 'Original assignment' }, ...editRows('original-edit', ['original.ts']), ...yieldRows(),
      { role: 'user', attribution: 'agent', steering: true, content: 'Later coordination' },
      ...(revived ? [...editRows('revived-edit', ['revived.ts']), call('revived-yield', 'yield', {}), result('revived-yield', 'yield', { status: 'success' })] : []),
    ]));
    const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
    assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/original.ts']);
    assert.equal(evidence.pending, false);
    if (revived) assert.match(evidence.reasons.join(' '), /without original-task ownership/);
    else assert.deepEqual(evidence.reasons, []);
  });
});

test('queued pre-yield native steering preserves subsequent original-task final endpoints', async () => fixture(async (collector, parent, artifacts) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Delegate' }, call('task-a', 'task', {}), result('task-a', 'task', { results: [{ id: 'child', index: 0, exitCode: 0 }] })]));
  const later = editRows('later-edit', ['original.ts']);
  later[1] = result('later-edit', 'edit', { perFileResults: [{ path: 'original.ts', diff: '@@ -1 +1 @@\n-new\n+final', isError: false }] });
  await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [
    { role: 'user', attribution: 'agent', content: 'Original assignment' }, ...editRows('original-edit', ['original.ts']),
    call('yield-first', 'yield', {}), { ...result('yield-first', 'yield', { status: 'success' }), timestamp: Date.parse(timestamp) + 20 },
    { role: 'user', attribution: 'agent', steering: true, timestamp: Date.parse(timestamp) + 10, content: 'Queued during original work' },
    ...later, ...yieldRows(),
  ]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.equal(evidence.pending, false);
  assert.deepEqual(evidence.reasons, []);
  const changes = resolveFinalChanges(evidence.operations);
  assert.deepEqual(changes.map(change => change.path), ['/workspace/original.ts']);
  assert.match(changes[0]!.patch, /\+final/);
  assert.match(changes[0]!.patch, /-old/);
}));

test('typed same-turn parent delivery authorizes only the addressed original child continuation', async () => {
  for (const scenario of ['edits', 'completion', 'other-recipient', 'later-parent-turn', 'failed-delivery', 'outside-delivery', 'new-assignment'] as const) await fixture(async (collector, parent, artifacts) => {
    const at = (offset: number) => Date.parse(timestamp) + offset;
    const recipient = scenario === 'other-recipient' ? 'other' : 'child';
    const original: NativeMessage[] = [{ role: 'user', content: 'Delegate' }, call('task-a', 'task', {}), result('task-a', 'task', { results: [{ id: 'child', index: 0, exitCode: 0 }] })];
    await writeFile(parent, journal('parent', [
      ...original, ...(scenario === 'later-parent-turn' ? [{ role: 'user', content: 'Unrelated parent request' }] : []),
      { ...call('delivery', 'write', { path: `agent://${recipient}`, content: 'Continue' }), timestamp: at(20) },
      { ...result('delivery', 'write', { message: { op: 'send', from: 'Main', to: recipient, receipts: [{ to: recipient, outcome: 'woken' }] } }), isError: scenario === 'failed-delivery', timestamp: at(40) },
    ]));
    const later = editRows('later-edit', ['original.ts']);
    later[1] = result('later-edit', 'edit', { perFileResults: [{ path: 'original.ts', diff: '@@ -1 +1 @@\n-new\n+final', isError: false }] });
    const rejected = editRows('rejected', ['rejected.ts']);
    rejected[1] = { ...result('rejected', 'edit'), isError: true };
    await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [
      { role: 'user', attribution: 'agent', content: 'Original assignment' }, ...editRows('original-edit', ['original.ts']),
      call('yield-first', 'yield', {}), { ...result('yield-first', 'yield', { status: 'success' }), timestamp: at(10) },
      scenario === 'new-assignment'
        ? { role: 'user', attribution: 'agent', timestamp: at(30), content: 'Genuine new assignment' }
        : { role: 'custom', customType: 'irc:incoming', attribution: 'agent', display: true, details: { id: 'native-delivery', from: 'Main' }, timestamp: at(scenario === 'outside-delivery' ? 41 : 30), content: 'Coordination' },
      ...(scenario === 'completion' ? [] : [...rejected, ...later]), ...yieldRows(),
    ]));
    const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
    assert.equal(evidence.pending, false);
    const changes = resolveFinalChanges(evidence.operations);
    assert.deepEqual(changes.map(change => change.path), ['/workspace/original.ts']);
    assert.match(changes[0]!.patch, scenario === 'edits' ? /\+final/ : /\+new/);
    if (scenario === 'edits' || scenario === 'completion' || scenario === 'new-assignment') assert.deepEqual(evidence.reasons, []);
    else assert.match(evidence.reasons.join(' '), /without original-task ownership/);
  });
});

test('tool IDs from independent sources remain independent and another parent turn is isolated', async () => fixture(async (collector, parent, artifacts) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'First' }, ...editRows('same-id', ['parent.ts']), call('task-a', 'task', {}), result('task-a', 'task', { results: [{ id: 'child', index: 0, exitCode: 0 }] }), { role: 'user', content: 'Second' }, ...editRows('second-edit', ['second.ts'])]));
  await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [{ role: 'user', content: 'Child task' }, ...editRows('same-id', ['child.ts']), ...yieldRows()]));
  const first = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.deepEqual(first.operations.map(operation => operation.path).sort(), ['/workspace/child.ts', '/workspace/parent.ts']);
  assert.notEqual(first.operations[0]!.id, first.operations[1]!.id);
  const second = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e5' });
  assert.deepEqual(second.operations.map(operation => operation.path), ['/workspace/second.ts']);
  const wrong = await collector.collect({ context: { kind: 'saved', parentPath: parent, leafId: 'e4' }, anchorId: 'e5', toolCallIds: ['second-edit'] });
  assert.deepEqual(wrong.operations, []); assert.equal(wrong.complete, false);
}));

test('deferred assistant calls and per-file results are hydrated, while missing child journals remain incomplete', async () => fixture(async (collector, parent) => {
  const rows = editRows('large', ['large.ts']);
  const blocks = rows[0]!.content as Record<string, unknown>[];
  (blocks[0]!.arguments as Record<string, unknown>).i = 'x'.repeat(1100000);
  (rows[1]!.details as Record<string, unknown>).padding = 'x'.repeat(1100000);
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Edit and delegate' }, ...rows, call('task-missing', 'task', {}), result('task-missing', 'task', { results: [{ id: 'absent', index: 0, exitCode: 0 }] })]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/large.ts']);
  assert.equal(evidence.complete, false);
  assert.match(evidence.reasons.join(' '), /child|Child|source|journal/);
}));

test('missing tool results report pending evidence rather than confirmed writes', async () => fixture(async (collector, parent) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Write' }, call('pending-write', 'write', { path: 'new.ts', content: 'not confirmed' })]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.equal(evidence.pending, true); assert.equal(evidence.complete, false);
  assert.equal(evidence.operations.some(operation => operation.applied === 'confirmed'), false);
  assert.match(evidence.reasons.join(' '), /pending/);
}));

test('nested authorized child edges recurse but untrusted report paths never become sources', async () => fixture(async (collector, parent, artifacts) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Delegate' }, call('task-a', 'task', {}), result('task-a', 'task', { results: [{ id: 'child', index: 0, exitCode: 0, sessionFile: '/untrusted/outside.jsonl' }] })]));
  await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [{ role: 'user', content: 'Delegate nested' }, call('nested-task', 'task', {}), result('nested-task', 'task', { results: [{ id: 'nested', index: 0, exitCode: 0 }] }), ...yieldRows()]));
  await mkdir(join(artifacts, 'child'));
  await writeFile(join(artifacts, 'child', 'nested.jsonl'), journal('nested-session', [{ role: 'user', content: 'Edit' }, ...editRows('nested-edit', ['nested.ts']), ...yieldRows()]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/nested.ts']);
  assert.equal(evidence.operations[0]!.origin.parentToolCallId, 'nested-task');
}));

test('required older pages and automatic child delivery remain bound to the original assignment', async () => fixture(async (collector, parent, artifacts, resources) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Delegate' }, call('task-a', 'task', {}), result('task-a', 'task', { results: [{ id: 'child', index: 0, exitCode: 0 }] })]));
  const filler: NativeMessage[] = Array.from({ length: 240 }, () => ({ role: 'assistant', content: [] }));
  await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [{ role: 'user', attribution: 'agent', content: 'Edit' }, ...editRows('early', ['early.ts']), ...filler, ...yieldRows(), { role: 'custom', customType: 'async-result', display: true, content: 'Original background task finished' }, ...editRows('late', ['late.ts']), call('yield-late', 'yield', {}), result('yield-late', 'yield', { status: 'success' })]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.deepEqual(evidence.operations.map(operation => operation.path).sort(), ['/workspace/early.ts', '/workspace/late.ts']);
  const child = (await resources.listHistorySubagents({ path: parent })).subagents[0]!;
  const selectedChild = await collector.collect({ context: { kind: 'saved', parentPath: parent, subagentId: child.id }, anchorId: 'child-session:e0' });
  assert.deepEqual(selectedChild.operations.map(operation => operation.path).sort(), ['/workspace/early.ts', '/workspace/late.ts']);
}));

test('typed result evidence survives a missing call without inventing its arguments', async () => fixture(async (collector, parent) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Edit' }, result('missing-call', 'edit', { perFileResults: [{ path: 'recorded.ts', diff: '@@ -1 +1 @@\n-old\n+new' }] })]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/recorded.ts']);
  assert.equal(evidence.complete, false);
  assert.match(evidence.reasons.join(' '), /no available call/);
}));

test('capture boundary uses actual hidden native predecessor and persisted user aliases', async () => fixture(async (collector, parent) => {
  await writeFile(parent, jsonl(header('parent'),
    { type: 'message', id: 'previous-user', parentId: null, timestamp, message: { role: 'user', content: 'Previous request' } },
    { type: 'custom', id: 'hidden-boundary', parentId: 'previous-user', customType: 'session-state', timestamp, data: {} },
    { type: 'message', id: 'selected-user', parentId: 'hidden-boundary', timestamp, message: { role: 'user', id: 'native-user', messageId: 'transport-user', content: 'Selected request' } }));
  const selected = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'selected-user' });
  assert.equal(selected.startEntryId, 'selected-user');
  assert.deepEqual(selected.startMessageIds, ['native-user', 'transport-user']);
  assert.equal(selected.beforeEntryId, 'hidden-boundary');
  assert.equal(selected.exactInterval, true);
  const previous = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'previous-user' });
  assert.equal(previous.beforeEntryId, null);
  assert.equal(previous.startMessageId, undefined);
}));

test('selected edits and empty turns ignore more than 32 MiB of unrelated earlier and later payloads', async () => fixture(async (collector, parent) => {
  const prose = 'x'.repeat(2 * 1024 * 1024);
  const unrelated: NativeMessage[] = Array.from({ length: 17 }, () => ({ role: 'assistant', content: prose }));
  await writeFile(parent, journal('parent', [
    { role: 'user', content: prose }, ...unrelated,
    { role: 'user', content: 'Selected edit' }, ...editRows('selected', ['selected.ts']),
    { role: 'user', content: 'No changes' }, { role: 'assistant', content: 'Explained only' },
    { role: 'user', content: 'Later unrelated work' }, ...unrelated,
  ]));
  const selected = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e19' });
  assert.deepEqual(selected.operations.map(operation => operation.path), ['/workspace/selected.ts']);
  assert.equal(selected.complete, true, selected.reasons.join(' '));
  assert.equal(selected.beforeEntryId, 'e17');
  const empty = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e22' });
  assert.deepEqual(empty.operations, []);
  assert.equal(empty.complete, true, empty.reasons.join(' '));
  const wrongLeaf = await collector.collect({ context: { kind: 'saved', parentPath: parent, leafId: 'e17' }, anchorId: 'e19', toolCallIds: ['selected'] });
  assert.deepEqual(wrongLeaf.operations, []);
  assert.equal(wrongLeaf.complete, false);
}));

test('an old deferred user does not invalidate a later verified write boundary', async () => fixture(async (collector, parent) => {
  await writeFile(parent, journal('parent', [
    { role: 'user', content: 'x'.repeat(9 * 1024 * 1024) },
    { role: 'user', content: 'Write' }, call('write', 'write', { path: 'native.ts', content: 'replacement' }), result('write', 'write'),
  ]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e2' });
  assert.equal(evidence.complete, true, evidence.reasons.join(' '));
  assert.equal(evidence.beforeEntryId, 'e0');
  const files = resolveFinalChanges(evidence.operations, [], evidence.cwd);
  assert.deepEqual(files.map(file => file.path), ['native.ts']);
  assert.equal(files[0]!.countsKnown, false);
}));

test('relevant oversized content keeps earlier verified operations and native write identity', async () => fixture(async (collector, parent) => {
  await writeFile(parent, journal('parent', [
    { role: 'user', content: 'Edit then write' }, ...editRows('small', ['small.ts']),
    call('large-write', 'write', { path: 'large.ts', content: 'x'.repeat(9 * 1024 * 1024) }), result('large-write', 'write'),
  ]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/small.ts', '/workspace/large.ts']);
  assert.equal(evidence.complete, true, evidence.reasons.join(' '));
  const files = resolveFinalChanges(evidence.operations, [], evidence.cwd);
  assert.equal(files.find(file => file.path === 'large.ts')!.countsKnown, false);
}));

test('display-only compaction archive omissions do not poison subsequent no-change evidence', async () => fixture(async (collector, parent) => {
  await writeFile(parent, jsonl(header('parent'),
    { type: 'compaction', id: 'compact', parentId: null, timestamp, summary: 'Archived context', preserveData: { snapcompact: { truncatedChars: 2000000, frames: [] } } },
    { type: 'message', id: 'request', parentId: 'compact', timestamp, message: { role: 'user', content: 'Explain only' } },
    { type: 'message', id: 'answer', parentId: 'request', timestamp, message: { role: 'assistant', content: 'Explanation' } }));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'answer' });
  assert.deepEqual(evidence.operations, []);
  assert.equal(evidence.complete, true, evidence.reasons.join(' '));
  assert.equal(evidence.beforeEntryId, 'compact');
}));

test('tool identities from another authorized source never select a turn in this source', async () => fixture(async (collector, parent, artifacts) => {
  const other = join(artifacts, 'other.jsonl');
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Unrelated' }, { role: 'assistant', content: 'No changes' }]));
  await writeFile(other, journal('other', [{ role: 'user', content: 'Edit elsewhere' }, ...editRows('elsewhere', ['outside.ts'])]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'other:e1', toolCallIds: ['elsewhere'] });
  assert.deepEqual(evidence.operations, []);
  assert.equal(evidence.complete, false);
}));

test('a revision change during relevant hydration rejects all collected operations', async () => fixture(async (collector, parent, _artifacts, _resources, reader) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Edit' }, ...editRows('edit', ['selected.ts'])]));
  const hydrate = reader.readEvidenceEntry.bind(reader);
  let changed = false;
  reader.readEvidenceEntry = async options => {
    const detail = await hydrate(options);
    if (!changed && options.entryId === 'e2') { changed = true; await appendFile(parent, '\n'); }
    return detail;
  };
  await assert.rejects(collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' }), /changed|stale/);
}));

test('legacy indexed identities retain native write evidence without invented entry ancestry', async () => fixture(async (collector, parent, _artifacts, _resources, reader) => {
  await writeFile(parent, jsonl({ ...header('legacy'), version: 1 }, ...[
    { role: 'user', content: 'Write' }, call('write', 'write', { path: 'legacy.ts', content: 'new' }), result('write', 'write'),
  ].map(message => ({ type: 'message', timestamp, message }))));
  const page = await reader.readEvidence({ path: parent });
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: page.messages[1]!.id });
  assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/legacy.ts']);
  assert.equal(evidence.complete, true, evidence.reasons.join(' '));
  assert.equal(evidence.startEntryId, undefined);
  assert.equal(evidence.beforeEntryId, undefined);
}));

test('oversized unrelated source records do not poison a subsequent independently verified turn', async () => fixture(async (collector, parent) => {
  await writeFile(parent, journal('parent', [
    { role: 'user', content: 'x'.repeat(17 * 1024 * 1024) },
    { role: 'user', content: 'Selected' }, ...editRows('selected', ['selected.ts']),
  ]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e2' });
  assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/selected.ts']);
  assert.equal(evidence.complete, true, evidence.reasons.join(' '));
  assert.equal(evidence.beforeEntryId, 'e0');
}));

test('history beyond the former metadata page and message ceilings remains readable in segments', async () => fixture(async (collector, parent) => {
  const unrelated: NativeMessage[] = Array.from({ length: 102500 }, () => ({ role: 'assistant', content: [] }));
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Earlier request' }, ...unrelated, { role: 'user', content: 'Selected edit' }, ...editRows('selected', ['selected.ts'])]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'parent:e102502' });
  assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/selected.ts']);
  assert.equal(evidence.complete, true, evidence.reasons.join(' '));
}));

test('one selected turn streams beyond the former aggregate payload allowance without losing recorded patches', async () => fixture(async (collector, parent) => {
  const messages: NativeMessage[] = [{ role: 'user', content: 'Several edits' }];
  for (let index = 0; index < 18; index++) {
    const edits = editRows(`edit-${index}`, [`file-${index}.ts`]);
    (edits[1]!.details as Record<string, unknown>).padding = 'x'.repeat(2 * 1024 * 1024);
    messages.push(...edits);
  }
  await writeFile(parent, journal('parent', messages));
  let started = false;
  const recorded: string[] = [];
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0', onStart: metadata => {
    assert.equal(metadata.startEntryId, 'e0');
    assert.deepEqual(metadata.toolCallIds, Array.from({ length: 18 }, (_, index) => `edit-${index}`));
    started = true;
  }, onOperation: operation => {
    assert.equal(started, true);
    assert.equal(operation.patch, '@@ -1 +1 @@\n-old\n+new');
    recorded.push(operation.path);
  } });
  assert.deepEqual(recorded, Array.from({ length: 18 }, (_, index) => `/workspace/file-${index}.ts`));
  assert.deepEqual(evidence.operations, []);
  assert.equal(evidence.complete, true, evidence.reasons.join(' '));
}));

test('authorized child origins are attached before streamed operations leave the collector', async () => fixture(async (collector, parent, artifacts) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Delegate' }, call('task', 'task', {}), result('task', 'task', { results: [{ id: 'child', index: 0, exitCode: 0 }] })]));
  await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [{ role: 'user', attribution: 'agent', content: 'Edit' }, ...editRows('child-edit', ['child.ts']), ...yieldRows()]));
  const paths: string[] = [];
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0', onOperation: operation => {
    assert.equal(operation.origin.parentToolCallId, 'task');
    assert.equal(operation.origin.sessionId, 'child-session');
    paths.push(operation.path);
  } });
  assert.deepEqual(paths, ['/workspace/child.ts']);
  assert.deepEqual(evidence.operations, []);
}));

test('oversized recorded task results still authorize original child changes', async () => fixture(async (collector, parent, artifacts) => {
  await writeFile(parent, journal('parent', [{ role: 'user', content: 'Delegate' }, call('task', 'task', {}), result('task', 'task', { padding: 'x'.repeat(17 * 1024 * 1024), results: [{ id: 'child', index: 0, exitCode: 0 }] })]));
  await writeFile(join(artifacts, 'child.jsonl'), journal('child-session', [{ role: 'user', attribution: 'agent', content: 'Edit' }, ...editRows('child-edit', ['child.ts']), ...yieldRows()]));
  const evidence = await collector.collect({ context: { kind: 'saved', parentPath: parent }, anchorId: 'e0' });
  assert.deepEqual(evidence.operations.map(operation => operation.path), ['/workspace/child.ts']);
  assert.equal(evidence.complete, true, evidence.reasons.join(' '));
}));

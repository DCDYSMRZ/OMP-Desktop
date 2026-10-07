import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordMetadata, SOURCE_CHUNK } from './history-source';
import { record } from './io';

function project(source: string, evidence = false, edit = false, chunk = SOURCE_CHUNK) {
  const bytes = Buffer.from(source), projection = new RecordMetadata(evidence, edit);
  for (let offset = 0; offset < bytes.length; offset += chunk) projection.feed(bytes.subarray(offset, offset + chunk));
  assert.equal(projection.complete, true);
  return projection.values;
}

test('incremental metadata locates native boundaries and exact tool identities past huge unrelated strings', () => {
  const padding = 'p'.repeat(17 * 1024 * 1024);
  const call = { type: 'toolCall', id: 'call-中文-😀', name: 'edit', arguments: { path: 'a\\b/中文.ts', content: padding } };
  const row = project(JSON.stringify({ padding, type: 'message', id: 'entry', parentId: 'user', message: { padding, content: [call], role: 'assistant', after: padding }, after: padding }));
  assert.deepEqual(row.message, { content: [{ type: 'toolCall', id: call.id, name: 'edit', arguments: { path: call.arguments.path } }], role: 'assistant' });
  const boundary = project(JSON.stringify({ type: 'message', message: { content: padding, role: 'user', synthetic: true, userInitiated: true, display: true }, id: 'user', parentId: null }));
  assert.deepEqual(boundary.message, { content: ' ', role: 'user', synthetic: true, userInitiated: true, display: true });
});

test('mutation strings and lexical edit header preserve escapes across every byte boundary', () => {
  const diff = '@@ -1 +1 @@\n-旧\\line\t\"\n+😀new\r\n';
  const details = { perFileResults: [{ path: '中文.ts', oldText: '旧\n', newText: '😀new\n', diff, op: 'update', applied: true, details: { diff } }] };
  const row = project(JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: '工具😀', toolName: 'edit', content: [{ type: 'text', text: diff }], details } }), true, true, 1);
  assert.ok(record(row.message));
  assert.deepEqual(row.message.details, details);
  assert.deepEqual(row.message.content, [{ type: 'text', text: diff }]);
  const call = project('{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"x","name":"edit","arguments":{"input":"[中文.ts#ABCD]\\u000aPUT 1:=2:\\n+requested"}}]}}', true, false, 1);
  assert.ok(record(call.message));
  assert.deepEqual(call.message.content, [{ type: 'toolCall', id: 'x', name: 'edit', arguments: { input: '[中文.ts#ABCD]' } }]);
});

test('strict projection rejects corrupt or truncated JSON even inside discarded payloads', () => {
  for (const source of ['{"padding":"unfinished', '{"padding":"bad\\q"}', '{"padding":01}', '{"padding":true,}', '{"padding":[1,]}', '{"padding":{"x" 1}}', '{}{}', '{"padding":"bad\u0001"}', '{"padding":tru}', '{"message":{"role":"user"}']) {
    const projection = new RecordMetadata();
    for (const byte of Buffer.from(source)) projection.feed(Buffer.from([byte]));
    assert.equal(projection.complete, false, source);
  }
  const projection = new RecordMetadata();
  projection.feed(Buffer.from([123, 34, 120, 34, 58, 34, 0xf0, 0x9f]));
  assert.equal(projection.complete, false);
});

test('yield completion fields survive projection without retaining submitted prose', () => {
  const row = project(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'yield', name: 'yield', arguments: { type: ['section'], complete: true, data: { prose: 'irrelevant' } } }] } }), true);
  assert.ok(record(row.message));
  assert.deepEqual(row.message.content, [{ type: 'toolCall', id: 'yield', name: 'yield', arguments: { type: ['section'], complete: true } }]);
  const result = project(JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'yield', toolName: 'yield', details: { status: 'success', complete: true }, content: 'irrelevant' } }), true);
  assert.ok(record(result.message));
  assert.deepEqual(result.message.details, { status: 'success', complete: true });
});

test('task ownership retains exact native identities without result prose', () => {
  const ownership = { id: 'native-child', index: 0, outputPath: '/sessions/native/task/child.jsonl', agent: 'worker', assignment: 'task', exitCode: 0, status: 'completed' };
  const row = project(JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'task', toolCallId: 'parent-task', details: { results: [{ ...ownership, output: 'unrelated prose' }], progress: [ownership] } } }), true);
  assert.ok(record(row.message));
  assert.deepEqual(row.message.details, { results: [ownership], progress: [ownership] });
  const declaration = project(JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'parent-task', name: 'task', arguments: { tasks: [{ id: 'native-child', name: 'child', agent: 'worker', task: 'assignment' }] } }] } }), true);
  assert.ok(record(declaration.message));
  assert.deepEqual(declaration.message.content, [{ type: 'toolCall', id: 'parent-task', name: 'task', arguments: { tasks: [{ id: 'native-child', name: 'child', agent: 'worker', task: 'assignment' }] } }]);
});

test('complete EOF projection accepts a subsequently committed newline', () => {
  const projection = new RecordMetadata();
  projection.feed(Buffer.from('{"type":"message","message":{"role":"user"}}'));
  assert.equal(projection.complete, true);
  projection.feed(Buffer.alloc(0));
  projection.feed(Buffer.from('\r'));
  assert.equal(projection.complete, true);
  assert.deepEqual(projection.values.message, { role: 'user' });
});

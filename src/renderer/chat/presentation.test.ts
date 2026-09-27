import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeMessage } from '../../shared/contracts';
import type { ChatMessage } from './model';
import { assistantTurnKey, buildTranscriptEntries, nativeUsageSummary, projectTurnProcess, readableNativeData } from './presentation';

const row = (id: string, raw: NativeMessage): ChatMessage => ({ id, raw, source: 'history', streaming: false });

test('provider fragments form one ordered process with only trailing response outside it', () => {
  const messages = [
    row('user', { role: 'user', content: 'Investigate' }),
    row('a', { role: 'assistant', content: [
      { type: 'thinking', thinking: 'First', thinkingSignature: 'opaque' },
      { type: 'thinking', thinking: 'Second' },
      { type: 'text', text: 'I will inspect the file.' },
      { type: 'thinking', thinking: 'After narration' },
      { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'x' } },
    ] }),
    row('result', { role: 'toolResult', toolCallId: 'call', toolName: 'read', isError: true, content: 'Denied' }),
    row('b', { role: 'assistant', content: [{ type: 'text', text: '# Result' }, { type: 'text', text: '- Could not read' }] }),
  ];
  const original = structuredClone(messages);
  const tool = { id: 'call', name: 'read', status: 'error' as const, result: messages[2].raw };
  const { entries, renderedTools } = buildTranscriptEntries(messages, { call: tool });
  assert.deepEqual(entries.map(entry => entry.kind), ['message', 'assistant-turn']);
  const turn = entries[1];
  assert.equal(turn.kind, 'assistant-turn');
  if (turn.kind !== 'assistant-turn') return;
  const { process, responses } = projectTurnProcess(turn);
  const parts = process.flatMap(part => part.kind === 'process' ? part.parts : []);
  assert.deepEqual(parts.map(part => part.kind), ['thinking', 'text', 'thinking', 'tool']);
  assert.deepEqual(parts.flatMap(part => part.kind === 'thinking' ? [part.value] : []), ['First\n\nSecond', 'After narration']);
  assert.deepEqual(responses.map(part => part.kind === 'text' ? part.value : part.kind), ['# Result', '- Could not read']);
  assert.equal(parts.find(part => part.kind === 'tool')?.tool, tool);
  assert.deepEqual([...renderedTools], ['call']);
  assert.deepEqual(messages, original);
});

test('hidden reminders do not split an active assistant process from its final response', () => {
  const progress = row('progress', { role: 'assistant', content: [{ type: 'text', text: 'Inspecting the file' }, { type: 'toolCall', id: 'read-call', name: 'read' }] });
  const result = row('result', { role: 'toolResult', toolCallId: 'read-call', toolName: 'read', content: 'File contents' });
  const final = { ...row('final', { role: 'assistant', content: 'Final answer' }), streaming: true };
  const { entries } = buildTranscriptEntries([
    progress, result,
    row('reminder', { role: 'custom', customType: 'todo-error-reminder', display: false, content: 'Internal reminder' }),
    row('nudge', { role: 'hookMessage', display: false, content: 'Internal nudge' }),
    final,
  ], {});
  assert.deepEqual(entries.map(entry => entry.id), ['progress']);
  const turn = entries[0];
  if (turn.kind !== 'assistant-turn') assert.fail('Expected the ongoing assistant turn');
  assert.deepEqual(turn.rows, [progress, result, final]);
  const { process, responses } = projectTurnProcess(turn);
  assert.deepEqual(process.flatMap(chunk => chunk.kind === 'process' ? chunk.parts.map(part => part.kind === 'text' ? part.value : part.kind) : []), ['Inspecting the file', 'tool']);
  assert.deepEqual(responses.map(part => part.kind === 'text' ? part.value : part.kind), ['Final answer']);
  assert.equal(responses[0].row.streaming, true);
  assert.equal(turn.rows.at(-1), final);
});

test('results after prose are activity, while special roles and image boundaries retain order', () => {
  const { entries } = buildTranscriptEntries([
    row('a', { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'bash' }, { type: 'text', text: 'Waiting' }] }),
    row('r', { role: 'toolResult', toolCallId: 't', content: 'done' }),
    row('c', { role: 'compactionSummary', summary: 'checkpoint' }),
    row('b', { role: 'assistant', content: [{ type: 'thinking', thinking: 'Before' }, { type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'thinking', thinking: 'After' }, { type: 'thinking', thinking: '', thinkingSignature: 'private' }] }),
    row('custom', { role: 'custom', content: 'Extension notice' }),
    row('unknown', { role: 'futureNativeRole', content: 'Retain me' }),
    row('orphan', { role: 'toolResult', content: 'Unkeyed result' }),
  ], {});
  assert.deepEqual(entries.map(entry => entry.id), ['a', 'c', 'b', 'custom', 'unknown', 'orphan']);
  assert.equal(entries[0].kind, 'assistant-turn');
  if (entries[0].kind === 'assistant-turn') {
    assert.deepEqual(projectTurnProcess(entries[0]).responses, []);
    const call = entries[0].parts.find(part => part.kind === 'tool');
    assert.equal(call?.tool.status, 'complete');
    assert.deepEqual(call?.tool.result, { role: 'toolResult', toolCallId: 't', content: 'done' });
  }
  if (entries[2].kind === 'assistant-turn') assert.deepEqual(entries[2].parts.map(part => part.kind), ['thinking', 'content', 'thinking']);
  if (entries[5].kind === 'assistant-turn') assert.deepEqual(entries[5].parts[0].kind, 'content');
});

test('assistant errors remain visible even when tools follow them', () => {
  const { entries } = buildTranscriptEntries([row('a', { role: 'assistant', errorMessage: 'Provider failed', content: [{ type: 'thinking', thinking: 'Trying' }] }), row('r', { role: 'toolResult', toolCallId: 't', content: 'Late result' })], {});
  if (entries[0].kind !== 'assistant-turn') assert.fail('Expected one assistant turn');
  assert.deepEqual(projectTurnProcess(entries[0]).responses.map(part => part.kind === 'error' ? part.value : part.kind), ['Provider failed']);
});

test('an assistant fragment before the final native message remains narration', () => {
  const { entries } = buildTranscriptEntries([row('a', { role: 'assistant', content: 'Intermediate narration' }), row('b', { role: 'assistant', content: 'Final response' })], {});
  if (entries[0].kind !== 'assistant-turn') assert.fail('Expected one assistant turn');
  const { process, responses } = projectTurnProcess(entries[0]);
  assert.deepEqual(process.flatMap(chunk => chunk.kind === 'process' ? chunk.parts.map(part => part.kind === 'text' ? part.value : part.kind) : []), ['Intermediate narration']);
  assert.deepEqual(responses.map(part => part.kind === 'text' ? part.value : part.kind), ['Final response']);
});

test('usage uses native request totals without adding cache or reasoning again', () => {
  const raw = { role: 'assistant', usage: { input: 1000, output: 100, reasoning: 60, cacheRead: 5000, cacheWrite: 500, totalTokens: 6600, cost: { total: 0.1 + 0.2 } } };
  const summary = nativeUsageSummary(raw);
  assert.equal(summary.total, '6.6K');
  assert.equal(summary.cost, '$0.30');
  assert.equal(summary.detail, raw.usage);
  assert.equal(nativeUsageSummary({ role: 'assistant', usage: { input: 100, output: 20, reasoning: 5 } }).total, undefined);
  assert.equal(nativeUsageSummary({ role: 'assistant', usage: { cost: { total: 0.0000001 } } }).cost, '<$0.000001');
});

test('native fallbacks preserve readable unknown data without leaking signatures', () => {
  const raw = { type: 'future', text: 'Readable', nested: [{ signature: 'opaque', text: 'Also readable' }] };
  assert.deepEqual(readableNativeData(raw), { type: 'future', text: 'Readable', nested: [{ text: 'Also readable' }] });
  assert.equal(raw.nested[0].signature, 'opaque');
});

test('deferred saved content keeps its speaker, source action and original transcript position', () => {
  const assistant = { ...row('large-answer', { role: 'assistant', historyResourceDeferred: true, content: '' }), resourceReference: 'desktop-entry:answer' };
  const result = { ...row('large-result', { role: 'toolResult', toolName: 'read', toolCallId: 'read-call', historyResourceDeferred: true, content: '' }), resourceReference: 'desktop-entry:result' };
  const messages = [row('before', { role: 'assistant', content: 'Before' }), assistant, result, row('after', { role: 'assistant', content: 'After' })];
  const original = structuredClone(messages);
  const { entries } = buildTranscriptEntries(messages, {});
  assert.deepEqual(entries.map(entry => [entry.kind, entry.id]), [['assistant-turn', 'before'], ['message', 'large-answer'], ['message', 'large-result'], ['assistant-turn', 'after']]);
  assert.deepEqual(entries.flatMap(entry => entry.kind === 'message' ? [[entry.row.raw.role, entry.row.raw.toolName, entry.row.resourceReference]] : []), [['assistant', undefined, 'desktop-entry:answer'], ['toolResult', 'read', 'desktop-entry:result']]);
  assert.deepEqual(messages, original);
});

test('task calls split ordered process chunks without consuming the final response', () => {
  const messages = [row('a', { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Plan' },
    { type: 'toolCall', id: 'one', name: 'task', arguments: { task: 'Inspect' } },
    { type: 'text', text: 'Between calls' },
    { type: 'toolCall', id: 'read', name: 'read' },
    { type: 'toolCall', id: 'two', name: 'task' },
    { type: 'text', text: 'Answer' },
  ] })];
  const original = structuredClone(messages);
  const { entries, renderedTools } = buildTranscriptEntries(messages, {});
  if (entries[0].kind !== 'assistant-turn') assert.fail('Expected one turn');
  const { process, responses } = projectTurnProcess(entries[0]);
  assert.deepEqual(process.map(chunk => chunk.kind === 'stage' ? chunk.tool.id : chunk.parts.map(part => part.kind)), [['thinking'], 'one', ['text', 'tool'], 'two']);
  assert.deepEqual(responses.map(part => part.kind === 'text' ? part.value : part.kind), ['Answer']);
  assert.deepEqual([...renderedTools], ['one', 'read', 'two']);
  assert.deepEqual(messages, original);
});

test('task identities survive live row replacement and changing process chunks', () => {
  const call = { type: 'toolCall', id: 'stable-spawn', name: 'task', arguments: { task: 'Inspect' } };
  const live = buildTranscriptEntries([{ ...row('live:runtime:message-1', { role: 'assistant', content: [call] }), source: 'live', streaming: true }], {}).entries[0];
  const saved = buildTranscriptEntries([row('journal-entry-42', { role: 'assistant', content: [{ type: 'thinking', thinking: 'Saved planning' }, call] }), row('journal-result', { role: 'toolResult', toolCallId: 'stable-spawn', toolName: 'task', content: 'Complete' }), row('journal-answer', { role: 'assistant', content: 'Done' })], {}).entries[0];
  if (live.kind !== 'assistant-turn' || saved.kind !== 'assistant-turn') assert.fail('Expected task turns');
  assert.notEqual(live.id, saved.id);
  assert.equal(assistantTurnKey(live), 'stable-spawn');
  assert.equal(assistantTurnKey(saved), assistantTurnKey(live));
  const liveStage = projectTurnProcess(live).process.find(part => part.kind === 'stage');
  const savedStage = projectTurnProcess(saved).process.find(part => part.kind === 'stage');
  assert.equal(liveStage?.key, 'stable-spawn');
  assert.equal(savedStage?.key, liveStage?.key);
  assert.equal(saved.parts.find(part => part.kind === 'tool')?.key, 'stable-spawn');
});

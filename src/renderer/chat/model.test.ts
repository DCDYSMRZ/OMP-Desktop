import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatState, reduceChatFrame, record } from './model';
import type { SessionConnection } from '../../shared/contracts';

function fresh() {
  const connection: SessionConnection = { runtimeId: 'worker-A', cwd: '/workspace', state: { sessionId: 'session-A', isStreaming: false, isSettled: true }, messages: [], models: [], commands: [], thinkingLevels: [] };
  return createChatState(connection);
}
test('snapshot plus delta replaces text instead of doubling it, with process-scoped live identities', () => {
  let chat = fresh();
  chat = reduceChatFrame(chat, { type: 'message_start', messageId: 'msg-1', message: { role: 'assistant', content: [] } });
  chat = reduceChatFrame(chat, { type: 'message_update', messageId: 'msg-1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'reason' }] }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } });
  assert.deepEqual(chat.messages.map(row => row.raw.content), [[{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'reason' }]]);
  const live = chat.messages[0].id;
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [{ role: 'assistant', content: 'hello' }] });
  assert.notEqual(chat.messages[0].id, live);
  assert.equal(chat.messages[0].source, 'history');
});
test('a yielded agent and a prompt acceptance are not a settled session', () => {
  let chat = reduceChatFrame(fresh(), { type: 'agent_start' });
  chat = reduceChatFrame(chat, { type: 'response', command: 'prompt', success: true });
  chat = reduceChatFrame(chat, { type: 'agent_end', isTerminal: true, yielded: true });
  chat = reduceChatFrame(chat, { type: 'prompt_result', status: 'completed', sessionSettled: false });
  assert.equal(chat.isSettled, false);
  assert.equal(chat.isRunning, true);
  chat = reduceChatFrame(chat, { type: 'session_settled' });
  assert.equal(chat.isSettled, true);
  assert.equal(chat.isRunning, false);
});
test('execution end and toolResult share one authoritative result', () => {
  let chat = reduceChatFrame(fresh(), { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'false' } });
  chat = reduceChatFrame(chat, { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'exit 1' }] } });
  chat = reduceChatFrame(chat, { type: 'message_end', messageId: 'msg-2', message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'exit 1' }] } });
  assert.deepEqual(Object.keys(chat.tools), ['t1']);
  assert.equal(chat.tools.t1.status, 'error');
  assert.deepEqual(record(chat.tools.t1.result).content, [{ type: 'text', text: 'exit 1' }]);
});
test('extension cancellation removes only target request and progress uses nested native id', () => {
  let chat = reduceChatFrame(fresh(), { type: 'extension_ui_request', id: 'a', method: 'confirm', title: 'A' });
  chat = reduceChatFrame(chat, { type: 'extension_ui_request', id: 'b', method: 'input', title: 'B' });
  chat = reduceChatFrame(chat, { type: 'extension_ui_request', id: 'cancel', method: 'cancel', targetId: 'a' });
  assert.deepEqual(chat.prompts.map(item => item.id), ['b']);
  chat = reduceChatFrame(chat, { type: 'subagent_lifecycle', payload: { id: 'child', agent: 'worker', status: 'started' } });
  chat = reduceChatFrame(chat, { type: 'subagent_progress', payload: { agent: 'worker', progress: { id: 'child', toolCount: 4 } } });
  assert.deepEqual(chat.subagents.map(agent => [agent.id, agent.progress?.toolCount]), [['child', 4]]);
});
test('native command output survives context snapshots and failures never become success', () => {
  let chat = reduceChatFrame(fresh(), { type: 'command_output', text: 'native command output' });
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [] });
  assert.deepEqual(chat.messages.map(row => row.raw.content), ['native command output']);
  chat = reduceChatFrame(chat, { type: 'agent_start' });
  chat = reduceChatFrame(chat, { type: 'prompt_result', status: 'error', sessionSettled: true, error: { message: 'Provider rejected request' } });
  assert.equal(chat.error, 'Provider rejected request');
  assert.equal(chat.outcome, 'error');
  assert.equal(chat.isRunning, false);
});
test('malformed blocking UI frames fail visibly without entering the answer queue', () => {
  const missingIdentity = reduceChatFrame(fresh(), { type: 'extension_ui_request', method: 'confirm' });
  assert.deepEqual(missingIdentity.prompts, []);
  assert.match(missingIdentity.error ?? '', /id and method/);
  const malformedOptions = reduceChatFrame(fresh(), { type: 'extension_ui_request', id: 'bad', method: 'select', options: [42] });
  assert.deepEqual(malformedOptions.prompts, []);
  assert.match(malformedOptions.error ?? '', /invalid options/);
  const valid = reduceChatFrame(fresh(), { type: 'extension_ui_request', id: 'good', method: 'select', title: 'Choose', options: ['Yes'], optionDetails: [{ description: 'Continue' }], timeout: 1000, nativeMetadata: { origin: 'tool' } });
  assert.equal(valid.prompts[0].id, 'good');
  assert.deepEqual(valid.prompts[0].options, ['Yes']);
  assert.deepEqual(valid.prompts[0].nativeMetadata, { origin: 'tool' });
  assert.equal(typeof valid.prompts[0].receivedAt, 'number');
});

test('durable journal identities survive prepends and remain separate from live protocol identities', () => {
  const answer = { role: 'assistant', content: [{ type: 'text', text: 'Durable answer' }, { type: 'thinking', thinking: 'Readable', thinkingSignature: 'opaque' }] };
  const connection: SessionConnection = { runtimeId: 'worker-A', cwd: '/workspace', state: { sessionId: 'session-A', isStreaming: false, isSettled: true }, messages: [answer], messageIds: ['msg-1'], models: [], commands: [], thinkingLevels: [] };
  let chat = createChatState(connection);
  assert.equal(chat.messages[0].id, 'msg-1');
  assert.equal(chat.messages[0].raw, answer);
  chat = reduceChatFrame(chat, { type: 'message_end', messageId: 'msg-1', message: { role: 'assistant', content: 'Live continuation' } });
  assert.deepEqual(chat.messages.map(row => row.id), ['msg-1', 'live:worker-A:msg-1']);
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [{ role: 'user', content: 'Earlier prompt' }, answer], messageIds: ['entry-earlier', 'msg-1'] });
  assert.deepEqual(chat.messages.map(row => row.id), ['entry-earlier', 'msg-1']);
  assert.equal(chat.messages[1].raw, answer);
  assert.equal(record((chat.messages[1].raw.content as unknown[])[1]).thinkingSignature, 'opaque');
});

test('late child progress and stale snapshots preserve terminal truth until an explicit restart', () => {
  let chat = reduceChatFrame(fresh(), { type: 'subagent_lifecycle', payload: { id: 'child', parentToolCallId: 'task-a', status: 'started' } });
  chat = reduceChatFrame(chat, { type: 'subagent_progress', payload: { parentToolCallId: 'task-a', task: 'Review changes', progress: { id: 'child', status: 'running', durationMs: 100 } } });
  chat = reduceChatFrame(chat, { type: 'subagent_lifecycle', payload: { id: 'child', parentToolCallId: 'task-a', status: 'failed' } });
  chat = reduceChatFrame(chat, { type: 'subagent_progress', payload: { parentToolCallId: 'task-a', progress: { id: 'child', status: 'running', durationMs: 120 } } });
  chat = reduceChatFrame(chat, { type: 'subagents_snapshot', subagents: [{ id: 'child', parentToolCallId: 'task-a', status: 'running' }] });
  assert.equal(chat.subagents[0].status, 'failed');
  assert.equal(chat.subagents[0].task, 'Review changes');
  chat = reduceChatFrame(chat, { type: 'subagent_lifecycle', payload: { id: 'child', parentToolCallId: 'task-b', status: 'started' } });
  chat = reduceChatFrame(chat, { type: 'subagent_progress', payload: { parentToolCallId: 'task-a', progress: { id: 'child', status: 'completed' } } });
  assert.equal(chat.subagents[0].status, 'started');
  assert.equal(chat.subagents[0].parentToolCallId, 'task-b');
  assert.equal(chat.subagents[0].progress, undefined);
});

test('owned saved children coexist with live children without stale saved settlement overriding a restart', () => {
  const saved = { id: 'saved-task', nativeId: 'child', parentToolCallId: 'call', historical: true, status: 'failed', task: 'Retained assignment', progress: { error: 'Old failure', durationMs: 900 } };
  let chat = reduceChatFrame(fresh(), { type: 'saved_subagents_snapshot', subagents: [saved], historySource: { path: '/parent.jsonl', leafId: 'selected' } });
  assert.equal(chat.subagents[0].historical, true);
  chat = reduceChatFrame(chat, { type: 'subagents_snapshot', subagents: [{ id: 'child', parentToolCallId: 'call', status: 'running', progress: { durationMs: 10 } }, { id: 'new-child', parentToolCallId: 'new-call', status: 'running' }] });
  assert.deepEqual(chat.subagents.map(child => [child.id, child.nativeId, child.status]), [['saved-task', 'child', 'running'], ['new-child', undefined, 'running']]);
  assert.equal(chat.subagents[0].savedId, 'saved-task');
  assert.equal(chat.subagents[0].historical, false);
  assert.equal(chat.subagents[0].task, 'Retained assignment');
  assert.equal(chat.subagents[0].progress?.error, undefined);
  chat = reduceChatFrame(chat, { type: 'subagent_lifecycle', payload: { id: 'child', parentToolCallId: 'call', status: 'completed' } });
  chat = reduceChatFrame(chat, { type: 'subagent_lifecycle', payload: { id: 'child', parentToolCallId: 'call', status: 'started' } });
  chat = reduceChatFrame(chat, { type: 'saved_subagents_snapshot', subagents: [{ ...saved, status: 'completed' }], historySource: { path: '/parent.jsonl', leafId: 'later' } });
  assert.equal(chat.subagents[0].status, 'started');
  assert.equal(chat.subagents[0].progress, undefined);
  assert.deepEqual(chat.historySource, { path: '/parent.jsonl', leafId: 'later' });
});

test('saved child correlation does not combine unrelated task owners or ambiguous reused IDs', () => {
  const first = { id: 'saved-a', nativeId: 'reused', parentToolCallId: 'a', historical: true, status: 'completed' };
  const second = { id: 'saved-b', nativeId: 'reused', parentToolCallId: 'b', historical: true, status: 'failed' };
  let chat = reduceChatFrame(fresh(), { type: 'saved_subagents_snapshot', subagents: [first, second] });
  chat = reduceChatFrame(chat, { type: 'subagent_lifecycle', payload: { id: 'reused', status: 'started' } });
  assert.deepEqual(chat.subagents.map(child => child.id), ['saved-a', 'saved-b', 'reused']);
  chat = reduceChatFrame(chat, { type: 'subagent_progress', payload: { id: 'reused', parentToolCallId: 'b', progress: { status: 'running' } } });
  assert.deepEqual(chat.subagents.map(child => [child.id, child.status]), [['saved-a', 'completed'], ['saved-b', 'running']]);
  chat = reduceChatFrame(chat, { type: 'subagent_lifecycle', payload: { id: 'reused', parentToolCallId: 'c', status: 'started' } });
  assert.deepEqual(chat.subagents.map(child => [child.id, child.status]), [['saved-a', 'completed'], ['saved-b', 'failed'], ['reused', 'started']]);
  chat = reduceChatFrame(chat, { type: 'saved_subagents_snapshot', subagents: [first] });
  assert.deepEqual(chat.subagents.map(child => child.id), ['saved-a', 'reused']);
});

test('native task results enrich live terminal diagnostics without settling async siblings or other owners', () => {
  const result = { details: { results: [{ id: 'reviewer', status: 'cancelled', aborted: true, abortReason: 'Reviewer rejected the changed setting.' }, { id: 'failed-child', aborted: true, abortReason: 'Native terminal reason.' }], progress: [{ index: 1, status: 'failed', error: 'Inspection failed.' }, { id: 'detached', status: 'running' }, { id: 'other-owner', status: 'failed', error: 'Unrelated result.' }] } };
  for (const frame of [
    { type: 'tool_execution_end', toolCallId: 'batch', toolName: 'task', result },
    { type: 'message_end', messageId: 'batch-result', message: { role: 'toolResult', toolCallId: 'batch', toolName: 'task', ...result } },
  ]) {
    let chat = reduceChatFrame(fresh(), { type: 'saved_subagents_snapshot', subagents: [{ id: 'saved-reviewer', nativeId: 'reviewer', parentToolCallId: 'batch', status: 'running' }] });
    chat = reduceChatFrame(chat, { type: 'subagents_snapshot', subagents: [{ id: 'reviewer', parentToolCallId: 'batch', status: 'cancelled', progress: { tokens: 20 } }, { id: 'inspector', parentToolCallId: 'batch', index: 1, status: 'running' }, { id: 'detached', parentToolCallId: 'batch', status: 'running' }, { id: 'other-owner', parentToolCallId: 'new-batch', status: 'running' }, { id: 'failed-child', parentToolCallId: 'batch', status: 'failed' }] });
    const before = structuredClone(chat);
    const settled = reduceChatFrame(chat, frame);
    assert.deepEqual(chat, before);
    assert.equal(settled.liveSubagents[0].status, 'cancelled');
    assert.equal(settled.liveSubagents[0].abortReason, 'Reviewer rejected the changed setting.');
    assert.equal(settled.subagents[0].id, 'saved-reviewer');
    assert.equal(settled.subagents[0].abortReason, 'Reviewer rejected the changed setting.');
    assert.equal(settled.subagents[0].progress?.tokens, 20);
    assert.equal(settled.liveSubagents[1].status, 'failed');
    assert.equal(settled.liveSubagents[1].error, 'Inspection failed.');
    assert.equal(settled.liveSubagents[2].status, 'running');
    assert.equal(settled.liveSubagents[3].status, 'running');
    assert.equal(settled.liveSubagents[3].error, undefined);
    assert.equal(settled.liveSubagents[4].status, 'failed');
    assert.equal(settled.liveSubagents[4].abortReason, 'Native terminal reason.');
    const late = reduceChatFrame(settled, { type: 'subagent_progress', payload: { id: 'reviewer', parentToolCallId: 'batch', progress: { status: 'running' } } });
    assert.equal(late.liveSubagents[0].status, 'cancelled');
    assert.equal(late.liveSubagents[0].abortReason, 'Reviewer rejected the changed setting.');
    const restarted = reduceChatFrame(late, { type: 'subagent_lifecycle', payload: { id: 'reviewer', parentToolCallId: 'new-batch', status: 'started' } });
    const delayed = reduceChatFrame(restarted, frame);
    assert.equal(delayed.liveSubagents[0].status, 'started');
    assert.equal(delayed.liveSubagents[0].abortReason, undefined);
  }
});

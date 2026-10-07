import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatState, reduceChatFrame, record, type ChatState } from './model';
import type { SessionConnection } from '../../shared/contracts';
import { subagentPhase } from '../workspace/subagent-model';

function fresh() {
  const connection: SessionConnection = { source: { status: 'unpersisted', sessionId: 'session-A' }, runtimeId: 'worker-A', cwd: '/workspace', state: { sessionId: 'session-A', isStreaming: false, isSettled: true }, messages: [], models: [], commands: [], thinkingLevels: [] };
  return createChatState(connection);
}
test('request duration spans streaming, retries and settlement for every outcome', () => {
 for (const status of ['success', 'error', 'aborted']) {
  let chat=reduceChatFrame(fresh(),{type:'agent_start',timestamp:1000});
  chat=reduceChatFrame(chat,{type:'turn_start',timestamp:5000});
  chat=reduceChatFrame(chat,{type:'prompt_result',status,sessionSettled:true,timestamp:12000});
  assert.deepEqual(chat.requestTiming,{startedAt:1000,endedAt:12000});
  chat=reduceChatFrame(chat,{type:'session_settled',timestamp:15000});
  assert.equal(chat.requestTiming?.endedAt,12000);
  chat=reduceChatFrame(chat,{type:'agent_start',timestamp:20000});
  assert.deepEqual(chat.requestTiming,{startedAt:20000});
 }
});
test('bulk history matches incremental tool reduction without mutating earlier live states', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'a.ts' } }, { type: 'toolCall', id: 'check', name: 'bash', arguments: { command: 'false' } }] },
    { role: 'toolResult', toolCallId: 'check', toolName: 'bash', isError: true, content: 'exit 1' },
    { role: 'toolResult', toolCallId: 'read', toolName: 'read', content: 'file' },
    { role: 'toolResult', toolCallId: 'orphan', toolName: 'grep', content: 'match' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'orphan', name: 'grep', arguments: { pattern: 'needle' } }, { type: 'toolCall', id: 'pending', name: 'write', arguments: { path: 'b.ts' } }] },
  ];
  let live = fresh();
  const previous: { state: ChatState; tools: string }[] = [];
  for (const [index, message] of messages.entries()) {
    previous.push({ state: live, tools: JSON.stringify(live.tools) });
    live = reduceChatFrame(live, { type: 'message_end', messageId: `m${index}`, message });
  }
  const bulk = createChatState({ source: { status: 'unpersisted', sessionId: 'session-A' }, runtimeId: 'worker-A', cwd: '/workspace', state: { sessionId: 'session-A', isStreaming: false, isSettled: true }, messages, models: [], commands: [], thinkingLevels: [] });
  assert.deepEqual(bulk.tools, live.tools);
  assert.deepEqual(Object.values(bulk.tools).map(tool => tool.status), ['complete', 'error', 'complete', 'pending']);
  for (const value of previous) assert.equal(JSON.stringify(value.state.tools), value.tools);
});
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
test('terminal native turns stop executing without settling retained queues or background work', () => {
  let chat = reduceChatFrame(fresh(), { type: 'agent_start' });
  chat = reduceChatFrame(chat, { type: 'state_snapshot', state: { isStreaming: true, isSettled: false, queuedMessageCount: 1, hasPendingAsyncWork: false, isCompacting: false } });
  chat = reduceChatFrame(chat, { type: 'agent_end', isTerminal: false });
  assert.equal(chat.isRunning, true);
  chat = reduceChatFrame(chat, { type: 'agent_end', isTerminal: true, yielded: true });
  chat = reduceChatFrame(chat, { type: 'prompt_result', status: 'aborted', sessionSettled: false });
  assert.equal(chat.isRunning, false);
  assert.equal(chat.state.isStreaming, false);
  assert.equal(chat.isSettled, false);
  assert.equal(chat.state.queuedMessageCount, 1);
  chat = reduceChatFrame(chat, { type: 'state_snapshot', state: { isStreaming: false, isSettled: false, queuedMessageCount: 1, hasPendingAsyncWork: false, isCompacting: false } });
  assert.equal(chat.isRunning, false);
  assert.equal(chat.isSettled, false);
  assert.equal(chat.state.queuedMessageCount, 1);
  chat = reduceChatFrame(chat, { type: 'agent_start' });
  assert.equal(chat.isRunning, true);
  assert.equal(chat.state.queuedMessageCount, 1);
  chat = reduceChatFrame(chat, { type: 'state_snapshot', state: { hasPendingAsyncWork: true } });
  chat = reduceChatFrame(chat, { type: 'agent_end', isTerminal: true, yielded: true });
  assert.equal(chat.isRunning, true);
  assert.equal(chat.isSettled, false);
  chat = reduceChatFrame(chat, { type: 'prompt_result', status: 'completed', sessionSettled: true });
  assert.equal(chat.isSettled, true);
  assert.equal(chat.isRunning, false);
  assert.equal(chat.state.queuedMessageCount, 0);
  assert.equal(chat.state.isStreaming, false);
  assert.equal(chat.state.hasPendingAsyncWork, false);
  chat = reduceChatFrame(chat, { type: 'session_settled' });
  assert.equal(chat.isSettled, true);
  assert.equal(chat.isRunning, false);
});
test('connecting to a native paused queue does not claim active execution or settlement', () => {
  const chat = createChatState({ source: { status: 'unpersisted', sessionId: 'paused' }, runtimeId: 'paused', cwd: '/workspace', state: { sessionId: 'paused', isStreaming: false, isCompacting: false, isSettled: false, queuedMessageCount: 1, hasPendingAsyncWork: false }, messages: [], models: [], commands: [], thinkingLevels: [] });
  assert.equal(chat.isRunning, false);
  assert.equal(chat.isSettled, false);
  assert.equal(chat.state.queuedMessageCount, 1);
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
test('runtime loss makes nonterminal children unobserved without inventing terminal outcomes', () => {
  let chat = fresh();
  for (const id of ['running', 'done', 'failed', 'aborted']) chat = reduceChatFrame(chat, { type: 'subagent_lifecycle', payload: { id, status: 'started' } });
  for (const [id, status] of [['done', 'completed'], ['failed', 'failed'], ['aborted', 'aborted']]) chat = reduceChatFrame(chat, { type: 'subagent_lifecycle', payload: { id, status } });
  chat = reduceChatFrame(chat, { type: 'subagent_progress', payload: { id: 'running', progress: { status: 'running', toolCount: 3 } } });
  chat = reduceChatFrame(chat, { type: 'runtime_exit', error: 'Native process lost' });
  assert.deepEqual(chat.subagents.map(child => child.status), ['unknown', 'completed', 'failed', 'aborted']);
  assert.equal(chat.subagents[0].observationLost, true);
  assert.equal(chat.subagents[0].progress?.toolCount, 3);
  assert.equal(chat.subagents[0].progress?.status, 'unknown');
  assert.equal(chat.isRunning, false);
  assert.equal(chat.isSettled, false);
  assert.equal(chat.state.tokensPerSecond, null);
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
  const connection: SessionConnection = { source: { status: 'unpersisted', sessionId: 'session-A' }, runtimeId: 'worker-A', cwd: '/workspace', state: { sessionId: 'session-A', isStreaming: false, isSettled: true }, messages: [answer], messageIds: ['msg-1'], models: [], commands: [], thinkingLevels: [] };
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
  assert.deepEqual(chat.subagents.map(child => [child.id, child.nativeId, child.status]), [['saved-task', 'child', 'failed'], ['new-child', undefined, 'running']]);
  assert.equal(chat.subagents[0].savedId, 'saved-task');
  assert.equal(chat.subagents[0].historical, false);
  assert.equal(chat.subagents[0].task, 'Retained assignment');
  assert.equal(chat.subagents[0].progress?.error, 'Old failure');
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
    assert.equal(subagentPhase(settled.liveSubagents[0]), 'aborted');
    assert.equal(settled.liveSubagents[0].abortReason, 'Reviewer rejected the changed setting.');
    assert.equal(settled.subagents[0].id, 'saved-reviewer');
    assert.equal(settled.subagents[0].abortReason, 'Reviewer rejected the changed setting.');
    assert.equal(settled.subagents[0].progress?.tokens, 20);
    assert.equal(settled.liveSubagents[1].status, 'failed');
    assert.equal(settled.liveSubagents[1].error, 'Inspection failed.');
    assert.equal(settled.liveSubagents[2].status, 'running');
    assert.equal(settled.liveSubagents[3].status, 'running');
    assert.equal(settled.liveSubagents[3].error, undefined);
    assert.equal(subagentPhase(settled.liveSubagents[4]), 'aborted');
    assert.equal(settled.liveSubagents[4].abortReason, 'Native terminal reason.');
    const late = reduceChatFrame(settled, { type: 'subagent_progress', payload: { id: 'reviewer', parentToolCallId: 'batch', progress: { status: 'running' } } });
    assert.equal(subagentPhase(late.liveSubagents[0]), 'aborted');
    assert.equal(late.liveSubagents[0].abortReason, 'Reviewer rejected the changed setting.');
    const restarted = reduceChatFrame(late, { type: 'subagent_lifecycle', payload: { id: 'reviewer', parentToolCallId: 'new-batch', status: 'started' } });
    const delayed = reduceChatFrame(restarted, frame);
    assert.equal(delayed.liveSubagents[0].status, 'started');
    assert.equal(delayed.liveSubagents[0].abortReason, undefined);
  }
});

test('unkeyed nested lifecycles retain both equal user inputs and assistant continuation', () => {
  let chat = fresh();
  for (const timestamp of [1, 2]) {
    const message = { role: 'user', attribution: 'user', timestamp, content: 'same prompt' };
    chat = reduceChatFrame(chat, { type: 'message_start', message });
    chat = reduceChatFrame(chat, { type: 'message_end', message });
  }
  chat = reduceChatFrame(chat, { type: 'message_start', message: { role: 'assistant', content: 'before' } });
  chat = reduceChatFrame(chat, { type: 'message_start', message: { role: 'custom', customType: 'notice', content: 'nested' } });
  chat = reduceChatFrame(chat, { type: 'message_end', message: { role: 'custom', customType: 'notice', content: 'nested' } });
  chat = reduceChatFrame(chat, { type: 'message_end', message: { role: 'assistant', content: 'after' } });
  assert.deepEqual(chat.messages.map(row => row.raw.content), ['same prompt', 'same prompt', 'after', 'nested']);
  assert.equal(new Set(chat.messages.map(row => row.id)).size, 4);
  assert.deepEqual(chat.live.open, []);
});

test('user and user-attributed skill retain presentation only under unique native metadata', () => {
  const raw = { role: 'custom', customType: 'skill-prompt', display: true, attribution: 'user', timestamp: 10, content: '/skill literal' };
  let chat = reduceChatFrame(fresh(), { type: 'message_end', messageId: 'skill', message: raw });
  const presentation = chat.messages[0].presentation;
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [raw], messageIds: ['journal-skill'], reconcileLive: true });
  assert.equal(chat.messages[0].id, 'journal-skill');
  assert.deepEqual(chat.messages[0].presentation, presentation);
  assert.equal(chat.messages[0].raw.attribution, 'user');
  const user = { role: 'user', timestamp: 42, attribution: 'user', content: 'equal' };
  chat = fresh();
  for (const messageId of ['first', 'second']) chat = reduceChatFrame(chat, { type: 'message_end', messageId, message: user });
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [user, user], messageIds: ['entry-one', 'entry-two'], reconcileLive: true });
  assert.deepEqual(chat.messages.map(row => [row.id, row.presentation]), [['entry-one', undefined], ['entry-two', undefined]]);
});

test('keyed IDs cannot collide with compatibility IDs and snapshots preserve an open live message', () => {
  let chat = reduceChatFrame(fresh(), { type: 'message_start', message: { role: 'user', content: 'unkeyed' } });
  chat = reduceChatFrame(chat, { type: 'message_end', messageId: 'compat:1', message: { role: 'user', content: 'keyed' } });
  assert.notEqual(chat.messages[0].id, chat.messages[1].id);
  chat = reduceChatFrame(chat, { type: 'agent_start' });
  chat = reduceChatFrame(chat, { type: 'message_start', messageId: 'answer', message: { role: 'assistant', content: 'partial' } });
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [], messageIds: [], reconcileLive: true });
  assert.equal(chat.messages.find(row => row.id === 'live:worker-A:answer')?.raw.content, 'partial');
  chat = reduceChatFrame(chat, { type: 'message_end', messageId: 'answer', message: { role: 'assistant', content: 'complete' } });
  assert.deepEqual(chat.messages.filter(row => row.id === 'live:worker-A:answer').map(row => row.raw.content), ['complete']);
});

test('session switches cannot reuse unkeyed lifecycle ownership or presentation', () => {
  let chat = reduceChatFrame(fresh(), { type: 'message_start', message: { role: 'user', content: 'old intent', timestamp: 1 } });
  chat = reduceChatFrame(chat, { type: 'session_info_update', sessionId: 'session-B' });
  chat = reduceChatFrame(chat, { type: 'message_end', message: { role: 'user', content: 'new intent', timestamp: 1 } });
  assert.deepEqual(chat.messages.map(row => [row.raw.content, row.presentation?.sessionId]), [['new intent', 'session-B']]);
  assert.deepEqual(chat.live.open, []);
});

test('first durable source assignment preserves an open native message without borrowing source authority', () => {
  let chat = reduceChatFrame(fresh(), { type: 'message_start', messageId: 'user', message: { role: 'user', content: 'original literal input' } });
  const identity = chat.messages[0].id;
  chat = reduceChatFrame(chat, { type: 'state_snapshot', state: { sessionFile: '/new-native-source.jsonl' } });
  chat = reduceChatFrame(chat, { type: 'message_end', messageId: 'user', message: { role: 'user', content: 'original literal input' } });
  assert.deepEqual(chat.messages.map(row => [row.id, row.raw.content, row.streaming]), [[identity, 'original literal input', false]]);
  assert.equal(chat.historySource, undefined);
});

test('command output retains verified neighbors across hydration and stays out of unrelated older windows', () => {
  const requestA = { role: 'user', attribution: 'user', timestamp: 101, content: 'first request' };
  const answerA = { role: 'assistant', timestamp: 102, provider: 'native', model: 'model', stopReason: 'stop', content: 'first answer' };
  const requestB = { role: 'user', attribution: 'user', timestamp: 103, content: 'second request' };
  const answerB = { role: 'assistant', timestamp: 104, provider: 'native', model: 'model', stopReason: 'stop', content: 'second answer' };
  let chat = fresh();
  for (const [messageId, message] of [['request-a', requestA], ['answer-a', answerA]] as const) chat = reduceChatFrame(chat, { type: 'message_end', messageId, message });
  chat = reduceChatFrame(chat, { type: 'command_output', text: 'output between requests' });
  for (const [messageId, message] of [['request-b', requestB], ['answer-b', answerB]] as const) chat = reduceChatFrame(chat, { type: 'message_end', messageId, message });
  const snapshot = { type: 'messages_snapshot', messages: [requestA, answerA, requestB, answerB], messageIds: ['durable-a', 'durable-answer-a', 'durable-b', 'durable-answer-b'], reconcileLive: true };
  chat = reduceChatFrame(chat, snapshot);
  assert.deepEqual(chat.messages.map(row => row.raw.content), ['first request', 'first answer', 'output between requests', 'second request', 'second answer']);
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [requestA], messageIds: ['durable-a'], reconcileLive: false });
  assert.deepEqual(chat.messages.map(row => row.raw.content), ['first request']);
  assert.equal(chat.commandOutputs[0].row.raw.content, 'output between requests');
  chat = reduceChatFrame(chat, snapshot);
  assert.deepEqual(chat.messages.map(row => row.raw.content), ['first request', 'first answer', 'output between requests', 'second request', 'second answer']);
});

test('unverifiable command placement remains separate session output instead of joining a later answer', () => {
  let chat = reduceChatFrame(fresh(), { type: 'message_end', messageId: 'opaque', message: { role: 'assistant', content: 'unkeyed persistence metadata' } });
  chat = reduceChatFrame(chat, { type: 'command_output', text: 'retain native output' });
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [{ role: 'user', content: 'another request' }, { role: 'assistant', content: 'another answer' }], messageIds: ['different-request', 'different-answer'], reconcileLive: true });
  assert.deepEqual(chat.messages.map(row => row.raw.content), ['another request', 'another answer']);
  assert.deepEqual(chat.commandOutputs.map(output => [output.sessionId, output.row.raw.content]), [['session-A', 'retain native output']]);
});

test('provider retries stay live between empty attempts and never create transcript notices', () => {
  const retry = { type: 'auto_retry_start', attempt: 1, maxAttempts: 10, delayMs: 2000, errorMessage: '500 Internal Server Error' };
  let chat = reduceChatFrame(fresh(), retry);
  chat = reduceChatFrame(chat, { type: 'agent_start' });
  chat = reduceChatFrame(chat, { type: 'message_start', message: { role: 'assistant', content: [] } });
  chat = reduceChatFrame(chat, { type: 'agent_end', isTerminal: false });
  assert.deepEqual(chat.state.providerRetry, retry);
  assert.deepEqual(chat.notices, []);
  const received = reduceChatFrame(chat, { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered' }] } });
  assert.equal(received.state.providerRetry, undefined);
  const stopped = reduceChatFrame(chat, { type: 'auto_retry_end', aborted: true });
  assert.equal(stopped.state.providerRetry, undefined);
  assert.equal(stopped.outcome, 'aborted');
  assert.equal(stopped.error, undefined);
});

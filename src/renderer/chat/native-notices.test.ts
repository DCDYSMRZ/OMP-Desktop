import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatState, reduceChatFrame } from './model';

const fresh = () => createChatState({ source: { status: 'unpersisted', sessionId: 'session' }, runtimeId: 'runtime', cwd: '/workspace', state: { sessionId: 'session', isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [] });

test('retry progress replaces its prior state without hiding unrelated failures', () => {
  let chat = reduceChatFrame(fresh(), { type: 'notice', level: 'error', message: 'Persistence failed' });
  chat = reduceChatFrame(chat, { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'Provider unavailable' });
  chat = reduceChatFrame(chat, { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: 'Still unavailable' });
  const final = { type: 'auto_retry_end', success: false, attempt: 2, finalError: 'Quota exhausted' };
  chat = reduceChatFrame(chat, final);
  assert.equal(chat.state.providerRetry, undefined);
  assert.equal(chat.notices.length, 2);
  assert.equal(chat.notices[0].nativeMessage, 'Persistence failed');
  assert.equal(chat.notices[0].diagnostic, 'Persistence failed');
  assert.equal(chat.notices[1].level, 'error');
  assert.equal(chat.notices[1].values?.errorMessage, 'Quota exhausted');
  assert.equal(chat.notices[1].diagnostic, final);
  assert.match(chat.notices[1].text, /额度/);
});

test('compaction uses the native errorMessage and keeps refresh semantics', () => {
  let chat = reduceChatFrame(fresh(), { type: 'auto_compaction_start' });
  chat = reduceChatFrame(chat, { type: 'auto_compaction_end', errorMessage: 'Archive unavailable', aborted: false });
  assert.equal(chat.notices.length, 1);
  assert.equal(chat.notices[0].level, 'error');
  assert.equal(chat.notices[0].nativeMessage, 'Archive unavailable');
  assert.equal(chat.notices[0].values?.errorMessage, 'Archive unavailable');
  assert.match(chat.notices[0].text, /上下文/);
  assert.equal(chat.state.isCompacting, false);
  assert.equal(chat.refreshMessages, true);
});

test('todo and goal updates show current values rather than accumulated JSON', () => {
  let chat = reduceChatFrame(fresh(), { type: 'todo_reminder', todos: [{ status: 'completed' }, { status: 'in_progress' }], attempt: 1, maxAttempts: 3 });
  chat = reduceChatFrame(chat, { type: 'goal_updated', goal: { objective: 'Ship', status: 'active', tokensUsed: 10, tokenBudget: 100 } });
  chat = reduceChatFrame(chat, { type: 'goal_updated', goal: { objective: 'Ship', status: 'completed', tokensUsed: 30, tokenBudget: 100 } });
  assert.equal(chat.notices.filter(item => item.category === 'goal').length, 1);
  assert.deepEqual(chat.notices.find(item => item.category === 'goal')!.values, { objective: 'Ship', status: 'completed', tokensUsed: 30, tokenBudget: 100 });
  assert.equal(chat.notices.find(item => item.category === 'todo')!.values?.remaining, 1);
});

test('unknown native failures keep distinct messages and identical repeats deduplicate', () => {
  let chat = reduceChatFrame(fresh(), { type: 'notice', level: 'error', message: 'Persistence failed' });
  chat = reduceChatFrame(chat, { type: 'notice', level: 'error', message: 'Archive unavailable' });
  chat = reduceChatFrame(chat, { type: 'notice', level: 'error', message: 'Persistence failed' });
  assert.deepEqual(chat.notices.map(item => item.nativeMessage), ['Persistence failed', 'Archive unavailable']);
});

test('cancelled compaction does not masquerade as a failure', () => {
  const chat = reduceChatFrame(fresh(), { type: 'auto_compaction_end', aborted: true, errorMessage: 'Cancelled by user' });
  assert.equal(chat.notices[0].level, 'info');
  assert.equal(chat.notices[0].nativeMessage, undefined);
  assert.equal(chat.state.isCompacting, false);
  assert.equal(chat.refreshMessages, true);
});

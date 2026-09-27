import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatState, reduceChatFrame } from './model';

const fresh = () => createChatState({ runtimeId: 'runtime', cwd: '/workspace', state: { sessionId: 'session', isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [] });

test('retry progress replaces its prior state without hiding unrelated failures', () => {
  let chat = reduceChatFrame(fresh(), { type: 'notice', level: 'error', message: 'Persistence failed' });
  chat = reduceChatFrame(chat, { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'Provider unavailable' });
  chat = reduceChatFrame(chat, { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: 'Still unavailable' });
  const final = { type: 'auto_retry_end', success: false, attempt: 2, finalError: 'Quota exhausted' };
  chat = reduceChatFrame(chat, final);
  assert.deepEqual(chat.notices.map(item => [item.level, item.text]), [['error', 'Persistence failed'], ['error', 'Quota exhausted']]);
  assert.equal(chat.notices[1].diagnostic, final);
});

test('compaction uses the native errorMessage and keeps refresh semantics', () => {
  let chat = reduceChatFrame(fresh(), { type: 'auto_compaction_start' });
  chat = reduceChatFrame(chat, { type: 'auto_compaction_end', errorMessage: 'Archive unavailable', aborted: false });
  assert.deepEqual(chat.notices.map(item => [item.level, item.text]), [['error', 'Archive unavailable']]);
  assert.equal(chat.state.isCompacting, false);
  assert.equal(chat.refreshMessages, true);
});

test('todo and goal updates show current values rather than accumulated JSON', () => {
  let chat = reduceChatFrame(fresh(), { type: 'todo_reminder', todos: [{ status: 'completed' }, { status: 'in_progress' }], attempt: 1, maxAttempts: 3 });
  chat = reduceChatFrame(chat, { type: 'goal_updated', goal: { objective: 'Ship', status: 'active', tokensUsed: 10, tokenBudget: 100 } });
  chat = reduceChatFrame(chat, { type: 'goal_updated', goal: { objective: 'Ship', status: 'completed', tokensUsed: 30, tokenBudget: 100 } });
  assert.equal(chat.notices.filter(item => item.category === 'goal').length, 1);
  assert.match(chat.notices.find(item => item.category === 'goal')!.text, /completed.*30\/100/);
  assert.match(chat.notices.find(item => item.category === 'todo')!.text, /^1 tasks remaining/);
});

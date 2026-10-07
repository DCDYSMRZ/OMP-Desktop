import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeTodoItem, NativeTodoPhase } from '../../shared/contracts';
import { diffTodoDockPlans, latestTodoPhases, todoDockPlan } from './todo-dock-model';
import { createChatState, reduceChatFrame } from './model';

const task = (content: string, status: NativeTodoItem['status'] = 'pending'): NativeTodoItem => ({ content, status });
const plan = (tasks: NativeTodoItem[]) => todoDockPlan([{ name: 'Build', tasks }]);

test('initial hydration does not animate completed or new tasks', () => {
  const changes = diffTodoDockPlans(null, plan([task('Done', 'completed'), task('Next')]));
  assert.deepEqual([...changes.completed], []);
  assert.deepEqual([...changes.added], []);
  assert.equal(changes.phaseAdvanced, false);
});

test('only existing non-completed tasks transitioning to completed are animated', () => {
  const before = plan([task('Doing', 'in_progress'), task('Waiting', 'blocked'), task('Done', 'completed'), task('Skipped', 'abandoned'), task('Pending')]);
  const after = plan([task('Doing', 'completed'), task('Waiting', 'completed'), task('Done', 'completed'), task('Skipped', 'abandoned'), task('Pending', 'in_progress'), task('New done', 'completed')]);
  const changes = diffTodoDockPlans(before, after);
  assert.deepEqual([...changes.completed], after.phases[0].tasks.slice(0, 2).map(row => row.key));
  assert.deepEqual([...changes.added], [after.phases[0].tasks[5].key]);
  assert.equal(after.completed, 4);
  assert.equal(after.total, 6);
});

test('insertion and reordering do not mistake a neighboring task for a completion', () => {
  const before = plan([task('First'), task('Second', 'completed')]);
  const after = plan([task('Inserted'), task('Second', 'completed'), task('First', 'completed')]);
  const changes = diffTodoDockPlans(before, after);
  assert.deepEqual([...changes.completed], [after.phases[0].tasks[2].key]);
  assert.deepEqual([...changes.added], [after.phases[0].tasks[0].key]);
});

test('duplicate task text and phase names retain distinct identities', () => {
  const phases: NativeTodoPhase[] = [{ name: 'Same', tasks: [task('Same'), task('Same')] }, { name: 'Same', tasks: [task('Same')] }];
  const before = todoDockPlan(phases);
  const after = todoDockPlan([{ ...phases[0], tasks: [task('Same'), task('Same', 'completed')] }, phases[1]]);
  assert.equal(new Set(before.phases.flatMap(phase => phase.tasks.map(row => row.key))).size, 3);
  assert.deepEqual([...diffTodoDockPlans(before, after).completed], [after.phases[0].tasks[1].key]);
});

test('removed tasks and renamed tasks do not manufacture completion events', () => {
  const after = plan([task('Renamed', 'completed')]);
  const changes = diffTodoDockPlans(plan([task('Original'), task('Removed')]), after);
  assert.deepEqual([...changes.completed], []);
  assert.deepEqual([...changes.added], [after.phases[0].tasks[0].key]);
});

test('phase advances to running work, falls back to unfinished work, then final phase', () => {
  const before = todoDockPlan([{ name: 'First', tasks: [task('A', 'in_progress')] }, { name: 'Second', tasks: [task('B')] }]);
  const after = todoDockPlan([{ name: 'First', tasks: [task('A', 'completed')] }, { name: 'Second', tasks: [task('B', 'in_progress')] }]);
  assert.equal(after.current, 1);
  assert.equal(diffTodoDockPlans(before, after).phaseAdvanced, true);
  assert.equal(todoDockPlan([{ name: 'Blocked', tasks: [task('A', 'blocked')] }, { name: 'Active', tasks: [task('B', 'in_progress')] }]).current, 1);
  assert.equal(todoDockPlan([{ name: 'Blocked', tasks: [task('A', 'blocked')] }, { name: 'Done', tasks: [task('B', 'completed')] }]).current, 0);
  assert.equal(todoDockPlan([{ name: 'Done', tasks: [task('A', 'completed')] }, { name: 'Skipped', tasks: [task('B', 'abandoned')] }]).current, 1);
  assert.equal(todoDockPlan(undefined).current, -1);
  assert.equal(todoDockPlan([{ name: 'Empty', tasks: [] }]).total, 0);
});

const freshTodos = (phases?: NativeTodoPhase[]) => createChatState({ runtimeId: 'todo-runtime', cwd: '/workspace', source: { status: 'unpersisted', sessionId: 'todo-session' }, state: { sessionId: 'todo-session', isStreaming: true, todoPhases: phases }, messages: [], models: [], commands: [], thinkingLevels: [] });
const initialTodos: NativeTodoPhase[] = [{ name: 'Build', tasks: [task('A', 'in_progress'), task('B')] }];
const nextTodos: NativeTodoPhase[] = [{ name: 'Build', tasks: [task('A', 'completed'), task('B', 'in_progress')] }];

test('completed live todo execution replaces stale state before its transcript result arrives', () => {
  let chat = freshTodos(initialTodos);
  chat = reduceChatFrame(chat, { type: 'tool_execution_end', toolCallId: 'todo-1', toolName: 'todo', result: { details: { phases: nextTodos } } });
  assert.equal(latestTodoPhases(chat, true), nextTodos);
  assert.equal(chat.state.todoPhases, initialTodos);
});

test('newer state wins even while streaming, and duplicate result delivery cannot regress it', () => {
  let chat = reduceChatFrame(freshTodos(), { type: 'tool_execution_end', toolCallId: 'todo-1', toolName: 'todo', result: { details: { phases: initialTodos } } });
  chat = reduceChatFrame(chat, { type: 'state_snapshot', state: { todoPhases: nextTodos } });
  assert.equal(latestTodoPhases(chat, true), nextTodos);
  chat = reduceChatFrame(chat, { type: 'message_end', messageId: 'result', message: { role: 'toolResult', toolCallId: 'todo-1', toolName: 'todo', details: { phases: initialTodos } } });
  assert.equal(latestTodoPhases(chat, true), nextTodos);
  chat = reduceChatFrame(chat, { type: 'tool_execution_end', toolCallId: 'todo-1', toolName: 'todo', result: { details: { phases: initialTodos } } });
  assert.equal(latestTodoPhases(chat, true), nextTodos);
});

test('message-only completions update the plan and unrelated state patches do not make old todos newer', () => {
  let chat = reduceChatFrame(freshTodos(initialTodos), { type: 'message_end', messageId: 'result', message: { role: 'toolResult', toolCallId: 'todo-1', toolName: 'todo', details: { phases: nextTodos } } });
  chat = reduceChatFrame(chat, { type: 'state_snapshot', state: { isStreaming: true } });
  assert.equal(latestTodoPhases(chat, true), nextTodos);
});

test('hydrated plans use transcript order, with streaming, compacting, settled and historical precedence', () => {
  let chat = freshTodos(initialTodos);
  const messages = [nextTodos, []].map((phases, index) => ({ role: 'toolResult', toolName: 'todo', toolCallId: `todo-${index}`, details: { phases }, timestamp: 100 }));
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages });
  assert.deepEqual(latestTodoPhases(chat, true), []);
  chat = { ...chat, state: { ...chat.state, isStreaming: false, isCompacting: true } };
  assert.deepEqual(latestTodoPhases(chat, true), []);
  chat = { ...chat, state: { ...chat.state, isCompacting: false } };
  assert.equal(latestTodoPhases(chat, true), initialTodos);
  assert.deepEqual(latestTodoPhases(chat, false), []);
  chat = { ...chat, state: { ...chat.state, todoPhases: undefined } };
  assert.deepEqual(latestTodoPhases(chat, true), []);
});

test('history hydration preserves known tool freshness instead of reviving stale state', () => {
  let chat = reduceChatFrame(freshTodos(initialTodos), { type: 'state_snapshot', state: { todoPhases: initialTodos } });
  const result = { role: 'toolResult', toolName: 'todo', toolCallId: 'todo-1', details: { phases: nextTodos } };
  chat = reduceChatFrame(chat, { type: 'tool_execution_end', toolCallId: 'todo-1', toolName: 'todo', result });
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [result] });
  assert.equal(latestTodoPhases(chat, true), nextTodos);
});

test('no plans, failed tools and partial tool updates never manufacture a plan', () => {
  let chat = freshTodos();
  assert.equal(latestTodoPhases(chat, true), undefined);
  assert.equal(latestTodoPhases(chat, false), undefined);
  chat = reduceChatFrame(chat, { type: 'tool_execution_update', toolCallId: 'todo-1', toolName: 'todo', partialResult: { details: { phases: nextTodos } } });
  assert.equal(latestTodoPhases(chat, true), undefined);
  chat = reduceChatFrame(chat, { type: 'tool_execution_end', toolCallId: 'todo-1', toolName: 'todo', isError: true, result: { details: { phases: nextTodos } } });
  assert.equal(latestTodoPhases(chat, true), undefined);
  const stateOnly = freshTodos(initialTodos);
  assert.equal(latestTodoPhases(stateOnly, false), initialTodos);
});

test('a refreshed empty plan is authoritative and cannot be resurrected by older tool results', () => {
  let chat = reduceChatFrame(freshTodos(initialTodos), { type: 'tool_execution_end', toolCallId: 'todo-1', toolName: 'todo', result: { details: { phases: nextTodos } } });
  chat = reduceChatFrame(chat, { type: 'state_snapshot', state: { todoPhases: [], isStreaming: false } });
  assert.deepEqual(latestTodoPhases(chat, true), []);
});

test('known completed results remain visible during transcript delivery and outrank unversioned leftovers', () => {
  let chat = reduceChatFrame(freshTodos(initialTodos), { type: 'tool_execution_end', toolCallId: 'todo-1', toolName: 'todo', result: { details: { phases: nextTodos } } });
  chat = reduceChatFrame(chat, { type: 'message_start', messageId: 'result', message: { role: 'toolResult', toolCallId: 'todo-1', toolName: 'todo', details: { phases: nextTodos } } });
  chat = { ...chat, tools: { ...chat.tools, stale: { id: 'stale', name: 'todo', status: 'complete', result: { details: { phases: initialTodos } } } } };
  assert.equal(latestTodoPhases(chat, true), nextTodos);
});

test('observed completion order outranks tool-start insertion order', () => {
  let chat = freshTodos(initialTodos);
  for (const id of ['first', 'second']) chat = reduceChatFrame(chat, { type: 'tool_execution_start', toolCallId: id, toolName: 'todo' });
  chat = reduceChatFrame(chat, { type: 'tool_execution_end', toolCallId: 'second', toolName: 'todo', result: { details: { phases: initialTodos } } });
  chat = reduceChatFrame(chat, { type: 'tool_execution_end', toolCallId: 'first', toolName: 'todo', result: { details: { phases: nextTodos } } });
  assert.equal(latestTodoPhases(chat, true), nextTodos);
});

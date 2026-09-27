import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeSubagent } from '../../../shared/contracts';
import { diffAgentSnapshot } from './agent-events';
const agent = (status: string, progress: Record<string, unknown> = {}): NativeSubagent => ({ id: 'worker', status, progress });
test('initial appearance spawns without replaying archived completion', () => { assert.deepEqual(diffAgentSnapshot(undefined, agent('completed')), [{ type: 'spawn' }]); });
test('pending and restarted terminal agents begin a fresh running phase', () => {
  for (const before of ['pending', 'completed', 'failed', 'stopped']) assert.deepEqual(diffAgentSnapshot(agent(before), agent('started')), [{ type: 'start' }]);
});
test('each terminal transition emits once, including native aliases', () => {
  for (const [status, type] of [['completed', 'complete'], ['failed', 'fail'], ['timed_out', 'fail'], ['aborted', 'abort'], ['stopped', 'abort']]) {
    const next = agent(status); assert.deepEqual(diffAgentSnapshot(agent('running'), next), [{ type }]); assert.deepEqual(diffAgentSnapshot(next, { ...next }), []);
  }
});
test('tool count increments and tool switches are coalesced into one tool event', () => {
  const before = agent('running', { currentTool: 'read', toolCount: 2 });
  assert.deepEqual(diffAgentSnapshot(before, agent('running', { currentTool: 'read', toolCount: 3 })), [{ type: 'tool', tool: 'read' }]);
  assert.deepEqual(diffAgentSnapshot(before, agent('running', { currentTool: 'write', toolCount: 3 })).filter(event => event.type === 'tool'), [{ type: 'tool', tool: 'write' }]);
  assert.deepEqual(diffAgentSnapshot(before, agent('running', { currentTool: 'read', toolCount: 1 })), []);
});
test('metrics helpers preserve nested count precedence and unknown tool names', () => {
  const before = { ...agent('running', { toolCount: 2 }), toolCount: 99 };
  assert.deepEqual(diffAgentSnapshot(before, { ...before, progress: { toolCount: 3 } }), [{ type: 'tool', tool: '' }]);
});
test('output and intent changes emit only while running; identical snapshots stay silent', () => {
  const before = agent('running', { recentOutput: 'old', lastIntent: 'Reading' });
  assert.deepEqual(diffAgentSnapshot(before, { ...before, progress: { ...before.progress } }), []);
  assert.deepEqual(diffAgentSnapshot(before, agent('running', { recentOutput: 'new', lastIntent: 'Writing' })), [{ type: 'output' }]);
  const done = agent('completed', { recentOutput: 'old' }); assert.deepEqual(diffAgentSnapshot(done, agent('completed', { recentOutput: 'new' })), []);
});

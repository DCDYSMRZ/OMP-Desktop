import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSubagent, groupSubagentsByToolCall, plannedSubagentPhase, plannedSubagents, subagentActivity, subagentMetrics, subagentPhase, subagentTitle, subagentTree } from './subagent-model';

test('only native nested details establish ancestry, not dotted IDs', () => {
  const parent = { id: 'review', progress: { inflightTaskDetails: { progress: [{ id: 'inspect', status: 'running' }], results: [] } } };
  const trees = subagentTree([parent, { id: 'review.unrelated', status: 'running' }, { id: 'inspect', status: 'failed' }]);
  assert.deepEqual(trees.map(node => node.agent.id), ['review', 'review.unrelated']);
  assert.equal(trees[0].children[0].agent.status, 'failed');
});
test('persisted cancellation and failures cannot render as successful child tasks', () => {
  const agents = [{ id: 'parent', progress: { extractedToolData: { task: [{ results: [
    { id: 'cancelled', aborted: true, exitCode: 0 },
    { id: 'bad-output', error: 'Invalid result', exitCode: 0 },
    { id: 'unknown' },
  ] }] } } }];
  assert.equal(subagentPhase(findSubagent(agents, 'cancelled')!), 'aborted');
  assert.equal(subagentPhase(findSubagent(agents, 'bad-output')!), 'failed');
  assert.equal(subagentPhase(findSubagent(agents, 'unknown')!), 'unknown');
});
test('cyclic task references stay readable without recursive expansion', () => {
  const agents = [{ id: 'a', progress: { inflightTaskDetails: { progress: [{ id: 'b' }] } } }, { id: 'b', progress: { inflightTaskDetails: { progress: [{ id: 'a' }] } } }];
  const trees = subagentTree(agents);
  assert.deepEqual(trees.map(node => node.agent.id), ['a', 'b']);
  assert.equal(trees[0].children[0].children.length, 0);
});

test('merged saved identities retain native hierarchy and exact detail selection without ambiguous aliases', () => {
  const parent = { id: 'saved-parent', nativeId: 'parent', historical: false, progress: { inflightTaskDetails: { progress: [{ id: 'child', status: 'running' }] } } };
  const child = { id: 'saved-child', nativeId: 'child', savedId: 'saved-child', historical: false, status: 'failed' };
  const trees = subagentTree([parent, child]);
  assert.deepEqual(trees.map(node => node.agent.id), ['saved-parent']);
  assert.deepEqual(trees[0].children.map(node => [node.agent.id, node.agent.status]), [['saved-child', 'failed']]);
  assert.equal(findSubagent([parent, child], 'child'), child);
  assert.equal(findSubagent([parent, child], 'saved-child'), child);
  const unrelated = { id: 'older-child', nativeId: 'child', historical: true, status: 'completed' };
  const current = { id: 'child', status: 'running' };
  assert.equal(findSubagent([unrelated, current], 'child'), current);
  assert.equal(findSubagent([unrelated, child], 'child'), undefined);
});

test('planned tasks preserve native indices and reject malformed payloads', () => {
  assert.deepEqual(plannedSubagents({ context: 'Shared', tasks: [{ name: 'review', agent: 'reviewer', task: 'Review' }, { task: 'Inspect' }] }), [{ index: 0, name: 'review', agent: 'reviewer', task: 'Review' }, { index: 1, name: undefined, agent: undefined, task: 'Inspect' }]);
  assert.equal(plannedSubagents({ agent: 'worker', task: 'One' })[0].index, 0);
  for (const args of [null, [], {}, { tasks: 'bad' }, { tasks: [{ task: 'Valid' }, null] }, { task: 4 }]) assert.deepEqual(plannedSubagents(args), []);
});

test('tool grouping orders by native index with stable fallback and isolates missing anchors', () => {
  const agents = [{ id: 'late', parentToolCallId: 'call', progress: { index: 2 } }, { id: 'first', parentToolCallId: 'call', index: 0, progress: { index: 9 } }, { id: 'unknown-a', parentToolCallId: 'call' }, { id: 'unknown-b', parentToolCallId: 'call' }, { id: 'missing', parentToolCallId: 'gone' }, { id: 'unowned' }];
  const original = structuredClone(agents);
  const grouped = groupSubagentsByToolCall(agents, new Set(['call']));
  assert.deepEqual(grouped.byToolCall.get('call')?.map(agent => agent.id), ['first', 'late', 'unknown-a', 'unknown-b']);
  assert.deepEqual(grouped.orphans.map(agent => agent.id), ['missing', 'unowned']);
  assert.deepEqual(agents, original);
});

test('terminal metrics and status win over late progress while activity remains running-only', () => {
  const agent = { id: 'worker', status: 'completed', durationMs: 3000, assignment: 'First line\nSecond line', progress: { durationMs: 1000, lastIntent: 'Reading', tokens: 18000, toolCount: 12 } };
  assert.equal(subagentTitle(agent), 'First line');
  assert.equal(subagentMetrics(agent).durationMs, 3000);
  assert.equal(subagentActivity(agent), undefined);
  assert.equal(subagentActivity({ ...agent, status: 'started' }), 'Reading');
  assert.equal(subagentPhase({ id: 'denied', status: 'denied' }), 'failed');
});

test('terminal parent calls settle missing planned slots without declaring them successful', () => {
  for (const status of [undefined, 'pending', 'running', 'started']) assert.equal(plannedSubagentPhase(status), 'pending');
  for (const status of ['interrupted', 'aborted', 'cancelled', 'stopped', 'complete', 'completed']) assert.equal(plannedSubagentPhase(status), 'aborted');
  for (const status of ['error', 'failed', 'timed_out', 'denied']) assert.equal(plannedSubagentPhase(status), 'failed');
});

test('grouping resolves full ancestry before partitioning roots and preserves authoritative child aliases', () => {
  const parent = { id: 'saved-parent', nativeId: 'parent', parentToolCallId: 'outer', progress: { inflightTaskDetails: { progress: [{ id: 'child', status: 'running' }] } } };
  const child = { id: 'saved-child', nativeId: 'child', savedId: 'saved-child', parentToolCallId: 'inner', status: 'failed', error: 'Authoritative failure' };
  const orphan = { id: 'unrelated' };
  const agents = [parent, child, orphan];
  const original = structuredClone(agents);
  for (const anchors of [new Set(['outer']), new Set(['outer', 'inner'])]) {
    const grouped = groupSubagentsByToolCall(agents, anchors);
    assert.deepEqual([...grouped.byToolCall.keys()], ['outer']);
    assert.deepEqual(grouped.byToolCall.get('outer'), [parent]);
    assert.deepEqual(grouped.orphans, [orphan]);
    assert.equal(grouped.resolvedTrees[0].children[0].agent, child);
    assert.equal(findSubagent(agents, 'child'), child);
  }
  assert.deepEqual(agents, original);
});

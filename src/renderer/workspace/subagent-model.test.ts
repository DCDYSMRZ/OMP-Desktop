import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateSubagentPhase, childPanelTarget, findSubagent, flattenSubagentTree, groupSubagentsByToolCall, mergeChildRoster, plannedSlotStatus, plannedSubagentPhase, plannedSubagents, projectSavedHierarchy, retainSavedNavigation, subagentActivity, subagentMetrics, subagentObservedLive, subagentPhase, subagentPresentationId, subagentSummary, subagentTitle, subagentTree } from './subagent-model';
import type { SavedSubagentNavigation } from '../../shared/contracts';
import { childHistoryMetrics, subagentBrief } from './subagent-model';
import type { ChatMessage } from '../chat/model';
import { formatSubagentCost, formatSubagentTokens, subagentOutcome, subagentPreview, subagentResultFields, subagentResultSummary, withTaskResults } from './subagent-model';

test('missing child measurements stay absent while measured zero remains truthful', () => {
  assert.deepEqual(childHistoryMetrics([]), { toolCount: undefined, tokens: undefined, cost: undefined, durationMs: undefined });
  const rows: ChatMessage[] = [{ id: 'text', source: 'history', streaming: false, raw: { role: 'assistant', content: [{ type: 'text', text: 'No usage supplied' }] } }];
  assert.equal(childHistoryMetrics(rows).tokens, undefined);
  assert.equal(childHistoryMetrics(rows).cost, undefined);
  rows[0].raw.usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, totalTokens: 0, cost: { total: 0 } };
  assert.equal(childHistoryMetrics(rows).tokens, 0);
  assert.equal(childHistoryMetrics(rows).cost, 0);
  assert.equal(subagentMetrics({ id: 'instant', status: 'completed', durationMs: 0, progress: { durationMs: 3000 } }).durationMs, 0);
});
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
test('disconnected cyclic tasks remain reachable alongside ordinary roots', () => {
  const agents = [{ id: 'root', status: 'completed' }, { id: 'a', progress: { inflightTaskDetails: { progress: [{ id: 'b' }] } } }, { id: 'b', progress: { inflightTaskDetails: { progress: [{ id: 'a' }] } } }];
  assert.deepEqual(flattenSubagentTree(subagentTree(agents)).map(agent => agent.id).sort(), ['a', 'b', 'root']);
  for (const agent of agents) assert.equal(findSubagent(agents, agent.id)?.id, agent.id);
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
  assert.equal(subagentMetrics(agent).durationMs, 3000);
  assert.equal(subagentActivity(agent), undefined);
  assert.equal(subagentActivity({ ...agent, status: 'started' }), 'Reading');
  assert.equal(subagentPhase({ id: 'denied', status: 'denied' }), 'failed');
});

test('terminal parent calls settle missing planned slots without declaring them successful', () => {
  for (const status of [undefined, 'pending', 'running', 'started']) assert.equal(plannedSubagentPhase(status), 'pending');
  for (const status of ['interrupted', 'aborted', 'cancelled', 'stopped', 'complete', 'completed']) assert.equal(plannedSubagentPhase(status), 'aborted');
  for (const status of ['error', 'failed', 'timed_out', 'denied']) assert.equal(plannedSubagentPhase(status), 'failed');
  assert.equal(plannedSubagentPhase('unknown'), 'unknown');
});
test('declared slots of a live running call wait neutrally; unobserved or settled calls never look pending', () => {
  const live = plannedSlotStatus('running', true);
  assert.deepEqual(live, { status: 'pending' });
  assert.equal(subagentPhase({ id: 'planned:call:0', ...live }), 'pending');
  assert.deepEqual(subagentSummary([{ id: 'planned:call:0', ...live }]).counts, { running: 0, pending: 1, completed: 0, failed: 0, aborted: 0, unknown: 0 });
  const saved = plannedSlotStatus('running', false);
  assert.equal(saved.status, 'unknown');
  assert.match(String(saved.ownershipReason), /not yet been uniquely linked/);
  assert.equal(plannedSlotStatus('completed', true).status, 'aborted');
  assert.equal(plannedSlotStatus('error', true).status, 'failed');
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

test('mixed task outcomes never become success and attention survives ongoing work', () => {
  for (const phase of ['failed', 'aborted', 'unknown', 'pending'] as const) {
    assert.equal(aggregateSubagentPhase(['completed', phase]), phase);
    assert.equal(aggregateSubagentPhase([phase, 'completed']), phase);
  }
  assert.equal(aggregateSubagentPhase([]), 'unknown');
  const summary = subagentSummary([{ id: 'done', status: 'completed' }, { id: 'running', status: 'running' }, { id: 'failed', status: 'failed' }, { id: 'stopped', status: 'aborted' }, { id: 'unobserved', status: 'unknown' }]);
  assert.equal(summary.phase, 'running');
  assert.equal(summary.attention, 3);
  assert.equal(summary.counts.completed, 1);
  assert.equal(summary.total, 5);
});

test('lost observation stops nested activity without rewriting terminal native facts', () => {
  const parent = { id: 'parent', status: 'unknown', observationLost: true, observationReason: 'Runtime exited', progress: { inflightTaskDetails: { progress: [{ id: 'child', status: 'running', lastIntent: 'Old intent' }], results: [{ id: 'done', exitCode: 0 }, { id: 'failed', exitCode: 1 }] } } };
  const child = findSubagent([parent], 'child')!;
  assert.equal(subagentPhase(child), 'unknown');
  assert.equal(subagentActivity(child), undefined);
  assert.equal(child.observationReason, 'Runtime exited');
  assert.equal(subagentPhase(findSubagent([parent], 'done')!), 'completed');
  assert.equal(subagentPhase(findSubagent([parent], 'failed')!), 'failed');
});

test('a repeated explicit child remains addressable by its unique native alias', () => {
  const shared = { id: 'saved-child', nativeId: 'child', status: 'running' };
  const parents = ['a', 'b'].map(id => ({ id, progress: { inflightTaskDetails: { progress: [{ id: 'child' }] } } }));
  assert.equal(findSubagent([...parents, shared], 'child'), shared);
  assert.equal(subagentSummary(flattenSubagentTree(subagentTree([...parents, shared]))).total, 3);
});

test('authorized saved discoveries join the shared tree without losing source selectors or warming history', () => {
  const root = { id: 'saved-root', nativeId: 'worker', historical: true, parentToolCallId: 'task-root' };
  const child = { id: 'saved-child', nativeId: 'worker', historical: true, status: 'running' };
  const grandchild = { id: 'saved-grandchild', nativeId: 'worker', historical: true, status: 'pending' };
  const first: SavedSubagentNavigation = { ancestry: [], ancestors: [], children: [child], childAncestry: [{ subagentId: root.id, leafId: 'root-leaf', revision: 'root-v1' }] };
  const second: SavedSubagentNavigation = { ancestry: first.childAncestry, ancestors: [root], children: [grandchild], childAncestry: [...first.childAncestry, { subagentId: child.id, leafId: 'child-leaf', revision: 'child-v1' }] };
  const discoveries = retainSavedNavigation(retainSavedNavigation([], first), second);
  const agents = projectSavedHierarchy([root], discoveries);
  const grouped = groupSubagentsByToolCall(agents, new Set(['task-root']));
  assert.deepEqual(grouped.orphans, []);
  assert.deepEqual(flattenSubagentTree(grouped.resolvedTrees).map(agent => agent.id), [root.id, child.id, grandchild.id]);
  assert.equal(grouped.resolvedTrees[0].children[0].children[0].agent.id, grandchild.id);
  const selected = findSubagent(agents, grandchild.id)!;
  assert.deepEqual(selected.savedAncestry, second.childAncestry);
  assert.equal(selected.nativeId, 'worker');
  assert.equal(subagentObservedLive(selected, true), false);
  assert.equal(findSubagent(agents, 'worker'), undefined);
  assert.equal(subagentPhase(findSubagent(agents, child.id)!), 'unknown');
  const revised = retainSavedNavigation(discoveries, { ...first, childAncestry: [{ ...first.childAncestry[0], revision: 'root-v2' }] });
  assert.deepEqual(flattenSubagentTree(subagentTree(projectSavedHierarchy([root], revised))).map(agent => agent.id), [root.id, child.id]);
});

test('bounded saved discovery retention keeps the selected ancestry reachable', () => {
  const root = { id: 'root', historical: true };
  const first: SavedSubagentNavigation = { ancestry: [], ancestors: [], children: [{ id: 'child', historical: true }], childAncestry: [{ subagentId: root.id, leafId: null, revision: 'v1' }] };
  let discoveries = retainSavedNavigation([], first);
  const child: SavedSubagentNavigation = { ancestry: first.childAncestry, ancestors: [root], children: [{ id: 'grandchild', historical: true }], childAncestry: [...first.childAncestry, { subagentId: 'child', leafId: null, revision: 'v1' }] };
  for (let index = 0; index < 140; index++) {
    discoveries = retainSavedNavigation(discoveries, { ancestry: [], ancestors: [], children: [], childAncestry: [{ subagentId: `other-${index}`, leafId: null, revision: 'v1' }] });
    discoveries = retainSavedNavigation(discoveries, child);
  }
  assert.equal(discoveries.length, 128);
  assert.deepEqual(flattenSubagentTree(subagentTree(projectSavedHierarchy([root], discoveries))).map(agent => agent.id), ['root', 'child', 'grandchild']);
});

test('saved discovery does not replace an explicitly owned native child with a cold snapshot', () => {
  const liveChild = { id: 'live-child', nativeId: 'worker', historical: false, status: 'running' };
  const root = { id: 'root', progress: { inflightTaskDetails: { progress: [{ id: liveChild.id }] } } };
  const navigation: SavedSubagentNavigation = { ancestry: [], ancestors: [], children: [{ id: 'saved-child', nativeId: 'worker', historical: true, status: 'completed' }], childAncestry: [{ subagentId: root.id, leafId: null, revision: 'v1' }] };
  const trees = subagentTree(projectSavedHierarchy([root, liveChild], [navigation]));
  assert.deepEqual(flattenSubagentTree(trees).map(agent => agent.id), [root.id, liveChild.id]);
  assert.equal(subagentPhase(trees[0].children[0].agent), 'running');
  assert.equal(subagentObservedLive(trees[0].children[0].agent, true), true);
});

test('ended parent observation freezes embedded nonterminal descendants without inventing outcomes', () => {
  for (const status of ['completed', 'failed', 'aborted']) {
    const parent = { id: 'parent', status, progress: { inflightTaskDetails: { progress: [
      { id: 'child', status: 'running', durationMs: 356000, lastIntent: 'Old intent', inflightTaskDetails: { progress: [{ id: 'grandchild', status: 'pending' }] } },
    ], results: [{ id: 'done', exitCode: 0 }, { id: 'failed-child', exitCode: 1 }, { id: 'aborted-child', aborted: true }] } } };
    const trees = subagentTree([parent]);
    const agents = flattenSubagentTree(trees);
    const child = findSubagent(agents, 'child')!;
    assert.equal(child.status, 'running');
    assert.equal(child.progress?.status, 'running');
    assert.equal(subagentMetrics(child).durationMs, 356000);
    assert.equal(subagentPhase(child), 'unknown');
    assert.equal(subagentObservedLive(child, true), false);
    assert.equal(subagentActivity(child), undefined);
    const grandchild = findSubagent(agents, 'grandchild')!;
    assert.equal(grandchild.status, 'pending');
    assert.equal(subagentPhase(grandchild), 'unknown');
    assert.equal(subagentObservedLive(grandchild, true), false);
    assert.equal(subagentPhase(findSubagent(agents, 'done')!), 'completed');
    assert.equal(subagentPhase(findSubagent(agents, 'failed-child')!), 'failed');
    assert.equal(subagentPhase(findSubagent(agents, 'aborted-child')!), 'aborted');
  }
});

test('independently observed roster children outlive terminal or unobserved parents', () => {
  const child = { id: 'owned-child', nativeId: 'worker', status: 'running', progress: { inflightTaskDetails: { progress: [{ id: 'grandchild', status: 'pending' }] } } };
  for (const state of [{ status: 'completed' }, { status: 'unknown', observationLost: true }]) {
    const parent = { id: 'parent', ...state, progress: { inflightTaskDetails: { progress: [{ id: 'worker', status: 'running' }] } } };
    const trees = subagentTree([parent, child]);
    assert.equal(trees[0].children[0].agent, child);
    assert.equal(subagentPhase(trees[0].children[0].agent), 'running');
    assert.equal(subagentObservedLive(trees[0].children[0].agent, true), true);
    assert.equal(subagentPhase(trees[0].children[0].children[0].agent), 'pending');
    assert.equal(subagentObservedLive(trees[0].children[0].children[0].agent, true), true);
  }
});

test('child roster reconciles terminal evidence while preserving saved selectors and unmatched descendants', () => {
  const live = { id: 'native-child', parentToolCallId: 'call', status: 'running' };
  const saved = { id: 'saved-child', nativeId: 'native-child', parentToolCallId: 'call', historical: true, status: 'completed' };
  const merged = mergeChildRoster([saved], [live, { id: 'new-child', status: 'running' }]);
  assert.deepEqual(merged.map(child => child.id), ['native-child', 'new-child']);
  assert.equal(merged[0].savedId, 'saved-child');
  assert.equal(merged[0].status, 'completed');
  assert.equal(subagentPresentationId(merged[0]), subagentPresentationId(live));
  const promoted = { ...merged[0], id: 'saved-child', historical: false };
  assert.equal(subagentPresentationId(promoted), subagentPresentationId(live));
  const ambiguous = mergeChildRoster([saved, { ...saved, id: 'other-saved' }], [live]);
  assert.deepEqual(ambiguous.map(child => child.id), ['saved-child', 'other-saved', 'native-child']);
  const wrongOwner = mergeChildRoster([{ ...saved, parentToolCallId: 'other-call' }], [live]);
  assert.deepEqual(wrongOwner.map(child => child.id), ['saved-child', 'native-child']);
});

test('multiple parent occurrences retain actual third-level branches', () => {
  const parents = ['parent-a', 'parent-b'].map(id => ({ id, progress: { inflightTaskDetails: { progress: [{ id: 'shared' }] } } }));
  const shared = { id: 'shared', progress: { inflightTaskDetails: { progress: [{ id: 'grandchild', status: 'failed' }] } } };
  const trees = subagentTree([...parents, shared]);
  assert.deepEqual(trees.map(node => [node.agent.id, node.children[0].agent.id, node.children[0].children[0].agent.id]), [['parent-a', 'shared', 'grandchild'], ['parent-b', 'shared', 'grandchild']]);
  assert.equal(findSubagent([...parents, shared], 'grandchild')?.status, 'failed');
});

test('opening a reconciled live descendant follows its changing roster instead of pinning the saved snapshot', () => {
  const native = { id: 'native-child', parentToolCallId: 'spawn', status: 'running', sessionFile: '/owned/child.jsonl' };
  const saved = { id: 'saved-child', nativeId: native.id, parentToolCallId: 'spawn', historical: true, status: 'pending' };
  const ancestry: SavedSubagentNavigation['ancestry'] = [{ subagentId: 'saved-parent', leafId: 'parent-leaf', revision: 'parent-revision' }];
  const merged = mergeChildRoster([saved], [native])[0]!;
  const target = childPanelTarget({ ...merged, id: merged.savedId! }, ancestry, [native], true);
  assert.equal(target.subagentId, native.id);
  assert.equal(target.savedSubagent, undefined);
  assert.equal(target.savedAncestry, undefined);
  assert.deepEqual(target.savedRecovery, { subagentId: saved.id, ancestry });
  const updated = { ...native, status: 'completed', lastEvent: { type: 'message_end', message: { role: 'assistant', content: 'Final child answer' } } };
  const observed = target.savedSubagent ?? findSubagent([updated], target.subagentId);
  assert.equal(observed, updated);
  assert.equal(subagentObservedLive(observed!, true), true);
  assert.equal(observed?.status, 'completed');
  assert.deepEqual(observed?.lastEvent, updated.lastEvent);
});

test('saved, unobserved, ambiguous and conflicting descendants cannot acquire a native observation route', () => {
  const native = { id: 'native-child', parentToolCallId: 'spawn', status: 'running' };
  const saved = { id: 'saved-child', nativeId: native.id, parentToolCallId: 'spawn', historical: true };
  const merged = mergeChildRoster([saved], [native])[0]!;
  const ancestry: SavedSubagentNavigation['ancestry'] = [{ subagentId: 'saved-parent', leafId: 'leaf', revision: 'revision' }];
  const cases = [
    childPanelTarget(saved, ancestry, [native], true),
    childPanelTarget(merged, ancestry, [native], false),
    childPanelTarget(merged, ancestry, [{ ...native, observationLost: true }], true),
    childPanelTarget(merged, ancestry, [], true),
    childPanelTarget(merged, ancestry, [native, { ...native, id: 'other', nativeId: native.id }], true),
    childPanelTarget(merged, ancestry, [{ ...native, parentToolCallId: 'other-spawn' }], true),
  ];
  for (const target of cases) {
    assert.equal(target.subagentId, saved.id);
    assert.equal(target.savedSubagent?.historical, true);
    assert.deepEqual(target.savedAncestry, ancestry);
    assert.equal(target.savedRecovery, undefined);
  }
});

test('display names prefer task handles and never expose persistence selectors or headings', () => {
  assert.equal(subagentTitle({ id: 'PinFrontend', agent: 'task', task: '# Target\nBuild UI' }), 'PinFrontend');
  assert.equal(subagentTitle({ id: 'saved-abc', nativeId: 'Parent.PinBackend' }), 'PinBackend');
  assert.equal(subagentTitle({ id: 'saved-abc', progress: { id: 'Parent.PinRuntime' } }), 'PinRuntime');
  assert.equal(subagentTitle({ id: 'planned:call:0', name: 'Reviewer', task: '# Target', agent: 'task' }), 'Reviewer');
  assert.equal(subagentTitle({ id: 'saved-deadbeef', agent: 'scout', description: '# Target' }), 'scout');
});
test('briefs skip headings and fenced examples while retaining meaningful task prose', () => {
  assert.equal(subagentBrief({ id: 'a', task: '# Target\n\n```ts\nconst demo = 1\n```\n- **Build** the `header`. Then test it.' }), 'Build the header.');
  assert.equal(subagentBrief({ id: 'a', description: 'Describe the result', task: 'Ignored assignment' }), 'Describe the result');
  assert.equal(subagentBrief({ id: 'a', assignment: '# Target\n修复时间显示。保留历史。' }), '修复时间显示。');
  assert.equal(subagentBrief({ id: 'a', task: 'x'.repeat(200) }).length, 140);
});
test('history metrics sum assistant requests without counting tool results twice', () => {
  const rows: ChatMessage[] = [
    { id: 'u', source: 'history', streaming: false, raw: { role: 'user', timestamp: 1000, usage: { totalTokens: 999 } } },
    { id: 'a', source: 'history', streaming: false, raw: { role: 'assistant', timestamp: 2000, content: [{ type: 'toolCall', id: 'executed' }, { type: 'toolCall', id: 'unexecuted' }], usage: { input: 1000, output: 100, cacheWrite: 900, cacheRead: 35000, totalTokens: 37000, cost: { total: 0.12 } } } },
    { id: 'r', source: 'history', streaming: false, raw: { role: 'toolResult', toolCallId: 'executed', timestamp: 2500, content: [{ type: 'text' }] } },
    { id: 'b', source: 'history', streaming: false, raw: { role: 'assistant', timestamp: 6000, usage: { input: 500, output: 100, cacheRead: 50, cacheWrite: 50, cost: { total: 0.03 } } } },
  ];
  assert.deepEqual(childHistoryMetrics(rows), { toolCount: 1, tokens: 2650, cost: 0.15, durationMs: 5000 });
});

test('blocking results enrich only matching child identities and retain native tree ownership', () => {
  const nodes = [{ agent: { id: 'saved-a', nativeId: 'Parent.A', status: 'completed', durationMs: 0 }, children: [] }];
  const enriched = withTaskResults(nodes, [{ id: 'Parent.A', output: '{"summary":"Finished"}', error: 'Problem', durationMs: 45000 }, { id: 'B', output: 'Wrong child' }]);
  assert.equal(enriched[0].agent.output, '{"summary":"Finished"}');
  assert.equal(enriched[0].agent.error, 'Problem');
  assert.equal(subagentMetrics(enriched[0].agent).durationMs, 45000);
  assert.equal(nodes[0].agent.durationMs, 0);
});
test('history span accepts persisted ISO timestamps and omits unmeasured elapsed time', () => {
  const rows = ['2026-09-28T12:00:00.000Z', '2026-09-28T12:16:53.000Z'].map((timestamp, index) => ({ id: String(index), source: 'history', streaming: false, raw: { role: 'assistant', timestamp } })) as unknown as ChatMessage[];
  assert.equal(childHistoryMetrics(rows).durationMs, 1013000);
  assert.equal(childHistoryMetrics(rows.slice(0, 1)).durationMs, undefined);
});
test('subagent costs preserve small meaningful amounts and share dollar formatting', () => {
  assert.equal(formatSubagentCost(1.234), '$1.23');
  assert.equal(formatSubagentCost(0.0101), '$0.01');
  assert.equal(formatSubagentCost(0.0077), '<$0.01');
  assert.equal(formatSubagentCost(1836.86), '$1,836.86');
});

test('task previews retain literal identifiers while removing paired Markdown decoration', () => {
  const assignment = '# Target\n- **Inspect** `FIXTURE_CHILD=ScanFrontend` and a*b.';
  assert.equal(subagentBrief({ id: 'ScanFrontend', task: assignment }), 'Inspect FIXTURE_CHILD=ScanFrontend and a*b.');
  assert.equal(subagentPreview('# Target\nFIXTURE_CHILD=ScanFrontend\nfile_name.ts\n`a*b`', 3), 'FIXTURE_CHILD=ScanFrontend\nfile_name.ts\na*b');
});
test('subagent token counts use the same compact scale below ten thousand', () => {
  assert.equal(formatSubagentTokens(7120), '7.1K');
  assert.equal(formatSubagentTokens(9325), '9.3K');
});

test('outcomes extract markdown answers and human conclusions from structured delivery', () => {
  const answer: ChatMessage = { id: 'final', source: 'history', streaming: false, raw: { role: 'assistant', content: [{ type: 'text', text: '# Report\n\n**Ready** for review.\n- Coverage includes failure paths.' }] } };
  const outcome = subagentOutcome({ id: 'review', status: 'completed' }, [answer]);
  assert.equal(outcome.summary, 'Ready for review.\nCoverage includes failure paths.');
  assert.equal(outcome.reportRowId, 'final');
  assert.equal(outcome.tone, 'completed');
  assert.equal(subagentResultSummary('{"data":{"summary":"**Ready** for review","status":"passed"}}').text, 'Ready for review');
  assert.equal(subagentResultSummary({ verdict: 'incorrect' }).text, 'Verdict: incorrect');
  assert.equal(subagentResultSummary({ files: ['a.ts'], count: 1 }).text, 'Files: a.ts\nCount: 1');
});

test('failed and stopped outcomes retain the real reason rather than claiming success', () => {
  const failed = subagentOutcome({ id: 'review', status: 'failed', error: 'Compiler exited 1', output: 'Earlier progress' });
  assert.equal(failed.tone, 'failed');
  assert.equal(failed.summary, 'Compiler exited 1');
  const stopped = subagentOutcome({ id: 'review', status: 'stopped', abortReason: 'User stopped the task' });
  assert.equal(stopped.tone, 'aborted');
  assert.equal(stopped.summary, 'User stopped the task');
});

test('issue evidence is deduplicated across history and overlapping progress totals', () => {
  const rows: ChatMessage[] = ['first', 'duplicate'].map(id => ({ id, source: 'history', streaming: false, raw: { role: 'toolResult', toolCallId: 'same', isError: true } }));
  const outcome = subagentOutcome({ id: 'review', status: 'completed', output: { summary: 'Finished', issues: ['missing resource', 'failed check'] }, progress: { errorCount: 2 } }, rows);
  assert.equal(outcome.issueCount, 2);
  assert.equal(outcome.tone, 'issues');
  assert.equal(subagentOutcome({ id: 'review', status: 'completed', output: 'No problems' }).issueCount, 0);
  const intermediate = subagentOutcome({ id: 'review', status: 'completed', progress: { recentTools: [{ status: 'error' }, { status: 'complete' }] } }, rows);
  assert.equal(intermediate.issueCount, 0);
  assert.equal(intermediate.toolFailureCount, 1);
  assert.equal(intermediate.tone, 'completed');
});

test('terminal yield is a report while incremental yield is not', () => {
  const row = (id: string, args: unknown): ChatMessage => ({ id, source: 'history', streaming: false, raw: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'yield', arguments: args }] } });
  const outcome = subagentOutcome({ id: 'review', status: 'completed' }, [row('section', { type: ['section'], data: { summary: 'Interim' } }), row('final', { data: { summary: 'All acceptance checks passed' } })]);
  assert.equal(outcome.summary, 'All acceptance checks passed');
  assert.equal(outcome.reportRowId, 'final');
  const prose: ChatMessage = { id: 'answer', source: 'history', streaming: false, raw: { role: 'assistant', content: 'Final readable conclusion' } };
  const noData = subagentOutcome({ id: 'review', status: 'completed' }, [prose, row('submit', { type: 'result' })]);
  assert.equal(noData.summary, 'Final readable conclusion');
  assert.equal(noData.reportRowId, 'answer');
});

test('structured reports lead with prose and suppress identity and false flags', () => {
  const outcome = subagentOutcome({ id: 'ScanFrontend', status: 'completed', output: { agent: 'ScanFrontend', name: 'ScanFrontend', report: 'Inspected src/frontend.ts.', expectedFailure: false } });
  assert.equal(outcome.summary, 'Inspected src/frontend.ts.');
  assert.deepEqual(outcome.chips, []);
  const finding = subagentResultSummary({ finding: '**Review complete.**', expectedFailure: true, status: 'passed', files: ['src/frontend.ts'], tests: 4 });
  assert.equal(finding.text, 'Review complete.');
  assert.deepEqual(finding.chips?.map(chip => [chip.key, chip.value]), [['expectedfailure', true], ['status', 'passed'], ['files', 'src/frontend.ts']]);
  const wrapped = subagentResultSummary(JSON.stringify({ data: { report: 'Ready for review.', agent: 'ScanFrontend', expected_failure: false, verdict: 'correct' } }));
  assert.equal(wrapped.text, 'Ready for review.');
  assert.deepEqual(wrapped.chips?.map(chip => [chip.key, chip.value]), [['verdict', 'correct']]);
});

test('full report metadata excludes identity and empty flags without the card display limit', () => {
  const fields = subagentResultFields({ agent: 'Review', name: 'Review', report: 'Finished.', expectedFailure: false, empty: '', missing: null, files: [], status: 'passed', tests: 4, coverage: 'branches', changed: true });
  assert.deepEqual(fields.map(field => [field.key, field.value]), [['status', 'passed'], ['tests', '4'], ['coverage', 'branches'], ['changed', true]]);
});

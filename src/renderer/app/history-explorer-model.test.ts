import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryTreeNode, HistoryTreeSnapshot } from '../../shared/contracts';
import { historyExplorerRows, historyNodeDate, HistoryTreeWindowError, readHistoryTreeWindow, shapeHistoryTree } from './history-explorer-model';

function node(id: string, parentId: string | null, role = 'user', preview = id): HistoryTreeNode { return { id, parentId, type: role === 'technical' ? 'thinking_level_change' : 'message', role, preview, timestamp: '2026-09-28T08:00:00Z' }; }

test('folds a turn but preserves forks inside its assistant chain', () => {
  const model = shapeHistoryTree([node('u', null), node('a', 'u', 'assistant'), node('t', 'a', 'toolResult'), node('left', 't', 'assistant'), node('left-u', 'left'), node('right', 't', 'assistant'), node('right-u', 'right')]);
  assert.deepEqual(model.turns.map(turn => [turn.id, turn.parentId, turn.entries.map(entry => entry.id)]), [['u', null, ['a', 't']], ['left', 'u', []], ['left-u', 'left', []], ['right', 'u', []], ['right-u', 'right', []]]);
  assert.equal(model.turns[0].lane, model.turns[1].lane);
  assert.notEqual(model.turns[1].lane, model.turns[3].lane);
  assert.deepEqual(model.turns[0].children, ['left', 'right']);
  assert.equal(model.entryTurn.get('t'), 'u');
});

test('hidden technical nodes preserve ancestry, sibling forks and tip ownership', () => {
  const nodes = [node('u', null), node('meta', 'u', 'technical'), node('a', 'meta', 'assistant'), node('tip', 'a', 'technical'), node('b', 'meta')];
  const model = shapeHistoryTree(nodes);
  assert.equal(model.hiddenTechnical, 2);
  assert.deepEqual(model.turns.map(turn => [turn.id, turn.parentId]), [['u', null], ['a', 'u'], ['b', 'u']]);
  assert.equal(model.entryTurn.get('tip'), 'a');
  const shown = shapeHistoryTree(nodes, true);
  assert.equal(shown.hiddenTechnical, 0);
  assert.equal(historyExplorerRows(shown, new Set(shown.turns.map(turn => turn.id))).find(row => row.id === 'tip')?.node.type, 'thinking_level_change');
});

test('filter reveals matching folded entries and retains branch context only', () => {
  const model = shapeHistoryTree([node('root', null), node('one', 'root'), node('answer', 'one', 'assistant', '修复 Navigation issue'), node('two', 'root')]);
  const rows = historyExplorerRows(model, new Set(), '修复 NAVIGATION');
  assert.deepEqual(rows.map(row => row.id), ['root', 'one', 'answer']);
  assert.equal(rows[2].matched, true);
  assert.equal(rows[0].matched, false);
  assert.deepEqual(historyExplorerRows(model, new Set()).map(row => row.id), ['root', 'one', 'two']);
  assert.deepEqual(historyExplorerRows(model, new Set(['one'])).map(row => row.id), ['root', 'one', 'answer', 'two']);
});

test('paged orphan roots reconnect when older parents arrive without mutating input', () => {
  const later = [node('a', 'u', 'assistant'), node('v', 'a')];
  assert.equal(shapeHistoryTree(later).turns[0].id, 'a');
  const model = shapeHistoryTree([node('u', null), ...later]);
  assert.equal(model.entryTurn.get('a'), 'u');
  assert.equal(model.turns[1].parentId, 'u');
  assert.equal(later[0].parentId, 'u');
});

test('cycles and out-of-order parents neither lose entries nor loop', () => {
  const model = shapeHistoryTree([node('child', 'parent'), node('parent', null), node('x', 'y'), node('y', 'x')]);
  assert.equal(model.entryTurn.size, 4);
  assert.deepEqual(model.turns.slice(0, 2).map(turn => turn.id), ['parent', 'child']);
  assert.equal(new Set(historyExplorerRows(model, new Set(model.turns.map(turn => turn.id))).map(row => row.id)).size, 4);
});

test('dates use locale-aware relative and exact values and reject invalid input', () => {
  const now = Date.parse('2026-09-28T09:00:00Z');
  assert.equal(historyNodeDate('invalid', 'en', now), null);
  assert.match(historyNodeDate('2026-09-28T08:00:00Z', 'en', now)!.relative, /hour/);
  assert.match(historyNodeDate('2026-09-28T08:00:00Z', 'zh-CN', now)!.relative, /小时/);
  assert.match(historyNodeDate('2026-09-28T08:00:00Z', 'en', now)!.exact, /2026/);
});

test('refresh keeps the mounted range until a consistent replacement covers its oldest entry', async () => {
  const previous = [node('old', null), node('middle', 'old'), node('tail', 'middle')];
  let published = previous;
  let resolveEarlier!: (page: HistoryTreeSnapshot) => void;
  const earlier = new Promise<HistoryTreeSnapshot>(resolve => { resolveEarlier = resolve; });
  const pending = readHistoryTreeWindow(async before => before ? earlier : { revision: 'new', leafId: 'latest', nodes: [node('tail', 'middle'), node('latest', 'tail')], hasMore: true, nextBefore: 'older', diagnostics: [] }, 'old', () => true).then(tree => { if (tree) published = tree.nodes; });
  await Promise.resolve();
  assert.equal(published, previous);
  resolveEarlier({ revision: 'new', leafId: 'old-tip', nodes: [node('old', null), node('middle', 'old'), node('tail', 'middle')], hasMore: false, diagnostics: [] });
  await pending;
  assert.deepEqual(published.map(row => row.id), ['old', 'middle', 'tail', 'latest']);
});

test('refresh cannot publish mixed revisions or a cancelled source generation', async () => {
  const tail: HistoryTreeSnapshot = { revision: 'new', leafId: 'tail', nodes: [node('tail', 'old')], hasMore: true, nextBefore: 'older', diagnostics: [] };
  await assert.rejects(readHistoryTreeWindow(async before => before ? { ...tail, revision: 'foreign', nodes: [node('old', null)], hasMore: false } : tail, 'old', () => true), (error: unknown) => error instanceof HistoryTreeWindowError && error.reason === 'revision');
  let current = true;
  const cancelled = await readHistoryTreeWindow(async before => { if (before) current = false; return before ? { ...tail, nodes: [node('old', null)], hasMore: false } : tail; }, 'old', () => current);
  assert.equal(cancelled, undefined);
});

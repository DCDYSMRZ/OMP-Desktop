import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPaletteMessage, groupPaletteMessages, paletteMessageTimestamp, fuzzyMatch, parsePaletteQuery, rankPaletteItems, type RankablePaletteItem } from './palette-model';
import type { MessageSearchHit } from '../../shared/contracts';
test('prefixes override chips without consuming ordinary query punctuation', () => {
  assert.deepEqual(parsePaletteQuery('  # 分支 上下文', 'files'), { scope: 'messages', query: '分支 上下文' });
  assert.deepEqual(parsePaletteQuery('@ src/main'), { scope: 'files', query: 'src/main' });
  assert.deepEqual(parsePaletteQuery('/compact'), { scope: 'commands', query: 'compact' });
  assert.deepEqual(parsePaletteQuery('> stop'), { scope: 'actions', query: 'stop' });
  assert.deepEqual(parsePaletteQuery('a@b', 'sessions'), { scope: 'sessions', query: 'a@b' });
});
test('matching requires every token and exposes exact CJK and fuzzy highlight offsets', () => {
  assert.deepEqual(fuzzyMatch('查找历史分支', '历史')?.ranges, [[2, 4]]);
  assert.deepEqual(fuzzyMatch('CommandPalette', 'cpl')?.ranges, [[0, 1], [7, 8], [9, 10]]);
  assert.deepEqual(fuzzyMatch('😀x⚙', '😀⚙')?.ranges, [[0, 2], [3, 4]]);
  assert.equal(fuzzyMatch('history branch', 'history absent'), null);
  assert.ok(fuzzyMatch('palette', 'pal')!.score > fuzzyMatch('partial', 'pal')!.score);
});
test('grouping is stable across source completion order and prefers exact titles', () => {
  const items: RankablePaletteItem[] = [
    { id: 'b', group: 'files', title: 'partial', detail: '' },
    { id: 'a', group: 'files', title: 'palette', detail: '' },
    { id: 's', group: 'sessions', title: 'Palette design', detail: '' },
  ];
  const ids = (rows: RankablePaletteItem[]) => rankPaletteItems(rows, 'pal', 'all').map(row => row.item.id);
  assert.deepEqual(ids(items), ['s', 'a', 'b']);
  assert.deepEqual(ids([...items].reverse()), ids(items));
  assert.deepEqual(rankPaletteItems(items, 'pal', 'files').map(row => row.item.id), ['a', 'b']);
});
test('live source replaces saved duplicate and remote full-content matches survive short snippets', () => {
  const rows = rankPaletteItems([
    { id: 's', group: 'sessions', title: 'Saved', detail: 'old' },
    { id: 's', group: 'sessions', title: 'Live', detail: 'current' },
    { id: 'm', group: 'messages', title: 'Answer', detail: 'first token', matched: true },
  ], '', 'all');
  assert.deepEqual(rows.map(row => row.item.title), ['Live', 'Answer']);
  assert.equal(rankPaletteItems([rows[1].item], 'first elsewhere', 'messages')[0].item.id, 'm');
});
test('message snippets remove Markdown before calculating visible match coordinates', () => {
  const result = cleanPaletteMessage('### **构建** `foo_bar` [文件](src/a.ts)\n> 继续 **构建**', '构建 missing');
  assert.equal(result.text, '构建 foo_bar 文件\n继续 构建');
  assert.deepEqual(result.ranges, [[0, 2], [17, 19]]);
});
test('message context preserves readable lines and literal identifiers while merging overlapping terms', () => {
  const result = cleanPaletteMessage('## Search\n```ts\nconst foo_bar = a*b;\n```\n**C++** verifies the final result.', 'search sea C++ foo_bar');
  assert.equal(result.text, 'Search\nconst foo_bar = a*b;\nC++ verifies the final result.');
  assert.deepEqual(result.ranges.map(([start, end]) => result.text.slice(start, end)), ['Search', 'foo_bar', 'C++']);
});
test('empty sessions put the current project first then newest activity, never pathname order', () => {
  const items: RankablePaletteItem[] = [
    {id:'a',group:'sessions',title:'Same',detail:'',updatedAt:'2026-09-28',currentProject:false},
    {id:'b',group:'sessions',title:'Same',detail:'',updatedAt:'2026-09-26',currentProject:true},
    {id:'z',group:'sessions',title:'Same',detail:'',updatedAt:'2026-09-27',currentProject:true},
  ];
  assert.deepEqual(rankPaletteItems(items,'','sessions').map(row=>row.item.id),['z','b','a']);
});

test('identical normalized snippets collapse within a session while keeping the first native anchor', () => {
  const first: MessageSearchHit = { path: '/one.jsonl', title: 'Same title', cwd: '/project', entryId: 'first', role: 'toolResult', toolName: 'task', snippet: '**Use** proc://worker\nfor details', match: [8, 15], timestamp: 1000 };
  const groups = groupPaletteMessages([first, { ...first, entryId: 'second', snippet: 'Use   proc://worker for details', timestamp: 2000 }, { ...first, entryId: 'third', snippet: 'Use proc://worker for another result' }, { ...first, path: '/two.jsonl', entryId: 'other-session' }], 'proc://');
  assert.deepEqual(groups.map(group => [group.hit.path, group.hit.entryId, group.count]), [['/one.jsonl', 'first', 2], ['/one.jsonl', 'third', 1], ['/two.jsonl', 'other-session', 1]]);
  assert.equal(groups[0].hit, first);
  assert.deepEqual(groups[0].ranges.map(([start, end]) => groups[0].text.slice(start, end)), ['proc://']);
});

test('snippet grouping keeps different literal content and compact time distinguishes occurrences', () => {
  const hit: MessageSearchHit = { path: '/one.jsonl', title: 'Search', cwd: '/', entryId: 'a', role: 'assistant', snippet: 'Case A', match: [0, 4] };
  assert.deepEqual(groupPaletteMessages([hit, { ...hit, entryId: 'b', snippet: 'case A' }], 'case').map(group => group.count), [1, 1]);
  assert.equal(paletteMessageTimestamp(new Date(2026, 8, 29, 14, 52).getTime()), '9/29 14:52');
  assert.equal(paletteMessageTimestamp(undefined), undefined);
  assert.equal(paletteMessageTimestamp(NaN), undefined);
});

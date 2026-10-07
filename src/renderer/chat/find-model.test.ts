import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFindSources, findMatches, findMatchesChunked, findTextRanges, nextFindIndex } from './find-model';
import { buildTranscriptEntries } from './presentation';
import type { ChatMessage, ToolActivity } from './model';

const row = (id: string, role: string, content: unknown): ChatMessage => ({ id, source: 'history', streaming: false, raw: { role, content } });
test('literal CJK, punctuation and Unicode ranges preserve original offsets', () => {
  assert.deepEqual(findTextRanges('😀 中文 A.B a.b 中文', '中文'), [[3, 5], [14, 16]]);
  assert.deepEqual(findTextRanges('A.B axb a.b', 'a.b'), [[0, 3], [8, 11]]);
  assert.deepEqual(findTextRanges('İ x', 'x'), [[2, 3]]);
  assert.deepEqual(findTextRanges('anything', '  '), []);
  assert.deepEqual(findTextRanges('aaaa', 'aa'), [[0, 2], [2, 4]]);
});
test('matches search collapsed thinking and literal tool output once, with reveal paths', () => {
  const tools: Record<string, ToolActivity> = {};
  const calls = Array.from({ length: 5 }, (_, index) => {
    const id = `call-${index}`;
    tools[id] = { id, name: 'bash', args: { command: `echo ${index}`, i: 'Inspect logs' }, result: { content: [{ type: 'text', text: index === 4 ? 'hidden needle and needle' : 'ok' }] }, status: 'complete' };
    return { type: 'toolCall', id, name: 'bash', arguments: tools[id].args };
  });
  const messages = [row('user', 'user', 'needle question'), row('work', 'assistant', [{ type: 'thinking', thinking: 'private needle reasoning' }, ...calls]), row('answer', 'assistant', [{ type: 'text', text: 'final needle answer' }])];
  const entries = buildTranscriptEntries(messages, tools).entries;
  const sources = buildFindSources(entries);
  const matches = findMatches(sources, 'needle');
  assert.equal(matches.length, 5);
  const output = matches.filter(match => match.source.text.includes('hidden needle'));
  assert.equal(output.length, 2);
  assert.equal(output[1].occurrence, 1);
  assert.ok(output[0].source.reveal.some(identity => identity.includes('process')));
  assert.ok(matches.some(match => match.source.text.includes('private needle')));
});
test('tool summaries, read display and subagent briefs are searchable without fetching deferred data', () => {
  const tools: ToolActivity[] = [{ id: 'read', name: 'read', args: { path: 'src/search.ts', i: 'Investigate retrieval' }, status: 'complete', result: { content: [{ type: 'text', text: '[file#ABCD]\n1:plain needle' }], details: { displayContent: { text: 'plain needle' } } } }, { id: 'task', name: 'task', status: 'complete' }];
  const sources = buildFindSources([], [{ id: 'Scout', description: 'Locate retrieval paths', parentToolCallId: 'task' }], tools);
  assert.equal(findMatches(sources, 'ABCD').length, 0);
  assert.equal(findMatches(sources, 'plain needle').length, 1);
  assert.equal(findMatches(sources, 'Investigate retrieval').length, 1);
  assert.equal(findMatches(sources, 'Scout').length, 1);
  assert.equal(findMatches(sources, 'Locate retrieval').length, 1);
});
test('navigation wraps and handles an emptied result set', () => {
  assert.equal(nextFindIndex(0, -1, 3), 2);
  assert.equal(nextFindIndex(2, 1, 3), 0);
  assert.equal(nextFindIndex(0, 1, 0), -1);
});
test('non-text messages retain focus anchors without producing phantom matches', () => {
  const entries = buildTranscriptEntries([row('image', 'user', [{ type: 'image', data: 'abc', mimeType: 'image/png' }])], {}).entries;
  const sources = buildFindSources(entries);
  assert.equal(sources[0].messageId, 'image');
  assert.equal(findMatches(sources, 'abc').length, 0);
});
test('translated tool verbs are searchable', () => {
  const tool: ToolActivity = { id: 'call', name: 'bash', status: 'complete', args: { command: 'pwd' } };
  const sources = buildFindSources([], [], [tool], () => '执行');
  assert.equal(findMatches(sources, '执行').length, 1);
});

test('chunked literal search preserves matches crossing text windows and cancellation', async () => {
  const source = { id: 'large', entryId: 'turn', messageId: 'message', reveal: [], text: 'x'.repeat(32767) + 'needle' + 'x'.repeat(32767) + 'needle' };
  assert.deepEqual(await findMatchesChunked([source], 'needle', new AbortController().signal), findMatches([source], 'needle'));
  const cancelled = new AbortController(); cancelled.abort();
  assert.deepEqual(await findMatchesChunked([source], 'needle', cancelled.signal), []);
});

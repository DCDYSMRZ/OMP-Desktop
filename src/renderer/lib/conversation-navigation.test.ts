import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConversationMinimapMarkers, minimapPreview } from './conversation-minimap';
import { createReadingAnchor, readingAnchorAdjustment, readingAnchorMessageIds, recallReadingPosition, rememberReadingPosition } from './transcript-reading-position';

test('navigation snippets remove markdown without discarding code or link labels', () => {
  assert.equal(minimapPreview('## **Answer**\n[Read the file](https://example.com) and *continue*.\n```ts\nconst snake_case = 42;\n```'), 'Answer\nRead the file and continue.\nconst snake_case = 42;');
  assert.equal(minimapPreview('one\ntwo\nthree\nfour\nfive'), 'one\ntwo\nthree\nfour');
});

test('separate projected answers retain their own navigation targets', () => {
  assert.deepEqual(buildConversationMinimapMarkers([
    { id: 'a', role: 'assistant', content: '**First answer**' },
    { id: 'boundary', role: 'custom', content: 'Context reset' },
    { id: 'b', role: 'assistant', content: 'Second answer' },
  ]), [
    { id: 'a', role: 'assistant', preview: 'First answer' },
    { id: 'b', role: 'assistant', preview: 'Second answer' },
  ]);
});

test('reading memory separates sessions and evicts the least recently visited', () => {
  for (let index = 0; index < 64; index++) rememberReadingPosition(`navigation-test:${index}`, { scrollTop: index * 100, following: index === 63, anchors: [] });
  assert.deepEqual(recallReadingPosition('navigation-test:0'), { scrollTop: 0, following: false, anchors: [] });
  rememberReadingPosition('navigation-test:new', { scrollTop: 9000, following: true, anchors: [] });
  assert.equal(recallReadingPosition('navigation-test:1'), undefined);
  assert.equal(recallReadingPosition('navigation-test:0')?.following, false);
  assert.equal(recallReadingPosition('navigation-test:63')?.scrollTop, 6300);
  assert.equal(recallReadingPosition('navigation-test:new')?.following, true);
});

test('history paging restores visible durable rows and their enclosing turn, not fragment keys', () => {
  const position = { scrollTop: 4500, following: false, anchors: [
    { id: 'row-40:block:2', attribute: 'data-presentation-key' as const, top: 8 },
    { id: 'row-12', attribute: 'data-minimap-id' as const, top: -400 },
    { id: 'row-40', attribute: 'data-message-id' as const, top: 8 },
  ] };
  assert.deepEqual(readingAnchorMessageIds(position), ['row-12', 'row-40']);
  assert.deepEqual(readingAnchorMessageIds({ ...position, following: true }), []);
  assert.deepEqual(readingAnchorMessageIds({ ...position, anchors: [position.anchors[1], position.anchors[1]] }), ['row-12']);
  assert.deepEqual(readingAnchorMessageIds({ ...position, anchors: [position.anchors[0]] }), []);
});

test('a final response and its enclosing turn never share a reading element identity', () => {
  const response = createReadingAnchor({ presentationKey: 'answer:block:0', messageId: 'answer', turnId: 'turn-start' }, 20)!;
  const turn = createReadingAnchor({ minimapId: 'turn-start', messageId: 'answer', turnId: 'turn-start' }, -484)!;
  // The former message-ID lookup selected the turn first: 551 - 504 = 47.
  assert.equal(551 + readingAnchorAdjustment([response], [turn, response])!, 551);
  assert.deepEqual(readingAnchorMessageIds({ scrollTop: 551, following: false, anchors: [response] }), ['answer', 'turn-start']);
});

test('stage restoration retains its offset through partial layout until the reader chooses a new one', () => {
  const saved = createReadingAnchor({ presentationKey: 'task-2:block:0', turnId: 'turn-start' }, 24)!;
  const interim = { ...saved, top: -76 };
  const settled = { ...saved, top: 124 };
  assert.equal(readingAnchorAdjustment([saved], [interim]), -100);
  assert.equal(readingAnchorAdjustment([saved], [settled]), 100);
  assert.equal(readingAnchorAdjustment([{ ...saved, top: 54 }], [settled]), 70);
  assert.deepEqual(readingAnchorMessageIds({ scrollTop: 551, following: false, anchors: [saved] }), ['turn-start']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscriptEntries } from './presentation';
import { unchangedHistoryEntry } from './history-entry-cache';
import type { ChatMessage } from './model';

test('unchanged history can reuse rendering but changed tool outcomes and regrouped rows cannot', () => {
  const rows: ChatMessage[] = [{ id: 'call', source: 'history', streaming: false, raw: { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: { path: 'a' } }] } }, { id: 'answer', source: 'history', streaming: false, raw: { role: 'assistant', content: 'Answer' } }];
  const tool = { id: 't', name: 'read', status: 'complete' as const, result: 'original' };
  const first = buildTranscriptEntries(rows, { t: tool }).entries[0];
  assert.equal(unchangedHistoryEntry(first, buildTranscriptEntries(rows, { t: tool }).entries[0]), true);
  assert.equal(unchangedHistoryEntry(first, buildTranscriptEntries(rows, { t: { ...tool, result: 'updated', status: 'error' } }).entries[0]), false);
  assert.equal(unchangedHistoryEntry(first, buildTranscriptEntries([{ ...rows[0], raw: { ...rows[0].raw, content: 'Earlier narration' } }, ...rows], { t: tool }).entries[0]), false);
  assert.equal(unchangedHistoryEntry(first, buildTranscriptEntries([rows[0]], { t: tool }).entries[0]), false);
});

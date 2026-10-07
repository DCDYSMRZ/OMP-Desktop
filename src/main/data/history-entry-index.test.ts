import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryEntryIndex } from './history-entry-index';

test('recorded selection stays indexed on a 100k-entry ancestry without a thinking change', async t => {
  const index = new HistoryEntryIndex();
  try {
    for (let i = 0; i < 100000; i++) index.set(String(i), { id: String(i), parentId: i ? String(i - 1) : null, type: 'message', role: i ? 'user' : 'assistant', timestamp: '', preview: '', offset: i, length: 1, visible: true });
    index.finish();
    await index.select('99999');
    const start = performance.now();
    const selection = index.selectionEntries();
    const elapsed = performance.now() - start;
    assert.deepEqual(selection.map(entry => entry.id), ['0']);
    assert.ok(elapsed < 200, `Recorded selection took ${elapsed.toFixed(2)} ms`);
    t.diagnostic(`100k-entry recorded selection: ${elapsed.toFixed(2)} ms`);
    index.set('thinking', { id: 'thinking', parentId: '99999', type: 'thinking_level_change', timestamp: '', preview: '', offset: 100000, length: 1, visible: false });
    await index.select('thinking');
    assert.deepEqual(index.selectionEntries().map(entry => entry.id), ['0', 'thinking']);
    await index.select('99999');
    assert.deepEqual(index.selectionEntries().map(entry => entry.id), ['0']);
  } finally { index.close(); }
});

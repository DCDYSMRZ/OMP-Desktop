import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopApi, HistorySnapshot } from '../../shared/contracts';
import { recallReadingPosition, rememberReadingPosition } from '../lib/transcript-reading-position';
import { HistoryStore } from './history-store';

function snapshot(path: string, ids: string[], before?: string, revision = 'r1'): HistorySnapshot {
  return {
    session: { id: path, path, cwd: '/workspace', title: path, preview: '', updatedAt: '', sourceKind: 'journal', writable: false, canFork: true },
    revision, leafId: 'leaf', selectedLeafId: 'leaf',
    messages: ids.map(id => ({ id, raw: { role: 'user', content: id } })),
    hasMore: before !== undefined, nextBefore: before, diagnostics: [], access: { status: 'idle', checkedAt: 0 },
  };
}

test('returning to a paged-up session rebuilds its durable reading window before publication', async () => {
  const path = '/reading-restore-a';
  let latest = snapshot(path, ['5', '6'], '5');
  const pages = new Map([['7', snapshot(path, ['5', '6'], '5')], ['5', snapshot(path, ['3', '4'], '3')]]);
  const store = new HistoryStore({
    watchHistory: async ({ path: requested }) => requested === path ? latest : snapshot(requested, ['b']),
    readHistory: async ({ before }) => { const page = pages.get(before!); assert.ok(page, `Unexpected page ${before}`); return page; },
  } as DesktopApi);
  await store.select({ path });
  await store.older();
  const position = { scrollTop: 400, following: false, anchors: [{ id: '3', attribute: 'data-message-id' as const, top: 12 }] };
  rememberReadingPosition(`history:${path}:${path}`, position);
  await store.select({ path: '/reading-restore-b' });
  latest = snapshot(path, ['7', '8'], '7');
  const published: string[][] = [];
  const detach = store.subscribe(() => {
    const view = store.getSnapshot();
    if (view?.options.path === path && view.chat) published.push(view.chat.messages.map(row => row.id));
  });
  await store.select({ path });
  detach();
  assert.deepEqual(published, [['3', '4', '5', '6', '7', '8']]);
  assert.deepEqual(recallReadingPosition(`history:${path}:${path}`), position);
});

test('a disappeared durable anchor falls back to latest only after consistent history is exhausted', async () => {
  const path = '/reading-restore-missing';
  const latest = snapshot(path, ['5', '6'], '5');
  rememberReadingPosition(`history:${path}:${path}`, { scrollTop: 400, following: false, anchors: [{ id: 'removed', attribute: 'data-message-id', top: 12 }] });
  const store = new HistoryStore({
    watchHistory: async () => latest,
    readHistory: async () => snapshot(path, ['1', '2']),
  } as unknown as DesktopApi);
  await store.select({ path });
  assert.deepEqual(store.getSnapshot()?.chat?.messages.map(row => row.id), ['5', '6']);
  assert.deepEqual(recallReadingPosition(`history:${path}:${path}`), { scrollTop: 0, following: true, anchors: [] });
});

test('a revision change while restoring pages cannot discard the saved reading anchor', async () => {
  const path = '/reading-restore-revision';
  const position = { scrollTop: 400, following: false, anchors: [{ id: '3', attribute: 'data-message-id' as const, top: 12 }] };
  rememberReadingPosition(`history:${path}:${path}`, position);
  const store = new HistoryStore({
    watchHistory: async () => snapshot(path, ['5', '6'], '5'),
    readHistory: async () => snapshot(path, ['1', '2'], undefined, 'r2'),
  } as unknown as DesktopApi);
  await store.select({ path });
  assert.equal(store.getSnapshot()?.chat, null);
  assert.equal(store.getSnapshot()?.loading, false);
  assert.deepEqual(recallReadingPosition(`history:${path}:${path}`), position);
});

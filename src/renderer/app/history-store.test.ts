import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopApi, HistorySnapshot } from '../../shared/contracts';
import { recallReadingPosition, rememberReadingPosition } from '../lib/transcript-reading-position';
import { HistoryStore } from './history-store';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryReader } from '../../main/data/journal';
import { savedComposerMode } from './composer-mode';
import { ComposerDraft } from '../chat/composer/drafts';
import { UserFacingError } from '../lib/user-errors';

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
  assert.deepEqual(published[0], ['3', '4', '5', '6']);
  assert.deepEqual(store.getSnapshot()?.chat?.messages.map(row => row.id), ['3', '4', '5', '6', '7', '8']);
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

test('saved source failures preserve separately observed ownership and native diagnostics', async () => {
  let listener!: Parameters<DesktopApi['onHistoryEvent']>[0];
  const store = new HistoryStore({
    onHistoryEvent: callback => { listener = callback; return () => {}; },
    watchHistory: async (_options: Parameters<DesktopApi['watchHistory']>[0]): Promise<HistorySnapshot> => ({ ...snapshot('/source', ['message']), access: { status: 'external', reason: 'Other native writer', checkedAt: 4 } }),
    unwatchHistory: async () => {},
  } as DesktopApi);
  store.connect();
  await store.select({ path: '/source' });
  listener({ kind: 'error', path: '/source', error: 'Malformed native journal at line 3' });
  assert.equal(store.getSnapshot()?.access?.status, 'external');
  assert.equal(store.getSnapshot()?.error, 'Malformed native journal at line 3');
  assert.equal(store.getSnapshot()?.chat?.messages[0].id, 'message');
});

test('clearing a removed saved source rejects its late watch completion and preserves the next selection', async () => {
  const { promise: pending, resolve: finish } = Promise.withResolvers<HistorySnapshot>();
  const started = Promise.withResolvers<void>();
  const store = new HistoryStore({ watchHistory: async ({ path }) => { if (path === '/removed') { started.resolve(); return pending; } return snapshot(path, ['kept']); }, unwatchHistory: async () => {} } as DesktopApi);
  const removed = store.select({ path: '/removed' });
  await started.promise;
  store.clear();
  const other = store.select({ path: '/other' });
  finish(snapshot('/removed', ['stale']));
  await Promise.all([removed, other]);
  assert.equal(store.getSnapshot()?.options.path, '/other');
  assert.deepEqual(store.getSnapshot()?.chat?.messages.map(row => row.id), ['kept']);
});

test('explicit Latest reads newest page instead of restoring an older reading window', async () => {
  const path = '/explicit-latest';
  const store = new HistoryStore({
    watchHistory: async ({ path: requested }: Parameters<DesktopApi['watchHistory']>[0]): Promise<HistorySnapshot> => snapshot(requested, ['old']),
    readHistory: async options => { assert.equal(options.before, undefined); assert.equal(options.anchorId, undefined); return snapshot(path, ['new'], 'new'); },
  } as DesktopApi);
  await store.select({ path });
  rememberReadingPosition(`history:${path}:${path}`, { scrollTop: 200, following: false, anchors: [{ id: 'old', attribute: 'data-message-id', top: 4 }] });
  await store.latest();
  assert.deepEqual(store.getSnapshot()?.chat?.messages.map(row => row.id), ['new']);
  assert.equal(recallReadingPosition(`history:${path}:${path}`)?.following, true);
});

test('a saved Latest superseded by a watcher preserves the reading anchor and rejects navigation', async () => {
  const path = '/latest-watcher-race';
  const deferred = Promise.withResolvers<HistorySnapshot>();
  let listener!: Parameters<DesktopApi['onHistoryEvent']>[0];
  const store = new HistoryStore({
    watchHistory: async (options: Parameters<DesktopApi['watchHistory']>[0]): Promise<HistorySnapshot> => snapshot(options.path, ['old']),
    readHistory: async (_options: Parameters<DesktopApi['readHistory']>[0]): Promise<HistorySnapshot> => deferred.promise,
    onHistoryEvent: (callback: Parameters<DesktopApi['onHistoryEvent']>[0]) => { listener = callback; return () => { listener = () => {}; }; },
  } as DesktopApi);
  store.connect();
  await store.select({ path });
  const position = { scrollTop: 200, following: false, anchors: [{ id: 'old', attribute: 'data-message-id' as const, top: 4 }] };
  rememberReadingPosition(`history:${path}:${path}`, position);
  const latest = store.latest();
  const rejected = assert.rejects(latest);
  listener({ kind: 'snapshot', path, snapshot: snapshot(path, ['old', 'watcher']) });
  deferred.resolve(snapshot(path, ['requested-latest']));
  await rejected;
  assert.deepEqual(store.getSnapshot()?.chat?.messages.map(row => row.id), ['old', 'watcher']);
  assert.deepEqual(recallReadingPosition(`history:${path}:${path}`), position);
});

test('message search landing can page older without reusing its exclusive anchor cursor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-anchor-paging-'));
  const path = join(root, 'session.jsonl');
  const reader = new HistoryReader();
  try {
    const rows = [{ type: 'session', version: 3, id: 'search-landing', cwd: root }, ...Array.from({ length: 500 }, (_, i) => ({ type: 'message', id: `m${i}`, parentId: i ? `m${i - 1}` : null, message: { role: 'user', content: `Saved message ${i}` } }))];
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const read = async (options: Parameters<DesktopApi['readHistory']>[0]): Promise<HistorySnapshot> => ({ ...await reader.read(options, root), access: { status: 'idle', checkedAt: 0 } });
    const store = new HistoryStore({ watchHistory: read, readHistory: read } as DesktopApi);
    await store.select({ path, leafId: 'm499', anchorId: 'm300' });
    assert.equal(store.getSnapshot()?.error, '');
    assert.ok(store.getSnapshot()?.snapshot?.messages.some(message => message.entryId === 'm300'));
    const before = store.getSnapshot()!.snapshot!.messages[0]!.entryId!;
    await store.older();
    assert.equal(store.getSnapshot()?.error, '');
    assert.notEqual(store.getSnapshot()?.snapshot?.messages[0]?.entryId, before);
    assert.ok(store.getSnapshot()?.snapshot?.messages.some(message => message.entryId === 'm300'));
  } finally { reader.close(); await rm(root, { recursive: true, force: true }); }
});

test('budgeted prepends preserve chronology, existing identities and one in-flight request', async () => {
  const path = '/chunked-history';
  const newest = snapshot(path, ['61', '62'], 'older');
  const older = snapshot(path, Array.from({ length: 60 }, (_, index) => String(index + 1)));
  let reads = 0;
  const store = new HistoryStore({ watchHistory: async () => newest, unwatchHistory: async () => {}, readHistory: async () => { reads++; return older; } } as unknown as DesktopApi);
  await store.select({ path });
  const retained = store.getSnapshot()!.chat!.messages[0];
  const published: string[][] = [];
  const detach = store.subscribe(() => { const state = store.getSnapshot(); if (state?.chat && state.chat.messages.length > 2) published.push(state.chat.messages.map(row => row.id)); });
  const pending = store.older();
  await store.older();
  await pending;
  detach();
  assert.equal(reads, 1);
  const expected = Array.from({ length: 62 }, (_, index) => String(index + 1));
  for (const rows of published) assert.deepEqual(rows, expected.slice(-rows.length));
  assert.deepEqual(store.getSnapshot()!.chat!.messages.map(row => row.id), expected);
  assert.equal(store.getSnapshot()!.chat!.messages.at(-2), retained);
  assert.equal(store.getSnapshot()!.snapshot!.hasMore, false);
  assert.equal(store.getSnapshot()!.paging, false);
});

test('external observation drives live tools but pinned history never follows activity', async () => {
  const latest = snapshot('/observed', ['request']);
  latest.activity = { state: 'running', owner: 'external', source: 'journal', confidence: 'inferred', currentTool: { toolCallId: 'read', name: 'read', intent: 'Reading configuration' } };
  const store = new HistoryStore({ watchHistory: async () => latest } as unknown as DesktopApi);
  await store.select({ path: '/observed' });
  assert.equal(store.getSnapshot()?.chat?.isRunning, true);
  assert.equal(store.getSnapshot()?.chat?.isSettled, false);
  assert.equal(store.getSnapshot()?.chat?.tools.read.status, 'running');
  assert.equal(store.getSnapshot()?.chat?.state.observedSource, 'external');
  latest.activity = { ...latest.activity, state: 'stale' };
  await store.select({ path: '/observed' });
  assert.equal(store.getSnapshot()?.chat?.isRunning, false);
  assert.equal(store.getSnapshot()?.chat?.isSettled, false);
  latest.activity = { ...latest.activity, state: 'running' };
  await store.select({ path: '/observed', leafId: 'leaf' });
  assert.equal(store.getSnapshot()?.chat?.isRunning, false);
  assert.equal(store.getSnapshot()?.chat?.state.observedSource, undefined);
});

test('presence streams through existing assistant rows then yields to persisted identity without duplication', async () => {
  let listener!: Parameters<DesktopApi['onHistoryEvent']>[0];
  const initial = snapshot('/presence', ['user']);
  const store = new HistoryStore({ watchHistory: async () => initial, onHistoryEvent: (callback: Parameters<DesktopApi['onHistoryEvent']>[0]) => { listener = callback; return () => {}; }, unwatchHistory: async () => {} } as unknown as DesktopApi);
  store.connect(); await store.select({ path: '/presence' });
  const activity = { state: 'running', source: 'presence', confidence: 'exact', owner: 'external', requestStartedAt: 1000 } as const;
  const tail = { id: 'live:1', startedAt: 1100, ended: false, content: [{ type: 'text', text: 'Live answer' }] } as const;
  listener({ kind: 'presence', path: '/presence', activity, liveTail: [{ ...tail, content: [...tail.content] }] });
  assert.equal(store.getSnapshot()?.chat?.messages.at(-1)?.streaming, true);
  assert.equal(store.getSnapshot()?.chat?.state.observedActivity, activity);
  listener({ kind: 'presence', path: '/presence', activity, liveTail: [{ ...tail, content: [...tail.content], ended: true }] });
  listener({ kind: 'snapshot', path: '/presence', snapshot: { ...initial, revision: 'r2', activity, liveTail: [], messages: [...initial.messages, { id: 'durable', raw: { role: 'assistant', content: [...tail.content] } }] } });
  const rows = store.getSnapshot()!.chat!.messages;
  assert.deepEqual(rows.map(row => row.id), ['user', 'durable']);
  assert.equal(rows[1].presentation?.id, 'live:1');
  assert.equal(rows[1].streaming, false);
});

test('cached history paints immediately but never reuses another branch or its error', async () => {
  let fail = false;
  const store = new HistoryStore({ watchHistory: async ({ path }) => { if (fail) throw new Error('unreadable'); return snapshot(path, ['saved']); } } as DesktopApi);
  await store.select({ path: '/cached' });
  const cached = store.getSnapshot()!.chat;
  await store.select({ path: '/other' });
  fail = true;
  const selecting = store.select({ path: '/cached' });
  assert.equal(store.getSnapshot()?.chat, cached);
  await selecting;
  assert.equal(store.getSnapshot()?.error, 'unreadable');
  const branch = store.select({ path: '/cached', leafId: 'different' });
  assert.equal(store.getSnapshot()?.chat, null);
  assert.equal(store.getSnapshot()?.error, '');
  await branch;
  fail = false;
  await store.select({ path: '/other' });
  assert.equal(store.getSnapshot()?.error, '');
});

test('switching from a deleted source restores cached reading state without blocking a readable session', async () => {
  const path = '/retained-access';
  const readable = (ids: string[], before?: string) => { const result = snapshot(path, ids, before); result.session.writable = true; return result; };
  let latest = readable(['oldest'], 'older');
  let listener!: Parameters<DesktopApi['onHistoryEvent']>[0];
  const store = new HistoryStore({
    watchHistory: async ({ path: selected }) => { if (selected === '/deleted') throw new Error('ENOENT deleted source'); return latest; },
    readHistory: async ({ before }) => readable([before!], before + '-previous'),
    onHistoryEvent: callback => { listener = callback; return () => {}; },
  } as DesktopApi);
  store.connect();
  await store.select({ path });
  const chat = store.getSnapshot()!.chat;
  rememberReadingPosition(`history:${path}:${path}`, { scrollTop: 120, following: false, anchors: [{ id: 'oldest', attribute: 'data-message-id', top: 0 }] });
  await store.select({ path: '/deleted' });
  assert.equal(savedComposerMode(store.getSnapshot()!).category, 'source-unavailable');
  latest = readable(['newest'], 'middle');
  await store.select({ path });
  listener({ kind: 'error', path: '/deleted', error: 'late deleted source error' });
  assert.equal(store.getSnapshot()!.chat, chat);
  assert.equal(store.getSnapshot()!.snapshot!.messages[0]!.id, 'oldest');
  assert.equal(store.getSnapshot()!.error, '');
  assert.equal(savedComposerMode(store.getSnapshot()!).category, 'ready');
  assert.equal(savedComposerMode(store.getSnapshot()!).ready, true);
});

test('selected saved access resolves independently and preserves genuinely inconclusive reasons', async () => {
  const free = snapshot('/free', ['saved']); free.session.writable = true;
  const uncertain = snapshot('/uncertain', ['other']); uncertain.session.writable = true;
  uncertain.access = { status: 'unknown', checkedAt: 1, reason: 'A native terminal has missing or stale session evidence.' };
  let listener!: Parameters<DesktopApi['onHistoryEvent']>[0];
  const selected = Promise.withResolvers<HistorySnapshot>();
  const store = new HistoryStore({
    watchHistory: async ({ path }) => path === '/uncertain' ? uncertain : selected.promise,
    onHistoryEvent: callback => { listener = callback; return () => {}; },
  } as DesktopApi);
  store.connect();
  await store.select({ path: '/uncertain' });
  assert.equal(savedComposerMode(store.getSnapshot()!).category, 'unknown');
  assert.equal(store.getSnapshot()!.access?.reason, uncertain.access.reason);
  const opening = store.select({ path: '/free' });
  assert.equal(savedComposerMode(store.getSnapshot()!).category, 'checking');
  assert.equal(store.getSnapshot()!.access, undefined);
  selected.resolve(free); await opening;
  assert.equal(savedComposerMode(store.getSnapshot()!).ready, true);
  listener({ kind: 'access', path: '/uncertain', access: uncertain.access });
  assert.equal(savedComposerMode(store.getSnapshot()!).ready, true);
  listener({ kind: 'access', path: '/free', access: { status: 'external', checkedAt: 2, reason: 'Another omp process has this session open.' } });
  assert.equal(savedComposerMode(store.getSnapshot()!).category, 'external');
  assert.equal(savedComposerMode(store.getSnapshot()!).ready, false);
});

test('history paints while admission is pending and an early access event survives the snapshot', async () => {
  const page = snapshot('/pending', ['readable']); page.session.writable = true;
  page.access = { status: 'unknown', pending: true, checkedAt: 0 };
  let listener!: Parameters<DesktopApi['onHistoryEvent']>[0];
  let early = false;
  const store = new HistoryStore({
    watchHistory: async () => { if (early) listener({ kind: 'access', path: '/pending', access: { status: 'external', checkedAt: 2 } }); return page; },
    onHistoryEvent: (callback: Parameters<DesktopApi['onHistoryEvent']>[0]) => { listener = callback; return () => {}; },
  } as unknown as DesktopApi);
  store.connect();
  await store.select({ path: '/pending' });
  assert.equal(store.getSnapshot()!.chat!.messages[0].id, 'readable');
  assert.equal(savedComposerMode(store.getSnapshot()!).category, 'checking');
  assert.equal(savedComposerMode(store.getSnapshot()!).ready, false);
  listener({ kind: 'access', path: '/pending', access: { status: 'idle', checkedAt: 1 } });
  assert.equal(savedComposerMode(store.getSnapshot()!).ready, true);
  early = true; await store.select({ path: '/pending' });
  assert.equal(savedComposerMode(store.getSnapshot()!).category, 'external');
});

for (const phase of ['read', 'publish'] as const) test(`watch metadata during older-page ${phase} cannot discard the prepend`, async () => {
  const path = `/prepend-watch-${phase}`;
  const latest = snapshot(path, ['25', '26'], 'older');
  const page = snapshot(path, Array.from({ length: 24 }, (_, i) => String(i + 1)));
  const deferred = Promise.withResolvers<HistorySnapshot>();
  let listener!: Parameters<DesktopApi['onHistoryEvent']>[0];
  const store = new HistoryStore({
    watchHistory: async () => latest,
    readHistory: async () => deferred.promise,
    onHistoryEvent: (callback: Parameters<DesktopApi['onHistoryEvent']>[0]) => { listener = callback; return () => {}; },
  } as unknown as DesktopApi);
  store.connect(); await store.select({ path });
  let replaced = false;
  const replace = () => { replaced = true; listener({ kind: 'snapshot', path, snapshot: { ...latest, session: { ...latest.session, title: 'Updated metadata' } } }); };
  const detach = store.subscribe(() => { if (phase === 'publish' && !replaced && store.getSnapshot()!.snapshot!.messages.length > 2) replace(); });
  const pending = store.older();
  if (phase === 'read') replace();
  deferred.resolve(page); await pending; detach();
  assert.deepEqual(store.getSnapshot()!.snapshot!.messages.map(message => message.id), Array.from({ length: 26 }, (_, i) => String(i + 1)));
  assert.equal(store.getSnapshot()!.snapshot!.session.title, 'Updated metadata');
  assert.equal(store.getSnapshot()!.paging, false);
});

test('a deferred new revision preserves the completed prepend and new tail', async () => {
  const path = '/prepend-revision';
  const initial = snapshot(path, ['3', '4'], 'older');
  const updated = snapshot(path, ['3', '4', '5'], 'older-new', 'r2');
  const pendingPage = Promise.withResolvers<HistorySnapshot>();
  let listener!: Parameters<DesktopApi['onHistoryEvent']>[0];
  let reads = 0;
  const store = new HistoryStore({
    watchHistory: async () => initial,
    readHistory: async () => ++reads === 1 ? pendingPage.promise : snapshot(path, ['1', '2'], undefined, 'r2'),
    onHistoryEvent: (callback: Parameters<DesktopApi['onHistoryEvent']>[0]) => { listener = callback; return () => {}; },
  } as unknown as DesktopApi);
  store.connect(); await store.select({ path });
  const pending = store.older();
  listener({ kind: 'snapshot', path, snapshot: updated });
  pendingPage.resolve(snapshot(path, ['1', '2']));
  await pending;
  assert.deepEqual(store.getSnapshot()!.snapshot!.messages.map(message => message.id), ['1', '2', '3', '4', '5']);
  assert.equal(store.getSnapshot()!.snapshot!.revision, 'r2');
  assert.equal(store.getSnapshot()!.paging, false);
});

for (const status of ['idle', 'external', 'unknown'] as const) test(`Enter during saved admission resolves ${status} without losing or duplicating input`, async () => {
  const path = `/pending-send-${status}`;
  const page = snapshot(path, ['saved']); page.session.writable = true;
  page.access = { status: 'unknown', pending: true, checkedAt: 0 };
  let listener!: Parameters<DesktopApi['onHistoryEvent']>[0];
  const store = new HistoryStore({
    watchHistory: async () => page,
    onHistoryEvent: (callback: Parameters<DesktopApi['onHistoryEvent']>[0]) => { listener = callback; return () => {}; },
  } as unknown as DesktopApi);
  store.connect(); await store.select({ path });
  const draft = new ComposerDraft();
  draft.setDraft({ text: 'Continue this saved session', attachments: [], references: [] });
  let sends = 0;
  const send = () => draft.submit(async () => {
    const resolved = await store.waitForAccess();
    if (!savedComposerMode(resolved).ready) throw new UserFacingError('Sending is blocked', resolved.access?.reason);
    sends++;
  });
  const first = send(); await send();
  assert.equal(draft.getSnapshot().pending?.text, 'Continue this saved session');
  assert.equal(sends, 0);
  const reason = status === 'external' ? 'Another terminal owns the session' : 'Session ownership is inconclusive';
  listener({ kind: 'access', path, access: { status, checkedAt: 1, reason } });
  await first;
  assert.equal(sends, status === 'idle' ? 1 : 0);
  assert.equal(draft.getSnapshot().pending, undefined);
  assert.equal(draft.draft.text, status === 'idle' ? '' : 'Continue this saved session');
  if (status !== 'idle') {
    assert.ok(draft.getSnapshot().error instanceof UserFacingError);
    assert.equal((draft.getSnapshot().error as UserFacingError).technicalDetails, reason);
  }
});

for (const activity of [undefined, { state: 'unknown' as const, owner: 'unknown' as const, source: 'journal' as const, confidence: 'inferred' as const }]) test(`incremental prepends equal full projection with ${activity?.state ?? 'idle'} observation and cross-boundary tools`, async () => {
  const path = '/projection-equality';
  const raw = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'a' } }] },
    { role: 'toolResult', toolCallId: 'a', content: 'ok' },
    { role: 'toolResult', toolCallId: 'b', toolName: 'bash', isError: true, content: 'failed' },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'b', name: 'retry', arguments: { command: 'x' } }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'first', arguments: { old: true } }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'second' }] },
    { role: 'toolResult', toolCallId: 'c', content: 'done' },
    { role: 'assistant', content: 'Answer' },
  ];
  const full = snapshot(path, raw.map((_, index) => String(index)));
  full.messages = full.messages.map((message, index) => ({ ...message, raw: raw[index], resourceReference: `resource:${index}` }));
  full.activity = activity;
  for (let boundary = 1; boundary < raw.length; boundary++) {
    const initial = { ...full, messages: full.messages.slice(boundary), hasMore: true, nextBefore: 'older' };
    const older = { ...full, messages: full.messages.slice(0, boundary) };
    const incremental = new HistoryStore({ watchHistory: async () => initial, readHistory: async () => older } as unknown as DesktopApi);
    await incremental.select({ path });
    const retained = incremental.getSnapshot()!.chat!.messages.slice();
    await incremental.older();
    const reference = new HistoryStore({ watchHistory: async () => full } as unknown as DesktopApi);
    await reference.select({ path });
    assert.deepEqual(incremental.getSnapshot()!.chat, reference.getSnapshot()!.chat);
    for (let index = 0; index < retained.length; index++) assert.equal(incremental.getSnapshot()!.chat!.messages[boundary + index], retained[index]);
  }
});

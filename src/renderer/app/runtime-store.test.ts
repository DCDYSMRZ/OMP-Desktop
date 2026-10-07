import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopApi, NativeState, RuntimeAccess, RuntimeHistory, SessionConnection } from '../../shared/contracts';
import { RuntimeStore, appendToast, classifyRuntimeNotice, routeSessionPrompts, reduceInbox, type InboxState, type SessionPrompt } from './runtime-store';
import { createChatState, reduceChatFrame } from '../chat/model';
import { rememberReadingPosition } from '../lib/transcript-reading-position';

test('shown drafts start once, are adopted for send, and unsent replacements wait for disposal', async () => {
  const starts: string[] = [], closes: string[] = [], notices: string[] = [];
  const gate = Promise.withResolvers<void>();
  const store = new RuntimeStore({
    startSession: async ({cwd}: {cwd:string}): Promise<SessionConnection> => {
      starts.push(cwd);
      return {runtimeId:cwd,cwd,source:{status:'unpersisted',sessionId:cwd},state:{sessionId:cwd,isStreaming:false},messages:[],models:[],commands:[],thinkingLevels:[]};
    },
    request: () => Promise.withResolvers<never>().promise,
    closeSession: async (id:string) => {closes.push(id);await gate.promise;if(id==='/next')throw new Error('Already exited');},
  } as unknown as DesktopApi, notice=>notices.push(notice.message),()=>{});
  const first = store.showDraft('first','/first');
  assert.equal(store.showDraft('first','/first'),first);
  const record = await first;
  assert.equal(store.getDraft('first')?.runtimeId,record.runtimeId);
  store.adoptDraft('first');
  await store.releaseDraft('first');
  assert.deepEqual(closes,[]);
  assert.equal(store.getSnapshot()['/first'].closed,false);
  await store.showDraft('unsent','/unsent');
  const next = store.showDraft('next','/next');
  await Promise.resolve();
  assert.deepEqual(starts,['/first','/unsent']);
  assert.deepEqual(closes,['/unsent']);
  gate.resolve();
  await next;
  assert.equal(store.getSnapshot()['/unsent'],undefined);
  assert.deepEqual(starts,['/first','/unsent','/next']);
  store.receive({runtimeId:'/next',kind:'error',error:'Draft stopped'});
  assert.deepEqual(notices,[]);
  await store.releaseDraft('next');
  assert.deepEqual(Object.keys(store.getSnapshot()),['/first']);
  await store.showDraft('restarted','/restarted');
  assert.equal(store.getDraft('restarted')?.closed,false);
  await store.releaseDraft('restarted');
});

test('forgetting a removed runtime fences pending hydration and late blocking prompts without affecting another runtime', async () => {
  const { promise: pending, resolve: resolveState } = Promise.withResolvers<NativeState>();
  const connection: SessionConnection = { source: { status: 'unpersisted', sessionId: 'removed', path: '/removed.jsonl' }, runtimeId: 'removed', cwd: '/workspace', state: { sessionId: 'removed', sessionFile: '/removed.jsonl', isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [] };
  const api = {
    startSession: async ({ cwd }: { cwd: string }) => cwd === '/other' ? { ...connection, runtimeId: 'other', cwd, source: { status: 'unpersisted', sessionId: 'other' }, state: { sessionId: 'other', isStreaming: false } } : connection,
    request: async (id: string) => id === 'removed' ? pending : Promise.withResolvers<never>().promise,
  } as unknown as DesktopApi;
  const store = new RuntimeStore(api, () => {}, () => {});
  await store.start({ cwd: '/workspace' });
  await store.start({ cwd: '/other' });
  const refresh = store.refresh('removed');
  store.forget(['removed']);
  resolveState(connection.state);
  await refresh;
  store.receive({ runtimeId: 'removed', kind: 'frame', frame: { type: 'extension_ui_request', id: 'late', method: 'confirm', timeout: 1000 } });
  store.receive({ runtimeId: 'removed', kind: 'exit', exitCode: 0 });
  assert.deepEqual(Object.keys(store.getSnapshot()), ['other']);
  assert.deepEqual(store.startupPrompts, []);
  assert.equal(store.getSnapshot().other.closed, false);
});

test('resumed and paged history show material problems once but keep source provenance out of the transcript', async () => {
  const provenance = 'Default view follows the last persisted entry, not a verified active native leaf.';
  const source = { status: 'persisted' as const, sessionId: 'resumed', path: '/resumed.jsonl' };
  const connection: SessionConnection = { source, runtimeId: 'resumed', cwd: '/workspace', state: { sessionId: 'resumed', sessionFile: '/resumed.jsonl', isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [], historyDiagnostics: [provenance, 'Archive source is missing'] };
  const page: RuntimeHistory = { source, messages: [], hasMore: false, diagnostics: [provenance, 'Archive source is missing'] };
  const store = new RuntimeStore({ startSession: async () => connection, readRuntimeHistory: async () => page, request: async () => Promise.withResolvers<never>().promise } as unknown as DesktopApi, () => {}, () => {});
  await store.start({ cwd: '/workspace', sessionPath: '/resumed.jsonl', mode: 'resume' });
  await store.latest('resumed');
  assert.deepEqual(store.getSnapshot().resumed.chat.notices.map(notice => notice.diagnostic), ['Archive source is missing']);
});

test('recoverable observation failure preserves live work and prompts while fatal runtime errors still close the projection', async () => {
  const connection: SessionConnection = { source: { status: 'persisted', sessionId: 'observed-session', path: '/observed.jsonl' }, runtimeId: 'observed', cwd: '/workspace', state: { sessionId: 'observed-session', sessionFile: '/observed.jsonl', isStreaming: true, isSettled: false }, messages: [], models: [], commands: [], thinkingLevels: [] };
  const notices: string[] = [];
  const store = new RuntimeStore({ startSession: async () => connection, request: async () => Promise.withResolvers<never>().promise } as unknown as DesktopApi, notice => notices.push(notice.message), () => {});
  await store.start({ cwd: '/workspace' });
  store.receive({ runtimeId: 'observed', kind: 'frame', frame: { type: 'extension_ui_request', id: 'confirm', method: 'confirm', title: 'Continue?' } });
  store.receive({ runtimeId: 'observed', kind: 'frame', frame: { type: 'tool_execution_start', toolCallId: 'read', toolName: 'read', args: { path: 'fixture.txt' } } });
  store.receive({ runtimeId: 'observed', kind: 'observation_error', sessionId: 'observed-session', sourcePath: '/observed.jsonl', error: 'Native state observation changed' });
  const current = store.getSnapshot().observed;
  assert.equal(current.closed, false);
  assert.equal(current.chat.isRunning, true);
  assert.deepEqual(current.chat.prompts.map(prompt => prompt.id), ['confirm']);
  assert.equal(current.chat.tools.read.status, 'running');
  assert.equal(current.source.status, 'persisted');
  assert.deepEqual(notices, ['Native state observation changed']);
  store.receive({ runtimeId: 'observed', kind: 'observation_error', sessionId: 'old-session', sourcePath: '/observed.jsonl', error: 'Stale observation' });
  store.receive({ runtimeId: 'observed', kind: 'observation_error', sessionId: 'observed-session', sourcePath: '/old.jsonl', error: 'Stale path observation' });
  assert.deepEqual(notices, ['Native state observation changed']);
  store.receive({ runtimeId: 'observed', kind: 'error', error: 'Native transport failed' });
  assert.equal(store.getSnapshot().observed.closed, true);
  assert.deepEqual(store.getSnapshot().observed.chat.prompts, []);
  assert.equal(store.getSnapshot().observed.chat.tools.read.status, 'interrupted');
});

test('older runtime windows remain stable during live updates and Latest fetches native context', async () => {
  const source = { status: 'persisted' as const, sessionId: 'reading-session', path: '/reading.jsonl' };
  const connection: SessionConnection = { source, runtimeId: 'reading', cwd: '/workspace', state: { sessionId: source.sessionId, sessionFile: source.path, isStreaming: true }, messages: [{ role: 'user', content: 'latest input' }], messageIds: ['latest-input'], models: [], commands: [], thinkingLevels: [], history: { source, messages: [], messageIds: ['latest-input'], hasMore: true, diagnostics: [] } };
  const requests: unknown[] = [];
  const store = new RuntimeStore({
    startSession: async (_options: Parameters<DesktopApi['startSession']>[0]): Promise<SessionConnection> => connection,
    request: <T = unknown>(_id: string, _command: Parameters<DesktopApi['request']>[1]): Promise<T> => Promise.withResolvers<T>().promise,
    readRuntimeHistory: async (_id: string, options: Parameters<DesktopApi['readRuntimeHistory']>[1]): Promise<RuntimeHistory> => { requests.push(options); return { source, messages: [{ role: 'user', content: options?.beforeEntryId ? 'older input' : 'newest native input' }], messageIds: [options?.beforeEntryId ? 'older' : 'newest'], hasMore: true, diagnostics: [] }; }
  } as DesktopApi, () => {}, () => {});
  await store.start({ cwd: '/workspace' });
  await store.older('reading');
  store.receive({ runtimeId: 'reading', kind: 'frame', frame: { type: 'message_start', messageId: 'live-answer', message: { role: 'assistant', content: 'streaming now' } } });
  assert.deepEqual(store.getSnapshot().reading.chat.messages.map(row => row.raw.content), ['older input']);
  assert.equal(store.getSnapshot().reading.chat.live.messages[0].raw.content, 'streaming now');
  await store.latest('reading');
  assert.deepEqual(requests, [{ beforeEntryId: 'latest-input', leafId: undefined }, {}]);
  assert.deepEqual(store.getSnapshot().reading.chat.messages.map(row => row.raw.content), ['newest native input', 'streaming now']);
  assert.equal(store.getSnapshot().reading.historyFollowing, true);
});

test('reading an earlier row preserves native latest continuation and its loaded chronology at completion', async () => {
  const source = { status: 'persisted' as const, sessionId: 'anchored-continuation', path: '/anchored-continuation.jsonl' };
  const oldMessages = [{ role: 'user', content: 'saved request' }, { role: 'assistant', content: 'saved answer' }];
  const continued = [{ role: 'user', content: 'continued request', timestamp: 10 }, { role: 'assistant', content: 'continued answer', timestamp: 11, provider: 'native', model: 'model', stopReason: 'stop' }];
  const history: RuntimeHistory = { source, messages: oldMessages, messageIds: ['old-user', 'old-answer'], historySource: { path: source.path, leafId: 'old-answer' }, revision: 'r1', hasMore: false, diagnostics: [] };
  const connection: SessionConnection = { source, runtimeId: source.sessionId, cwd: '/workspace', state: { sessionId: source.sessionId, sessionFile: source.path, isStreaming: false }, messages: oldMessages, messageIds: history.messageIds, historySource: history.historySource, history, models: [], commands: [], thinkingLevels: [] };
  const store = new RuntimeStore({
    startSession: async () => connection,
    request: async (_id: string, command: { type: string }) => command.type === 'get_state' ? connection.state : { subagents: [] },
    getRuntimeAccess: async () => ({ source }),
    listHistorySubagents: async () => ({ subagents: [], diagnostics: [] }),
    readRuntimeHistory: async (_id: string, options: Parameters<DesktopApi['readRuntimeHistory']>[1]): Promise<RuntimeHistory> => {
      if (options?.leafId === 'old-answer' || options?.anchorId) return history;
      const latest = { ...history, historySource: { path: source.path, leafId: 'new-answer' }, revision: 'r2' };
      return options?.beforeEntryId ? { ...latest, messages: oldMessages, messageIds: history.messageIds } : { ...latest, messages: continued, messageIds: ['new-user', 'new-answer'], hasMore: true };
    },
  } as unknown as DesktopApi, () => {}, () => {});
  await store.start({ cwd: '/workspace', sessionPath: source.path, mode: 'resume' });
  await store.refresh(source.sessionId);
  store.receive({ runtimeId: source.sessionId, kind: 'frame', frame: { type: 'message_end', messageId: 'continued-user', message: continued[0] } });
  // Feed the completed assistant through the reducer without installing the
  // unrelated renderer context-usage timer.
  const current = store.getSnapshot()[source.sessionId];
  current.chat = reduceChatFrame(current.chat, { type: 'message_end', messageId: 'continued-answer', message: continued[1] });
  const liveIdentity = current.chat.messages.at(-1)!.presentation;
  const position = { scrollTop: 40, following: false, anchors: [{ id: 'old-user', attribute: 'data-message-id' as const, top: 5 }] };
  rememberReadingPosition(`${source.sessionId}:${source.sessionId}`, position);
  await store.refresh(source.sessionId, true);
  const result = store.getSnapshot()[source.sessionId];
  assert.equal(result.historyFollowing, true);
  assert.equal(result.chat.historySource?.leafId, 'new-answer');
  assert.equal(result.history?.revision, 'r2');
  assert.deepEqual(result.chat.messages.map(row => row.id), ['old-user', 'old-answer', 'new-user', 'new-answer']);
  assert.deepEqual(result.chat.messages.map(row => row.raw.content), ['saved request', 'saved answer', 'continued request', 'continued answer']);
  assert.deepEqual(result.chat.messages.at(-1)!.presentation, liveIdentity);
  await store.older(source.sessionId, 'new-user');
  assert.equal(store.getSnapshot()[source.sessionId].historyFollowing, false);
  assert.deepEqual(store.getSnapshot()[source.sessionId].chat.messages.map(row => row.id), ['old-user', 'old-answer']);
});

test('an anchored background refresh supersedes Latest without reporting navigation success', async () => {
  const source = { status: 'persisted' as const, sessionId: 'latest-race', path: '/latest-race.jsonl' };
  const state: NativeState = { sessionId: source.sessionId, sessionFile: source.path, isStreaming: false };
  const connection: SessionConnection = { source, runtimeId: 'latest-race', cwd: '/workspace', state, messages: [{ role: 'user', content: 'old' }], messageIds: ['old'], models: [], commands: [], thinkingLevels: [] };
  const stateGate = Promise.withResolvers<void>();
  const latestPage = Promise.withResolvers<RuntimeHistory>();
  const anchored = Promise.withResolvers<void>();
  const store = new RuntimeStore({
    startSession: async (_options: Parameters<DesktopApi['startSession']>[0]): Promise<SessionConnection> => connection,
    request: async <T = unknown>(_id: string, command: Parameters<DesktopApi['request']>[1]): Promise<T> => {
      if (command.type === 'get_state') { await stateGate.promise; return state as T; }
      if (command.type === 'get_subagents') return { subagents: [] } as T;
      throw new Error(`Unexpected native request ${command.type}`);
    },
    getRuntimeAccess: async (_id: string): Promise<RuntimeAccess> => ({ source, status: 'owned', checkedAt: 1, canSend: true, canFork: true }),
    readRuntimeHistory: async (_id: string, options: Parameters<DesktopApi['readRuntimeHistory']>[1]): Promise<RuntimeHistory> => {
      if (!options?.anchorId && !options?.beforeEntryId) return latestPage.promise;
      if (options.anchorId) anchored.resolve();
      return { source, messages: [{ role: 'user', content: 'older window' }], messageIds: ['older'], hasMore: true, diagnostics: [] };
    },
  } as DesktopApi, () => {}, () => {});
  await store.start({ cwd: '/workspace' });
  await store.older('latest-race', 'old');
  const latest = store.latest('latest-race');
  const rejected = assert.rejects(latest);
  const refresh = store.refresh('latest-race', true);
  stateGate.resolve();
  await anchored.promise;
  await refresh;
  latestPage.resolve({ source, messages: [{ role: 'user', content: 'newest' }], messageIds: ['newest'], hasMore: false, diagnostics: [] });
  await rejected;
  assert.equal(store.getSnapshot()['latest-race'].historyFollowing, false);
  assert.deepEqual(store.getSnapshot()['latest-race'].chat.messages.map(row => row.raw.content), ['older window']);
});

test('pending prompts route only to the selected runtime and local dismissal is runtime-scoped', () => {
  const prompts: SessionPrompt[] = [
    { runtimeId: 'B', request: { type: 'extension_ui_request', id: 'shared', method: 'confirm' } },
    { runtimeId: 'B', request: { type: 'extension_ui_request', id: 'next', method: 'input' } },
    { runtimeId: 'A', request: { type: 'extension_ui_request', id: 'shared', method: 'confirm' } },
  ];
  assert.equal(routeSessionPrompts(prompts, 'A', new Set()).prompt?.runtimeId, 'A');
  assert.equal(routeSessionPrompts(prompts, null, new Set()).prompt, undefined);
  const routed = routeSessionPrompts(prompts, 'B', new Set(['B:shared']));
  assert.equal(routed.prompt?.request.id, 'next');
  assert.deepEqual([...routed.counts], [['B', 1], ['A', 1]]);
  assert.equal(routeSessionPrompts(prompts, 'B', new Set(['B:shared', 'B:next'])).prompt, undefined);
});

test('native user interrupts are expected but unexpected aborts and transport errors remain notices', () => {
  assert.equal(classifyRuntimeNotice('A', { type: 'notice', level: 'error', message: 'Interrupted by user' }), undefined);
  assert.equal(classifyRuntimeNotice('A', { type: 'extension_ui_request', method: 'notify', notifyType: 'error', message: 'Interrupted by user' }), undefined);
  assert.equal(classifyRuntimeNotice('A', { type: 'notice', level: 'error', message: 'Request was aborted' })?.severity, 'error');
  assert.equal(classifyRuntimeNotice('A', { type: 'rpc_frame_error', error: 'Interrupted by user' })?.severity, 'error');
  for (const severity of ['info', 'success', 'warning', 'error']) assert.equal(classifyRuntimeNotice('B', { type: 'extension_ui_request', method: 'notify', notifyType: severity, message: 'Notice' })?.severity, severity);
  assert.equal(classifyRuntimeNotice('A', { type: 'notice', level: 'warning', message: 'Attention' })?.severity, 'warning');
});

test('identical notices group without mixing sources, severities or link actions', () => {
  const notice = { runtimeId: 'A', message: 'Notice', severity: 'warning' as const };
  const grouped = appendToast(appendToast([], notice, 1), notice, 2);
  assert.deepEqual(grouped, [{ ...notice, id: 1, count: 2 }]);
  const otherSession = appendToast(grouped, { ...notice, runtimeId: 'B' }, 3);
  const otherSeverity = appendToast(otherSession, { ...notice, severity: 'error' }, 4);
  const otherLink = appendToast(otherSeverity, { ...notice, url: 'https://example.com' }, 5);
  assert.deepEqual(otherLink.map(item => [item.id, item.count]), [[1, 2], [3, 1], [4, 1], [5, 1]]);
});

test('localized generic failures only group when their underlying messages match', () => {
  const base = { runtimeId: 'A', message: '操作未能完成。', severity: 'error' as const };
  const one = { ...base, error: { kind: 'generic' as const, message: base.message, action: '重试', details: 'Persistence failed' } };
  const two = { ...base, error: { ...one.error, details: 'Archive unavailable' } };
  const items = appendToast(appendToast(appendToast([], one, 1), two, 2), one, 3);
  assert.deepEqual(items.map(item => [item.error?.details, item.count]), [['Persistence failed', 2], ['Archive unavailable', 1]]);
});

const inboxChat = () => createChatState({ runtimeId: 'A', cwd: '/work', source: { status: 'unpersisted', sessionId: 's' }, state: { sessionId: 's', isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [] });
const emptyInbox = (): InboxState => ({ items: [], sequence: 0, turns: {} });
test('inbox records away completion once, retains duration and turn anchor, and late failure replaces completion', () => {
  const initial = inboxChat();
  const running = reduceChatFrame(initial, { type: 'agent_start' });
  let inbox = reduceInbox(emptyInbox(), { type: 'transition', previous: initial, next: running, away: true, now: 100 });
  const answer = reduceChatFrame(running, { type: 'message_end', messageId: 'answer', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } });
  const settled = reduceChatFrame(answer, { type: 'session_settled' });
  inbox = reduceInbox(inbox, { type: 'transition', previous: answer, next: settled, away: true, now: 21100 });
  assert.deepEqual(inbox.items.map(item => [item.kind, item.durationMs, item.turnId]), [['completed', 21000, answer.messages[0].id]]);
  inbox = reduceInbox(inbox, { type: 'transition', previous: settled, next: settled, away: true, now: 22000 });
  assert.equal(inbox.items.length, 1);
  const failed = reduceChatFrame(settled, { type: 'prompt_result', status: 'error', error: 'private provider error' });
  inbox = reduceInbox(inbox, { type: 'transition', previous: settled, next: failed, away: false, now: 23000 });
  assert.deepEqual(inbox.items.map(item => item.kind), ['failed']);
  assert.equal(reduceInbox(inbox, { type: 'read', id: inbox.items[0].id }).items[0].read, true);
});

test('foreground completions and operator stops are quiet; independent runtimes and new turns still report', () => {
  for (const outcome of ['success', 'aborted']) {
    const initial = inboxChat();
    const running = reduceChatFrame(initial, { type: 'agent_start' });
    let inbox = reduceInbox(emptyInbox(), { type: 'transition', previous: initial, next: running, away: true, now: 1 });
    const stopped = reduceChatFrame(running, { type: 'prompt_result', status: outcome, sessionSettled: true });
    inbox = reduceInbox(inbox, { type: 'transition', previous: running, next: stopped, away: outcome === 'aborted', now: 30000 });
    assert.deepEqual(inbox.items, []);
    const next = reduceChatFrame(stopped, { type: 'agent_start' });
    inbox = reduceInbox(inbox, { type: 'transition', previous: stopped, next, away: true, now: 31000 });
    inbox = reduceInbox(inbox, { type: 'transition', previous: next, next: reduceChatFrame(next, { type: 'session_settled' }), away: true, now: 62000 });
    assert.deepEqual(inbox.items.map(item => item.durationMs), [31000]);
  }
});

test('pending requests survive mark-read, deduplicate across hydration and expire on removal', () => {
  const prompts: SessionPrompt[] = ['A', 'B'].map(runtimeId => ({ runtimeId, request: { type: 'extension_ui_request', id: 'same', method: 'confirm', message: 'secret', deadlineAt: 10000 } }));
  let inbox = reduceInbox(emptyInbox(), { type: 'prompts', prompts, now: 100 });
  inbox = reduceInbox(inbox, { type: 'read', runtimeId: 'A' });
  inbox = reduceInbox(inbox, { type: 'prompts', prompts, now: 200 });
  assert.deepEqual(inbox.items.map(item => [item.runtimeId, item.read, item.deadlineAt]), [['A', true, 10000], ['B', false, 10000]]);
  inbox = reduceInbox(inbox, { type: 'prompts', prompts: [prompts[1]], now: 11000 });
  assert.deepEqual(inbox.items.map(item => item.runtimeId), ['B']);
  assert.deepEqual(reduceInbox(inbox, { type: 'forget', ids: ['B'] }).items, []);
});

test('child failures are new lifecycle events, not historical hydration or repeated observations', () => {
  const initial = inboxChat();
  const historical = { ...initial, subagents: [{ id: 'old', status: 'failed', historical: true }] };
  let inbox = reduceInbox(emptyInbox(), { type: 'transition', next: historical, away: true, now: 1 });
  assert.deepEqual(inbox.items, []);
  const next = { ...historical, subagents: [...historical.subagents, { id: 'child', status: 'failed', parentToolCallId: 'task1' }] };
  inbox = reduceInbox(inbox, { type: 'transition', previous: historical, next, away: true, now: 2 });
  inbox = reduceInbox(inbox, { type: 'transition', previous: next, next: { ...next }, away: true, now: 3 });
  assert.deepEqual(inbox.items.map(item => [item.kind, item.subagentId]), [['child', 'child']]);
});

test('early errors and late operator stops do not masquerade as successful completion', () => {
  const initial = inboxChat();
  const error = reduceChatFrame(initial, { type: 'prompt_result', status: 'error' });
  const failed = reduceInbox(emptyInbox(), { type: 'transition', previous: initial, next: error, away: true, now: 1 });
  assert.deepEqual(failed.items.map(item => item.kind), ['failed']);
  const running = reduceChatFrame(initial, { type: 'agent_start' });
  let inbox = reduceInbox(emptyInbox(), { type: 'transition', previous: initial, next: running, away: true, now: 1 });
  const settled = reduceChatFrame(running, { type: 'session_settled' });
  inbox = reduceInbox(inbox, { type: 'transition', previous: running, next: settled, away: true, now: 2 });
  inbox = reduceInbox(inbox, { type: 'transition', previous: settled, next: reduceChatFrame(settled, { type: 'prompt_result', status: 'aborted' }), away: true, now: 3 });
  assert.deepEqual(inbox.items, []);
});

test('startup prompts notify once across replay, including multiple pending requests', async () => {
  const pending = Promise.withResolvers<SessionConnection>();
  const emitted: string[] = [];
  const store = new RuntimeStore({ startSession: () => pending.promise, request: () => Promise.withResolvers<never>().promise } as unknown as DesktopApi, () => {}, () => {}, { isAway: () => true, onEvent: item => emitted.push(`${item.runtimeId}:${item.promptId}`) });
  const started = store.start({ cwd: '/work' });
  for (const id of ['one', 'two']) store.receive({ runtimeId: 'A', kind: 'frame', frame: { type: 'extension_ui_request', method: 'confirm', id } });
  pending.resolve({ runtimeId: 'A', cwd: '/work', source: { status: 'unpersisted', sessionId: 's' }, state: { sessionId: 's', isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [] });
  await started;
  assert.deepEqual(emitted, ['A:one', 'A:two']);
  assert.deepEqual(store.getInboxSnapshot().map(item => item.promptId), ['one', 'two']);
});

test('inbox turn anchors follow canonical history replacement instead of pointing at removed live rows', () => {
  const initial = inboxChat();
  const previous = { ...initial, messages: [{ id: 'live-answer', source: 'live' as const, streaming: false, raw: { role: 'assistant', content: 'Done' } }] };
  const next = { ...initial, messages: [{ id: 'saved-answer', source: 'history' as const, streaming: false, presentation: { id: 'live-answer', sessionId: 's' }, raw: { role: 'assistant', content: 'Done' } }] };
  const inbox: InboxState = { sequence: 1, turns: {}, items: [{ id: 1, kind: 'completed', runtimeId: 'A', turnId: 'live-answer', read: false, createdAt: 1 }] };
  assert.equal(reduceInbox(inbox, { type: 'transition', previous, next, away: true, now: 2 }).items[0].turnId, 'saved-answer');
});

test('inbox previews retain the final answer first line, excluding thinking and later turns', () => {
  const initial = inboxChat();
  const running = reduceChatFrame(initial, { type: 'agent_start' });
  let inbox = reduceInbox(emptyInbox(), { type: 'transition', previous: initial, next: running, away: true, now: 1 });
  const answer = reduceChatFrame(running, { type: 'message_end', messageId: 'answer', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Internal reasoning' }, { type: 'text', text: '\n## **Review complete** for [workspace](https://example.com)\nLonger details follow.' }] } });
  const settled = reduceChatFrame(answer, { type: 'session_settled' });
  inbox = reduceInbox(inbox, { type: 'transition', previous: answer, next: settled, away: true, now: 2 });
  assert.equal(inbox.items[0].snippet, 'Review complete for workspace');
  const next = reduceChatFrame(settled, { type: 'agent_start' });
  inbox = reduceInbox(inbox, { type: 'transition', previous: settled, next, away: true, now: 3 });
  assert.equal(inbox.items[0].snippet, 'Review complete for workspace');
});

test('inbox previews use question text or title, bounded plain headlines for failures, and no raw content fields', () => {
  const prompts: SessionPrompt[] = [{ runtimeId: 'A', request: { type: 'extension_ui_request', id: 'question', method: 'confirm', title: 'Request', message: '\n> **Deploy** `release` now?\nSecret detail', options: ['secret choice'] } }, { runtimeId: 'B', request: { type: 'extension_ui_request', id: 'title', method: 'input', title: '## Which [branch](https://example.com)?' } }];
  const inbox = reduceInbox(emptyInbox(), { type: 'prompts', prompts, now: 1 });
  assert.deepEqual(inbox.items.map(item => item.snippet), ['Deploy release now?', 'Which branch?']);
  assert.ok(!JSON.stringify(inbox).includes('Secret detail'));
  assert.ok(!JSON.stringify(inbox).includes('secret choice'));
  const initial = inboxChat();
  const next = reduceChatFrame(initial, { type: 'prompt_result', status: 'error', error: '**Provider unavailable**\nStack trace detail' });
  const failed = reduceInbox(emptyInbox(), { type: 'transition', previous: initial, next, away: true, now: 2 });
  assert.equal(failed.items[0].snippet, 'Provider unavailable');
  const long = reduceInbox(emptyInbox(), { type: 'prompts', prompts: [{ runtimeId: 'A', request: { type: 'extension_ui_request', id: 'long', method: 'input', message: 'a'.repeat(1000) } }], now: 3 });
  assert.equal(long.items[0].snippet, `${'a'.repeat(239)}…`);
});

test('intentional disconnect stays neutral when its exit arrives after acknowledgement', async () => {
  const source = { status: 'unpersisted' as const, sessionId: 'disconnect-session', path: '/disconnect.jsonl' };
  const connection: SessionConnection = { source, runtimeId: 'disconnect', cwd: '/workspace', state: { sessionId: source.sessionId, sessionFile: source.path, isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [] };
  const notices: { severity: string }[] = [];
  const api = { startSession: async () => connection, request: async () => Promise.withResolvers<never>().promise, closeSession: async () => {}, getRuntimeAccess: async () => ({ source, status: 'idle', reason: '', checkedAt: 1, canSend: false, canFork: false }) } as unknown as DesktopApi;
  const store = new RuntimeStore(api, notice => notices.push(notice), () => {});
  await store.start({ cwd: '/workspace' });
  await store.close('disconnect');
  assert.equal(store.getSnapshot().disconnect.closed, true);
  assert.equal(store.getSnapshot().disconnect.chat.error, undefined);
  store.receive({ runtimeId: 'disconnect', kind: 'exit', exitCode: 1, error: 'Process terminated during requested shutdown' });
  assert.equal(store.getSnapshot().disconnect.chat.error, undefined);
  assert.equal(notices.length, 0);
  const unexpected = new RuntimeStore(api, notice => notices.push(notice), () => {});
  await unexpected.start({ cwd: '/workspace' });
  unexpected.receive({ runtimeId: 'disconnect', kind: 'error', error: 'Unexpected transport failure' });
  assert.equal(notices.at(-1)?.severity, 'error');
});

test('selection is optimistic, rolls back rejected settings and reconciles without history refresh', async () => {
  const model = { provider: 'fixture', id: 'initial' };
  const alternate = { provider: 'fixture', id: 'alternate' };
  const connection: SessionConnection = { runtimeId: 'selection', cwd: '/workspace', source: { status: 'unpersisted', sessionId: 's' }, state: { sessionId: 's', isStreaming: false, model, thinkingLevel: 'low' }, messages: [], models: [model, alternate], commands: [], thinkingLevels: ['off', 'low', 'max'] };
  let gate = Promise.withResolvers<unknown>();
  let state = connection.state;
  let historyChanges = 0;
  const requests: string[] = [];
  const store = new RuntimeStore({
    startSession: async () => connection,
    request: async (_id: string, frame: { type: string }) => {
      requests.push(frame.type);
      if (frame.type === 'get_state') return state;
      if (frame.type === 'get_available_thinking_levels') return { levels: ['off', 'low'] };
      if (frame.type.startsWith('set_')) return gate.promise;
      throw new Error('Unexpected heavyweight read: ' + frame.type);
    },
  } as unknown as DesktopApi, () => {}, () => { historyChanges++; });
  let fullRefreshes = 0;
  store.refresh = async () => { fullRefreshes++; };
  await store.start({ cwd: '/workspace' });
  fullRefreshes = 0;
  const rejected = store.command('selection', { type: 'set_thinking_level', level: 'max' });
  assert.equal(store.getSnapshot().selection.chat.state.thinkingLevel, 'max');
  gate.reject(new Error('Native rejected selection'));
  await assert.rejects(rejected, /Native rejected selection/);
  assert.equal(store.getSnapshot().selection.chat.state.thinkingLevel, 'low');
  gate = Promise.withResolvers<unknown>();
  const accepted = store.command('selection', { type: 'set_thinking_level', level: 'max' });
  state = { ...state, thinkingLevel: 'max' };
  gate.resolve(undefined);
  await accepted;
  assert.equal(store.getSnapshot().selection.chat.state.thinkingLevel, 'max');
  store.receive({ runtimeId: 'selection', kind: 'frame', frame: { type: 'thinking_level_changed', thinkingLevel: 'max' } });
  assert.equal(fullRefreshes, 0);
  assert.equal(historyChanges, 0);
  assert.deepEqual(requests, ['set_thinking_level', 'set_thinking_level', 'get_state']);
  gate = Promise.withResolvers<unknown>();
  const rejectedModel = store.command('selection', { type: 'set_model', provider: 'fixture', modelId: 'alternate' });
  assert.equal(store.getSnapshot().selection.chat.state.model?.id, 'alternate');
  gate.reject(new Error('Unavailable model'));
  await assert.rejects(rejectedModel, /Unavailable model/);
  assert.equal(store.getSnapshot().selection.chat.state.model?.id, 'initial');
  gate = Promise.withResolvers<unknown>();
  const changed = store.command('selection', { type: 'set_model', provider: 'fixture', modelId: 'alternate' });
  state = { ...state, model: alternate, thinkingLevel: 'low' };
  gate.resolve(alternate);
  await changed;
  assert.deepEqual(store.getSnapshot().selection.chat.thinkingLevels, ['off', 'low']);
  assert.equal(store.getSnapshot().selection.chat.state.thinkingLevel, 'low');
  assert.equal(fullRefreshes, 0);
  assert.equal(historyChanges, 0);
  state = { ...state, fastModeEnabled: false, fastModeActive: false };
  await store.command('selection', { type: 'set_fast_mode', enabled: false });
  assert.equal(store.getSnapshot().selection.chat.state.fastModeEnabled, false);
  assert.equal(fullRefreshes, 0);
  assert.equal(historyChanges, 0);
});

test('removal suppresses expected clean shutdown but rejected admission leaves later exits observable', async () => {
  for (const accepted of [false, true]) {
    const source = { status: 'persisted' as const, sessionId: 'remove-session', path: '/remove.jsonl' };
    const connection: SessionConnection = { source, runtimeId: 'remove', cwd: '/workspace', state: { sessionId: source.sessionId, sessionFile: source.path, isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [] };
    const notices: { severity: string }[] = [];
    const api = { startSession: async () => connection, request: async () => Promise.withResolvers<never>().promise, getRuntimeAccess: async () => ({source}), removeSession: async () => {
      if (accepted) store.receive({ runtimeId: 'remove', kind: 'exit', exitCode: 0 });
      return { sourceRemoved: accepted };
    } } as unknown as DesktopApi;
    const store = new RuntimeStore(api, notice => notices.push(notice), () => {});
    await store.start({ cwd: '/workspace' });
    await store.remove({ kind: 'runtime', runtimeId: 'remove', sessionId: source.sessionId });
    assert.equal(notices.length, 0);
    if (!accepted) {
      store.receive({ runtimeId: 'remove', kind: 'exit', exitCode: 1 });
      assert.equal(notices.at(-1)?.severity, 'error');
    }
  }
});

test('one crash emits one notice across transport error, exit and duplicate exit', async () => {
  const connection: SessionConnection = { source: { status: 'unpersisted', sessionId: 'crash' }, runtimeId: 'crash', cwd: '/workspace', state: { sessionId: 'crash', isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [] };
  const notices: unknown[] = [];
  const store = new RuntimeStore({ startSession: async () => connection, request: async () => Promise.withResolvers<never>().promise } as unknown as DesktopApi, notice => notices.push(notice), () => {});
  await store.start({ cwd: '/workspace' });
  store.receive({ runtimeId: 'crash', kind: 'error', error: 'Broken pipe' });
  store.receive({ runtimeId: 'crash', kind: 'exit', exitCode: 1 });
  store.receive({ runtimeId: 'crash', kind: 'exit', exitCode: 1 });
  assert.equal(notices.length, 1);
  assert.equal(store.getSnapshot().crash.closed, true);
});

test('automatic saved-child refresh retains scoped diagnostics without toast or transcript errors', async () => {
  const source = { status: 'persisted' as const, sessionId: 'saved', path: '/saved.jsonl' };
  const historySource = { path: source.path, leafId: 'leaf', revision: 'r1' };
  const connection: SessionConnection = { source, runtimeId: 'saved', cwd: '/workspace', state: { sessionId: 'saved', sessionFile: source.path, isStreaming: false }, messages: [], models: [], commands: [], thinkingLevels: [], historySource, history: { source, messages: [], hasMore: false, diagnostics: [] } };
  const notices: unknown[] = [];
  let failure = true;
  const store = new RuntimeStore({
    startSession: async () => connection,
    request: async (_id: string, command: { type: string }) => command.type === 'get_state' ? connection.state : { subagents: [] },
    getRuntimeAccess: async () => ({ source, canSend: true }),
    listHistorySubagents: async () => { if (failure) throw new Error('Saved child source unavailable'); return { subagents: [], diagnostics: ['Saved task history is still changing'] }; },
  } as unknown as DesktopApi, notice => notices.push(notice), () => {});
  await store.start({ cwd: '/workspace', sessionPath: source.path, mode: 'resume' });
  await store.refresh('saved');
  assert.ok(store.getSnapshot().saved.history!.diagnostics.includes('Saved child source unavailable'));
  failure = false;
  await store.refresh('saved');
  assert.ok(store.getSnapshot().saved.history!.diagnostics.includes('Saved task history is still changing'));
  assert.deepEqual(notices, []);
  assert.deepEqual(store.getSnapshot().saved.chat.notices, []);
  assert.equal(store.getSnapshot().saved.closed, false);
});

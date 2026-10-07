import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSidebarConversation, sidebarSubmission, sidebarConversationDetails, projectSidebarSessions, sidebarProjects, sidebarProjectRows, sidebarProjectNeedsAttention, sidebarForkReason, type SidebarSession } from './sidebar-session';
import { SubmissionStore, type SubmissionReceipt } from '../chat/submissions';
import type { ChatMessage } from '../chat/model';
import { projectSubmissions } from '../chat/presentation';

test('allocations stay drafts until a message is sent', () => {
  const source = { status: 'unpersisted' as const, sessionId: 'draft', path: '/allocated.jsonl' };
  assert.equal(isSidebarConversation(source, []), false);
  assert.equal(isSidebarConversation(source, [{ raw: { role: 'system' } }]), false);
  assert.equal(isSidebarConversation(source, [{ raw: { role: 'user' } }]), true);
});

test('legacy empty saved conversations remain visible and removable', () => {
  assert.equal(isSidebarConversation({ status: 'persisted', sessionId: 'old', path: '/old.jsonl' }, []), true);
  assert.equal(isSidebarConversation({ status: 'unavailable', sessionId: 'old', path: '/old.jsonl' }, []), true);
});

test('accepted prompt creates a titled row before native messages, not drafts, commands or rejected sends', () => {
  const receipt: SubmissionReceipt = { id: 'send', runtimeId: 'runtime', sessionId: 'session', input: { text: 'First line\nFurther details' }, status: 'accepted', submittedAt: 1000 };
  const source = { status: 'unpersisted' as const, sessionId: 'session', path: '/allocated.jsonl' };
  assert.equal(isSidebarConversation(source, [], sidebarSubmission([receipt], 'runtime', 'session')), true);
  assert.deepEqual(sidebarConversationDetails([], receipt), { title: 'First line', updatedAt: new Date(1000).toISOString() });
  for (const status of ['submitting', 'local', 'error'] as const) assert.equal(isSidebarConversation(source, [], sidebarSubmission([{ ...receipt, status }], 'runtime', 'session')), false);
  assert.equal(sidebarSubmission([receipt], 'other', 'session'), undefined);
  assert.equal(sidebarSubmission([receipt], 'runtime', 'other'), undefined);
});

test('background output and completion cannot overtake a newer conversation in the project', () => {
  const row = (id: string, at: number, extra: Partial<SidebarSession> = {}): SidebarSession => ({ id, path: `/${id}.jsonl`, cwd: '/project', title: id, preview: '', updatedAt: new Date(at).toISOString(), sourceKind: 'journal', writable: true, canFork: true, ...extra });
  const messages: ChatMessage[] = [{ id: 'user', source: 'live', streaming: false, raw: { role: 'user', content: 'Request', timestamp: 1000 } }, { id: 'answer', source: 'live', streaming: false, raw: { role: 'assistant', content: 'Done', timestamp: 5000 } }];
  const old = row('older', 5000);
  const details = sidebarConversationDetails(messages, undefined, old);
  for (const status of [{ running: true }, { pendingCount: 1 }, { failed: true }, { unreadCompletion: true }, { closed: true }]) {
    const rows = projectSidebarSessions([row('older', 5000, { ...details, ...status }), row('newer', 2000), row('other-project', 6000, { cwd: '/other' })], '/project');
    assert.deepEqual(rows.map(row => row.id), ['newer', 'older']);
  }
});

test('pins stay once inside their own project ahead of recent unpinned rows', () => {
  const row = (id: string, at: number): SidebarSession => ({ id, path: `/${id}`, cwd: '/project', title: id, preview: '', updatedAt: new Date(at).toISOString(), sourceKind: 'journal', writable: true, canFork: true });
  const rows = projectSidebarSessions([row('recent', 3000), row('pin-old', 1000), row('pin-new', 2000)], '/project', ['/pin-old', '/pin-new']);
  assert.deepEqual(rows.map(row => row.id), ['pin-new', 'pin-old', 'recent']);
});

test('project recency ignores persisted workspace order and budgets preserve attention', () => {
  const rows: SidebarSession[] = Array.from({ length: 12 }, (_, index) => ({ id: String(index), path: `/${index}`, cwd: '/active', title: 'Duplicate', preview: '', updatedAt: new Date(12_000-index*1000).toISOString(), sourceKind: 'journal', writable: true, canFork: true }));
  const other = { ...rows[0], cwd: '/older', updatedAt: new Date(1).toISOString() };
  assert.deepEqual(sidebarProjects(['/older', '/empty'], [...rows, other]), ['/active', '/older', '/empty']);
  assert.equal(sidebarProjectRows(rows, true, false, null).length, 8);
  assert.equal(sidebarProjectRows(rows, false, false, null).length, 5);
  assert.equal(sidebarProjectRows(rows, false, true, null).length, 12);
  rows[11].pendingCount = 1;
  assert.deepEqual(sidebarProjectRows(rows, false, false, '/10').map(row => row.id), ['0', '1', '2', '3', '4', '10', '11']);
  assert.equal(sidebarProjectNeedsAttention(rows, null), true);
  rows[11].pendingCount = 0;
  assert.equal(sidebarProjectNeedsAttention(rows, null), false);
});

test('saved session forks do not depend on ownership, activity or cached send admission', () => {
  const saved: SidebarSession = { id: 'saved', path: '/saved.jsonl', cwd: '/project', title: 'Saved', preview: '', updatedAt: '', sourceKind: 'journal', writable: true, canFork: false };
  for (const state of [{}, { runtimeId: 'owned', running: false }, { runtimeId: 'owned', running: true }, { runtimeId: 'owned', closed: true }, { activity: 'running' as const, writable: false }]) {
    assert.equal(sidebarForkReason({ ...saved, ...state }), undefined);
    assert.equal(sidebarForkReason({ ...saved, ...state, source: { status: 'persisted', sessionId: 'saved', path: '/saved.jsonl' } }), undefined);
  }
  assert.equal(sidebarForkReason({ ...saved, source: { status: 'unpersisted', sessionId: 'saved', path: '/allocated.jsonl' } }), 'unsaved');
  assert.equal(sidebarForkReason({ ...saved, path: 'runtime:owned' }), 'unsaved');
  assert.equal(sidebarForkReason({ ...saved, source: { status: 'unavailable', sessionId: 'saved', path: '/missing.jsonl' } }), 'unavailable');
});

test('one acceptance receipt publishes the first transcript bubble and sidebar row together', () => {
  const store = new SubmissionStore();
  const source = { status: 'unpersisted' as const, sessionId: 'session' };
  const states: { transcript: boolean; sidebar: boolean }[] = [];
  const unsubscribe = store.subscribe(() => {
    const receipts = store.getSnapshot();
    states.push({ transcript: projectSubmissions(receipts, [], 'runtime', 'session').pending.length > 0, sidebar: isSidebarConversation(source, [], sidebarSubmission(receipts, 'runtime', 'session')) });
  });
  const receipt = store.begin('runtime', 'session', { text: 'First request', mode: 'prompt' });
  store.accepted(receipt.id, { requestId: 'request', data: { agentInvoked: true } });
  unsubscribe();
  assert.deepEqual(states, [{ transcript: false, sidebar: false }, { transcript: true, sidebar: true }]);
});

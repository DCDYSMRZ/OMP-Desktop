import test from 'node:test';
import assert from 'node:assert/strict';
import { sidebarStatus } from './sidebar-status';
import type { SidebarSession } from './sidebar-session';

const session: SidebarSession = { id: 'one', path: '/session', title: 'Session', cwd: '/project', updatedAt: new Date(0).toISOString(), preview: '', sourceKind: 'journal', writable: false, canFork: true };

test('saved, ready and stale observed sessions have no activity mark', () => {
  assert.equal(sidebarStatus(session), undefined);
  assert.equal(sidebarStatus({ ...session, runtimeId: 'runtime' }), undefined);
  assert.equal(sidebarStatus({ ...session, activity: 'stale' }), undefined);
  assert.equal(sidebarStatus({ ...session, runtimeId: 'closed', running: true, closed: true }), undefined);
});

test('external activity and runtime activity share the running mark without changing access', () => {
  assert.equal(sidebarStatus({ ...session, activity: 'running' }), 'running');
  assert.equal(sidebarStatus({ ...session, runtimeId: 'runtime', running: true }), 'running');
  assert.equal(sidebarStatus({ ...session, closed: true, activity: 'running' }), 'running');
});

test('attention outranks running and unread completion only marks settled work', () => {
  assert.equal(sidebarStatus({ ...session, pendingCount: 1, failed: true, activity: 'running', unreadCompletion: true }), 'waiting');
  assert.equal(sidebarStatus({ ...session, failed: true, running: true, unreadCompletion: true }), 'failed');
  assert.equal(sidebarStatus({ ...session, activity: 'running', unreadCompletion: true }), 'running');
  assert.equal(sidebarStatus({ ...session, unreadCompletion: true }), 'unread');
  assert.equal(sidebarStatus({ ...session, unreadCompletion: false }), undefined);
});

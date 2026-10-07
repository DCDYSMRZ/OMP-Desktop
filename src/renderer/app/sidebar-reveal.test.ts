import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldRevealSidebar } from './sidebar-reveal';

const active = { active: 'session-a', project: '/work', visible: true, rowVisible: true };

test('metadata and session-count refresh cannot reclaim sidebar browsing', () => {
  const previous = { ...active, updatedAt: 'old', sessions: 20 };
  const refreshed = { ...active, updatedAt: 'new', sessions: 21 };
  assert.equal(shouldRevealSidebar(previous, refreshed), false);
});

test('explicit session navigation and visible re-entry reveal the active row', () => {
  assert.equal(shouldRevealSidebar(active, { ...active, active: 'session-b' }), true);
  assert.equal(shouldRevealSidebar({ ...active, visible: false }, active), true);
  assert.equal(shouldRevealSidebar({ ...active, rowVisible: false }, active), true);
  assert.equal(shouldRevealSidebar(undefined, active), true);
});

test('hidden sidebar or unavailable row does not consume a visible landing', () => {
  assert.equal(shouldRevealSidebar(active, { ...active, visible: false, active: 'session-b' }), false);
  assert.equal(shouldRevealSidebar(active, { ...active, rowVisible: false }), false);
  assert.equal(shouldRevealSidebar(active, { ...active, active: null }), false);
});

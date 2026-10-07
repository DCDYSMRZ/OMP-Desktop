import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextStageFoldState, recallStageFoldState, rememberStageFoldState } from './stage-fold-state';

test('successful settlement can fold only after idle and never during interaction', () => {
  const mounted = nextStageFoldState(undefined, { type: 'mount', active: true, defaultExpanded: true });
  const settled = nextStageFoldState(mounted, { type: 'settle', canFold: true });
  const waiting = nextStageFoldState(settled, { type: 'idle', now: 100, protected: false });
  assert.equal(waiting.expanded, true);
  assert.equal(nextStageFoldState(waiting, { type: 'deadline', now: 100, protected: false }).expanded, true);
  assert.equal(nextStageFoldState(waiting, { type: 'deadline', now: 10000, protected: true }).expanded, true);
  const held = nextStageFoldState(waiting, { type: 'interact' });
  assert.equal(nextStageFoldState(held, { type: 'deadline', now: 10000, protected: false }).expanded, true);
  assert.equal(nextStageFoldState(waiting, { type: 'deadline', now: 10000, protected: false }).expanded, false);
});

test('attention interrupts a pending fold and reopens automatic disclosure', () => {
  const collapsed = nextStageFoldState(undefined, { type: 'mount', active: false, defaultExpanded: false });
  assert.equal(nextStageFoldState(collapsed, { type: 'attention' }).expanded, true);
  const waiting = { expanded: true, manual: false, wasActive: true, foldDueAt: 100 };
  const attention = nextStageFoldState(waiting, { type: 'attention' });
  assert.equal(nextStageFoldState(attention, { type: 'deadline', now: 10000, protected: false }).expanded, true);
});

test('manual disclosure survives activity, attention and remount', () => {
  const mounted = nextStageFoldState(undefined, { type: 'mount', active: true, defaultExpanded: true });
  const manual = nextStageFoldState(mounted, { type: 'manual', expanded: false });
  assert.equal(nextStageFoldState(manual, { type: 'settle', canFold: true }).expanded, false);
  assert.equal(nextStageFoldState(manual, { type: 'attention' }).expanded, false);
  assert.equal(nextStageFoldState(manual, { type: 'active' }).expanded, false);
  assert.equal(nextStageFoldState(manual, { type: 'mount', active: false, defaultExpanded: true }).expanded, false);
});

test('remount retains an in-flight idle deadline rather than restarting the wait', () => {
  const waiting = { expanded: true, manual: false, wasActive: true, foldDueAt: 100 };
  const remounted = nextStageFoldState(waiting, { type: 'mount', active: false, defaultExpanded: false });
  assert.equal(remounted.expanded, true);
  assert.equal(nextStageFoldState(remounted, { type: 'deadline', now: 101, protected: false }).expanded, false);
});

test('stage memory retains recent manual choices and bounds older conversation state', () => {
  const state = { expanded: true, manual: true, wasActive: false };
  for (let i = 0; i < 128; i++) rememberStageFoldState(`fold-lru-${i}`, state);
  assert.deepEqual(recallStageFoldState('fold-lru-0'), state);
  rememberStageFoldState('fold-lru-new', state);
  assert.equal(recallStageFoldState('fold-lru-1'), undefined);
  assert.deepEqual(recallStageFoldState('fold-lru-0'), state);
});

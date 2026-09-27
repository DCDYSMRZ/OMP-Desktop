import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextStageFoldState, recallStageFoldState, rememberStageFoldState } from './stage-fold-state';

test('settlement waits for absorb and then the full 1400ms deadline', () => {
  let state = nextStageFoldState(undefined, { type: 'mount', active: true, defaultExpanded: true });
  state = nextStageFoldState(state, { type: 'settle', canFold: true });
  assert.equal(state.expanded, true);
  assert.equal(state.foldDueAt, undefined);
  state = nextStageFoldState(state, { type: 'absorb-done', now: 650, protected: false, returnsPending: true });
  assert.equal(state.foldDueAt, undefined);
  state = nextStageFoldState(state, { type: 'absorb-done', now: 650, protected: false, returnsPending: false });
  assert.equal(state.foldDueAt, 2050);
  assert.equal(nextStageFoldState(state, { type: 'deadline', now: 2049, protected: false, returnsPending: false }).expanded, true);
  state = nextStageFoldState(state, { type: 'deadline', now: 2050, protected: false, returnsPending: false });
  assert.deepEqual(state, { expanded: false, manual: false, wasActive: false });
});

test('hover and focus protection cancel the deadline and leaving rearms a full wait', () => {
  let state = { expanded: true, manual: false, wasActive: true, foldDueAt: 1400 };
  const held = nextStageFoldState(state, { type: 'hover-in' });
  assert.equal(held.foldDueAt, undefined);
  assert.equal(nextStageFoldState(state, { type: 'deadline', now: 1600, protected: true, returnsPending: false }).expanded, true);
  const rearmed = nextStageFoldState(held, { type: 'hover-out', now: 2000, protected: false, returnsPending: false });
  assert.equal(rearmed.foldDueAt, 3400);
});

test('remount resumes a recorded deadline but history without a record uses its default', () => {
  const recorded = { expanded: true, manual: false, wasActive: true, foldDueAt: 2400 };
  const remounted = nextStageFoldState(recorded, { type: 'mount', active: false, defaultExpanded: false });
  assert.equal(remounted.foldDueAt, 2400);
  assert.equal(nextStageFoldState(remounted, { type: 'absorb-done', now: 2200, protected: false, returnsPending: false }).foldDueAt, 2400);
  assert.equal(nextStageFoldState(remounted, { type: 'deadline', now: 2400, protected: false, returnsPending: false }).expanded, false);
  const waiting = nextStageFoldState({ expanded: true, manual: false, wasActive: true }, { type: 'mount', active: false, defaultExpanded: false });
  assert.equal(waiting.expanded, true);
  assert.equal(nextStageFoldState(waiting, { type: 'absorb-done', now: 3000, protected: false, returnsPending: false }).foldDueAt, 4400);
  assert.deepEqual(nextStageFoldState(undefined, { type: 'mount', active: false, defaultExpanded: false }), { expanded: false, manual: false, wasActive: false });
});

test('manual control survives settlement, interaction and remount', () => {
  const manual = nextStageFoldState({ expanded: true, manual: false, wasActive: true }, { type: 'manual', expanded: false });
  assert.equal(nextStageFoldState(manual, { type: 'settle', canFold: true }).expanded, false);
  assert.equal(nextStageFoldState(manual, { type: 'hover-out', now: 100, protected: false, returnsPending: false }).foldDueAt, undefined);
  assert.deepEqual(nextStageFoldState(manual, { type: 'mount', active: false, defaultExpanded: true }), manual);
});

test('stage memory retains recently used calls and evicts older calls at 128', () => {
  const state = { expanded: true, manual: true, wasActive: false };
  for (let i = 0; i < 128; i++) rememberStageFoldState(`fold-lru-${i}`, state);
  assert.deepEqual(recallStageFoldState('fold-lru-0'), state);
  rememberStageFoldState('fold-lru-new', state);
  assert.equal(recallStageFoldState('fold-lru-1'), undefined);
  assert.deepEqual(recallStageFoldState('fold-lru-0'), state);
});

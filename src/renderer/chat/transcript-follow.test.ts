import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalesceFrame, followAfterScroll, returnToLatest, interruptTranscriptNavigation, scheduleTranscriptNavigation, scrollKeyDirection, scrollGestureReachesViewport, createNavigationRequest } from './transcript-follow';

test('upward intent releases follow while only downward near-bottom motion resumes it', () => {
  assert.equal(followAfterScroll(true, false, 500, -1), true);
  assert.equal(followAfterScroll(true, true, 1, -1), false);
  assert.equal(followAfterScroll(false, true, 1, 0), false);
  assert.equal(followAfterScroll(false, true, 80, 1), true);
  assert.equal(followAfterScroll(false, true, 81, 1), false);
  assert.equal(followAfterScroll(false, false, 0, 1), false);
});

test('passive shrink and regrowth cannot impersonate upward reading intent', () => {
  assert.equal(followAfterScroll(true, false, 0, -19), true);
  assert.equal(followAfterScroll(true, false, 57.5, -21.5), true);
  assert.equal(followAfterScroll(false, false, 0, 21.5), false);
  assert.equal(followAfterScroll(true, true, 1, -1), false);
});

test('source resolution cannot revive interrupted or already claimed navigation', () => {
  const request = createNavigationRequest();
  request.observe('focus:1', 4);
  request.observe('focus:1', 5);
  assert.equal(request.take('focus:1', 5), false);
  request.observe('focus:2', 5);
  assert.equal(request.take('focus:2', 5), true);
  request.observe('focus:2', 5);
  assert.equal(request.take('focus:2', 5), false);
  request.observe('focus:3', 6);
  assert.equal(request.take('focus:3', 6), true);
});

test('claimed navigation survives source refresh until a newer explicit request', () => {
  const request = createNavigationRequest();
  let cancelled = false;
  let top = 0;
  request.observe('step:1', 4);
  assert.equal(request.take('step:1', 4), true);
  request.retain(() => { cancelled = true; });
  request.observe('step:1', 5);
  assert.equal(request.take('step:1', 5), false);
  if (!cancelled) top = 240;
  assert.equal(top, 240);
  request.observe('step:2', 6);
  assert.equal(cancelled, true);
  assert.equal(request.take('step:2', 6), true);
});

test('scroll keys distinguish upward intent and modified editing commands', () => {
  const key = { key: ' ', shiftKey: true, metaKey: false, ctrlKey: false, altKey: false };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Element');
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: class {} });
  try {
    assert.equal(scrollKeyDirection(key, null), -1);
    assert.equal(scrollKeyDirection({ ...key, shiftKey: false }, null), 1);
    assert.equal(scrollKeyDirection({ ...key, key: 'ArrowUp', ctrlKey: true }, null), 0);
    assert.equal(scrollKeyDirection({ ...key, key: 'Enter' }, null), 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'Element', previous);
    else Reflect.deleteProperty(globalThis, 'Element');
  }
});

test('a newer gesture cancels delayed report navigation without affecting another viewport', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const timers = new Map<number, () => void>();
  let next = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: (run: () => void) => { timers.set(++next, run); return next; }, clearTimeout: (id: number) => timers.delete(id) } });
  class Viewport extends EventTarget { scrollTop = 0; closest() { return this; } }
  const first = new Viewport();
  const second = new Viewport();
  try {
    scheduleTranscriptNavigation(first as unknown as HTMLElement, () => { first.scrollTop = 300; }, 200);
    scheduleTranscriptNavigation(second as unknown as HTMLElement, () => { second.scrollTop = 500; }, 200);
    interruptTranscriptNavigation(first as unknown as HTMLElement);
    for (const run of [...timers.values()]) run();
    assert.equal(first.scrollTop, 0);
    assert.equal(second.scrollTop, 500);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('vertical inner scrolling consumes input but horizontal-only overflow does not', () => {
  const names = ['Element', 'HTMLElement', 'getComputedStyle'] as const;
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  class Node {
    parentElement: Node | null = null;
    scrollTop = 0;
    scrollHeight = 100;
    clientHeight = 100;
    overflowY = 'auto';
    overscrollBehaviorY = 'auto';
    contains(target: Node): boolean { return target === this || target.parentElement === this; }
    closest(): null { return null; }
  }
  Object.defineProperties(globalThis, { Element: { configurable: true, value: Node }, HTMLElement: { configurable: true, value: Node }, getComputedStyle: { configurable: true, value: (node: Node) => node } });
  const viewport = new Node();
  const inner = new Node(); inner.parentElement = viewport;
  const root = viewport as unknown as HTMLElement;
  const target = inner as unknown as EventTarget;
  try {
    assert.equal(scrollGestureReachesViewport(root, target, -1), true);
    inner.scrollHeight = 300; inner.scrollTop = 80;
    assert.equal(scrollGestureReachesViewport(root, target, -1), false);
    assert.equal(scrollGestureReachesViewport(root, target, 1), false);
    inner.scrollTop = 0;
    assert.equal(scrollGestureReachesViewport(root, target, -1), true);
    inner.overscrollBehaviorY = 'contain';
    assert.equal(scrollGestureReachesViewport(root, target, -1), false);
    inner.scrollTop = 200; inner.overscrollBehaviorY = 'auto';
    assert.equal(scrollGestureReachesViewport(root, target, 1), true);
  } finally {
    names.forEach((name, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

test('resize and render notifications share one pin; cancelled frames never run', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0, pins = 0;
  const clock = coalesceFrame(() => pins++, callback => { frames.set(++next, callback); return next; }, id => { frames.delete(id); });
  for (let i = 0; i < 50; i++) clock.schedule();
  assert.equal(frames.size, 1);
  const callback = frames.get(1)!; frames.delete(1); callback(16);
  assert.equal(pins, 1);
  clock.schedule(); clock.cancel();
  assert.equal(frames.size, 0);
  clock.schedule(); frames.get(3)!(32);
  assert.equal(pins, 2);
});

test('a resize flush pins before paint and cancels the queued duplicate', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let calls = 0;
  const pin = coalesceFrame(() => calls++, callback => { frames.set(1, callback); return 1; }, id => { frames.delete(id); });
  pin.schedule(); pin.schedule(); pin.flush();
  assert.equal(calls, 1);
  assert.equal(frames.size, 0);
});


test('required history navigation failures are preserved', async () => {
  const cause = new Error('Session changed');
  await assert.rejects(returnToLatest({ following: false, latest: async () => { throw cause; } }, () => {}, () => true), error => error === cause);
});

test('latest completion cannot override a newer reading gesture', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let current = true;
  let position = 240;
  const navigation = returnToLatest({ following: false, latest: () => pending }, () => { position = 1000; }, () => current);
  assert.equal(position, 1000);
  current = false;
  position = 720;
  finish();
  await navigation;
  assert.equal(position, 720);
});

test('latest completion follows the loaded window when navigation still owns it', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let bottom = 1000;
  let position = 240;
  const navigation = returnToLatest({ following: false, latest: () => pending }, () => { position = bottom; }, () => true);
  assert.equal(position, 1000);
  bottom = 1800;
  finish();
  await navigation;
  assert.equal(position, 1800);
});

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createSmoothFollow, glideGap } from './smooth-follow';
import { isProgrammaticScroll } from '../ui/motion/programmatic-scroll';

test('B1 uses tau 80, caps page lag at 64, and settles below 1.5 pixels', () => {
  assert.equal(glideGap(64, 80, 80, 64), 64 / Math.E);
  assert.equal(glideGap(500, 16, 80, 64), 64);
  assert.equal(glideGap(1.5, 0, 80, 64), 1.5);
  assert.equal(glideGap(1.5, 1, 80, 64), 0);
  assert.equal(glideGap(64, 350, 80, 64), 0);
});

function harness(t: TestContext) {
  let now = 0, sequence = 0, reduced = false;
  const frames = new Map<number, FrameRequestCallback>();
  const originalRequest = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  Object.assign(globalThis, { requestAnimationFrame() { return 0; }, cancelAnimationFrame() {} });
  t.after(() => {
    t.mock.restoreAll();
    if (originalRequest) Object.defineProperty(globalThis, 'requestAnimationFrame', originalRequest); else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    if (originalCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', originalCancel); else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  t.mock.method(globalThis, 'cancelAnimationFrame', (id: number) => frames.delete(id));
  const element = { scrollTop: 0, scrollHeight: 800, clientHeight: 400 };
  const controller = createSmoothFollow(element as unknown as HTMLElement, { tauMs: 80, maxLagPx: 64, snapPx: node => node.clientHeight, reducedMotion: () => reduced });
  return { element, controller, frames, reduce() { reduced = true; }, step(time: number, timestamp = time) { now = time; const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(timestamp); } };
}


test('B1 snaps an insertion larger than the viewport to 64 then glides', t => {
  const h = harness(t);
  h.element.scrollHeight = 1000;
  h.controller.contentChanged();
  assert.equal(h.element.scrollTop, 536);
  h.step(80);
  assert.ok(Math.abs(600 - h.element.scrollTop - 64 / Math.E) < 1e-9);
  h.step(400);
  assert.equal(h.element.scrollTop, 600);
  assert.equal(h.frames.size, 0);
});

test('post-layout growth clamps before the next animation frame', t => {
  const h = harness(t);
  h.element.scrollTop = 330;
  h.controller.contentChanged();
  assert.equal(h.element.scrollTop, 336);
  assert.equal(h.frames.size, 1);
});

test('small late growth glides from an already settled bottom instead of jumping', t => {
  const h = harness(t);
  h.element.scrollTop = 400;
  h.controller.contentChanged();
  h.element.scrollHeight += 48;
  h.controller.contentChanged();
  assert.equal(h.element.scrollTop, 400);
  h.step(19.6);
  assert.ok(h.element.scrollTop > 400);
  assert.ok(h.element.scrollTop - 400 <= 1.45 * 19.6);
  h.step(350);
  assert.equal(h.element.scrollTop, 448);
});

test('a stale frame timestamp cannot over-decay a newly clamped gap', t => {
  const h = harness(t);
  h.controller.contentChanged();
  h.step(100, 0);
  h.element.scrollHeight += 100;
  h.controller.contentChanged();
  const top = h.element.scrollTop;
  h.step(116, 16);
  assert.ok(Math.abs(h.element.scrollTop - top - 64 * (1 - Math.exp(-16 / 80))) < 1e-9);
});

test('B3 tween follows the live target and finishes at 300ms', t => {
  const h = harness(t);
  h.controller.returnToBottom();
  assert.equal(h.element.scrollTop, 0);
  // Bezier parameter t=.5 gives x=.2 and y=.5: 60ms is halfway.
  h.step(60);
  assert.ok(Math.abs(h.element.scrollTop - 200) < 0.001);
  h.element.scrollHeight = 900;
  h.controller.contentChanged();
  h.step(299);
  assert.ok(h.element.scrollTop < 500);
  h.step(300);
  assert.equal(h.element.scrollTop, 500);
  assert.equal(h.frames.size, 0);
});

test('B3 boundary is two viewport heights; farther returns snap', t => {
  const h = harness(t);
  h.element.scrollHeight = 1200;
  h.controller.returnToBottom();
  assert.equal(h.element.scrollTop, 0);
  h.controller.interrupt();
  h.element.scrollHeight = 1201;
  h.controller.returnToBottom();
  assert.equal(h.element.scrollTop, 801);
  assert.equal(h.frames.size, 0);
});

test('interrupt, disabling follow, and disposal stop writes immediately', t => {
  const h = harness(t);
  h.controller.returnToBottom(); h.step(60);
  const top = h.element.scrollTop;
  assert.equal(h.controller.writing, true);
  assert.equal(isProgrammaticScroll(h.element), true);
  h.controller.interrupt(); h.step(300);
  assert.equal(h.element.scrollTop, top);
  assert.equal(h.controller.writing, false);
  assert.equal(isProgrammaticScroll(h.element), false);
  h.controller.setFollowing(false); h.controller.contentChanged(); h.step(600);
  assert.equal(h.element.scrollTop, top);
  h.controller.returnToBottom(); h.step(660);
  const disposedTop = h.element.scrollTop;
  assert.equal(isProgrammaticScroll(h.element), true);
  h.controller.dispose(); h.step(900);
  assert.equal(h.element.scrollTop, disposedTop);
  assert.equal(isProgrammaticScroll(h.element), false);
});

test('B4 reduced motion pins both growth and return instantly', t => {
  const h = harness(t); h.reduce();
  h.controller.contentChanged();
  assert.equal(h.element.scrollTop, 400);
  h.element.scrollTop = 0; h.controller.returnToBottom();
  assert.equal(h.element.scrollTop, 400);
  assert.equal(h.frames.size, 0);
});

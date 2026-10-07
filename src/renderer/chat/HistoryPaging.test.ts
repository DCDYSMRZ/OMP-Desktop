import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PagingGate } from './history-paging-model';
import { PrependAnchor } from './HistoryPaging';
import { viewportReadingAnchorHandoff, type ViewportReadingAnchor } from './viewport-reading-anchor';
import { isProgrammaticScroll } from '../ui/motion/programmatic-scroll';

test('paging chains changed cursors only, with one request in flight', () => {
  const gate = new PagingGate();
  assert.equal(gate.begin('a', false, false), false);
  assert.equal(gate.begin('a', true, true), false);
  assert.equal(gate.begin('a', true, false), true);
  assert.equal(gate.begin('b', true, false), false);
  gate.finish(false);
  assert.equal(gate.begin('a', true, false), false);
  assert.equal(gate.begin('b', true, false), true);
  gate.finish(false);
  assert.equal(gate.begin(undefined, true, false), false);
});
test('failure pauses automatic reads until deliberate retry', () => {
  const gate = new PagingGate();
  gate.begin('a', true, false); gate.finish(true);
  assert.equal(gate.begin('b', true, false), false);
  gate.retry();
  assert.equal(gate.begin('a', true, false), true);
});

/** Deterministic geometry host: exercise production lifecycle and anchor helpers. */
function prependFixture(t: TestContext) {
  let viewportTop = 80, contentTop = 620, hidden = false;
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const listeners = new Map<string, EventListener>();
  const root = {
    scrollTop: 500, isConnected: true,
    getBoundingClientRect: () => ({ top: viewportTop, bottom: viewportTop + 600, left: 0, width: 800, height: 600 }),
    querySelectorAll: () => [element],
    querySelector: () => hidden ? null : element,
    contains: (node: unknown) => node === element,
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as HTMLDivElement;
  const element = {
    isConnected: true, dataset: { presentationKey: 'answer:block:0', messageId: 'answer' },
    getBoundingClientRect: () => ({ top: viewportTop + contentTop - root.scrollTop, bottom: viewportTop + contentTop - root.scrollTop + 300, height: 300 }),
    hasAttribute: (name: string) => name === 'data-presentation-key' || name === 'data-message-id',
    getAttribute: (name: string) => name === 'data-presentation-key' ? 'answer:block:0' : name === 'data-message-id' ? 'answer' : null,
    closest: (selector: string) => selector.includes('[hidden]') ? hidden ? element : null : selector === '[data-minimap-id]' ? null : element,
  } as unknown as HTMLElement;
  for (const [name, value] of Object.entries({
    document: { caretRangeFromPoint: () => null }, Text: class {}, CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  let restored: ViewportReadingAnchor | undefined;
  const anchor = new PrependAnchor({ scrollRef: { current: root }, first: 'new', children: null, onReveal: () => {}, onRestore: (_element, snapshot) => { restored = snapshot; } });
  anchor.componentDidMount();
  t.after(() => anchor.componentWillUnmount());
  return { root, element, anchor, frames, listeners, restored: () => restored, prepend(height: number) { contentTop += height; }, hide(value: boolean) { hidden = value; }, moveViewport(top: number) { viewportTop = top; } };
}

test('each prepend compensates only new height after intervening native scrolling', t => {
  const fixture = prependFixture(t);
  const { anchor, root, element } = fixture;
  for (const [index, height] of [360.25, 720.5, 240.125].entries()) {
    if (index) root.scrollTop -= 97.5;
    const before = element.getBoundingClientRect().top;
    const scrollTop = root.scrollTop;
    const snapshot = anchor.getSnapshotBeforeUpdate({ ...anchor.props, first: `older-${index}` });
    fixture.prepend(height);
    anchor.componentDidUpdate(anchor.props, undefined, snapshot);
    assert.equal(root.scrollTop, scrollTop + height);
    assert.equal(element.getBoundingClientRect().top, before);
    assert.equal(anchor.active, false);
    assert.equal(fixture.frames.size, 0);
    assert.equal(isProgrammaticScroll(root), true);
  }
});

test('input invalidates a pending reveal even if its queued callback arrives later', t => {
  const fixture = prependFixture(t);
  const { anchor, root } = fixture;
  const snapshot = anchor.getSnapshotBeforeUpdate({ ...anchor.props, first: 'old' });
  fixture.prepend(400); fixture.hide(true);
  anchor.componentDidUpdate(anchor.props, undefined, snapshot);
  const queued = [...fixture.frames.values()][0];
  assert.equal(anchor.active, true);
  fixture.listeners.get('wheel')!(new Event('wheel'));
  root.scrollTop -= 80; fixture.hide(false);
  queued(0);
  assert.equal(root.scrollTop, 420);
  assert.equal(anchor.active, false);
  assert.equal(fixture.restored(), undefined);
});

test('fragment handoff retains canonical attribute and viewport-relative coordinates', t => {
  const fixture = prependFixture(t);
  const { anchor, root } = fixture;
  const snapshot = anchor.getSnapshotBeforeUpdate({ ...anchor.props, first: 'old' });
  fixture.prepend(280); fixture.moveViewport(160);
  anchor.componentDidUpdate(anchor.props, undefined, snapshot);
  assert.deepEqual(viewportReadingAnchorHandoff(root, fixture.restored()!), { id: 'answer:block:0', attribute: 'data-presentation-key', top: 120, messageId: 'answer', turnId: undefined });
  assert.equal(root.scrollTop, 780);
});

test('reparented text hands off the fragment top rather than the text offset', t => {
  const fixture = prependFixture(t);
  const { anchor, root, element } = fixture;
  const node = new Text(), replacement = new Text();
  let textOffset = 45, connected = true;
  Object.defineProperties(node, { isConnected: { get: () => connected }, parentElement: { value: element }, textContent: { value: 'The reader is midway through this long response.' } });
  Object.defineProperties(replacement, { isConnected: { value: true }, parentElement: { value: element }, textContent: { value: node.textContent } });
  root.contains = candidate => candidate === element || candidate === node || candidate === replacement;
  root.querySelector = ((selector: string) => selector.startsWith('.') ? null : element) as typeof root.querySelector;
  const previousFilter = Object.getOwnPropertyDescriptor(globalThis, 'NodeFilter');
  Object.defineProperty(globalThis, 'NodeFilter', { configurable: true, value: { SHOW_TEXT: 4 } });
  t.after(() => { if (previousFilter) Object.defineProperty(globalThis, 'NodeFilter', previousFilter); else Reflect.deleteProperty(globalThis, 'NodeFilter'); });
  Object.assign(document, { caretRangeFromPoint: () => ({ startContainer: node }), createRange: () => ({ selectNodeContents() {}, getBoundingClientRect: () => ({ top: element.getBoundingClientRect().top + textOffset }) }), createTreeWalker: () => { let visited = false; return { nextNode: () => { if (visited) return null; visited = true; return replacement; } }; } });
  const snapshot = anchor.getSnapshotBeforeUpdate({ ...anchor.props, first: 'old' });
  fixture.prepend(280); textOffset += 90; connected = false;
  anchor.componentDidUpdate(anchor.props, undefined, snapshot);
  assert.equal(root.scrollTop, 870);
  assert.equal(element.getBoundingClientRect().top + textOffset, 245);
  assert.equal(fixture.restored()!.node, replacement);
  assert.deepEqual(viewportReadingAnchorHandoff(root, fixture.restored()!), { id: 'answer:block:0', attribute: 'data-presentation-key', top: 30, messageId: 'answer', turnId: undefined });
});

test('navigation cancels pending reveal without discarding the next prepend', t => {
  const fixture = prependFixture(t);
  const { anchor, root } = fixture;
  const first = anchor.getSnapshotBeforeUpdate({ ...anchor.props, first: 'old' });
  fixture.prepend(200); fixture.hide(true);
  anchor.componentDidUpdate(anchor.props, undefined, first);
  const stale = [...fixture.frames.values()][0];
  anchor.cancel();
  root.scrollTop = 700; fixture.hide(false);
  const next = anchor.getSnapshotBeforeUpdate({ ...anchor.props, first: 'older' });
  fixture.prepend(100); fixture.hide(true);
  anchor.componentDidUpdate(anchor.props, undefined, next);
  const current = [...fixture.frames.values()][0];
  fixture.hide(false);
  stale(0);
  assert.equal(root.scrollTop, 700);
  assert.equal(anchor.active, true);
  current(0);
  assert.equal(root.scrollTop, 800);
  assert.equal(anchor.active, false);
});

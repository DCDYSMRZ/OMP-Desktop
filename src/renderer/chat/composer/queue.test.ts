import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { DesktopQueue } from './queue';
const draft = { text: 'queued', references: [], attachments: [] };

test('settlement sends one item exactly once despite duplicate native frames', async () => {
  const delivered: string[] = [];
  const gate = Promise.withResolvers<void>();
  const queue = new DesktopQueue(async item => { delivered.push(item.input.text); await gate.promise; });
  queue.enqueue('r', 's', { text: 'first' }, draft); queue.enqueue('r', 's', { text: 'second' }, draft);
  queue.settled('r', 's'); queue.settled('r', 's');
  assert.deepEqual(delivered, ['first']);
  gate.resolve(); await setImmediate();
  assert.deepEqual(queue.getSnapshot().map(item => item.input.text), ['second']);
});
test('Stop pauses all entries before native settlement; manual send sends only one', async () => {
  const delivered: string[] = [];
  const queue = new DesktopQueue(async item => { delivered.push(item.input.text); });
  queue.enqueue('r', 's', { text: 'first' }, draft); queue.enqueue('r', 's', { text: 'second' }, draft);
  queue.pause('r'); queue.settled('r', 's');
  assert.deepEqual(delivered, []);
  assert.ok(queue.getSnapshot().every(item => item.paused));
  await queue.send(queue.getSnapshot()[0].id, 'prompt'); queue.settled('r', 's');
  assert.deepEqual(delivered, ['first']);
  assert.deepEqual(queue.getSnapshot().map(item => item.input.text), ['second']);
});
test('insert and atomic replacement use native modes; rejected input is retained paused', async () => {
  const modes: string[] = [];
  const queue = new DesktopQueue(async (_, mode) => { modes.push(mode); if (mode === 'abort_and_prompt') throw new Error('offline'); });
  queue.enqueue('r', 's', { text: 'insert' }, draft);
  await queue.send(queue.getSnapshot()[0].id, 'steer');
  queue.enqueue('r', 's', { text: 'replace' }, draft);
  await assert.rejects(queue.send(queue.getSnapshot()[0].id, 'abort_and_prompt'), /offline/);
  assert.deepEqual(modes, ['steer', 'abort_and_prompt']);
  assert.equal(queue.getSnapshot()[0].paused, true);
  assert.equal(queue.getSnapshot()[0].sending, false);
});
test('session identity, removal and forget prevent unintended delivery', () => {
  const queue = new DesktopQueue(async () => { assert.fail('must not deliver'); });
  queue.enqueue('r', 'old', { text: 'old session' }, draft); queue.settled('r', 'new');
  const removed = queue.remove(queue.getSnapshot()[0].id);
  assert.equal(removed?.draft, draft);
  queue.enqueue('other', 's', { text: 'forgotten' }, draft); queue.forget(['other']);
  assert.deepEqual(queue.getSnapshot(), []);
});
test('new messages can queue in a later run without resuming stopped messages', async () => {
  const delivered: string[] = [];
  const queue = new DesktopQueue(async item => { delivered.push(item.input.text); });
  queue.enqueue('r', 's', { text: 'stopped' }, draft); queue.pause('r');
  queue.enqueue('r', 's', { text: 'later run' }, draft);
  queue.settled('r', 's'); await setImmediate();
  assert.deepEqual(delivered, ['later run']);
  assert.deepEqual(queue.getSnapshot().map(item => item.input.text), ['stopped']);
});

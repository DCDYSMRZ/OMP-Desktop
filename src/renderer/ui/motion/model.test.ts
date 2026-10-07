import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flipDelta, flipSnapshotMode, numberColumns, swapMotionMode } from './model';
test('FLIP preserves the prior painted bounds across relocation and resize', () => {
  const before = { left: 15, top: 31, width: 80, height: 24 }, after = { left: 44, top: 9, width: 100, height: 48 };
  const delta = flipDelta(before, after);
  assert.equal(after.left + delta.x, before.left); assert.equal(after.top + delta.y, before.top);
  assert.equal(after.width * delta.scaleX, before.width); assert.equal(after.height * delta.scaleY, before.height);
});
test('collapsed boxes never produce infinite transforms', () => {
  assert.deepEqual(flipDelta({ left: 0, top: 0, width: 12, height: 20 }, { left: 0, top: 0, width: 0, height: 0 }), { x: 0, y: 0, scaleX: 1, scaleY: 1 });
});
test('number carries preserve units identity and include separators', () => {
  assert.deepEqual(numberColumns('99'), [{ character: '9', key: 1 }, { character: '9', key: 0 }]);
  assert.deepEqual(numberColumns('1,000').map(column => column.key), [4, 3, 2, 1, 0]);
  assert.equal(numberColumns('-10').at(-1)?.key, numberColumns('9').at(-1)?.key);
});

test('swaps skip mount, unchanged content, disabled motion, offscreen content and scrolling', () => {
  assert.equal(swapMotionMode(false, true, true, false, false), 'none');
  assert.equal(swapMotionMode(true, false, true, false, false), 'none');
  assert.equal(swapMotionMode(true, true, false, false, false), 'none');
  assert.equal(swapMotionMode(true, true, true, true, false), 'none');
});

test('visible changed content keeps spatial motion or an opacity-only reduced crossfade', () => {
  assert.equal(swapMotionMode(true, true, true, false, false), 'spatial');
  assert.equal(swapMotionMode(true, true, true, false, true), 'fade');
  assert.equal(swapMotionMode(true, true, false, false, true), 'none');
});

test('disabled lists skip geometry and reenabling establishes a quiet baseline', () => {
  assert.equal(flipSnapshotMode(false, true), 'skip');
  assert.equal(flipSnapshotMode(false, false), 'skip');
  assert.equal(flipSnapshotMode(true, false), 'baseline');
});

test('an enabled list preserves painted row positions across reorder', () => {
  assert.equal(flipSnapshotMode(true, true), 'animate');
  const first = { left: 10, top: 20, width: 100, height: 30 };
  const second = { ...first, top: 50 };
  assert.equal(second.top + flipDelta(first, second).y, first.top);
  assert.equal(first.top + flipDelta(second, first).y, second.top);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approxLength, pointAt, tendrilBetween } from './bezier';
test('tendrils retain exact endpoints with sway and clamp particle progress', () => {
  const from = { x: 4, y: 9 }, to = { x: 103, y: 82 }; const curve = tendrilBetween(from, to, { dx1: 3, dy1: -2, dx2: -2, dy2: 3 });
  assert.deepEqual(pointAt(curve, 0), from); assert.deepEqual(pointAt(curve, 1), to); assert.deepEqual(pointAt(curve, -1), from); assert.deepEqual(pointAt(curve, 2), to);
  assert.ok(approxLength(curve) >= Math.hypot(to.x - from.x, to.y - from.y));
});
test('length grows with layout span and coincident endpoints remain finite', () => {
  let previous = 0;
  for (const distance of [10, 40, 100, 500]) { const length = approxLength(tendrilBetween({ x: 0, y: 0 }, { x: distance, y: distance / 2 })); assert.ok(length > previous); previous = length; }
  assert.ok(approxLength(tendrilBetween({ x: 2, y: 3 }, { x: 2, y: 3 })) < 1e-10);
});

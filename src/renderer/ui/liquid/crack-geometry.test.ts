import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crackPath, crackPoints, crackSpurs } from './crack-geometry';

test('seeded cracks preserve waypoint junctions and bounded perpendicular displacement', () => {
  const anchors = [{ x: 20, y: 0 }, { x: 20, y: 120 }, { x: 80, y: 120 }];
  const points = crackPoints(anchors, 'task:agent', { amplitude: 1.6 });
  assert.deepEqual(points, crackPoints(anchors, 'task:agent', { amplitude: 1.6 }));
  assert.notDeepEqual(points, crackPoints(anchors, 'task:other', { amplitude: 1.6 }));
  assert.deepEqual(points[0], anchors[0]);
  assert.deepEqual(points.at(-1), anchors.at(-1));
  const turn = points.findIndex(point => point.x === 20 && point.y === 120);
  assert.ok(turn > 0);
  for (let index = 0; index <= turn; index++) assert.ok(Math.abs(points[index].x - 20) <= 3.2);
  for (let index = turn; index < points.length; index++) assert.ok(Math.abs(points[index].y - 120) <= 3.2);
});

test('spurs retain minimum arc spacing across multiple waypoint segments', () => {
  const points = [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 240, y: 0 }];
  const spurs = crackSpurs(points, 'task:trunk', { every: [26, 26] });
  assert.deepEqual(spurs, crackSpurs(points, 'task:trunk', { every: [26, 26] }));
  const starts = spurs.map(path => Number(path.match(/^M ([^,]+),/)![1]));
  assert.deepEqual(starts, [26, 52, 78, 104, 130, 156, 182, 208, 234]);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 26);
});

test('empty, zero-length and fractional paths keep their endpoint contract', () => {
  assert.deepEqual(crackPoints([], 'empty'), []);
  assert.deepEqual(crackSpurs([{ x: 2, y: 3 }, { x: 2, y: 3 }], 'zero'), []);
  assert.deepEqual(crackPoints([{ x: 2, y: 3 }, { x: 2, y: 3 }], 'zero'), [{ x: 2, y: 3 }, { x: 2, y: 3 }]);
  assert.equal(crackPath([{ x: 1.23, y: 4.56 }, { x: 7.89, y: 10.12 }]), 'M 1.2,4.6 L 7.9,10.1');
});

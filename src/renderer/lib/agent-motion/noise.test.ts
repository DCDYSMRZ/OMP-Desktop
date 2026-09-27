import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seededNoise } from './noise';
test('seeded sway is repeatable, bounded and smooth across lattice boundaries', () => {
  const a = seededNoise('agent-a'), b = seededNoise('agent-a'), c = seededNoise('agent-b');
  for (let i = -200; i < 200; i++) { const t = i / 13; assert.equal(a(t), b(t)); assert.ok(a(t) >= -1 && a(t) <= 1); }
  assert.notEqual(a(.5), c(.5));
  for (let i = -10; i <= 10; i++) assert.ok(Math.abs(a(i - .0001) - a(i + .0001)) < .00001);
});

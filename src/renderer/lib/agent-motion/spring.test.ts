import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpring, isSpringSettled, springs } from './spring';
for (const [name, config] of Object.entries(springs)) test(name + ' converges after retargeting and remains bounded', () => {
  const spring = createSpring(config, 0); spring.setTarget(1);
  let peak = 0;
  for (let i = 0; i < 600; i++) { spring.step(i % 4 === 0 ? .05 : 1 / 60); peak = Math.max(peak, spring.value); assert.ok(spring.value >= 0 && spring.value < 1.2); }
  assert.equal(spring.value, 1); assert.equal(spring.velocity, 0); assert.ok(spring.settled);
  if (name === 'bloom') assert.ok(peak > 1.05);
  spring.setTarget(-3); for (let i = 0; i < 600; i++) spring.step(1 / 60); assert.equal(spring.value, -3);
  spring.jump(4); assert.equal(spring.target, 4); assert.equal(spring.velocity, 0); assert.ok(spring.settled);
});
test('a background gap cannot destabilize a spring', () => { const spring = createSpring(springs.bloom, 0); spring.setTarget(100); spring.step(20); assert.ok(spring.value > 0 && spring.value < 100); spring.step(0); assert.ok(Number.isFinite(spring.value)); });
test('visual rest requires both strict velocity and distance thresholds', () => {
  const spring = createSpring(springs.gentle, 0);
  spring.target = .099; spring.velocity = .009;
  assert.equal(isSpringSettled(spring), true);
  spring.target = .1; assert.equal(isSpringSettled(spring), false);
  spring.target = -.1; assert.equal(isSpringSettled(spring), false);
  spring.target = -.099; spring.velocity = .01; assert.equal(isSpringSettled(spring), false);
  spring.velocity = -.01; assert.equal(isSpringSettled(spring), false);
  spring.velocity = -.009; assert.equal(isSpringSettled(spring), true);
});
test('reaching visual rest snaps to the target so an unsubscribed node has no residual offset', () => {
  const spring = createSpring(springs.gentle, 0); spring.setTarget(20);
  let steps = 0;
  while (!isSpringSettled(spring) && steps < 600) { spring.step(1 / 60); steps++; }
  assert.ok(steps < 600); assert.equal(spring.value, 20); assert.equal(spring.velocity, 0);
  spring.setTarget(40); assert.equal(isSpringSettled(spring), false);
});

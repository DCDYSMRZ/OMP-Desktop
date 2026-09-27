import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liquidIndicatorScale } from './liquid-indicator-scale';

test('indicator stretch is direction-independent, bounded, and compresses the perpendicular axis by half', () => {
  assert.equal(liquidIndicatorScale(0), 1);
  assert.equal(liquidIndicatorScale(0, true), 1);
  for (const velocity of [240, -240]) {
    assert.equal(liquidIndicatorScale(velocity), 1.1);
    assert.equal(liquidIndicatorScale(velocity, true), .95);
  }
  for (const velocity of [432, -432, 2400, -2400]) {
    assert.equal(liquidIndicatorScale(velocity), 1.18);
    assert.equal(liquidIndicatorScale(velocity, true), .91);
  }
});

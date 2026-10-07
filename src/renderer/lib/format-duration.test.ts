import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed } from './format-duration';

const s = 1000, m = 60 * s, h = 60 * m, d = 24 * h;

test('clock style keeps unbounded minutes and seconds', () => {
  assert.equal(formatElapsed(147 * m + 39 * s, 'clock', 'zh-CN'), '147:39');
  assert.equal(formatElapsed(9 * s, 'clock', 'en'), '00:09');
});

test('unit style promotes to the two most significant units and drops seconds from an hour up', () => {
  assert.equal(formatElapsed(39 * s, 'units', 'zh-CN'), '39秒');
  assert.equal(formatElapsed(27 * m + 9 * s, 'units', 'zh-CN'), '27分钟9秒');
  assert.equal(formatElapsed(2 * h + 27 * m + 39 * s, 'units', 'zh-CN'), '2小时27分钟');
  assert.equal(formatElapsed(3 * d + 4 * h + 5 * m, 'units', 'zh-CN'), '3天4小时');
  assert.equal(formatElapsed(2 * h + 27 * m, 'units', 'en'), '2h 27m');
  assert.equal(formatElapsed(45 * d, 'units', 'en'), '1mo 2w');
});

test('zero, sub-second and negative values read as zero seconds', () => {
  assert.equal(formatElapsed(0, 'units', 'zh-CN'), '0秒');
  assert.equal(formatElapsed(400, 'units', 'en'), '0s');
  assert.equal(formatElapsed(-5 * s, 'clock', 'en'), '00:00');
});

test('a skipped middle unit does not pull in a third unit', () => {
  assert.equal(formatElapsed(2 * h + 5 * s, 'units', 'zh-CN'), '2小时');
  assert.equal(formatElapsed(d + 30 * s, 'units', 'en'), '1d');
});

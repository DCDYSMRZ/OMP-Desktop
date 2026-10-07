import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSessionRelativeTime } from './session-relative-time';

const now = new Date(2026, 8, 28, 12).getTime();
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

test('compact time changes at complete minute and hour boundaries', () => {
  for (const [seconds, expected] of [[59, '刚刚'], [60, '1分'], [3599, '59分'], [3600, '1时'], [10800, '3时']] as const)
    assert.equal(formatSessionRelativeTime(ago(seconds), 'zh-CN', now), expected);
  assert.equal(formatSessionRelativeTime(ago(180), 'en', now), '3m');
});
test('yesterday uses local calendar day and older dates use month/day', () => {
  assert.equal(formatSessionRelativeTime(new Date(2026, 8, 27, 23).toISOString(), 'zh-CN', now), '昨天');
  assert.equal(formatSessionRelativeTime(new Date(2026, 8, 26, 23).toISOString(), 'zh-CN', now), '9/26');
});
test('missing times stay unknown and future clock skew is just now', () => {
  assert.equal(formatSessionRelativeTime('', 'en', now), null);
  assert.equal(formatSessionRelativeTime('not-a-date', 'en', now), null);
  assert.equal(formatSessionRelativeTime(ago(60), 'en', NaN), null);
  assert.equal(formatSessionRelativeTime(ago(-600), 'en', now), 'now');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionStatusUsage } from './session-status';

test('unpersisted statistics reject mismatched identities and malformed usage', () => {
  const stats = { sessionId: 'a', cost: 0, tokens: { input: 10, output: -1, cacheRead: 80, cacheWrite: 10 } };
  assert.equal(sessionStatusUsage(stats, 'b'), null);
  assert.equal(sessionStatusUsage({}, 'a'), null);
  const result = sessionStatusUsage(stats, 'a');
  assert.equal(result?.cost, 0); assert.equal(result?.output, undefined); assert.equal(result?.total, undefined); assert.equal(result?.cacheRead, 80);
});

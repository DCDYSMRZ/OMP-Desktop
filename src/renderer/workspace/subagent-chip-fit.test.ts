import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fittedSubagentCount } from './subagent-model';

test('collapsed rosters reserve the overflow control and never include a partial chip', () => {
 const seven = Array(7).fill(100), overflow = Array(7).fill(34);
 assert.equal(fittedSubagentCount(seven, overflow, 772, 12), 7);
 assert.equal(fittedSubagentCount(seven, overflow, 660, 12), 5);
 assert.equal(fittedSubagentCount(seven, overflow, 396, 12), 3);
 assert.equal(fittedSubagentCount(Array(20).fill(100), Array(20).fill(42), 396, 12), 3);
 assert.equal(fittedSubagentCount([450], [34], 396, 12), 0);
 assert.equal(fittedSubagentCount([100], [34], 396, 12), 1);
 assert.equal(fittedSubagentCount([100, 100], [25, 30], 137, 12), 1);
 assert.equal(fittedSubagentCount([100, 100], [25, 30], 136, 12), 0);
});

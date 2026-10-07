import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFileTarget, parseFileTarget } from './file-target';

test('line selectors split off the path; ranges normalize to an inclusive end line', () => {
  assert.deepEqual(parseFileTarget('src/a.ts:12'), { path: 'src/a.ts', line: 12, endLine: undefined });
  assert.deepEqual(parseFileTarget('src/a.ts:12-40'), { path: 'src/a.ts', line: 12, endLine: 40 });
  assert.deepEqual(parseFileTarget('src/a.ts:12+5'), { path: 'src/a.ts', line: 12, endLine: 16 });
  assert.deepEqual(parseFileTarget('README.md#L3-L9'), { path: 'README.md', line: 3, endLine: 9 });
});

test('non-selector suffixes stay part of the path', () => {
  assert.deepEqual(parseFileTarget('src/a.ts#9906'), { path: 'src/a.ts#9906' });
  assert.deepEqual(parseFileTarget('C:\\repo\\a.ts'), { path: 'C:\\repo\\a.ts' });
  assert.deepEqual(parseFileTarget('src/a.ts:0'), { path: 'src/a.ts:0' });
  // An inverted range keeps the start line and drops the bogus end.
  assert.deepEqual(parseFileTarget('src/a.ts:40-12'), { path: 'src/a.ts', line: 40, endLine: undefined });
});

test('format round-trips through parse', () => {
  for (const value of ['src/a.ts', 'src/a.ts:7', 'src/a.ts:7-9']) assert.equal(formatFileTarget(parseFileTarget(value)), value);
});

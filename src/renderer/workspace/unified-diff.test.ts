import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUnifiedDiff } from './unified-diff';

test('rename metadata is retained without becoming source lines', () => {
  const diff = parseUnifiedDiff('diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n');
  assert.equal(diff.renamedFrom, 'old.ts');
  assert.equal(diff.renamedTo, 'new.ts');
  assert.equal(diff.state, 'noLineDetails');
  assert.deepEqual(diff.hunks, []);
  assert.equal(diff.additions, 0);
  assert.equal(diff.deletions, 0);
});

test('binary changes never masquerade as empty text diffs', () => {
  for (const patch of ['diff --git a/image b/image\nBinary files a/image and b/image differ\n', 'diff --git a/image b/image\nGIT binary patch\nliteral 3\nabc\n']) {
    assert.equal(parseUnifiedDiff(patch).state, 'binary');
    assert.deepEqual(parseUnifiedDiff(patch).hunks, []);
  }
});

test('no-newline markers annotate the preceding side without advancing gutters', () => {
  const diff = parseUnifiedDiff('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  assert.deepEqual(diff.hunks[0].lines, [
    { type: 'del', text: 'old', oldLine: 1, noNewline: true },
    { type: 'add', text: 'new', newLine: 1, noNewline: true },
  ]);
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
});

test('multiple hunks restart both gutters and preserve source resembling headers', () => {
  const diff = parseUnifiedDiff('diff --git a/file b/file\nindex abc..def 100644\n--- a/file\n+++ b/file\n@@ -3,2 +3,3 @@ function\n same\n-old\n+new\n+++source\n@@ -20,0 +22,2 @@\n+later\n+last\n');
  assert.equal(diff.state, 'text');
  assert.deepEqual(diff.hunks.map(hunk => hunk.lines), [
    [
      { type: 'context', text: 'same', oldLine: 3, newLine: 3 },
      { type: 'del', text: 'old', oldLine: 4 },
      { type: 'add', text: 'new', newLine: 4 },
      { type: 'add', text: '++source', newLine: 5 },
    ],
    [{ type: 'add', text: 'later', newLine: 22 }, { type: 'add', text: 'last', newLine: 23 }],
  ]);
  assert.equal(diff.additions, 4);
  assert.equal(diff.deletions, 1);
});

test('oversized line previews retain honest totals and withhold incomplete hunks', () => {
  const diff = parseUnifiedDiff('@@ -0,0 +1,5001 @@\n' + '+line\n'.repeat(5001));
  assert.equal(diff.state, 'tooLarge');
  assert.equal(diff.additions, 5001);
  assert.equal(diff.deletions, 0);
  assert.deepEqual(diff.hunks, []);
});

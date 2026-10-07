import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureReviewReading, restoreReviewReading, retainReviewHunk, type ReviewReadingLine } from './review-reading';

const line: ReviewReadingLine = { type: 'add', text: 'current reading fragment', newLine: 80, top: 90, height: 24, hunk: 1 };

test('same-file rebuilt patch keeps the current line offset through insertions above it', () => {
  const saved = captureReviewReading('workspace:file.ts', 500, 100, [line], 1);
  const updated = { ...line, newLine: 100, top: 210, hunk: 2 };
  assert.deepEqual(restoreReviewReading(saved, 'workspace:file.ts', 500, 100, [updated]), { top: 620, navigated: false });
  assert.deepEqual(restoreReviewReading(saved, 'workspace:file.ts', 500, 100, [{ ...line }]), { top: 500, navigated: false });
});

test('new user reading position replaces the old snapshot before the next refresh', () => {
  const moved = { ...line, top: 95, newLine: 150 };
  const saved = captureReviewReading('workspace:file.ts', 900, 100, [moved], 2);
  assert.deepEqual(restoreReviewReading(saved, 'workspace:file.ts', 900, 100, [{ ...moved, top: 119 }]), { top: 924, navigated: false });
});

test('file and source navigation reset rather than retaining another target', () => {
  const saved = captureReviewReading('workspace:file.ts', 500, 100, [line], 1);
  for (const target of ['workspace:other.ts', 'other-source:file.ts']) {
    assert.deepEqual(restoreReviewReading(saved, target, 500, 100, [line]), { top: 0, navigated: true });
  }
});

test('edited line falls back to its coordinate and missing line retains the current viewport', () => {
  const saved = captureReviewReading('file', 500, 100, [line], 1);
  assert.equal(restoreReviewReading(saved, 'file', 500, 100, [{ ...line, text: 'edited', top: 138 }]).top, 548);
  assert.equal(restoreReviewReading(saved, 'file', 500, 100, []).top, 500);
});

test('selected hunk survives inserted hunks and clamps when removed', () => {
  const selected = { header: '@@ old @@', lines: [line] };
  const inserted = { header: '@@ inserted @@', lines: [{ ...line, text: 'other', newLine: 1 }] };
  const moved = { header: '@@ moved @@', lines: [{ ...line, newLine: 100 }] };
  assert.equal(retainReviewHunk(selected, 0, [inserted, moved]), 1);
  assert.equal(retainReviewHunk(selected, 4, [inserted]), 0);
  assert.equal(retainReviewHunk(selected, 4, []), 0);
});

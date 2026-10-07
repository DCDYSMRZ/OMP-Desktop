import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resumeThinkingFollow } from './thinking-follow';

test('reasoning resumes against the bottom when downward user input began', () => {
  // Reproduced wheel: height 314 -> 345 before scroll delivery, gap 31.5.
  assert.equal(resumeThinkingFollow(1, 31.5, 31), true);
  assert.equal(resumeThinkingFollow(1, 39, 31), true);
  assert.equal(resumeThinkingFollow(1, 39.5, 31), false);
});
test('partial downward reading stays paused despite growth', () => {
  assert.equal(resumeThinkingFollow(1, 91.5, 31), false);
});
test('upward or absent user movement never resumes reasoning follow', () => {
  assert.equal(resumeThinkingFollow(-1, 0, 31), false);
  assert.equal(resumeThinkingFollow(-1, 8, 0), false);
  assert.equal(resumeThinkingFollow(0, 0, 31), false);
});

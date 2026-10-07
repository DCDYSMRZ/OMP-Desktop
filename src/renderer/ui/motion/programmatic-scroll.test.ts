import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearProgrammaticScroll, isProgrammaticScroll, noteProgrammaticScroll } from './programmatic-scroll';

test('recorded browser position identifies asynchronous programmatic scroll events', () => {
  const element = { scrollTop: 10.5 };
  noteProgrammaticScroll(element);
  assert.equal(isProgrammaticScroll(element), true);
  assert.equal(isProgrammaticScroll(element), true);
});

test('a later user position change is not programmatic', () => {
  const element = { scrollTop: 20 };
  noteProgrammaticScroll(element);
  element.scrollTop = 19.5;
  assert.equal(isProgrammaticScroll(element), false);
});

test('equal positions on different elements do not share ownership', () => {
  const element = { scrollTop: 0 };
  noteProgrammaticScroll(element);
  assert.equal(isProgrammaticScroll({ scrollTop: 0 }), false);
  assert.equal(isProgrammaticScroll(null), false);
  assert.equal(isProgrammaticScroll({}), false);
});

test('interrupting or disposing ownership restores user scroll handling', () => {
  const element = { scrollTop: 7 };
  noteProgrammaticScroll(element);
  clearProgrammaticScroll(element);
  assert.equal(isProgrammaticScroll(element), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewRelativePath } from './review-path';

test('macOS aliases match workspace diff identities in both directions', () => {
  for (const directory of ['tmp', 'var', 'etc']) {
    const alias = '/' + directory + '/omp-live/workspace';
    const canonical = '/private' + alias;
    assert.equal(reviewRelativePath(canonical, alias + '/verification.txt'), 'verification.txt');
    assert.equal(reviewRelativePath(alias, canonical + '/src/verification.txt'), 'src/verification.txt');
    assert.equal(reviewRelativePath(canonical, canonical + '/verification.txt'), 'verification.txt');
  }
});

test('relative paths and line targets retain the diff list identity', () => {
  assert.equal(reviewRelativePath('/private/tmp/project/', 'src/verification.txt'), 'src/verification.txt');
  assert.equal(reviewRelativePath('/private/tmp/project/', './verification.txt:4-8'), 'verification.txt');
  assert.equal(reviewRelativePath('/private/tmp/project/', '/tmp/project/verification.txt#L4'), 'verification.txt');
  assert.equal(reviewRelativePath('C:\\project', 'C:\\project\\src\\file.ts:3'), 'src/file.ts');
});

test('outside paths never match by basename or partial workspace prefix', () => {
  assert.equal(reviewRelativePath('/private/tmp/project', '/tmp/project-other/verification.txt'), '/tmp/project-other/verification.txt');
  assert.equal(reviewRelativePath('/private/tmp/project', '/tmp/elsewhere/verification.txt'), '/tmp/elsewhere/verification.txt');
  assert.equal(reviewRelativePath('/private/project', '/project/verification.txt'), '/project/verification.txt');
  assert.equal(reviewRelativePath('/tmp/project', '/private/tmp-other/project/verification.txt'), '/private/tmp-other/project/verification.txt');
});
test('shell-relative parent segments group with the same recorded file', () => {
  assert.equal(reviewRelativePath('/work', 'src/locales/messages/../init.ts'), 'src/locales/init.ts');
  assert.equal(reviewRelativePath('/work', '/work/src/./a.ts'), 'src/a.ts');
  assert.equal(reviewRelativePath('/work', '../outside/a.ts'), '../outside/a.ts');
});

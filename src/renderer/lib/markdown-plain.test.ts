import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainMarkdownLine } from './markdown-plain';

test('paired emphasis, code, links and block markers are removed', () => {
  assert.equal(plainMarkdownLine('**Reading backend report**'), 'Reading backend report');
  assert.equal(plainMarkdownLine('## Target: *fix* the `parser`'), 'Target: fix the parser');
  assert.equal(plainMarkdownLine('- see [docs](https://x.y) and ~~old~~ _new_ path'), 'see docs and old new path');
});

test('identifiers with underscores or lone asterisks stay literal', () => {
  assert.equal(plainMarkdownLine('FIXTURE_CHILD=ScanFrontend'), 'FIXTURE_CHILD=ScanFrontend');
  assert.equal(plainMarkdownLine('set MAX__RETRIES and x_y_z'), 'set MAX__RETRIES and x_y_z');
  assert.equal(plainMarkdownLine('call snake_case_name with a*b'), 'call snake_case_name with a*b');
});

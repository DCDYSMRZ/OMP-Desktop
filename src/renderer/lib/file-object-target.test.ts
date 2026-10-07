import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileObjectPath, parseEditorTarget } from './file-object-target';

test('editor targets retain lines and columns without copying selectors into paths', () => {
  for (const value of ['src/a.ts:42-50', 'src/a.ts:42+9', 'src/a.ts#L42-L50']) assert.deepEqual(parseEditorTarget(value), { path: 'src/a.ts', line: 42 });
  assert.deepEqual(parseEditorTarget('src/a.ts:42:7'), { path: 'src/a.ts', line: 42, column: 7 });
  assert.deepEqual(parseEditorTarget('C:\\work\\a.ts:42:7'), { path: 'C:\\work\\a.ts', line: 42, column: 7 });
  assert.deepEqual(parseEditorTarget('readme#AB12'), { path: 'readme#AB12' });
  assert.deepEqual(parseEditorTarget('C:'), { path: 'C:' });
  assert.deepEqual(parseEditorTarget('src/a.ts'), { path: 'src/a.ts' });
  for (const value of ['src/a.ts:0:7', 'src/a.ts:7:0', 'src/a.ts#L0', 'src/a.ts:9007199254740992']) assert.deepEqual(parseEditorTarget(value), { path: value });
});

test('copy path resolves relative locations and preserves absolute paths', () => {
  assert.equal(fileObjectPath('/workspace/', 'src/a.ts'), '/workspace/src/a.ts');
  assert.equal(fileObjectPath('/workspace', '/other/a.ts'), '/other/a.ts');
  assert.equal(fileObjectPath('C:\\workspace', 'a.ts'), 'C:\\workspace\\a.ts');
  assert.equal(fileObjectPath('C:\\workspace', 'D:\\a.ts'), 'D:\\a.ts');
});

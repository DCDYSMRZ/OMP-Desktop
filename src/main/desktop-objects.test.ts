import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorCommand, validateDesktopFileRequest } from './desktop-objects';

test('editor commands preserve a single literal target and exact line and column', () => {
  const target = { path: '/work/a space;$(touch nope)\".ts', line: 42, column: 7 };
  for (const editor of ['vscode', 'cursor'] as const) {
    assert.deepEqual(editorCommand(editor, target, `/bin/${editor}`), { executable: `/bin/${editor}`, args: ['-g', `${target.path}:42:7`] });
    assert.deepEqual(editorCommand(editor, { path: target.path, line: 2 }, '/editor').args, ['-g', `${target.path}:2:1`]);
  }
  assert.deepEqual(editorCommand('zed', target, '/bin/zed'), { executable: '/bin/zed', args: [`${target.path}:42`] });
  assert.deepEqual(editorCommand('vscode', { path: '/work/file' }, '/editor').args, ['-g', '/work/file']);
});

test('mac application fallbacks keep location arguments, other platforms require a CLI', () => {
  for (const [editor, app] of [['vscode', 'Visual Studio Code'], ['cursor', 'Cursor'], ['zed', 'Zed']] as const) {
    assert.deepEqual(editorCommand(editor, { path: '/work/file', line: 9 }, undefined, 'darwin'), { executable: '/usr/bin/open', args: ['-a', app, '--args', ...(editor === 'zed' ? ['/work/file:9'] : ['-g', '/work/file:9:1'])] });
    assert.throws(() => editorCommand(editor, { path: '/work/file' }, undefined, 'linux'), /PATH/);
  }
});

test('desktop file requests reject malformed paths, unsupported fields, and invalid positions', () => {
  const request = { cwd: '/work', path: 'file.ts' };
  assert.deepEqual(validateDesktopFileRequest({ ...request, line: 1, column: 2 }, true), { ...request, line: 1, column: 2 });
  for (const value of [null, [], {}, { ...request, path: '' }, { ...request, path: 'x\0y' }, { ...request, cwd: 'x\ny' }, { ...request, path: 'x'.repeat(4097) }, { ...request, command: 'code' }]) assert.throws(() => validateDesktopFileRequest(value, true));
  for (const line of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]) assert.throws(() => validateDesktopFileRequest({ ...request, line }, true));
  assert.throws(() => validateDesktopFileRequest({ ...request, column: 1 }, true));
  assert.throws(() => validateDesktopFileRequest({ ...request, line: 1 }));
});

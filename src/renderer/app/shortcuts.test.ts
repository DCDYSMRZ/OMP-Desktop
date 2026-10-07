import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShortcut, shortcutKeycaps, type ShortcutEvent } from './shortcuts';
const event = (patch: Partial<ShortcutEvent>): ShortcutEvent => ({ key: 'k', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...patch });
test('platform primary modifier and shifted scopes are unambiguous', () => {
  assert.equal(resolveShortcut(event({ metaKey: true }), 'darwin', true), 'palette');
  assert.equal(resolveShortcut(event({ ctrlKey: true }), 'win32', true), 'palette');
  assert.equal(resolveShortcut(event({ ctrlKey: true }), 'darwin'), undefined);
  assert.equal(resolveShortcut(event({ key: 'f', metaKey: true }), 'darwin'), 'find');
  assert.equal(resolveShortcut(event({ key: 'F', metaKey: true, shiftKey: true }), 'darwin'), 'search-messages');
  assert.equal(resolveShortcut(event({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'darwin'), 'prev-tab');
});
test('handled events, IME, extra modifiers and editable question marks do not navigate', () => {
  for (const patch of [{ defaultPrevented: true }, { isComposing: true }, { keyCode: 229 }, { altKey: true }, { shiftKey: true }]) assert.equal(resolveShortcut(event({ metaKey: true, ...patch }), 'darwin'), undefined);
  assert.equal(resolveShortcut(event({ key: '?', shiftKey: true }), 'darwin', true), undefined);
  assert.equal(resolveShortcut(event({ key: '?', shiftKey: true }), 'darwin'), 'shortcuts');
});
test('keycaps preserve platform modifiers and unbound actions have no invented binding', () => {
  assert.deepEqual(shortcutKeycaps('search-messages', 'darwin'), ['⌘', '⇧', 'F']);
  assert.deepEqual(shortcutKeycaps('search-messages', 'linux'), ['Ctrl', 'Shift', 'F']);
  assert.deepEqual(shortcutKeycaps('open-files', 'darwin'), []);
});

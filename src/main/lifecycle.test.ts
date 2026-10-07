import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lifecycleDecision, quitDialogOptions, validateAttention, validateNotification, validateWindowTitle, shouldNotify } from './lifecycle';

test('closing busy macOS windows hides them; all explicit quits confirm', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(lifecycleDecision('close', platform, 0), 'quit');
    assert.equal(lifecycleDecision('quit', platform, 0), 'quit');
    assert.equal(lifecycleDecision('close', platform, 2), platform === 'darwin' ? 'hide' : 'confirm');
    assert.equal(lifecycleDecision('quit', platform, 2), 'confirm');
  }
});

test('the quit confirmation never defaults or escapes to the destructive action', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const options = quitDialogOptions(language, 2);
    assert.equal(options.defaultId, 1);
    assert.equal(options.cancelId, 1);
  }
});

test('attention payloads accept only bounded badge counts and known bounce modes', () => {
  assert.deepEqual(validateAttention({ badge: '12', bounce: 'informational' }), { badge: '12', bounce: 'informational' });
  assert.equal(validateAttention({ badge: '' }).badge, '');
  for (const value of [null, [], { badge: 2 }, { badge: '0' }, { badge: '1000000' }, { badge: '-1' }, { badge: '1', bounce: 'forever' }, { badge: '1', extra: true }]) assert.throws(() => validateAttention(value));
});

test('notification and title payloads reject controls, oversized fields and unknown keys', () => {
  assert.equal(validateWindowTitle('Session — Project · Running'), 'Session — Project · Running');
  const payload = { title: 'OMP-Desktop', body: 'Session · Needs reply', runtimeId: 'r' };
  assert.deepEqual(validateNotification(payload), payload);
  for (const value of [null, '', ' '.repeat(10), 'x'.repeat(513), 'title\nspoof', 7]) assert.throws(() => validateWindowTitle(value));
  for (const value of [null, [], { ...payload, extra: true }, { ...payload, title: 'x'.repeat(161) }, { ...payload, body: 'x'.repeat(321) }, { ...payload, runtimeId: 'x'.repeat(257) }, { ...payload, body: 'secret\0' }, { ...payload, runtimeId: '' }]) assert.throws(() => validateNotification(value));
});

test('native notification policy requires opt-in and a background window', () => {
  for (const enabled of [true, false]) for (const visible of [true, false]) for (const focused of [true, false]) assert.equal(shouldNotify(enabled, visible, focused), enabled && !(visible && focused));
});

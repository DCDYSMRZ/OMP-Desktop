import assert from 'node:assert/strict';
import { test } from 'node:test';
import i18next from 'i18next';
import { errorsMessages } from '../locales/messages/errors';
import { presentUserError, preserveUserError, stripIpcError, UserFacingError } from './user-errors';
import { nativeError, unwrapNativeFailure } from '../../shared/native-error';

test('native error codes produce localized recovery guidance without leaking transport or paths', async () => {
  await i18next.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: errorsMessages['zh-CN'] } } });
  for (const [code, kind] of Object.entries({ EACCES: 'permission', EPERM: 'permission', ENOENT: 'missing', ENOSPC: 'space', ECONNREFUSED: 'connection', ETIMEDOUT: 'timeout' })) {
    const raw = `Error invoking remote method 'desktop:preferences': Error: ${code}: /private/data`;
    const result = presentUserError(new Error(raw));
    assert.equal(result.kind, kind);
    assert.match(result.message, /[\u4e00-\u9fff]/);
    assert.match(result.action, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(result.message + result.action, /desktop:|Error:|private|EACCES|EPERM|ENOENT|ENOSPC|ECONNREFUSED|ETIMEDOUT/);
    assert.equal(result.details, raw);
  }
  assert.equal(stripIpcError("Error invoking remote method 'desktop:request': TypeError: Invalid thinking level"), 'Invalid thinking level');
  assert.equal(presentUserError({ code: 'EPERM', message: 'write failed' }).kind, 'permission');
  assert.equal(presentUserError('500 Internal Server Error').kind, 'provider');
  assert.equal(presentUserError('Runtime exited: signal').kind, 'runtime');
  assert.equal(presentUserError('Invalid thinking level').kind, 'thinking');
  assert.equal(presentUserError('401 Unauthorized').kind, 'credentials');
  assert.equal(presentUserError('Invalid native session header').kind, 'source');
  assert.equal(presentUserError('Unsupported native journal version').kind, 'sourceVersion');
  assert.equal(presentUserError('History listing reached its file limit').kind, 'sourceLimit');
  assert.equal(presentUserError('Quota exhausted').kind, 'quota');
  assert.equal(presentUserError('HTTP 429').kind, 'quota');
  assert.equal(presentUserError(nativeError('Persistence failed')).nativeMessage, 'Persistence failed');
  assert.equal(presentUserError('sensitive unknown diagnostic').kind, 'generic');
});

test('desktop history authorization failures never masquerade as native provider messages', async () => {
  await i18next.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: errorsMessages['zh-CN'] } } });
  for (const cause of ['Choose a native session file or select it from history first', 'The source session has not been persisted or is no longer available.']) {
    const raw = `Error invoking remote method 'desktop:watchHistory': Error: ${cause}`;
    const result = presentUserError(raw);
    assert.equal(result.kind, 'sourceAccess');
    assert.equal(result.nativeMessage, undefined);
    assert.match(result.message, /[\u4e00-\u9fff]/);
    assert.match(result.action, /[\u4e00-\u9fff]/);
    assert.equal(result.details, raw);
  }
});

test('only structurally marked desktop instructions pass through as primary copy', () => {
  for (const message of ['更改配置前，请先断开活动的运行时。', 'Disconnect the active runtime before changing profiles.']) {
    const result = presentUserError(new UserFacingError(message));
    assert.equal(result.kind, 'userFacing');
    assert.equal(result.message, message);
    assert.equal(result.action, '');
    assert.equal(result.nativeMessage, undefined);
    assert.equal(result.details, '');
    const unknown = presentUserError(new Error(message));
    assert.equal(unknown.kind, 'generic');
    assert.equal(unknown.nativeMessage, undefined);
    assert.notEqual(unknown.message, message);
  }
  const result = presentUserError(new UserFacingError('Choose another folder.', 'permission diagnostic'));
  assert.equal(result.message, 'Choose another folder.');
  assert.equal(result.details, 'permission diagnostic');
});

test('unknown errors expose native copy only when the source explicitly identifies omp', () => {
  const message = 'Saved task history changed; refresh history';
  for (const cause of [message, new Error(message), { message }]) {
    const presented = presentUserError(cause);
    assert.equal(presented.kind, 'generic');
    assert.equal(presented.nativeMessage, undefined);
    assert.equal(presented.details, message);
  }
  const native = nativeError('Custom provider constraint: route unavailable', 'set_model');
  const copied = structuredClone({ desktopNativeFailure: native });
  assert.throws(() => unwrapNativeFailure(copied), cause => {
    const presented = presentUserError(cause);
    assert.equal(presented.nativeMessage, native.message);
    assert.equal(presented.details, native.message);
    assert.equal(presentUserError(preserveUserError(cause)).nativeMessage, native.message);
    return true;
  });
  assert.equal(presentUserError(nativeError('HTTP 500')).nativeMessage, undefined);
});

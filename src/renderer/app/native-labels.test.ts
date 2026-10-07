import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstance } from 'i18next';
import { shellMessages } from '../locales/messages/shell';
import { displayExtensionOption } from './native-labels';
import { displaySessionTitle } from '../lib/session-title';

test('reserved ask labels localize without changing custom options or their wire values', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'zh-CN', keySeparator: false, resources: { 'zh-CN': { translation: shellMessages['zh-CN'] }, en: { translation: shellMessages.en } } });
  const options = Object.freeze(['Other (type your own)', 'Chat about this', 'Next →', 'Other', 'constructor', '发布更新']);
  const labels = options.map(option => displayExtensionOption(option, key => i18n.t(key)));
  assert.deepEqual(labels, ['其他（自行输入）', '讨论这个问题', '下一步 →', 'Other', 'constructor', '发布更新']);
  assert.deepEqual(options, ['Other (type your own)', 'Chat about this', 'Next →', 'Other', 'constructor', '发布更新']);
  await i18n.changeLanguage('en');
  assert.deepEqual(options.map(option => displayExtensionOption(option, key => i18n.t(key))), options);
});

test('only the exact history fallback title is translated and named sessions remain untouched', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'zh-CN', keySeparator: false, resources: { 'zh-CN': { translation: shellMessages['zh-CN'] } } });
  const title = 'Untitled session';
  assert.equal(displaySessionTitle(title, key => i18n.t(key)), '未命名会话');
  assert.equal(title, 'Untitled session');
  for (const named of ['Untitled session review', 'My session', '我的会话', 'untitled session']) assert.equal(displaySessionTitle(named, key => i18n.t(key)), named);
  assert.equal(displaySessionTitle(undefined, key => i18n.t(key)), '未命名会话');
  assert.equal(displaySessionTitle('', key => i18n.t(key)), '未命名会话');
});

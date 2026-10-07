import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightSetting, indexDesktopSettings, indexNativeSettings, providerGroup, receiptProvenance, searchSettings, settingGroup, stringRoleRecord } from './settings-model';
import { settingsMessages } from '../locales/messages/settings';

const entries = [{ key: 'modelRoles', type: 'record', description: '', value: { default: 'provider/model' } }, { key: 'compaction.enabled', type: 'boolean', description: '', value: true }, { key: 'network.retry', type: 'number', description: 'Retry failed requests', value: 2 }, { key: 'auth.token', type: 'string', description: '', credential: true, redacted: true }];
test('Chinese model search discovers localized common rows and English aliases in either locale', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    const rows = indexNativeSettings(entries, key => settingsMessages[locale][key] ?? key);
    assert.deepEqual(searchSettings(rows, '模型').map(row => row.key), ['modelRoles']);
    assert.deepEqual(searchSettings(rows, 'MODEL TASK').map(row => row.key), ['modelRoles']);
    assert.deepEqual(searchSettings(rows, 'retry failed').map(row => row.key), ['network.retry']);
    assert.equal(rows.find(row => row.key === 'auth.token')?.category, 'credentials');
    assert.deepEqual(searchSettings(rows, 'no-such-setting'), []);
  }
});
test('desktop search indexes help and aliases at row granularity', () => {
  const rows = indexDesktopSettings(key => key === 'omp.settings.leaveBlankToDiscoverInstalledOmpBrowseSelectsA' ? 'Discover installed executable' : key);
  assert.deepEqual(searchSettings(rows, '字体').map(row => row.key), ['fontFamily']);
  assert.deepEqual(searchSettings(rows, 'discover').map(row => row.key), ['executablePath']);
  assert.deepEqual(searchSettings(rows, 'cursor').map(row => row.key), ['preferredEditor']);
});
test('curated advanced help stays localized without hiding unknown native metadata', () => {
  const rows = indexNativeSettings([{ key: 'model.loopGuard.enabled', type: 'boolean', description: 'Native repetition description' }, { key: 'vendor.future', type: 'string', description: 'Future vendor setting' }], key => settingsMessages['zh-CN'][key] ?? key);
  assert.equal(rows[0].category, 'advanced');
  assert.deepEqual(searchSettings(rows, '重复').map(row => row.key), ['model.loopGuard.enabled']);
  assert.deepEqual(searchSettings(rows, 'Native repetition').map(row => row.key), ['model.loopGuard.enabled']);
});
test('highlight treats keys and regex punctuation literally and retains complete text', () => {
  assert.deepEqual(highlightSetting('A a.b and aXb', 'a.b'), [{ text: 'A ', match: false }, { text: 'a.b', match: true }, { text: ' and aXb', match: false }]);
  assert.equal(highlightSetting('模型 Model model', '模型 model').filter(part => part.match).length, 3);
  assert.equal(highlightSetting('x [a] y', '[a]').map(part => part.text).join(''), 'x [a] y');
});
test('known structures use roles while unexpected values remain JSON', () => {
  assert.equal(stringRoleRecord({ default: 'a/b', custom: '@slow' }), true);
  for (const value of [null, [], { default: 3 }, { default: { id: 'x' } }]) assert.equal(stringRoleRecord(value), false);
  assert.equal(settingGroup('compaction.custom'), 'context');
});
test('source chips never infer provenance from an effective value or reset', () => {
  const snapshot = { entries: [], directory: '/tmp' };
  assert.equal(receiptProvenance({ snapshot }, true), 'unknown');
  assert.equal(receiptProvenance({ snapshot }, false), 'global');
  assert.equal(receiptProvenance({ snapshot, overriddenBy: 'project' }, false), 'project');
  assert.equal(receiptProvenance({ snapshot, overriddenBy: 'OMP_MODEL' }, false), 'environment');
  assert.equal(receiptProvenance({ snapshot, overriddenBy: 'overlay' }, false), 'override');
  assert.equal(receiptProvenance({ snapshot, fallbackEnv: 'OMP_MODEL' }, false), 'environment');
});
test('native namespaces have task-oriented destinations and terminal-only keys never mix with desktop preferences', () => {
  for (const key of ['statusLine.preset', 'tui.mouse', 'composer.shape', 'task.showResolvedModelBadge']) assert.equal(settingGroup(key), 'terminal');
  for (const key of ['task.maxConcurrency', 'async.maxJobs', 'worktree.base']) assert.equal(settingGroup(key), 'tasks');
  for (const key of ['startup.checkUpdate', 'autoResume', 'update.channel']) assert.equal(settingGroup(key), 'startup');
  assert.equal(settingGroup('retry.maxRetries'), 'network');
  assert.equal(settingGroup('vendor.future'), 'namespace:vendor');
});
test('curated native settings are discoverable in Chinese and English without losing raw-key search', () => {
  const native = ['task.maxConcurrency', 'compaction.keepRecentTokens', 'startup.checkUpdate', 'tui.mouse'].map(key => ({ key, type: 'number', description: '' }));
  for (const locale of ['zh-CN', 'en'] as const) {
    const rows = indexNativeSettings(native, key => settingsMessages[locale][key] ?? key);
    assert.deepEqual(searchSettings(rows, '子代理 并发').map(row => row.key), ['task.maxConcurrency']);
    assert.deepEqual(searchSettings(rows, 'recent tokens').map(row => row.key), ['compaction.keepRecentTokens']);
    assert.deepEqual(searchSettings(rows, 'startup.check').map(row => row.key), ['startup.checkUpdate']);
  }
});
test('provider grouping distinguishes API-key prompts from subscriptions and local servers', () => {
  assert.equal(providerGroup({ id: 'deepseek', authenticated: false }), 'api');
  assert.equal(providerGroup({ id: 'openai-codex', authenticated: false }), 'login');
  assert.equal(providerGroup({ id: 'ollama', authenticated: false }), 'local');
  assert.equal(providerGroup({ id: 'ollama-cloud', authenticated: false }), 'api');
  assert.equal(providerGroup({ id: 'deepseek', authenticated: true }), 'configured');
});
test('search preserves native description attribution without attributing translated desktop help to omp', () => {
  const rows = indexNativeSettings([{ key: 'task.maxConcurrency', type: 'number', description: 'Maximum concurrent tasks' }, { key: 'modelRoles', type: 'record', description: 'Native role information' }, { key: 'vendor.empty', type: 'string', description: '' }], key => settingsMessages['zh-CN'][key] ?? key);
  assert.equal(rows[0].nativeDescription, true);
  assert.equal(rows[1].nativeDescription, false);
  assert.equal(rows[2].nativeDescription, false);
  assert.deepEqual(searchSettings(rows, 'concurrent tasks').map(row => row.key), ['task.maxConcurrency']);
});

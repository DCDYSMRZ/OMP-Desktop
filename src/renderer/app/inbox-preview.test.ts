import assert from 'node:assert/strict';
import { test } from 'node:test';
import i18next from 'i18next';
import { errorsMessages } from '../locales/messages/errors';
import { inboxPreview } from './inbox-preview';

test('failure previews hide native diagnostics and follow the current display language', async () => {
  await i18next.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: errorsMessages['zh-CN'] }, en: { translation: errorsMessages.en } } });
  for (const kind of ['failed', 'child'] as const) {
    for (const snippet of ['500 Local provider unavailable. Retry your request.', '401 invalid API key private-token', 'Unrecognized native failure /private/workspace']) {
      const item = { kind, snippet };
      const chinese = inboxPreview(item)!;
      assert.match(chinese, /[\u4e00-\u9fff]/);
      assert.doesNotMatch(chinese, /500|401|Local provider|private-token|private\/workspace|Unrecognized/);
      await i18next.changeLanguage('en');
      const english = inboxPreview(item)!;
      assert.doesNotMatch(english, /[\u4e00-\u9fff]|500|401|Local provider|private-token|private\/workspace|Unrecognized/);
      assert.notEqual(english, chinese);
      assert.equal(item.snippet, snippet);
      await i18next.changeLanguage('zh-CN');
    }
  }
  assert.equal(inboxPreview({ kind: 'failed' }), undefined);
  for (const kind of ['prompt', 'completed'] as const) {
    assert.equal(inboxPreview({ kind, snippet: 'Investigate 500 errors in this project' }), 'Investigate 500 errors in this project');
  }
});

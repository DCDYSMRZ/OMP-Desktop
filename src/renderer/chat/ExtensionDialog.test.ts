import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionPromptHeading } from './extension-prompt';
test('custom ask editors separate the question from terminal choices', () => {
  assert.deepEqual(extensionPromptHeading('这次优先验证哪个界面？\n○ 计划与子代理\n检查进度\n◉ Other (type your own)\nEnter your response:', 'editor'), { title: '这次优先验证哪个界面？', custom: true });
});
test('ordinary user questions and selection titles remain intact', () => {
  for (const title of ['Explain ○ in this diagram', 'Enter your response:', 'Which?\n○ One\n◉ Two']) assert.deepEqual(extensionPromptHeading(title, 'editor'), { title, custom: false });
  const title = 'Question ○ One ◉ Other (type your own) Enter your response:';
  assert.deepEqual(extensionPromptHeading(title, 'select'), { title, custom: false });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatState } from './model';
import { deriveHomeReadiness, sessionProseExcerpt } from './home-model';

const chat = (patch: Partial<ChatState> = {}) => ({ models: [], state: { sessionId: 'one', isStreaming: false }, messages: [], ...patch } as ChatState);

test('setup lists only missing prerequisites in dependency order', () => {
  assert.deepEqual(deriveHomeReadiness({ available: false }, '', []).missing, ['installed', 'workspace']);
  assert.deepEqual(deriveHomeReadiness({ available: true }, '/project', [chat()]).missing, ['model']);
  assert.deepEqual(deriveHomeReadiness({ available: true }, '', []).missing, ['workspace']);
});
test('a usable model needs no first conversation milestone', () => {
  const ready = chat({ models: [{ id: 'model', provider: 'provider' }] });
  assert.equal(deriveHomeReadiness({ available: true }, '/project', [ready]).complete, true);
  assert.equal(deriveHomeReadiness({ available: true }, '/project', []).complete, true);
  assert.equal(deriveHomeReadiness(undefined, '/project', []).complete, true);
});
test('native startup failures distinguish missing credentials from unrelated connection failures', () => {
  assert.deepEqual(deriveHomeReadiness({ available: true }, '/project', [], 'Native RPC stdout closed: No models available. Use /login or set an API key environment variable.').missing, ['model']);
  assert.deepEqual(deriveHomeReadiness({ available: true }, '/project', [], 'Native RPC stdout closed: No model available matching enabledModels (provider/model) with usable credentials. Configure auth for an allowed provider or adjust enabledModels.').missing, ['model']);
  assert.deepEqual(deriveHomeReadiness({ available: true }, '/project', [], 'Connection refused').missing, []);
});

test('recent excerpts skip code and language labels and prefer prose over headings and lists', () => {
  const markdown = '# Result\n\n- **Files changed**\n\n```text\nLIVE_FIXTURE_COMPLETE\n```\n\n**Fixed** the [search](https://example.test) bug.\nThe results now stay ordered. More details follow.\n\n## Checks\nPassed.';
  assert.equal(sessionProseExcerpt(markdown), 'Fixed the search bug. The results now stay ordered.');
  assert.equal(sessionProseExcerpt('~~~json\n{"key":"value"}\n~~~\n\n已修复 **排序**。\n保留原有接口。更多信息。'), '已修复 排序。 保留原有接口。');
  assert.equal(sessionProseExcerpt('````typescript\n```\nnot prose\n````\n\nA clean answer.'), 'A clean answer.');
});

test('recent excerpts omit unfinished fences, retain inline code and fall back to cleaned list prose', () => {
  assert.equal(sessionProseExcerpt('```text\nOnly code'), '');
  assert.equal(sessionProseExcerpt('- Fixed `sort_items` and **preserved** a*b.\n- Second item'), 'Fixed sort_items and preserved a*b.');
  assert.equal(sessionProseExcerpt('  A   useful\nanswer with `inline_code`.  '), 'A useful answer with inline_code.');
  assert.equal(sessionProseExcerpt('x'.repeat(260)), 'x'.repeat(239) + '…');
  assert.equal(sessionProseExcerpt('## Done\n- **A** passed\n\n| Area | Result |\n| --- | --- |\n| Backend | Passed |\n\nThe generated `report.txt` records the results.'), 'The generated report.txt records the results.');
});

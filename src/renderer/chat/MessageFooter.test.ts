import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { ChatMessage } from './model';

// Isolate the portal/motion host; the footer still constructs its own children.
const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' };
  if (url.endsWith('/ui/AnchoredMenu.tsx')) return { format: 'module', shortCircuit: true, source: 'export function AnchoredMenu() { return null; }' };
  return nextLoad(url, context);
} });
// Static import would execute before the CSS/portal module-loading boundary is installed.
const { MessageFooter } = await import('./MessageFooter');
const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

test('closed footers never read original message bodies or format per-request usage cells', t => {
  let contentReads = 0;
  const raw = { role: 'assistant', model: 'model', timestamp: 1000, usage: { input: 120, output: 20, totalTokens: 140, cost: { total: 0.02 } }, get content() { contentReads++; return 'A long original response'; } };
  const rows: ChatMessage[] = [{ id: 'reply', source: 'history', streaming: false, resourceReference: 'source:reply', raw }];
  const formattedCells = t.mock.method(Number.prototype, 'toLocaleString');
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(MessageFooter, { rows, timestamp: undefined, onOpenSessionResource() {} })));
  assert.equal(contentReads, 0, 'closed original-record menu must not decode message previews');
  assert.equal(formattedCells.mock.callCount(), 0, 'closed usage menu must not format request cells');
});

process.on('exit', () => hooks.deregister());

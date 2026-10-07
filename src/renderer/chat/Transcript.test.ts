import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { initI18n } from '../locales/init';
import { buildTranscriptEntries } from './presentation';
import type { NativeMessage } from '../../shared/contracts';

const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' };
  if (url.endsWith('/workspace/SubagentStage.tsx')) return { format: 'module', shortCircuit: true, source: 'export function SubagentStage() { return null; } export function useLiveDuration(duration) { return duration; }' };
  if (url.endsWith('/ui/motion/index.tsx')) return { format: 'module', shortCircuit: true, source: "export { motion } from './model'; export function useReducedMotion() { return true; } export function isMotionPaused() { return false; } export function animateTo() {} export function Presence({show,children}) { return show ? children : null; } export function Swap({children}) { return children; } export function FlipList({children}) { return children; } export function useSurfaceMotion() {} export function useFlipList() {} export function AnimatedNumber({value}) { return value; }" };
  return nextLoad(url, context);
} });
const { TranscriptDisclosureProvider, useTranscriptDisclosureApi } = await import('./disclosure');
const { AssistantTurn } = await import('./Transcript');
const priorDocument = globalThis.document;
Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { documentElement: { lang: '' } } });
await initI18n('zh-CN');
Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: priorDocument });

function Surface({ raw, open, active = false }: { raw: NativeMessage; open: boolean; active?: boolean }) {
  const api = useTranscriptDisclosureApi();
  if (open) api?.reveal('a');
  const entry = buildTranscriptEntries([{ id: 'a', source: active ? 'live' : 'history', streaming: active, raw }], {}).entries[0];
  assert.equal(entry.kind, 'assistant-turn');
  if (entry.kind !== 'assistant-turn') throw new Error('Expected assistant turn');
  return createElement(AssistantTurn, { entry, active, byToolCall: new Map(), resolvedTrees: [], observedLive: active, onOpenSubagent() {}, cwd: '/workspace', onOpenFile() {} });
}
const render = (content: unknown[], open = false, active = false) => renderToStaticMarkup(createElement(TranscriptDisclosureProvider, { children: createElement(Surface, { raw: { role: 'assistant', content, timestamp: 1000, completedAt: 4000 }, open, active }) }));

test('settled no-tool reasoning is collapsed above its answer and expands to ordered text', () => {
  const blocks = [{ type: 'thinking', thinking: 'First reason.' }, { type: 'thinking', thinking: 'Second reason.' }, { type: 'text', text: 'Final answer.' }];
  const closed = render(blocks);
  assert.ok(closed.includes(i18next.t('omp.timeline.thought', { duration: '3秒' })));
  assert.match(closed, /aria-expanded="false"/);
  assert.ok(closed.indexOf('turn-timeline') < closed.indexOf('assistant-turn-response'));
  assert.ok(!closed.includes('First reason.'));
  const expanded = render(blocks, true);
  assert.ok(expanded.indexOf('First reason.') < expanded.indexOf('Second reason.'));
  assert.ok(expanded.includes('Second reason.'));
  assert.ok(!render([{ type: 'text', text: 'Final answer.' }]).includes('turn-timeline'));
});
test('redacted reasoning renders the localized note but never opaque provider fields', () => {
  for (const block of [{ type: 'thinking', thinking: '', thinkingSignature: 'SECRET_SIGNATURE' }, { type: 'redactedThinking', data: 'SECRET_SIGNATURE' }]) {
    const html = render([block, { type: 'text', text: 'Final answer.' }], true);
    assert.ok(html.includes(i18next.t('omp.native.redactedReasoning')));
    assert.ok(!html.includes('SECRET_SIGNATURE'));
  }
});
test('only the latest readable streaming reasoning block automatically expands', () => {
  const reasoning = { type: 'thinking', thinking: 'Readable reasoning.' };
  const live = render([reasoning], false, true);
  assert.match(live, /data-thinking-live="true"[\s\S]*?aria-expanded="true"/);
  const followed = render([reasoning, { type: 'text', text: 'Answer begins.' }], false, true);
  assert.ok(!followed.includes('data-thinking-live'));
  assert.match(followed, /timeline-thinking tool-row[\s\S]*?aria-expanded="false"/);
  for (const block of [{ type: 'thinking', thinking: '' }, { type: 'redactedThinking', data: 'SECRET' }]) {
    const redacted = render([block], false, true);
    assert.ok(!redacted.includes('data-thinking-live'));
    assert.match(redacted, /timeline-thinking tool-row[\s\S]*?aria-expanded="false"/);
    assert.ok(!redacted.includes('SECRET'));
  }
});
process.on('exit', () => hooks.deregister());

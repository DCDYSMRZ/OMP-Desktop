import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatState } from '../chat/model';
import { buildSessionMeter, contextComposition, contextLevel, formatContextPercent, formatTokensCompact, formatCost } from './session-meter-model';

test('context thresholds match omp percent and absolute token boundaries', () => {
  assert.deepEqual([0, 49.99, 50, 69.99, 70, 89.99, 90].map(p => contextLevel(p, 100_000)), ['normal', 'normal', 'warning', 'warning', 'purple', 'purple', 'error']);
  assert.deepEqual([14.99, 15, 26.99, 27, 49.99, 50, 56.8628].map(p => contextLevel(p, 1_000_000)), ['normal', 'warning', 'warning', 'purple', 'purple', 'error', 'error']);
  assert.equal(contextLevel(NaN, 1_000_000), 'normal'); assert.equal(contextLevel(70, 0), 'purple');
});
test('live native percent is authoritative and window zero falls back to the actual model', () => {
  const chat = createChatState({ runtimeId: 'r', cwd: '/tmp', source: { status: 'unpersisted', sessionId: 's' }, state: { sessionId: 's', isStreaming: true, model: { provider: 'p', id: 'm', contextWindow: 1_000_000 }, contextUsage: { tokens: 568628, contextWindow: 0, percent: 0 } }, messages: [], models: [], commands: [], thinkingLevels: [] });
  const context = buildSessionMeter({ chat, live: true }).context;
  assert.equal(context.window, 1_000_000); assert.equal(context.percent, 56.8628); assert.equal(context.level, 'error');
  chat.state.contextUsage = { tokens: 123, contextWindow: 1_000_000, percent: 42 };
  assert.equal(buildSessionMeter({ chat, live: true }).context.percent, 42);
  chat.state.model = undefined; chat.state.contextUsage.contextWindow = 0;
  assert.equal(buildSessionMeter({ chat, live: true }).context.state, 'windowUnknown');
  assert.equal(buildSessionMeter({ chat, live: true }).context.percent, undefined);
});
test('saved compaction and spend remain separate from request measurement', () => {
  const meter = buildSessionMeter({ chat: null, live: false, usage: { incomplete: false, contextTokens: 568628, contextWindow: 1_000_000, windowSource: 'config', contextState: 'compacted', compactedTokens: 10000, cost: 15, mainCost: 10, subagentCost: 5, input: 10, cacheRead: 80, cacheWrite: 10 }, pending: true });
  assert.equal(meter.context.state, 'compacted'); assert.equal(meter.context.compactedTokens, 10000);
  assert.equal(meter.spend.total, 15); assert.equal(meter.spend.cacheHitRate, 80); assert.equal(meter.spend.stale, true);
  assert.equal(meter.work, null);
});
test('formatting preserves compact meaningful occupancy and currency strings', () => {
  assert.equal(formatContextPercent(56.9), '57%'); assert.equal(formatContextPercent(0.4), '0.4%');
  assert.equal(formatTokensCompact(568628), '568.6K'); assert.equal(formatTokensCompact(1_000_000), '1M');
  assert.equal(formatCost(118.57), '$118.57');
  assert.equal(formatCost(0.00202), '<$0.01'); assert.equal(formatCost(0), '$0.00');
});
test('currency groups session totals using the selected locale without losing small spend', () => {
  assert.equal(formatCost(1763.93, 'en-US'), '$1,763.93');
  assert.equal(formatCost(1634.38, 'zh-CN'), '$1,634.38');
  assert.equal(formatCost(1763.93, 'de-DE'), '1.763,93\u00a0$');
  assert.equal(formatCost(1234567.89, 'en-IN'), '$12,34,567.89');
  assert.equal(formatCost(0.00202, 'en-US'), '<$0.01');
  assert.equal(formatCost(0.00202, 'de-DE'), '<0,01\u00a0$');
  assert.equal(formatCost(0, 'zh-CN'), '$0.00');
  assert.equal(formatCost(0.01, 'en-US'), '$0.01');
});
test('composition preserves measured overhead, proportional categories, and the message residual', () => {
  const prompt = { systemPrompt: ['base <skills>read</skills>', 'project rules'], dumpTools: [{ name: 'read', description: 'Read a file', parameters: { path: 'string' } }] };
  const result = contextComposition(1000, 400, prompt, 'live')!;
  assert.equal(result.categories.reduce((sum, category) => sum + category.tokens, 0), 1000);
  assert.equal(result.categories.find(category => category.id === 'messages')?.tokens, 600);
  assert.ok(result.categories.find(category => category.id === 'skills')!.tokens > 0);
  assert.ok(result.categories.find(category => category.id === 'systemContext')!.tokens > 0);
  assert.equal(result.estimated, true);
  assert.deepEqual(contextComposition(100, 150)?.categories, [{ id: 'nonMessage', tokens: 100 }, { id: 'messages', tokens: 0 }]);
  assert.equal(contextComposition(100, undefined), undefined);
  assert.equal(contextComposition(100, undefined, prompt)?.basis, 'characters');
});
test('saved composition is request-scoped and compacted requests do not pretend to be current', () => {
  const usage = { incomplete: false, contextTokens: 1000, nonMessageTokens: 200, contextWindow: 2000 };
  const context = buildSessionMeter({ chat: null, live: false, usage }).context;
  assert.deepEqual(context.composition?.categories, [{ id: 'nonMessage', tokens: 200 }, { id: 'messages', tokens: 800 }]);
  assert.equal(context.composition?.source, 'request');
  assert.equal(buildSessionMeter({ chat: null, live: false, usage: { ...usage, contextState: 'compacted' } }).context.composition, undefined);
});
test('partial session-init prompt never assigns unrecorded tool definitions to system prompt', () => {
  const composition = contextComposition(1000, 400, { systemPrompt: ['A'.repeat(100)], dumpTools: [], partial: true })!;
  assert.equal(composition.categories.find(category => category.id === 'systemPrompt')?.tokens, 25);
  assert.equal(composition.categories.find(category => category.id === 'nonMessage')?.tokens, 375);
  assert.equal(composition.categories.find(category => category.id === 'messages')?.tokens, 600);
  assert.equal(composition.basis, 'partial');
});

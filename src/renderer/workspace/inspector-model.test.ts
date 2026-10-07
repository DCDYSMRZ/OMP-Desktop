import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeState } from '../../shared/contracts';
import { deriveInspectorSummary } from './inspector-model';
const state: NativeState = { sessionId: 'session', isStreaming: true, isCompacting: false, tokensPerSecond: 42, queuedMessageCount: 2, contextUsage: { tokens: 500, contextWindow: 1000, percent: 50 } };

test('disconnect keeps last context but never reports live activity or speed', () => {
  const summary = deriveInspectorSummary(state, false);
  assert.equal(summary.activity, 'offline');
  assert.equal(summary.animated, false);
  assert.equal(summary.generation.speed, undefined);
  assert.equal(summary.context.tokens, 500);
  assert.equal(deriveInspectorSummary(null, true).live, false);
});

test('compaction wins over generation and suppresses stale generation throughput', () => {
  const summary = deriveInspectorSummary({ ...state, isCompacting: true }, true);
  assert.equal(summary.activity, 'compacting');
  assert.equal(summary.generation.speed, undefined);
  assert.equal(summary.animated, true);
  assert.equal(deriveInspectorSummary(state, true).generation.speed, 42);
  assert.equal(deriveInspectorSummary({ ...state, isStreaming: false }, true).generation.speed, undefined);
});

test('settlement, asynchronous work and queue retain their distinct activity semantics', () => {
  const idle = { ...state, isStreaming: false };
  assert.equal(deriveInspectorSummary({ ...idle, isSettled: true }, true).activity, 'settled');
  assert.equal(deriveInspectorSummary({ ...idle, hasPendingAsyncWork: true }, true).activity, 'background');
  assert.equal(deriveInspectorSummary(idle, true).activity, 'queued');
  assert.equal(deriveInspectorSummary({ ...idle, queuedMessageCount: 0 }, true).activity, 'unknown');
});

test('unknown and invalid measurements stay unknown; zero is real and rings clamp without hiding pressure', () => {
  const summary = deriveInspectorSummary({ ...state, tokensPerSecond: 0, queuedMessageCount: NaN, contextUsage: { tokens: -1, contextWindow: Infinity, percent: 125 } }, true);
  assert.equal(summary.generation.speed, 0);
  assert.equal(summary.generation.queued, undefined);
  assert.deepEqual(summary.context, { tokens: undefined, window: undefined, percent: 125, ringPercent: 100, autoCompaction: undefined });
  assert.equal(deriveInspectorSummary({ ...state, contextUsage: undefined, autoCompactionEnabled: false }, true).context.autoCompaction, false);
  assert.equal(deriveInspectorSummary({ ...state, tokensPerSecond: -1 }, true).generation.speed, undefined);
});

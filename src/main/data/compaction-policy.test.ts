import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigEntry } from '../../shared/contracts';
import { compactionPolicy } from './compaction-policy';
const settings = (values: Record<string, ConfigEntry['value']>): ConfigEntry[] => Object.entries(values).map(([key, value]) => ({ key: `compaction.${key}`, value, type: 'number', description: '' }));
test('one-million window uses 850K application and only eligible speculation', () => {
  const vision = { input: ['text', 'image'], remoteCompaction: false };
  const local = compactionPolicy(1e6, settings({ methodOrder: ['snapcompact', 'soft'], asyncEnabled: true }), vision);
  assert.equal(local.threshold, 850000); assert.equal(local.speculationStart, undefined); assert.equal(local.method, 'snapcompact');
  const soft = compactionPolicy(1e6, settings({ methodOrder: ['soft', 'snapcompact'] }), vision);
  assert.equal(soft.speculationStart, 818000);
  assert.equal(compactionPolicy(1e6, settings({ methodOrder: ['snapcompact', 'soft'] }), { input: ['text'] }).speculationStart, 818000);
});
test('fixed tokens precede percent and reserve; invalid triggers fall back', () => {
  assert.equal(compactionPolicy(100000, settings({ thresholdTokens: 70000, thresholdPercent: 20, reserveTokens: 40000 })).threshold, 70000);
  assert.equal(compactionPolicy(100000, settings({ thresholdTokens: -1, thresholdPercent: 60 })).threshold, 60000);
  assert.equal(compactionPolicy(100000, settings({ thresholdPercent: 120 })).threshold, 99000);
  assert.equal(compactionPolicy(100000, settings({ thresholdTokens: 200000 })).threshold, 99999);
  assert.equal(compactionPolicy(100000, settings({ thresholdTokens: -1, thresholdPercent: -1 })).threshold, 83616);
});
test('small-window recovery distinguishes explicit reserve from unset reserve', () => {
  assert.equal(compactionPolicy(18000).threshold, 15300);
  assert.equal(compactionPolicy(18000, settings({ reserveTokens: 16384 })).threshold, 1616);
  assert.equal(compactionPolicy(8000, settings({ reserveTokens: 16384 })).threshold, 6800);
  assert.equal(compactionPolicy(1).threshold, 0);
});
test('off, synchronous, unavailable and unknown methods do not invent preparation', () => {
  assert.equal(compactionPolicy(1e6, settings({ enabled: false })).threshold, undefined);
  assert.equal(compactionPolicy(1e6, settings({ strategy: 'off' })).enabled, false);
  assert.equal(compactionPolicy(1e6, settings({ methodOrder: ['soft'], asyncEnabled: false })).speculationStart, undefined);
  assert.equal(compactionPolicy(1e6, settings({ methodOrder: ['snapcompact', 'soft'] })).eligibilityUnknown, true);
  assert.equal(compactionPolicy(1e6, settings({ methodOrder: ['shake', 'soft'] })).speculationStart, undefined);
  assert.equal(compactionPolicy(1e6, [], { input: ['text'], remoteCompaction: false }).method, 'handoff');
  assert.equal(compactionPolicy(1e6, [], { input: ['image'], remoteCompaction: false }).speculationStart, undefined);
  assert.equal(compactionPolicy(1e6, [], { input: ['image'], remoteCompaction: true }).speculationStart, 818000);
});
test('runtime auto-compaction flag overrides the current settings toggle in both directions', () => {
  assert.equal(compactionPolicy(1e6, settings({ enabled: false }), { input: ['image'], remoteCompaction: false }, true).threshold, 850000);
  assert.equal(compactionPolicy(1e6, settings({ enabled: true }), undefined, false).threshold, undefined);
});

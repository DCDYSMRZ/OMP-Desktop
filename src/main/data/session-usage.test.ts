import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { SessionUsageReader } from './session-usage';

const row = (usage: object, timestamp = 1000) => JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', usage } }) + '\n';
test('whole-session totals survive compaction and append; context excludes generated output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-usage-'));
  try {
    const path = join(directory, 'session.jsonl');
    await writeFile(path, row({ input: 10, output: 2, cacheRead: 20, cacheWrite: 3, totalTokens: 35, cost: { total: 0.5 } }) + row({ input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, 2000));
    const reader = new SessionUsageReader();
    const initial = await reader.read(path);
    assert.equal(initial.cost, 0.5); assert.equal(initial.total, 41); assert.equal(initial.contextTokens, 5);
    await appendFile(path, row({ input: 2, output: 3, cost: { total: 1 } }, 3000));
    const next = await reader.read(path);
    assert.equal(next.cost, 1.5); assert.equal(next.total, 46); assert.equal(next.contextTokens, 2);
    const archive = join(directory, 'session.jsonl.gz');
    await writeFile(archive, gzipSync(row({ input: 4, output: 2, cost: { total: 0.2 } })));
    assert.equal((await reader.read(archive)).contextTokens, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('prompt snapshots follow selected ancestry and compaction supersedes only older requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-usage-'));
  try {
    const path = join(directory, 'session.jsonl');
    const assistant = (id: string, parentId: string | null, prompt: number) => ({ type: 'message', id, parentId, timestamp: 2000, message: { role: 'assistant', provider: 'p', model: 'm', contextSnapshot: { promptTokens: prompt }, usage: { input: 10, cacheRead: 20, cacheWrite: 5, output: 100, cost: { total: 1 } } } });
    await writeFile(path, [assistant('a', null, 42), assistant('other', null, 900), { type: 'compaction', id: 'c', parentId: 'a', tokensAfter: 12 }, { type: 'message', id: 'u', parentId: 'c', message: { role: 'user' } }].map(row => JSON.stringify(row)).join('\n') + '\n');
    const reader = new SessionUsageReader();
    const compacted = await reader.read(path);
    assert.equal(compacted.contextTokens, 42); assert.equal(compacted.contextState, 'compacted'); assert.equal(compacted.compactedTokens, 12);
    assert.deepEqual(compacted.model, { provider: 'p', id: 'm' }); assert.equal(compacted.observedAt, 2000);
    assert.equal((await reader.read(path, 'other')).contextTokens, 900);
    assert.equal((await reader.read(path, null)).contextTokens, undefined);
    await appendFile(path, JSON.stringify(assistant('b', 'c', 18)) + '\n');
    assert.equal((await reader.read(path)).contextState, 'measured');
    assert.equal((await reader.read(path)).contextTokens, 18);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('native task aggregate counts descendants once; non-transcript model calls count as main', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-usage-'));
  try {
    const path = join(directory, 'session.jsonl');
    const usage = { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, totalTokens: 35, cost: { total: 2 }, premiumRequests: 1 };
    await writeFile(path, row(usage) + [
      { type: 'message', message: { role: 'toolResult', toolName: 'task', toolCallId: 'task-1', details: { usage, results: [{ usage }] } } },
      { type: 'model_usage', purpose: 'judgment', usage },
      { type: 'message', message: { role: 'toolResult', toolName: 'read', details: { usage } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = await new SessionUsageReader().read(path);
    assert.equal(result.mainCost, 4); assert.equal(result.subagentCost, 2); assert.equal(result.cost, 6);
    assert.equal(result.total, 105); assert.equal(result.input, 30); assert.equal(result.premiumRequests, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('missing, partial and oversized records never invent zero context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-usage-'));
  try {
    const path = join(directory, 'session.jsonl');
    await writeFile(path, row({}) + '{partial');
    const empty = await new SessionUsageReader().read(path);
    assert.equal(empty.incomplete, true); assert.equal(empty.cost, undefined); assert.equal(empty.contextTokens, undefined);
    await writeFile(path, JSON.stringify({ padding: 'x'.repeat(16 * 1024 * 1024) }) + '\n' + row({ input: 1, output: 2, cost: { total: 0 } }));
    const result = await new SessionUsageReader().read(path);
    assert.equal(result.incomplete, true); assert.equal(result.total, 3); assert.equal(result.cost, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('context anchors ignore failed requests and retain correction metadata on the selected branch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-context-'));
  try {
    const path = join(directory, 'session.jsonl');
    const message = (id: string, parentId: string | null, stopReason: string, snapshot: object) => ({ type: 'message', id, parentId, message: { role: 'assistant', stopReason, contextSnapshot: snapshot, usage: { input: 10, output: 7 } } });
    await writeFile(path, [
      { type: 'session_init', id: 'init', parentId: null, systemPrompt: 'A saved system prompt', tools: ['read'] },
      message('measured', 'init', 'stop', { promptTokens: 200, nonMessageTokens: 80, compactionEpoch: 3, historyRewriteTokensRemoved: 25 }),
      message('failed', 'measured', 'error', { promptTokens: 500, nonMessageTokens: 400 }),
      message('aborted', 'failed', 'aborted', { promptTokens: 900, nonMessageTokens: 700 }),
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const usage = await new SessionUsageReader().read(path);
    assert.equal(usage.contextTokens, 200); assert.equal(usage.nonMessageTokens, 80);
    assert.equal(usage.compactionEpoch, 3); assert.equal(usage.historyRewriteTokensRemoved, 25);
    assert.equal(usage.contextPrompt?.partial, true);
    assert.deepEqual(usage.contextPrompt?.systemPrompt, ['A saved system prompt']);
    assert.equal(usage.total, 51); // failed calls still contribute billed usage
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activitySignal, ACTIVITY_FRESH_MS, ChildJournalObserver, ListedJournalObserver, inferActivity, type ActivitySignal } from './session-observer';
import type { SessionSummary } from '../../shared/contracts';

const now = 1_800_000_000_000;
const owner = { status: 'external' as const, checkedAt: now };
const request: ActivitySignal = { kind: 'request', at: now - 1000 };
const start: ActivitySignal = { kind: 'start', calls: [{ toolCallId: 'read-1', name: 'read', startedAt: now - 500, intent: 'Reading configuration' }] };

test('open request requires a living owner and recent evidence, never ownership alone', () => {
  assert.equal(inferActivity([request], owner, now - 1000, now).state, 'running');
  assert.equal(inferActivity([request], owner, now - ACTIVITY_FRESH_MS, now).state, 'stale');
  assert.equal(inferActivity([request], { ...owner, status: 'idle' }, now, now).state, 'stale');
  assert.equal(inferActivity([{ kind: 'stop' }, request], owner, now, now).state, 'idle');
  assert.equal(inferActivity([], owner, now, now).state, 'unknown');
  assert.equal(inferActivity([request], { ...owner, status: 'unknown' }, now, now).state, 'unknown');
});

test('tool starts survive metadata, matching results clear the tool, exit closes the request', () => {
  const running = inferActivity([start, request], owner, now, now);
  assert.equal(running.currentTool?.toolCallId, 'read-1');
  assert.equal(running.requestStartedAt, request.at);
  assert.equal(running.confidence, 'inferred');
  const result: ActivitySignal = { kind: 'result', toolCallId: 'read-1' };
  assert.equal(inferActivity([result, start, request], owner, now, now).currentTool, undefined);
  assert.equal(inferActivity([{ kind: 'exit' }, start, request], owner, now, now).state, 'idle');
  assert.equal(inferActivity([request, { kind: 'exit' }], owner, now, now).state, 'running');
  assert.equal(activitySignal({ type: 'custom', customType: 'tool_execution_start', data: { toolCallId: 'read-1', toolName: 'read', startedAt: now, intent: 'Reading' } })?.kind, 'start');
  assert.equal(activitySignal({ type: 'custom', customType: 'session_exit', data: { reason: 'normal' } })?.kind, 'exit');
});

test('independent child growth refreshes parent activity without changing its journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-observation-'));
  try {
    const parent = join(root, 'parent.jsonl'), directory = join(root, 'parent');
    await mkdir(directory); await writeFile(parent, 'parent');
    await writeFile(join(directory, 'child.jsonl'), 'one\n');
    const observer = new ChildJournalObserver();
    const first = await observer.poll(parent);
    assert.equal(first.lastGrowthAt, (await stat(join(directory, 'child.jsonl'))).mtimeMs);
    await appendFile(join(directory, 'child.jsonl'), 'two\n');
    const next = await observer.poll(parent);
    assert.notEqual(next.revision, first.revision);
    assert.equal(inferActivity([request], owner, now - ACTIVITY_FRESH_MS, now, { ...next, lastGrowthAt: now }).state, 'running');
    assert.equal((await observer.poll(parent)).revision, next.revision);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('listed journal hints need open work and follow terminal completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-listed-observation-'));
  const observer = new ListedJournalObserver(() => {});
  const path = join(root, 'session.jsonl');
  const session: SessionSummary = { id: 's', path, cwd: root, title: 'Session', preview: '', updatedAt: '', sourceKind: 'journal', writable: true, canFork: true };
  const user = { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Work' } };
  try {
    await writeFile(path, JSON.stringify(user) + '\n');
    await observer.observe([session]);
    assert.equal(session.activity, 'running');
    const old = new Date(Date.now() - 180_000); await utimes(path, old, old);
    await observer.observe([session]);
    assert.equal(session.activity, 'stale');
    await appendFile(path, JSON.stringify({ type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', stopReason: 'stop', content: 'Done' } }) + '\n');
    await observer.observe([session]);
    assert.equal(session.activity, 'idle');
  } finally { observer.close(); await rm(root, { recursive: true, force: true }); }
});

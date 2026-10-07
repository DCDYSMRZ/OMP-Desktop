import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObservedActivity } from '../../shared/contracts';
import { selectTurnClock, turnClockElapsed, savedWaitingIntervals, mergeWaitingIntervals, activeTurnDuration } from './turn-clock';
import { buildTranscriptEntries } from './presentation';
import type { ChatMessage } from './model';

const activity: ObservedActivity = { state: 'running', source: 'journal', confidence: 'inferred', owner: 'external', requestStartedAt: 1000, lastAppendAt: 12000 };
const fallback = { startedAt: 5000, endedAt: 12000, running: true };

test('observed request clock advances during parent silence and child-only updates', () => {
  const clock = selectTurnClock(activity, fallback);
  assert.equal(turnClockElapsed(clock, 12000), 11000);
  assert.equal(turnClockElapsed(clock, 32500), 31500);
  assert.deepEqual(selectTurnClock({ ...activity, childrenRevision: 'new-child-progress' }, fallback), clock);
  assert.equal(clock.startedAt, 1000);
});

test('stale observation freezes at its last durable progress rather than claiming completion', () => {
  const clock = selectTurnClock({ ...activity, state: 'stale' }, fallback);
  assert.equal(clock.running, false);
  assert.equal(clock.stale, true);
  assert.equal(turnClockElapsed(clock, 20000), 11000);
  assert.equal(turnClockElapsed(clock, 90000), 11000);
});

test('native, settled, and timestamp-poor sources retain their existing elapsed boundaries', () => {
  assert.equal(selectTurnClock(undefined, fallback).startedAt, 5000);
  assert.equal(selectTurnClock({ ...activity, requestStartedAt: undefined }, fallback).startedAt, 5000);
  const settled = selectTurnClock({ ...activity, state: 'idle' }, { ...fallback, running: false });
  assert.equal(turnClockElapsed(settled, 90000), 7000);
  assert.equal(settled.stale, false);
});

test('live and saved ask projections exclude the same durable user wait', () => {
  const rows: ChatMessage[] = [
    { id: 'call', source: 'history', streaming: false, raw: { role: 'assistant', timestamp: 1000, completedAt: 1500, content: [{ type: 'toolCall', id: 'ask-1', name: 'ask', arguments: { questions: [] } }] } },
    { id: 'receipt', source: 'history', streaming: false, raw: { role: 'toolResult', toolCallId: 'ask-1', toolName: 'ask', timestamp: 21500, content: 'User selected: Yes' } },
    { id: 'answer', source: 'history', streaming: false, raw: { role: 'assistant', timestamp: 22000, stopReason: 'stop', content: 'Done' } },
  ];
  for (const source of ['live', 'history'] as const) {
    const turn = buildTranscriptEntries(rows.map(row => ({ ...row, source })), {}).entries[0];
    assert.equal(turn.kind, 'assistant-turn');
    if (turn.kind !== 'assistant-turn') throw Error('Missing turn');
    const saved = savedWaitingIntervals(turn.parts);
    assert.deepEqual(saved, [{ start: 1500, end: 21500 }]);
    const intervals = source === 'live' ? mergeWaitingIntervals([...saved, { start: 1600, end: 21400 }]) : saved;
    assert.equal(activeTurnDuration(1000, 22000, intervals), 1000);
    assert.equal(activeTurnDuration(20000, 22000, intervals), 500);
  }
});

test('explicit approval and input receipts merge overlaps without treating tool execution as waiting', () => {
  const event = (id: string, customType: string, timestamp: number, details: object) => ({ kind: 'activity' as const, key: id, row: { id, source: 'history' as const, streaming: false, raw: { role: 'custom', customType, timestamp, details } } });
  const intervals = savedWaitingIntervals([
    event('a', 'tool_approval_requested', 1000, { toolCallId: 'write-1' }),
    event('b', 'extension_ui_request', 2000, { id: 'choice', method: 'confirm' }),
    event('c', 'tool_approval_resolved', 4000, { toolCallId: 'write-1', approved: false }),
    event('d', 'extension_ui_response', 5000, { id: 'choice', cancelled: true }),
    event('e', 'tool_execution_start', 6000, { toolCallId: 'bash-1' }),
    event('f', 'tool_execution_end', 9000, { toolCallId: 'bash-1' }),
    event('g', 'tool_approval_requested', 10000, { toolCallId: 'unmatched' }),
  ]);
  assert.deepEqual(intervals, [{ start: 1000, end: 5000 }]);
  assert.equal(activeTurnDuration(0, 12000, intervals), 8000);
  assert.equal(activeTurnDuration(undefined, 12000, intervals), undefined);
});

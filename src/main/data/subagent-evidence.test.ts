import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childJournalEvidence } from './subagent-evidence';
import { evidenceOf, visibleAgentPhase } from '../../shared/subagent-evidence';
const entry = (message: object, timestamp: number) => ({ type: 'message', timestamp, message });
const yielded = (args: object = {}, details: object = { status: 'success' }) => [entry({ role: 'assistant', usage: { input: 10, output: 3, cacheWrite: 2, cacheRead: 100, totalTokens: 115 }, content: [{ type: 'toolCall', id: 'yield-1', name: 'yield', arguments: args }] }, 10), entry({ role: 'toolResult', toolName: 'yield', toolCallId: 'yield-1', details }, 20)];

test('accepted terminal yield establishes completion and native token totals exclude cached reads', () => {
 const agent = childJournalEvidence([...yielded(), { customType: 'session_exit', timestamp: 100, data: { kind: 'normal', reason: 'dispose' } }]);
 assert.equal(visibleAgentPhase(agent), 'completed');
 assert.equal(agent.progress?.tokens, 15);
 assert.equal(agent.progress?.toolCount, 1);
 assert.equal(agent.progress?.durationMs, 10);
});
test('later async invalidation and revival require a fresh accepted outcome', () => {
 for (const later of [{ customType: 'async-result', timestamp: 30 }, entry({ role: 'user', content: 'More work' }, 30)]) {
  const agent = childJournalEvidence([...yielded(), later]);
  assert.equal(visibleAgentPhase(agent), 'unknown');
  assert.equal(evidenceOf(agent).generation, 1);
  assert.ok(evidenceOf(agent).reason);
 }
 const renewed = childJournalEvidence([...yielded(), { customType: 'async-result', timestamp: 30 }, ...yielded().map(row => ({ ...row, timestamp: Number(row.timestamp) + 30 }))]);
 assert.equal(visibleAgentPhase(renewed), 'completed');
});
test('incremental, rejected, missing, error and aborted yields are not conflated', () => {
 assert.equal(visibleAgentPhase(childJournalEvidence(yielded({ type: ['section'] }))), 'unknown');
 assert.equal(visibleAgentPhase(childJournalEvidence(yielded({}, { status: 'error' }))), 'unknown');
 assert.equal(visibleAgentPhase(childJournalEvidence(yielded({ error: 'failed verification' }))), 'failed');
 assert.equal(visibleAgentPhase(childJournalEvidence(yielded({}, { status: 'aborted' }))), 'stopped');
 assert.equal(visibleAgentPhase(childJournalEvidence([{ customType: 'session_exit', data: { kind: 'normal' } }])), 'unknown');
 assert.equal(visibleAgentPhase(childJournalEvidence(yielded({ type: ['section'], complete: true }))), 'completed');
});

test('a revived clean assistant stop followed by disposal completes, but pending calls and errors do not', () => {
 const wake = entry({ role: 'user', content: 'Follow-up' }, 30);
 const stop = entry({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Follow-up handled' }] }, 40);
 const exit = { customType: 'session_exit', timestamp: 50, data: { kind: 'normal', reason: 'dispose' } };
 const completed = childJournalEvidence([...yielded(), wake, stop, exit]);
 assert.equal(visibleAgentPhase(completed), 'completed');
 assert.equal(completed.followupCompleted, true);
 const pending = entry({ role: 'assistant', content: [{ type: 'toolCall', id: 'pending', name: 'bash' }] }, 35);
 assert.equal(visibleAgentPhase(childJournalEvidence([...yielded(), wake, pending, stop, exit])), 'unknown');
 assert.equal(visibleAgentPhase(childJournalEvidence([...yielded(), wake, entry({ role: 'assistant', stopReason: 'error' }, 40), exit])), 'failed');
 assert.equal(visibleAgentPhase(childJournalEvidence([...yielded(), wake, stop])), 'unknown');
});

test('intermediate errors and harness skips are separate from explicit final findings', () => {
 const errors = [entry({ role: 'toolResult', toolCallId: 'failed-check', isError: true }, 1), entry({ role: 'toolResult', toolCallId: 'skipped', isError: true, content: 'Skipped due to pending peer interrupt. Retry later.' }, 2)];
 const clean = childJournalEvidence([...errors, ...yielded()]);
 assert.equal(clean.progress?.toolFailureCount, 1);
 assert.equal(evidenceOf(clean).findings, 0);
 const report = childJournalEvidence([...errors, ...yielded({ data: { issues: ['Unresolved mismatch'] } })]);
 assert.equal(evidenceOf(report).findings, 1);
 assert.equal(visibleAgentPhase(report), 'completed');
});

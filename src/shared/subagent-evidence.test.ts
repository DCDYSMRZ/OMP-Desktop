import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAgent, normalizeAgentFrame, reconcileAgent, settleAgentJobs, visibleAgentPhase, unknownAgentReason, evidenceOf, jobEvidence, inferChildActivity, SUBAGENT_FRESH_MS } from './subagent-evidence';
import { parseNativeAsyncDelivery, parseNativeJobSnapshot } from './native-task-results';

const envelope = (id: string, status = 'completed') => `<task-result id="${id}" agent="task" status="${status}" duration="4.1s">\n<output>\nreport\n</output>\n</task-result>`;
const spawn = (id: string) => normalizeAgent({ id, status: 'pending', parentToolCallId: 'batch', progress: { tokens: 0, cost: 0, toolCount: 0, durationMs: 0 } }, { source: 'task', observedAt: 10 });

test('consuming wait snapshots settle each native child, not the primary batch or suffixed job identity', () => {
 const agents = [spawn('primary'), spawn('member')];
 const message = { role: 'toolResult', toolName: 'wait', details: { jobs: [{ id: 'primary', type: 'task', agentUrlId: 'primary', status: 'running' }, { id: 'member-2', type: 'task', agentUrlId: 'member', status: 'completed', durationMs: 3, resultText: envelope('member') }] } };
 const result = settleAgentJobs(agents, message, 20);
 assert.deepEqual(result.map(visibleAgentPhase), ['running', 'completed']);
 assert.equal(result[1].progress?.durationMs, 4100);
 assert.equal(result[1].progress?.deliveryDurationMs, 3);
 assert.equal(parseNativeJobSnapshot(message)?.jobs[1].agentId, 'member');
});

test('custom batch suffixes retain validated agent identity and delivery timing', () => {
 const message = { role: 'custom', customType: 'async-result', details: { jobs: [{ jobId: 'member-2', type: 'task', durationMs: 3 }, { jobId: 'other', type: 'task', durationMs: 4 }] }, content: `<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job member-2 ──\n${envelope('member')}\n── Job other ──\n${envelope('other')}\n</system-notice>` };
 assert.deepEqual(settleAgentJobs([spawn('member'), spawn('other')], message, 20).map(visibleAgentPhase), ['completed', 'completed']);
 const job = parseNativeAsyncDelivery(message)!.jobs[0];
 assert.equal(jobEvidence(spawn('member'), job).progress?.deliveryDurationMs, 3);
});

test('terminal results and merge failure beat stale launch progress; only explicit revival reopens', () => {
 const started = normalizeAgentFrame(undefined, 'subagent_lifecycle', { id: 'child', status: 'started' }, 10)!;
 const done = normalizeAgent({ id: 'child', exitCode: 0 }, { source: 'task', observedAt: 20, historical: true });
 assert.equal(visibleAgentPhase(reconcileAgent(started, done)), 'completed');
 assert.equal(visibleAgentPhase(reconcileAgent(done, started)), 'completed');
 const failed = normalizeAgent({ id: 'child', exitCode: 0, error: 'Merge failed' }, { source: 'task', observedAt: 25 });
 assert.equal(visibleAgentPhase(reconcileAgent(done, failed)), 'failed');
 const revived = normalizeAgentFrame(done, 'subagent_lifecycle', { id: 'child', status: 'started' }, 30)!;
 assert.equal(visibleAgentPhase(reconcileAgent(revived, done)), 'running');
 assert.equal(evidenceOf(revived).generation, 1);
});

test('cancelled and failed snapshots retain distinct outcomes and ambiguous aliases stay unknown with reasons', () => {
 for (const [status, phase] of [['cancelled', 'stopped'], ['failed', 'failed']] as const) {
  const message = { role: 'toolResult', toolName: 'cancel', details: { jobs: [{ id: 'job', agentUrlId: 'child', type: 'task', status }] } };
  assert.equal(visibleAgentPhase(settleAgentJobs([spawn('child')], message, 20)[0]), phase);
  const ambiguous = settleAgentJobs([spawn('child'), { ...spawn('child'), parentToolCallId: 'other' }], message, 20);
  assert.equal(visibleAgentPhase(ambiguous[0]), 'unknown');
  assert.match(unknownAgentReason(ambiguous[0])!, /multiple/);
 }
 const historical = { ...spawn('child'), historical: true };
 assert.equal(visibleAgentPhase(historical), 'unknown');
 assert.ok(unknownAgentReason(historical));
});

test('progress identity works without payload id and spawn zero metrics cannot mask child totals', () => {
 const progress = normalizeAgentFrame(undefined, 'subagent_progress', { progress: { id: 'child', status: 'running', tokens: 12 } }, 20)!;
 assert.equal(progress.id, 'child');
 const journal = normalizeAgent({ id: 'child', status: 'completed', progress: { tokens: 42, toolCount: 3 } }, { source: 'journal', observedAt: 30, historical: true });
 assert.equal(reconcileAgent(journal, spawn('child')).progress?.tokens, 42);
});

test('recent child activity is inferred only under an active parent, and expires without inventing completion', () => {
 const now = 1_000_000;
 const journal = normalizeAgent({ id: 'child', status: 'unknown', journalOpen: true }, { source: 'journal', historical: true, observedAt: now - 1000 });
 const parent = { state: 'running', source: 'journal', confidence: 'inferred', owner: 'external' } as const;
 assert.equal(evidenceOf(inferChildActivity(journal, parent, now)).observation, 'inferred');
 assert.equal(evidenceOf(inferChildActivity(journal, parent, now)).phase, 'running');
 assert.equal(evidenceOf(inferChildActivity(journal, undefined, now)).phase, 'unknown');
 assert.equal(evidenceOf(inferChildActivity(journal, { ...parent, state: 'idle' }, now)).phase, 'unknown');
 assert.equal(evidenceOf(inferChildActivity(journal, parent, now + SUBAGENT_FRESH_MS)).phase, 'unknown');
 assert.equal(evidenceOf(inferChildActivity({ ...journal, journalOpen: false }, parent, now)).phase, 'unknown');
});
test('ambiguous same-generation observations never downgrade verified terminal outcomes in either arrival order', () => {
 for (const status of ['completed', 'failed', 'aborted']) {
  const terminal = normalizeAgent({ id: 'child', status }, { source: 'delivery', observedAt: 20, historical: true });
  const ambiguous = normalizeAgent({ id: 'child', status: 'unknown' }, { source: 'delivery', observedAt: 30, historical: true, reason: 'Ambiguous delivery' });
  for (const result of [reconcileAgent(terminal, ambiguous), reconcileAgent(ambiguous, terminal)]) {
   assert.equal(result.status, terminal.status);
   assert.deepEqual(result.unverifiedObservation, { status: 'unknown', evidence: evidenceOf(ambiguous) });
  }
  const later = normalizeAgent({ id: 'child', status: 'failed', error: 'Merge failed' }, { source: 'delivery', observedAt: 40 });
  assert.equal(reconcileAgent(terminal, later).status, 'failed');
  const revived = normalizeAgent({ id: 'child', status: 'running' }, { source: 'lifecycle', observedAt: 40, generation: 1, generationStartedAt: 40 });
  assert.equal(reconcileAgent(terminal, revived).status, 'running');
  assert.equal(reconcileAgent(revived, terminal).status, 'running');
 }
});

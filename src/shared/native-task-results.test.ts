import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNativeAsyncDelivery, resolveNativeTaskOwnership, subsetNativeAsyncDelivery } from './native-task-results';

const envelope = (id: string, status = 'completed', body = '<output>\nResult\n</output>') => `<task-result id="${id}" agent="task" status="${status}" duration="1m35s">\n${body}\n</task-result>`;
const delivery = (content: unknown, jobs: unknown[] = [{ jobId: 'child', type: 'task' }]) => ({ role: 'custom', customType: 'async-result', content, details: { jobs } });
const batch = (rows: { id: string; text: string }[]) => `<system-notice>\n${rows.length} background jobs have completed. Resume your work using the results below.\n\n${rows.map(row => `── Job ${row.id} ──\n${row.text}`).join('\n')}\n</system-notice>`;

test('terminal task evidence is independent from job-manager identity and notification prose', () => {
  const parsed = parseNativeAsyncDelivery(delivery(envelope('child-agent', 'failed (exit 1)', '<error>Provider stopped</error>\n<output>\nPartial work\n</output>'), [{ jobId: 'child-agent-2', type: 'task' }]))!;
  assert.equal(parsed.jobs[0].id, 'child-agent-2');
  assert.equal(parsed.jobs[0].agentId, 'child-agent');
  assert.equal(parsed.jobs[0].status, 'failed');
  assert.equal(parsed.jobs[0].result, 'Partial work');
  assert.equal(parsed.jobs[0].error, 'Provider stopped');
  assert.equal(parseNativeAsyncDelivery(delivery('Background job child has completed.'))!.jobs[0].status, 'unknown');
  assert.equal(parseNativeAsyncDelivery(delivery(envelope('child', 'merge failed')))!.jobs[0].status, 'failed');
  const aborted = parseNativeAsyncDelivery(delivery(envelope('child', 'cancelled', '<abort-reason>Stopped</abort-reason>\n<output>\nPartial\n</output>')))!;
  assert.equal(aborted.jobs[0].status, 'aborted');
  assert.equal(aborted.jobs[0].abortReason, 'Stopped');
});

test('mixed late deliveries link each verified owner while preserving shell, eval, images and schema failures', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'native-image' };
  const meta = { artifactError: 'Capture unavailable' };
  const schema = { status: 'invalid', data: { useful: true }, error: 'Expected field' };
  const content = [{ type: 'text', text: batch([{ id: 'job-a', text: envelope('agent-a') }, { id: 'shell', text: 'Shell output' }, { id: 'job-b', text: envelope('agent-b') }, { id: 'eval', text: 'Eval output' }]) }, image];
  const parsed = parseNativeAsyncDelivery(delivery(content, [{ jobId: 'job-a', type: 'task', schema }, { jobId: 'shell', type: 'bash', meta }, { jobId: 'job-b', type: 'task' }, { jobId: 'eval', type: 'eval' }]))!;
  const owners = resolveNativeTaskOwnership(parsed, [{ id: 'agent-a', parentToolCallId: 'call-a' }, { id: 'saved-b', nativeId: 'agent-b', historical: true, parentToolCallId: 'call-b' }], [{ toolCallId: 'call-a', messageIndex: 1 }, { toolCallId: 'call-b', messageIndex: 7 }], 15);
  assert.deepEqual(owners.linked.map(item => [item.job.id, item.toolCallId]), [['job-a', 'call-a'], ['job-b', 'call-b']]);
  assert.deepEqual(owners.unlinked.map(item => [item.job.type, item.job.result?.trim()]), [['bash', 'Shell output'], ['eval', 'Eval output']]);
  assert.equal(parsed.jobs[0].schema, schema);
  assert.equal(parsed.jobs[1].meta, meta);
  assert.equal(parsed.content, content);
  assert.deepEqual(parsed.residualContent, [image]);
  const residual = subsetNativeAsyncDelivery(parsed, owners.unlinked.map(item => item.job), true);
  assert.deepEqual(residual.residualContent, [image]);
  assert.deepEqual(subsetNativeAsyncDelivery(parsed, [owners.linked[0].job]).residualContent, []);
});

test('persisted terse native batches retain task ownership and mixed output without relaxing section ambiguity', () => {
  const source = `<system-notice>\n2 Background jobs done. Resume with results below.\n\n── Job task-job-2 ──\n${envelope('task-agent')}\n── Job shell-job ──\nHistorical shell output\n</system-notice>`;
  const jobs = [{ jobId: 'task-job-2', type: 'task' }, { jobId: 'shell-job', type: 'bash' }];
  const roster = [{ id: 'task-agent', parentToolCallId: 'original-call' }];
  const anchors = [{ toolCallId: 'original-call', messageIndex: 1 }];
  const image = { type: 'image', mimeType: 'image/png', data: 'historical-image' };
  const parsed = parseNativeAsyncDelivery(delivery([{ type: 'text', text: source }, image], jobs))!;
  const ownership = resolveNativeTaskOwnership(parsed, roster, anchors, 9);
  assert.deepEqual(ownership.linked.map(item => [item.job.id, item.job.agentId, item.job.status, item.toolCallId]), [['task-job-2', 'task-agent', 'completed', 'original-call']]);
  assert.deepEqual(ownership.unlinked.map(item => [item.job.type, item.job.result]), [['bash', 'Historical shell output']]);
  assert.deepEqual(parsed.residualContent, [image]);
  for (const malformed of [source.replace('── Job shell-job ──\n', ''), source.replace('── Job shell-job ──', '── Job task-job-2 ──'), source.replace('2 Background', '3 Background')]) {
    const rejected = parseNativeAsyncDelivery(delivery(malformed, jobs))!;
    assert.ok(rejected.jobs.every(job => job.ambiguous));
    assert.deepEqual(resolveNativeTaskOwnership(rejected, roster, anchors, 9).linked, []);
    assert.deepEqual(rejected.residualContent, [{ type: 'text', text: malformed }]);
  }
});

test('reused aliases, duplicated jobs, unavailable and future task calls never establish ownership', () => {
  const parsed = parseNativeAsyncDelivery(delivery(envelope('child')))!;
  const anchors = [{ toolCallId: 'call', messageIndex: 3 }];
  for (const agents of [[{ id: 'first', nativeId: 'child', historical: true, parentToolCallId: 'call' }, { id: 'second', nativeId: 'child', historical: true, parentToolCallId: 'other' }], [{ id: 'child', parentToolCallId: 'absent' }], [{ id: 'child.named', parentToolCallId: 'call' }]]) assert.deepEqual(resolveNativeTaskOwnership(parsed, agents, anchors, 9).linked, []);
  assert.deepEqual(resolveNativeTaskOwnership(parsed, [{ id: 'child', parentToolCallId: 'call' }], anchors, 2).linked, []);
  const duplicate = parseNativeAsyncDelivery(delivery(batch([{ id: 'child', text: envelope('child') }, { id: 'child', text: envelope('child') }]), [{ jobId: 'child', type: 'task' }, { jobId: 'child', type: 'task' }]))!;
  assert.ok(duplicate.jobs.every(job => job.ambiguous));
  assert.deepEqual(resolveNativeTaskOwnership(duplicate, [{ id: 'child', parentToolCallId: 'call' }], anchors, 9).linked, []);
});

test('ambiguous envelopes and unsegmented batches preserve original content without settling tasks', () => {
  for (const source of [envelope('child') + envelope('child', 'failed (exit 1)'), envelope('child').replace('status="completed"', 'status="completed" status="cancelled"'), envelope('child').replace('</task-result>', ''), envelope('child', 'completed', `<output>\n${envelope('nested')}\n</output>`)]) {
    const parsed = parseNativeAsyncDelivery(delivery(source))!;
    assert.equal(parsed.jobs[0].status, 'unknown');
    assert.equal(parsed.jobs[0].ambiguous, true);
    assert.equal(parsed.jobs[0].content, source);
  }
  const source = envelope('a') + envelope('b');
  const parsed = parseNativeAsyncDelivery(delivery(source, [{ jobId: 'a', type: 'task' }, { jobId: 'b', type: 'task' }]))!;
  assert.deepEqual(parsed.residualContent, [{ type: 'text', text: source }]);
  assert.ok(parsed.jobs.every(job => job.ambiguous));
});

test('bounded interpretation retains long output, preview references and oversized raw data without granting paths', () => {
  const long = 'x'.repeat(12000);
  assert.equal(parseNativeAsyncDelivery(delivery(envelope('child', 'completed', `<output>\n${long}\n</output>`)))!.jobs[0].result, long);
  const preview = parseNativeAsyncDelivery(delivery(envelope('child', 'completed', '<preview full-output="agent://foreign">\nPreview\n</preview>')))!;
  assert.equal(preview.jobs[0].agentId, 'child');
  assert.equal(preview.jobs[0].result, 'Preview');
  assert.equal('outputPath' in preview.jobs[0], false);
  const source = envelope('child') + 'x'.repeat(1024 * 1024);
  const oversized = parseNativeAsyncDelivery(delivery(source))!;
  assert.equal(oversized.jobs[0].status, 'unknown');
  assert.deepEqual(oversized.residualContent, [{ type: 'text', text: source }]);
});

test('delivery snapshot replacements and revisions cannot reuse stale settlement evidence', () => {
  const message = { ...delivery(envelope('child')), revision: 1 };
  assert.equal(parseNativeAsyncDelivery(message)!.jobs[0].status, 'completed');
  message.content = envelope('child', 'failed (exit 1)', '<error>Stopped</error>\n<output>\nPartial\n</output>');
  assert.equal(parseNativeAsyncDelivery(message)!.jobs[0].status, 'failed');
  const jobs = [{ jobId: 'different', type: 'bash' }];
  message.details = { jobs };
  assert.equal(parseNativeAsyncDelivery(message)!.jobs[0].type, 'bash');
  jobs[0].type = 'task'; message.revision++;
  const revised = parseNativeAsyncDelivery(message)!;
  assert.equal(revised.jobs[0].type, 'task');
  assert.equal(revised.jobs[0].status, 'failed');
  assert.deepEqual(revised, parseNativeAsyncDelivery(structuredClone(message)));
});

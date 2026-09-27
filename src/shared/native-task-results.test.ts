import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNativeTaskDelivery } from './native-task-results';

const envelope = (id: string, status = 'completed', body = '<output>\nResult\n</output>') => `<task-result id="${id}" agent="task" status="${status}" duration="1m35s">\n${body}\n</task-result>`;
const delivery = (content: unknown, jobs: unknown[] = [{ jobId: 'child', type: 'task', label: 'Review', durationMs: 95015 }]) => ({ role: 'custom', customType: 'async-result', content, details: { jobs } });

test('native delivery headers determine terminal states, never the completed notification headline', () => {
  const failed = parseNativeTaskDelivery(delivery(`<system-notice>Background job child has completed.\n${envelope('child', 'failed (exit 1)', '<error>Provider stopped</error>\n<output>\nPartial work\n</output>')}\n</system-notice>`))!;
  assert.deepEqual(failed.jobs[0], { id: 'child', label: 'Review', status: 'failed', agent: 'task', durationMs: 95015, duration: '1m35s', result: 'Partial work', error: 'Provider stopped', abortReason: undefined });
  assert.equal(parseNativeTaskDelivery(delivery('Background job child has completed.'))!.jobs[0]!.status, 'unknown');
  assert.equal(parseNativeTaskDelivery(delivery(envelope('child', 'failed')))!.jobs[0]!.status, 'unknown');
  assert.equal(parseNativeTaskDelivery(delivery(envelope('child', 'merge failed')))!.jobs[0]!.status, 'failed');
  const cancelled = parseNativeTaskDelivery(delivery(envelope('child', 'cancelled', '<abort-reason>Stopped by user</abort-reason>\n<output>\nPartial\n</output>')))!;
  assert.equal(cancelled.jobs[0]!.status, 'aborted');
  assert.equal(cancelled.jobs[0]!.abortReason, 'Stopped by user');
});

test('native metadata establishes candidates and unrelated headers cannot establish task identities', () => {
  assert.equal(parseNativeTaskDelivery({ ...delivery(envelope('child')), role: 'assistant' }), null);
  assert.equal(parseNativeTaskDelivery(delivery(envelope('child'), [{ jobId: 'child', type: 'bash' }])), null);
  const result = parseNativeTaskDelivery(delivery(envelope('foreign') + '\n' + envelope('child')))!;
  assert.deepEqual(result.jobs.map(job => [job.id, job.status]), [['child', 'completed']]);
  assert.equal(parseNativeTaskDelivery(delivery(envelope('foreign')))!.jobs[0]!.status, 'unknown');
  const invalid = parseNativeTaskDelivery(delivery(envelope('../escape'), [{ jobId: '../escape', type: 'task' }]))!;
  assert.deepEqual(invalid.jobs, []);
  assert.ok(invalid.diagnostics.some(item => item.includes('identity')));
});

test('duplicate, conflicting, malformed and nested envelopes remain unknown', () => {
  for (const content of [
    envelope('child') + '\n' + envelope('child'),
    envelope('child') + '\n' + envelope('child', 'failed (exit 1)'),
    envelope('child').replace('status="completed"', 'status="completed" status="cancelled"'),
    envelope('child').replace('</task-result>', ''),
    envelope('child', 'completed', `<output>\n${envelope('child', 'failed (exit 1)')}\n</output>`),
  ]) {
    const result = parseNativeTaskDelivery(delivery(content))!;
    assert.equal(result.jobs[0]!.status, 'unknown');
    assert.equal(result.jobs[0]!.result, undefined);
    assert.ok(result.diagnostics.length > 0);
  }
  const duplicated = parseNativeTaskDelivery(delivery(envelope('child'), [{ jobId: 'child', type: 'task' }, { jobId: 'child', type: 'task' }]))!;
  assert.equal(duplicated.jobs[0]!.status, 'unknown');
});

test('bounded parsing supports native text blocks and previews without authorizing output paths', () => {
  const result = parseNativeTaskDelivery(delivery([{ type: 'text', text: envelope('child', 'completed', '<preview full-output="agent://foreign">\nPreview only\n</preview>') }, { type: 'image', data: 'ignored' }]))!;
  assert.equal(result.jobs[0]!.result, 'Preview only');
  assert.equal(result.jobs[0]!.status, 'completed');
  assert.equal('outputPath' in result.jobs[0]!, false);
  const oversized = parseNativeTaskDelivery(delivery(envelope('child') + 'x'.repeat(1024 * 1024)))!;
  assert.equal(oversized.jobs[0]!.status, 'unknown');
  assert.ok(oversized.diagnostics.some(item => item.includes('bounds')));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubmissionStore, submissionReceiptVisible } from './submissions';

test('equal original inputs retain independent late outcomes without becoming transcript messages', () => {
  const store = new SubmissionStore();
  const first = store.begin('runtime', 'session', { text: '/skill review', mode: 'prompt' });
  const second = store.begin('runtime', 'session', { text: '/skill review', mode: 'prompt' });
  store.started('runtime', { submissionId: first.id, requestId: 'prompt:a', sessionId: 'session' });
  store.receive('runtime', { type: 'prompt_result', id: 'prompt:a', status: 'error', error: { message: 'Late skill failure' }, sessionSettled: true });
  store.accepted(first.id, { requestId: 'prompt:a', data: { agentInvoked: true } });
  store.accepted(second.id, { requestId: 'prompt:b', data: { agentInvoked: true } });
  store.receive('other-runtime', { type: 'prompt_result', id: 'prompt:b', status: 'completed' });
  assert.deepEqual(store.getSnapshot().map(item => [item.input.text, item.status, item.error]), [['/skill review', 'error', 'Late skill failure'], ['/skill review', 'accepted', undefined]]);
  store.receive('runtime', { type: 'prompt_result', id: 'prompt:b', status: 'completed', sessionSettled: false });
  assert.equal(store.getSnapshot()[1].sessionSettled, false);
});

test('queue acknowledgement survives Stop and aggregate queue changes without a delivery claim', () => {
  const store = new SubmissionStore();
  const receipt = store.begin('runtime', 'session', { text: 'Keep this intent', mode: 'follow_up' });
  store.accepted(receipt.id, { requestId: 'prompt:queue', data: undefined });
  for (const frame of [{ type: 'agent_end', isTerminal: true }, { type: 'state_snapshot', state: { queuedMessageCount: 0 } }, { type: 'session_settled' }]) store.receive('runtime', frame);
  assert.equal(store.getSnapshot()[0].status, 'queue-accepted');
  store.unobserved('runtime');
  assert.equal(store.getSnapshot()[0].status, 'unknown');
  assert.equal(store.getSnapshot()[0].input.text, 'Keep this intent');
});

test('capacity rejects new intent without evicting failed or unresolved receipts', () => {
  const store = new SubmissionStore();
  for (let index = 0; index < 64; index++) { const receipt = store.begin('runtime', 'session', { text: `intent ${index}` }); store.rejected(receipt.id, 'Admission rejected'); }
  assert.throws(() => store.begin('runtime', 'session', { text: 'must remain draft' }));
  assert.deepEqual(store.getSnapshot().map(item => item.input.text), Array.from({ length: 64 }, (_, index) => `intent ${index}`));
  store.dismiss(store.getSnapshot()[0].id);
  store.begin('runtime', 'session', { text: 'explicitly recovered capacity' });
  assert.equal(store.getSnapshot().at(-1)?.input.text, 'explicitly recovered capacity');
});

test('completed receipts are bounded while unresolved original intent is retained', () => {
  const store = new SubmissionStore();
  const unresolved = store.begin('runtime', 'session', { text: 'preserve original', mode: 'steer' });
  store.accepted(unresolved.id, { requestId: 'prompt:unresolved', data: undefined });
  for (let index = 0; index < 40; index++) {
    const receipt = store.begin('runtime', 'session', { text: `command ${index}` });
    store.accepted(receipt.id, { requestId: `prompt:${index}`, data: { agentInvoked: false } });
  }
  assert.deepEqual(store.getSnapshot().map(item => item.input.text), ['preserve original', ...Array.from({ length: 12 }, (_, index) => `command ${index + 28}`)]);
  assert.equal(store.getSnapshot()[0].status, 'queue-accepted');
});

test('native frames cannot impersonate host submission correlation', () => {
  const store = new SubmissionStore();
  const receipt = store.begin('runtime', 'session', { text: 'original intent' });
  store.receive('runtime', { type: 'desktop_submission_started', submissionId: receipt.id, requestId: 'forged', sessionId: 'session' });
  store.receive('runtime', { type: 'prompt_result', id: 'forged', status: 'completed' });
  assert.equal(store.getSnapshot()[0].requestId, undefined);
  assert.equal(store.getSnapshot()[0].status, 'submitting');
  store.started('runtime', { submissionId: receipt.id, requestId: 'host-owned', sessionId: 'session' });
  store.receive('runtime', { type: 'prompt_result', id: 'host-owned', status: 'error', error: { message: 'Actual failure' } });
  assert.equal(store.getSnapshot()[0].error, 'Actual failure');
});

test('a mismatched host target cannot turn an early failure into acceptance under the original session', () => {
  const store = new SubmissionStore();
  const receipt = store.begin('runtime', 'session-A', { text: 'belongs to A' });
  store.started('runtime', { submissionId: receipt.id, requestId: 'host-B', sessionId: 'session-B' });
  store.receive('runtime', { type: 'prompt_result', id: 'host-B', status: 'error', error: { message: 'Early native failure' } });
  store.accepted(receipt.id, { requestId: 'host-B', data: { agentInvoked: true } });
  assert.equal(store.getSnapshot()[0].sessionId, 'session-A');
  assert.equal(store.getSnapshot()[0].status, 'error');
  assert.equal(store.getSnapshot()[0].input.text, 'belongs to A');
  assert.equal(store.getSnapshot()[0].error, 'Early native failure');
});

test('receipts surface slow admission, queues and failures without accepted-turn noise', context => {
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const store = new SubmissionStore();
  const receipt = store.begin('runtime', 'session', { text: 'work' });
  assert.equal(submissionReceiptVisible(receipt, 3999), false);
  assert.equal(submissionReceiptVisible(receipt, 4000), true);
  store.accepted(receipt.id, { requestId: 'request', data: { agentInvoked: true } });
  assert.equal(submissionReceiptVisible(store.getSnapshot()[0], 10000), false);
  store.receive('runtime', { type: 'prompt_result', id: 'request', status: 'completed' });
  assert.equal(submissionReceiptVisible(store.getSnapshot()[0], 10000), false);
  store.receive('runtime', { type: 'prompt_result', id: 'request', status: 'error', error: 'Late failure' });
  assert.equal(submissionReceiptVisible(store.getSnapshot()[0], 10000), true);
  const queued = store.begin('runtime', 'session', { text: 'next', mode: 'follow_up' });
  store.accepted(queued.id, { requestId: 'queue', data: undefined });
  assert.equal(submissionReceiptVisible(store.getSnapshot()[1], 1000), true);
});

test('stopped receipts stay hidden and bounded without concealing failures', () => {
  const store = new SubmissionStore();
  const failed = store.begin('runtime', 'session', { text: 'failed' });
  store.rejected(failed.id, 'Unexpected failure');
  for (let index = 0; index < 70; index++) {
    const receipt = store.begin('runtime', 'session', { text: `stopped ${index}` });
    store.accepted(receipt.id, { requestId: `request:${index}`, data: undefined });
    store.receive('runtime', { type: 'prompt_result', id: `request:${index}`, status: 'aborted' });
    assert.equal(submissionReceiptVisible(store.getSnapshot().at(-1)!, Date.now()), false);
  }
  assert.deepEqual(store.getSnapshot().map(item => item.input.text), ['failed', ...Array.from({ length: 12 }, (_, index) => `stopped ${index + 58}`)]);
  assert.equal(submissionReceiptVisible(store.getSnapshot()[0], Date.now()), true);
});
test('terminal turn failures are bounded without hiding rejected admission', () => {
  const store = new SubmissionStore();
  const rejected = store.begin('runtime', 'session', { text: 'restore this draft' });
  store.rejected(rejected.id, 'Admission rejected');
  for (let index = 0; index < 70; index++) {
    const receipt = store.begin('runtime', 'session', { text: `failed turn ${index}` });
    store.accepted(receipt.id, { requestId: `terminal:${index}`, data: { agentInvoked: true } });
    store.receive('runtime', { type: 'prompt_result', id: `terminal:${index}`, status: 'error', error: 'Provider failed', sessionSettled: true });
    assert.equal(submissionReceiptVisible(store.getSnapshot().at(-1)!, Date.now()), false);
  }
  assert.deepEqual(store.getSnapshot().map(item => item.input.text), ['restore this draft', ...Array.from({ length: 12 }, (_, index) => `failed turn ${index + 58}`)]);
  assert.equal(submissionReceiptVisible(store.getSnapshot()[0], Date.now()), true);
  assert.equal(store.getSnapshot()[0].error, 'Admission rejected');
});

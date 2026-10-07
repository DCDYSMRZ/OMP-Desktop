import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declaredNativeContent, messageSemantics, nativeEventPresentation, nativeMessageNotice, nativeTaskDeliveryLinkVerified } from './native-message-semantics';
import { nativeHarnessNotice } from '../../shared/native-harness-notice';

test('speaker attribution does not grant arbitrary custom content a new human turn', () => {
  for (const customType of ['skill-prompt', 'collab-prompt']) {
    const request = { role: 'custom', display: true, attribution: 'user', customType };
    assert.equal(messageSemantics(request).initiatesTurn, true);
    assert.equal(messageSemantics({ ...request, attribution: 'agent' }).initiatesTurn, false);
  }
  for (const customType of ['background-tan-dispatch', 'advisor', 'extension-note']) {
    const semantics = messageSemantics({ role: 'custom', display: true, attribution: 'user', customType });
    assert.equal(semantics.actor, 'user');
    assert.equal(semantics.initiatesTurn, false);
  }
  assert.equal(messageSemantics({ role: 'user', attribution: 'agent' }).actor, 'agent');
  assert.equal(messageSemantics({ role: 'user', attribution: 'agent' }).initiatesTurn, false);
  assert.equal(messageSemantics({ role: 'user', synthetic: true }).initiatesTurn, false);
  assert.equal(messageSemantics({ role: 'user', synthetic: true, userInitiated: true }).initiatesTurn, true);
});

test('hidden and absent custom visibility cannot expose injected instruction prose', () => {
  for (const role of ['custom', 'hookMessage']) for (const display of [undefined, false]) {
    assert.equal(messageSemantics({ role, customType: 'skill-prompt', attribution: 'user', display }).visible, false);
  }
  for (const role of ['system', 'developer']) assert.equal(messageSemantics({ role, display: true, content: 'secret instructions' }).visible, false);
  assert.equal(messageSemantics({ role: 'future', display: false, content: 'hidden' }).visible, false);
});

test('native execution, context and future records remain in their declared scope', () => {
  for (const role of ['bashExecution', 'pythonExecution', 'fileMention']) {
    const semantics = messageSemantics({ role });
    assert.equal(semantics.actor, 'user');
    assert.equal(semantics.family, 'activity');
    assert.equal(semantics.initiatesTurn, false);
  }
  for (const role of ['compactionSummary', 'branchSummary']) assert.equal(messageSemantics({ role }).family, 'boundary');
  assert.equal(messageSemantics({ role: 'custom', customType: 'reset_boundary', display: true }).family, 'boundary');
  assert.equal(messageSemantics({ role: 'future-result', toolCallId: 'tool-7' }).actor, 'tool');
  assert.equal(messageSemantics({ role: 'future-result', attribution: 'user' }).actor, 'user');
  assert.equal(messageSemantics({ role: 'future-result' }).actor, 'session');
  for (const customType of ['async-result', 'lsp-late-diagnostic', 'advisor', 'irc:incoming', 'irc:relay', 'irc:autoreply', 'irc:workpool', 'launch-completion', 'handoff', 'live-delegation']) {
    const semantics = messageSemantics({ role: 'custom', customType, display: true, attribution: 'agent' });
    assert.equal(semantics.family, 'activity');
    assert.equal(semantics.initiatesTurn, false);
    assert.equal(semantics.actor, 'agent');
  }
});

test('future declared text and media stay ordered and literal without opening replay payloads', () => {
  const literal = '# heading\n<task-result>not markup</task-result>\n  **literal**';
  assert.deepEqual(declaredNativeContent({ role: 'user', content: literal }), [{ type: 'text', text: literal }]);
  const image = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
  assert.deepEqual(declaredNativeContent({ type: 'future', content: [{ type: 'text', text: 'first' }, image, { type: 'text', text: 'first' }] }), [{ type: 'text', text: 'first' }, image, { type: 'text', text: 'first' }]);
  assert.deepEqual(declaredNativeContent({ type: 'future', text: 'Visible', providerPayload: { text: 'Opaque' } }), [{ type: 'text', text: 'Visible' }]);
  assert.deepEqual(declaredNativeContent({ type: 'future', providerPayload: { text: 'Opaque' }, thinkingSignature: 'signed' }), []);
  assert.deepEqual(declaredNativeContent({ type: 'redactedThinking', data: 'encrypted', text: 'not prose' }), []);
  assert.deepEqual(declaredNativeContent({ type: 'future', display: false, text: 'hidden' }), []);
});

test('recovery and interruption do not erase genuine errors or become new failures', () => {
  const failed = { role: 'assistant', content: [{ type: 'text', text: 'Partial answer' }], stopReason: 'error', errorMessage: 'Connection lost' };
  assert.deepEqual(nativeMessageNotice(failed), { tone: 'error', text: 'Connection lost' });
  for (const status of ['recovered', 'superseded']) assert.deepEqual(nativeMessageNotice({ ...failed, retryRecovery: { kind: 'auto-retry', status, note: 'Retried on another model' } }), { tone: 'info', text: 'Retried on another model' });
  assert.equal(nativeMessageNotice({ ...failed, errorId: 0x02000000 }), undefined);
  assert.equal(nativeMessageNotice({ ...failed, errorMessage: '__omp.silent_abort__' }), undefined);
  assert.deepEqual(nativeMessageNotice({ ...failed, errorId: 0x04000000 }), { tone: 'info', text: 'Interrupted by user' });
  assert.deepEqual(nativeMessageNotice({ role: 'assistant', stopReason: 'aborted' }), { tone: 'info', text: 'Operation aborted' });
  assert.deepEqual(nativeMessageNotice({ role: 'toolResult', isError: true }), { tone: 'error', text: 'Native operation failed' });
});

test('event lifecycle reuses family slots and ignores transport without losing unfamiliar visible notices', () => {
  const start = nativeEventPresentation({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 1200, errorMessage: 'Busy' });
  const end = nativeEventPresentation({ type: 'auto_retry_end', success: true });
  assert.equal(start?.key, end?.key);
  assert.equal(start?.terminal, false);
  assert.equal(end?.terminal, true);
  assert.equal(end?.tone, 'success');
  assert.match(start!.text, /Busy/);
  assert.equal(nativeEventPresentation({ type: 'auto_compaction_end', error: 'Archive failed' })?.tone, 'error');
  assert.equal(nativeEventPresentation({ type: 'command_output', text: 'Native command failed', id: 'one' })?.key, nativeEventPresentation({ type: 'command_output', text: 'Finished', id: 'two' })?.key);
  for (const type of ['message_update', 'response', 'extension_ui_request', 'prompt_result', 'heartbeat']) assert.equal(nativeEventPresentation({ type, text: 'transport' }), undefined);
  assert.equal(nativeEventPresentation({ type: 'future_notice', message: 'Useful notice' })?.text, 'Useful notice');
  assert.equal(nativeEventPresentation({ type: 'session_future_notice', message: 'Session-owned future notice' })?.text, 'Session-owned future notice');
  assert.equal(nativeEventPresentation({ type: 'future_notice', providerPayload: { text: 'opaque' } }), undefined);
  assert.equal(nativeEventPresentation({ type: 'future_notice', display: false, text: 'hidden' }), undefined);
});

test('reported task outcomes cannot establish a child link without verified ownership evidence', () => {
  const job = { type: 'task' as const, agentId: 'worker', ambiguous: false };
  const child = { id: 'saved-worker', nativeId: 'worker', historical: true, parentToolCallId: 'original-call' };
  assert.equal(nativeTaskDeliveryLinkVerified(job, false, child), false);
  assert.equal(nativeTaskDeliveryLinkVerified(job, true, undefined), false);
  assert.equal(nativeTaskDeliveryLinkVerified(job, true, { ...child, parentToolCallId: undefined }), false);
  assert.equal(nativeTaskDeliveryLinkVerified({ ...job, ambiguous: true }, true, child), false);
  assert.equal(nativeTaskDeliveryLinkVerified({ ...job, agentId: 'another-worker' }, true, child), false);
  assert.equal(nativeTaskDeliveryLinkVerified(job, true, { ...child, nativeId: undefined }), false);
  assert.equal(nativeTaskDeliveryLinkVerified(job, true, child), true);
  assert.equal(nativeTaskDeliveryLinkVerified({ ...job, type: 'bash' }, true, child), false);
});
test('native harness interruptions are neutral without suppressing genuine tool errors',()=>{
 assert.equal(nativeHarnessNotice({isError:true,content:'Skipped due to a queued background completion.'})?.tone,'info');
 assert.equal(nativeHarnessNotice({isError:true,content:'Wait interrupted by message'})?.tone,'info');
 assert.equal(nativeHarnessNotice({isError:true,content:'Compilation failed: syntax error'}),undefined);
});
test('native interruption sources share one neutral protocol without hiding unrelated errors',()=>{
 const reasons=['pending steering message','queued user message','pending parent steering message','pending system advisory','pending peer interrupt','a queued background completion (job or supervised process)'];
 for(const reason of reasons){
  const content=`Skipped due to ${reason}. Do not count this skipped result as completed work or verification. After the interrupt is handled on the next step, retry the skipped tool if it is still needed.`;
  assert.equal(nativeHarnessNotice({isError:true,content})?.text,content);
  assert.equal(nativeHarnessNotice({isError:true,content:`Skipped due to ${reason}. Retry later.`})?.tone,'info');
 }
 assert.equal(nativeHarnessNotice({isError:true,content:'Skipped due to a future native wake. Do not count this skipped result as completed work or verification.'})?.tone,'info');
 for(const details of [{source:'interrupt_skipped',__synthetic:true,executed:false},{source:'interrupt_skipped',__interrupted:true,execution:'started'}])assert.equal(nativeHarnessNotice({isError:true,content:'Interrupted operation',details})?.tone,'info');
 assert.equal(nativeHarnessNotice({isError:true,content:'Skipped due to invalid credentials.'}),undefined);
 assert.equal(nativeHarnessNotice({isError:true,content:'Compilation failed. Skipped due to pending peer interrupt.'}),undefined);
});

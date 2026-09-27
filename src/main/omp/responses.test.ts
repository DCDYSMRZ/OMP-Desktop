import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeResponseError, NativeResponses } from './responses';

test('responses correlate by id and reject native errors rather than resolving false success', async () => {
  const responses = new NativeResponses();
  const state = responses.register('state', 'get_state');
  const prompt = responses.register('prompt', 'prompt');
  const rejected = assert.rejects(prompt, error => error instanceof NativeResponseError && error.code === 'session_busy' && error.command === 'prompt');
  assert.equal(responses.accept({ type: 'response', id: 'prompt', command: 'prompt', success: false, error: 'Busy', code: 'session_busy' }), true);
  responses.accept({ type: 'response', id: 'state', command: 'get_state', success: true, data: { sessionId: 's', isStreaming: false } });
  assert.deepEqual(await state, { sessionId: 's', isStreaming: false });
  await rejected;
});

test('transport exit rejects every outstanding response and prevents new requests', async () => {
  const responses = new NativeResponses();
  const login = assert.rejects(responses.register('login', 'login'), /stdout closed/);
  const approval = assert.rejects(responses.register('approval', 'prompt'), /stdout closed/);
  responses.terminate(new Error('stdout closed'));
  await Promise.all([login, approval]);
  assert.throws(() => responses.register('next', 'get_state'), /stdout closed/);
});

test('mismatched command cannot resolve a different request; late prompt errors stay observable', async () => {
  const responses = new NativeResponses();
  const accepted = responses.register('p', 'prompt');
  assert.throws(() => responses.accept({ type: 'response', id: 'p', command: 'abort', success: true }), /does not match/);
  responses.accept({ type: 'response', id: 'p', command: 'prompt', success: true });
  assert.equal(await accepted, undefined);
  assert.equal(responses.accept({ type: 'response', id: 'p', command: 'prompt', success: false, error: 'Provider failed after acceptance' }), false);
});

test('duplicate request IDs cannot orphan the first caller', async () => {
  const responses = new NativeResponses();
  const first = responses.register('same', 'get_state');
  assert.throws(() => responses.register('same', 'get_state'), /Duplicate/);
  responses.accept({ type: 'response', id: 'same', command: 'get_state', success: true, data: { sessionId: 'original' } });
  assert.deepEqual(await first, { sessionId: 'original' });
});

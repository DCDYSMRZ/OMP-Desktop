import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { presenceAccess, presenceRequest, PresenceSubscription, watchPresenceChanges } from './presence';
import { SessionPresenceObserver } from './session-observer';

test('lock proof distinguishes free, owned, external and unresponsive holders', () => {
  const holder = { pid: 42, processStartMs: 1, socketPath: '/socket', responsive: true };
  assert.equal(presenceAccess('free', [], []) , undefined);
  assert.equal(presenceAccess('held', [holder], [42])?.status, 'owned');
  assert.equal(presenceAccess('held', [holder], [])?.status, 'external');
  assert.equal(presenceAccess('held', [], [42])?.status, 'external');
  assert.equal(presenceAccess('unknown', [], [])?.status, 'unknown');
});

// Integration: actual Unix sockets exercise the absolute platform deadline and reconnect timer.
test('silent sockets time out and subscribers reconnect without inventing idle', { timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'presence-test-'));
  const path = join(root, 'p.sock');
  const clients = new Set<Socket>();
  let subscriptions = 0, failures = 0;
  const received = Promise.withResolvers<void>();
  const server = createServer(socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket));
    socket.on('data', bytes => {
      const request = JSON.parse(String(bytes));
      if (request.type !== 'subscribe') return;
      subscriptions++;
      if (subscriptions === 1) { socket.destroy(); return; }
      socket.write(JSON.stringify({ id: 3, ok: true }) + '\n' + JSON.stringify({ event: 'state', state: 'running', sessionFile: '/session', sessionId: 's', since: 1, requestStartedAt: 1 }) + '\n');
    });
  });
  server.listen(path); await once(server, 'listening');
  let subscription: PresenceSubscription | undefined;
  try {
    const start = Date.now();
    await assert.rejects(presenceRequest(path, { id: 1, type: 'hello' }, 50), /timed out/);
    assert.ok(Date.now() - start < 500);
    subscription = new PresenceSubscription(path, '/session', event => { assert.equal(event.event, 'state'); received.resolve(); }, () => { failures++; }, 20);
    await received.promise;
    assert.equal(subscriptions, 2); assert.equal(failures, 1);
  } finally { subscription?.close(); for (const client of clients) client.destroy(); server.close(); await rm(root, { recursive: true, force: true }); }
});

test('persisted-before-message-end race removes the streamed suffix only once', () => {
  const observer = new SessionPresenceObserver('/session', () => {});
  const old = { id: 'old', raw: { role: 'assistant', content: [{ type: 'text', text: 'same response' }] } };
  observer.reconcile([old]);
  observer.receive({ event: 'delta', kind: 'text', text: 'same response' });
  const saved = { ...old, id: 'new' };
  observer.reconcile([old, saved]);
  assert.deepEqual(observer.tails, []);
  observer.receive({ event: 'message_end' });
  observer.reconcile([old, saved]);
  assert.deepEqual(observer.tails, []);
  observer.close();
});

test('an unresponsive participating holder remains unknown activity, not idle', async () => {
  const observer = new SessionPresenceObserver('/session', () => {});
  try {
    await observer.poll({ status: 'external', occupancySource: 'presence', confidence: 'exact', checkedAt: 1 }, { complete: true, processes: [{ pid: 42, processStartMs: 1, socketPath: '/absent', responsive: false }] });
    assert.equal(observer.activity?.state, 'unknown');
    assert.equal(observer.activity?.source, 'presence');
    assert.equal(observer.activity?.confidence, 'exact');
    await observer.poll({ status: 'idle', occupancySource: 'presence', confidence: 'exact', checkedAt: 2 }, { complete: true, processes: [] });
    assert.equal(observer.activity?.state, 'idle');
  } finally { observer.close(); }
});

test('a disconnected prefix reconciles to the later complete durable response', () => {
  const observer = new SessionPresenceObserver('/session', () => {});
  observer.reconcile([]);
  observer.receive({ event: 'delta', kind: 'text', text: 'Beginning of' });
  observer.reconcile([{ id: 'saved', raw: { role: 'assistant', content: [{ type: 'text', text: 'Beginning of the completed response.' }] } }]);
  assert.deepEqual(observer.tails, []);
  observer.close();
});

test('selected-session presence observation survives roots created after selection', { timeout: 3000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'presence-late-root-')));
  const directory = join(root, 'run', 'presence', 'v1');
  let observed = Promise.withResolvers<void>();
  const stop = watchPresenceChanges(() => observed.resolve(), [directory]);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'peer.sock'), 'present');
    await observed.promise;
    observed = Promise.withResolvers<void>();
    await rm(directory, { recursive: true });
    await observed.promise;
    observed = Promise.withResolvers<void>();
    await mkdir(directory);
    await writeFile(join(directory, 'replacement.sock'), 'present');
    await observed.promise;
  } finally { stop(); await rm(root, { recursive: true, force: true }); }
});

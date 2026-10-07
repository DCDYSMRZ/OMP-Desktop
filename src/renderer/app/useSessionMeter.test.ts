import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopApi, NativeState, SessionConnection } from '../../shared/contracts';
import { RuntimeStore } from './runtime-store';
import { buildSessionMeter } from './session-meter-model';

test('completed assistant requests refresh occupancy while the same turn stays streaming', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const timers = new Map<number, () => void>();
  let sequence = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 400); const id = ++sequence; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id) } });
  try {
    const source = { status: 'unpersisted' as const, sessionId: 'session' };
    let state: NativeState = { sessionId: 'session', isStreaming: true, model: { provider: 'p', id: 'm', contextWindow: 1000000 }, contextUsage: { tokens: 100000, contextWindow: 1000000, percent: 10 } };
    const connection: SessionConnection = { runtimeId: 'runtime', cwd: '/tmp', source, state, messages: [], models: [], commands: [], thinkingLevels: [] };
    let interleaveTokens = false;
    const api = {
      startSession: async () => connection,
      request: async (_id: string, command: { type: string }) => {
        if (command.type !== 'get_state') return { subagents: [] };
        if (interleaveTokens) store.receive({ runtimeId: 'runtime', kind: 'frame', frame: { type: 'message_update', messageId: 'next-request', message: { role: 'assistant', content: [] } } });
        return state;
      },
      getRuntimeAccess: async () => ({ source, status: 'owned', canSend: true, canFork: false, checkedAt: 0 }),
    } as unknown as DesktopApi;
    const store = new RuntimeStore(api, error => { throw new Error(error.message); }, () => {});
    await store.start({ cwd: '/tmp' });
    await store.refresh('runtime');
    interleaveTokens = true;
    for (const tokens of [270000, 568628]) {
      state = { ...state, contextUsage: { tokens, contextWindow: 1000000, percent: tokens / 10000 } };
      store.receive({ runtimeId: 'runtime', kind: 'frame', frame: { type: 'message_update', messageId: `request-${tokens}`, message: { role: 'assistant', content: [] } } });
      assert.equal(timers.size, 0);
      store.receive({ runtimeId: 'runtime', kind: 'frame', frame: { type: 'message_end', messageId: `request-${tokens}`, message: { role: 'assistant', content: [] } } });
      assert.equal(timers.size, 1);
      const callback = [...timers.values()][0]; timers.clear(); callback();
      const tick = Promise.withResolvers<void>(); setImmediate(tick.resolve); await tick.promise;
      const chat = store.getSnapshot().runtime.chat;
      assert.equal(chat.state.isStreaming, true);
      assert.equal(buildSessionMeter({ chat, live: true }).context.tokens, tokens);
    }
    store.forget(['runtime']);
  } finally { if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window'); }
});

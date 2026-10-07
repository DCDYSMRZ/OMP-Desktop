import type { PromptInput } from '../../../shared/contracts';
import type { Draft } from './drafts';

export interface QueuedPrompt { id: string; runtimeId: string; sessionId: string; input: PromptInput; draft: Draft; paused: boolean; sending: boolean; error?: string }
export type QueueDelivery = 'prompt' | 'steer' | 'abort_and_prompt';
/** Desktop ownership is deliberate: native follow_up cannot be cleared on Stop. */
export class DesktopQueue {
  private items: QueuedPrompt[] = [];
  private listeners = new Set<() => void>();
  private active = new Set<string>();
  constructor(private deliver: (item: QueuedPrompt, mode: QueueDelivery) => Promise<void>) {}
  getSnapshot = () => this.items;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(items: QueuedPrompt[]) { this.items = items; for (const listener of this.listeners) listener(); }
  enqueue(runtimeId: string, sessionId: string, input: PromptInput, draft: Draft) {
    const item: QueuedPrompt = { id: crypto.randomUUID(), runtimeId, sessionId, input: { ...input, mode: 'prompt' }, draft, paused: false, sending: false };
    this.publish([...this.items, item]);
  }
  pause(runtimeId: string) { this.publish(this.items.map(item => item.runtimeId === runtimeId ? { ...item, paused: true } : item)); }
  remove(id: string): QueuedPrompt | undefined {
    const item = this.items.find(item => item.id === id && !item.sending);
    if (item) this.publish(this.items.filter(row => row !== item));
    return item;
  }
  forget(runtimeIds: readonly string[]) {
    this.publish(this.items.filter(item => !runtimeIds.includes(item.runtimeId)));
    for (const id of runtimeIds) this.active.delete(id);
  }
  async send(id: string, mode: QueueDelivery) {
    const item = this.items.find(item => item.id === id);
    if (!item || item.sending || this.active.has(item.runtimeId)) return;
    if (mode === 'abort_and_prompt') this.pause(item.runtimeId);
    this.active.add(item.runtimeId);
    this.publish(this.items.map(row => row.id === id ? { ...row, sending: true, error: undefined } : row));
    try {
      await this.deliver(item, mode);
      this.publish(this.items.filter(row => row.id !== id));
    } catch (cause) {
      this.pause(item.runtimeId);
      this.publish(this.items.map(row => row.id === id ? { ...row, sending: false, error: cause instanceof Error ? cause.message : String(cause) } : row));
      throw cause;
    } finally { this.active.delete(item.runtimeId); }
  }
  settled(runtimeId: string, sessionId: string) {
    if (this.active.has(runtimeId)) return;
    const item = this.items.find(item => item.runtimeId === runtimeId && item.sessionId === sessionId && !item.paused);
    if (item) void this.send(item.id, 'prompt').catch(() => undefined);
  }
}

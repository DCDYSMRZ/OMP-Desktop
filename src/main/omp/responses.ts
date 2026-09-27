import type { NativeFrame } from '../../shared/contracts';

export class NativeResponseError extends Error {
  constructor(message: string, readonly command: string, readonly code?: string) { super(message); this.name = 'NativeResponseError'; }
}

interface Pending { command: string; resolve: (value: unknown) => void; reject: (error: Error) => void }

/** Request lifetime is controlled by native response or transport termination, never a run timer. */
export class NativeResponses {
  private pending = new Map<string, Pending>();
  private terminated?: Error;

  register(id: string, command: string): Promise<unknown> {
    if (this.terminated) throw this.terminated;
    if (this.pending.size >= 128) throw new Error('Too many pending native requests');
    if (this.pending.has(id)) throw new Error('Duplicate native request ID');
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.pending.set(id, { command, resolve, reject });
    return promise;
  }

  accept(frame: NativeFrame): boolean {
    if (frame.type !== 'response' || typeof frame.command !== 'string' || typeof frame.success !== 'boolean' || (frame.id !== undefined && typeof frame.id !== 'string') || (!frame.success && typeof frame.error !== 'string') || (frame.code !== undefined && typeof frame.code !== 'string')) throw new Error('Invalid native response envelope');
    const pending = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined;
    if (!pending) return false;
    if (pending.command !== frame.command) throw new Error('Native response command does not match its request');
    this.pending.delete(frame.id as string);
    if (frame.success) pending.resolve(frame.data);
    else pending.reject(new NativeResponseError(frame.error as string, frame.command, frame.code as string | undefined));
    return true;
  }

  reject(id: string, error: Error): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.reject(error);
  }

  terminate(error: Error): void {
    this.terminated ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

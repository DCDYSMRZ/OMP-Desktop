import type { SessionAccess } from '../../shared/contracts';

/** Serialize admissions, not UI reply delivery (native commands may await those replies). */
export class SessionAdmissions {
  #pending = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(key) ?? Promise.resolve();
    const done = Promise.withResolvers<void>();
    this.#pending.set(key, done.promise);
    await previous;
    try { return await operation(); }
    finally {
      done.resolve();
      if (this.#pending.get(key) === done.promise) this.#pending.delete(key);
    }
  }
}

export function requireWritable(access: SessionAccess): void {
  if (access.status !== 'idle' && access.status !== 'owned') {
    throw new Error(access.reason || (access.status === 'external' ? 'This session is owned by another native process' : 'Session ownership could not be verified'));
  }
}

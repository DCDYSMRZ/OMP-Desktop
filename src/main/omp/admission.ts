import { realpath, stat } from 'node:fs/promises';
import type { RuntimeSourceState, SessionAccess } from '../../shared/contracts';

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
  if (access.pending || access.status !== 'idle' && access.status !== 'owned') {
    throw new Error(access.reason || (access.status === 'external' ? 'This session is owned by another native process' : 'Session ownership could not be verified'));
  }
}

/** Window-lifetime capabilities, independent of whether a native child is connected. */
export class SessionHistoryGrants extends Set<string> {
  grantSource(source: RuntimeSourceState): void {
    if (source.path && source.status !== 'unavailable') this.add(source.path);
  }
  async approve(requested: string): Promise<string> {
    const path = await realpath(requested);
    if (!this.has(path)) throw new Error('Choose a native session file or select it from history first');
    if (!(await stat(path)).isFile()) throw new Error('Native session source is not a file');
    return path;
  }
}

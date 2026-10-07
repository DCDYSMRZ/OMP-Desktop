import { watch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HistoryListing } from '../../shared/contracts';

interface DiscoveryOptions {
  roots(): Promise<string[]>;
  list(): Promise<HistoryListing>;
  publish(listing: HistoryListing): void;
  onError(error: unknown): void;
}

/** Directory hints accelerate the same authoritative listing used by explicit refresh. */
export class HistoryDiscovery {
  private watchers = new Map<string, FSWatcher>();
  private debounce?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private dirty = false;
  private closed = false;
  private fingerprint?: string;
  constructor(private readonly options: DiscoveryOptions) {}
  start(): Promise<void> {
    if (!this.poll) { this.poll = setInterval(() => { void this.reconcile(); }, 5000); this.poll.unref(); }
    return this.reconcile();
  }
  request(): void {
    if (this.closed) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { void this.reconcile(); }, 300);
    this.debounce.unref();
  }
  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.dirty = true;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      do {
        this.dirty = false;
        try {
          await this.watchRoots(await this.options.roots());
          const listing = await this.options.list();
          if (this.closed) return;
          const fingerprint = JSON.stringify(listing);
          if (fingerprint !== this.fingerprint) { this.fingerprint = fingerprint; this.options.publish(listing); }
        } catch (error) { if (!this.closed) this.options.onError(error); }
      } while (this.dirty && !this.closed);
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async watchRoots(roots: string[]): Promise<void> {
    const structural = new Set(roots.flatMap(root => [dirname(root), root]));
    const directories = new Set(structural);
    for (const root of roots) {
      try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (directories.size >= 256) break;
          if (entry.isDirectory()) directories.add(join(root, entry.name));
        }
      } catch { /* Watch hints are optional; the authoritative listing reports source diagnostics. */ }
    }
    if (this.closed) return;
    for (const [path, watcher] of this.watchers) if (!directories.has(path)) { watcher.close(); this.watchers.delete(path); }
    for (const path of directories) {
      if (this.watchers.has(path)) continue;
      try {
        const watcher = watch(path, { persistent: false }, (event, filename) => {
          if (!filename || /\.jsonl(?:\.gz)?$/.test(String(filename)) || structural.has(path) && event === 'rename') this.request();
        });
        watcher.on('error', () => { watcher.close(); this.watchers.delete(path); this.request(); });
        this.watchers.set(path, watcher);
      } catch { /* Reconciliation remains authoritative when a directory cannot be watched. */ }
    }
  }
  close(): void {
    this.closed = true; clearTimeout(this.debounce); clearInterval(this.poll);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}

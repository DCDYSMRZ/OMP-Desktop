import { createHash } from 'node:crypto';
import { lstat, readdir, open, realpath } from 'node:fs/promises';
import { constants, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ObservedActivity, ObservedTail, PresenceEvent, HistoryMessage, SessionAccess, SessionSummary } from '../../shared/contracts';
import { discoverPresence, presenceHolders, PresenceSubscription, type PresenceDiscovery } from './presence';
import { presenceTailMatches } from '../../shared/presence-tail';

/** Journal-independent state and a bounded, selected-session-only stream. */
export class SessionPresenceObserver {
  activity?: ObservedActivity;
  tails: ObservedTail[] = [];
  private subscription?: PresenceSubscription;
  private socketPath?: string;
  private closed = false;
  private sequence = 0;
  private knownMessages = new Set<string>();
  private tailBaselines = new Map<string, Set<string>>();
  constructor(private path: string, private publish: (event?: PresenceEvent) => void) {}
  async poll(access: SessionAccess, discovery?: PresenceDiscovery) {
    this.path = await realpath(this.path).catch(() => this.path);
    const holders = await presenceHolders(this.path, discovery ?? await discoverPresence());
    if (this.closed) return;
    const holder = holders.find(proc => proc.sessions?.some(session => session.sessionFile === this.path && session.state === 'running')) ?? holders[0];
    const session = holder?.sessions?.find(session => session.sessionFile === this.path);
    if (!holder || !session) {
      this.subscription?.close(); this.subscription = undefined; this.socketPath = undefined;
      this.activity = access.occupancySource === 'presence' ? { source: 'presence', confidence: 'exact', state: access.status === 'idle' ? 'idle' : 'unknown', owner: access.status === 'idle' ? 'none' : access.status } : undefined;
      return;
    }
    this.activity = { source: 'presence', confidence: 'exact', state: session.state, requestStartedAt: session.requestStartedAt, currentTool: session.currentTool, owner: access.status === 'owned' ? 'owned' : 'external' };
    if (this.socketPath === holder.socketPath) return;
    this.subscription?.close(); this.socketPath = holder.socketPath;
    this.subscription = new PresenceSubscription(holder.socketPath, this.path, event => this.receive(event), () => {
      if (this.activity) this.activity = { ...this.activity, state: 'unknown', currentTool: undefined };
      this.tails = this.tails.map(tail => ({ ...tail, ended: true }));
      this.publish();
    });
  }
  receive(event: PresenceEvent) {
    if (this.closed) return;
    if (event.event === 'state') this.activity = { source: 'presence', confidence: 'exact', owner: this.activity?.owner ?? 'external', state: event.state, requestStartedAt: event.requestStartedAt, currentTool: event.currentTool };
    else if (event.event === 'delta') {
      let tail = this.tails.at(-1);
      if (!tail || tail.ended || tail.messageId !== event.messageId) {
        tail = { id: `presence:${++this.sequence}`, messageId: event.messageId, startedAt: Date.now(), content: [], ended: false };
        this.tails = [...this.tails, tail].slice(-32);
        this.tailBaselines.set(tail.id, new Set(this.knownMessages));
      }
      const last = tail.content.at(-1);
      const content = [...tail.content];
      if (event.kind === 'text') {
        if (last?.type === 'text') content[content.length - 1] = { type: 'text', text: last.text + event.text };
        else content.push({ type: 'text', text: event.text });
      } else {
        if (last?.type === 'thinking') content[content.length - 1] = { type: 'thinking', thinking: last.thinking + event.text };
        else content.push({ type: 'thinking', thinking: event.text });
      }
      this.tails = [...this.tails.slice(0, -1), { ...tail, content }];
    } else if (event.event === 'message_end') this.tails = this.tails.map(tail => !tail.ended && (!event.messageId || event.messageId === tail.messageId) ? { ...tail, ended: true } : tail);
    else if (event.event === 'tool' && this.activity) this.activity = { ...this.activity, currentTool: event.phase === 'start' ? { name: event.name, toolCallId: event.toolCallId, startedAt: Date.now() } : undefined };
    else if (event.event === 'switch' && event.from === this.path && this.activity) this.activity = { ...this.activity, state: 'unknown', currentTool: undefined };
    this.publish(event);
  }
  reconcile(messages: HistoryMessage[]) {
    const consumed = new Set<string>();
    this.tails = this.tails.filter(tail => {
      const matched = messages.find(message => !consumed.has(message.id) && !this.tailBaselines.get(tail.id)?.has(message.id) && presenceTailMatches(tail, message));
      if (matched) { consumed.add(matched.id); this.tailBaselines.delete(tail.id); }
      return !matched;
    });
    this.knownMessages = new Set(messages.map(message => message.id));
  }
  close() { this.closed = true; this.subscription?.close(); }
}

export const ACTIVITY_FRESH_MS = 5 * 60_000;
type Row = Record<string, unknown>;
const object = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
export interface ActivitySignal { kind: 'request' | 'stop' | 'exit' | 'calls' | 'result' | 'start'; at?: number; calls?: { toolCallId: string; name: string; startedAt?: number; intent?: string }[]; toolCallId?: string }
export function activitySignal(row: Row): ActivitySignal | undefined {
  const message = object(row.message);
  const timestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : undefined;
  const at = typeof message?.timestamp === 'number' ? message.timestamp : Number.isFinite(timestamp) ? timestamp : undefined;
  if (row.type === 'custom' && row.customType === 'session_exit') return { kind: 'exit', at };
  if (row.type === 'custom' && row.customType === 'tool_execution_start') {
    const data = object(row.data);
    if (typeof data?.toolCallId === 'string' && typeof data.toolName === 'string') return { kind: 'start', at, calls: [{ toolCallId: data.toolCallId, name: data.toolName, ...(typeof data.startedAt === 'number' ? { startedAt: data.startedAt } : {}), ...(typeof data.intent === 'string' ? { intent: data.intent.slice(0, 512) } : {}) }] };
  }
  if (row.type === 'custom_message' && row.attribution === 'agent' && ['async-result', 'launch-completion'].includes(String(row.customType))) return { kind: 'request', at };
  if (row.type !== 'message' || !message) return;
  if (message.role === 'user') return { kind: 'request', at };
  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') return { kind: 'result', at, toolCallId: message.toolCallId };
  if (message.role !== 'assistant') return;
  const calls = Array.isArray(message.content) ? message.content.flatMap(value => {
    const part = object(value);
    return part?.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string' ? [{ toolCallId: part.id, name: part.name }] : [];
  }) : [];
  if (calls.length) return { kind: 'calls', at, calls };
  if (['stop', 'error', 'aborted', 'length'].includes(String(message.stopReason))) return { kind: 'stop', at };
}
/** Newest-first selected-branch evidence. A durable stop/exit wins over old unfinished calls. */
export function inferActivity(signals: Iterable<ActivitySignal>, access: SessionAccess, lastAppendAt: number | undefined, now = Date.now(), children?: { revision: string; lastGrowthAt?: number }): ObservedActivity {
  const result: ObservedActivity = { state: 'unknown', source: 'journal', confidence: 'inferred', owner: access.status === 'idle' ? 'none' : access.status, lastAppendAt, ...(children ? { childrenRevision: children.revision } : {}) };
  if (access.status === 'idle' && access.occupancySource === 'presence') return { ...result, state: 'idle', source: 'presence', confidence: 'exact' };
  const resolved = new Set<string>();
  let open = false, known = false;
  for (const signal of signals) {
    known = true;
    if (signal.kind === 'exit' || signal.kind === 'stop') break;
    if (signal.kind === 'result' && signal.toolCallId) { resolved.add(signal.toolCallId); open = true; }
    if (signal.kind === 'start' || signal.kind === 'calls') for (const call of signal.calls ?? []) {
      if (!resolved.has(call.toolCallId)) { open = true; result.currentTool ??= call; }
    }
    if (signal.kind === 'request') { open = true; result.requestStartedAt = signal.at; break; }
  }
  const recent = now - Math.max(lastAppendAt ?? 0, children?.lastGrowthAt ?? 0) < ACTIVITY_FRESH_MS;
  result.state = !known ? 'unknown' : !open ? 'idle' : access.status === 'unknown' ? 'unknown' : (access.status === 'external' || access.status === 'owned') && recent ? 'running' : 'stale';
  return result;
}

/** Child files are statted independently; no journal writes, locks, or native attachment. */
export class ChildJournalObserver {
  private revisions = new Map<string, { size: number; mtime: number }>();
  private initialized = false;
  private lastGrowthAt?: number;
  async poll(parentPath: string): Promise<{ revision: string; lastGrowthAt?: number }> {
    const root = parentPath.replace(/\.jsonl(?:\.gz)?$/, '');
    const next = new Map<string, { size: number; mtime: number }>();
    const scan = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8 || next.size >= 10_000) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (next.size >= 10_000) break;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await scan(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try { const info = await lstat(path); if (info.isFile()) next.set(path, { size: info.size, mtime: info.mtimeMs }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    };
    // Do not traverse an artifact-root symlink into unrelated sessions.
    try { if ((await lstat(root)).isDirectory()) await scan(root, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const hash = createHash('sha256');
    for (const [path, info] of [...next].sort(([a], [b]) => a.localeCompare(b))) {
      hash.update(`${path}\0${info.size}:${info.mtime}\n`);
      const previous = this.revisions.get(path);
      if (!this.initialized) this.lastGrowthAt = Math.max(this.lastGrowthAt ?? 0, info.mtime);
      if (this.initialized && (!previous || info.size > previous.size)) this.lastGrowthAt = Date.now();
    }
    this.initialized = true; this.revisions = next;
    return { revision: hash.digest('hex').slice(0, 24), lastGrowthAt: this.lastGrowthAt };
  }
}

/** Sidebar-only hints do not claim process ownership or grant permission. */
export class ListedJournalObserver {
  private sessions: SessionSummary[] = [];
  private cache = new Map<string, { revision: string; signals: ActivitySignal[]; children: ChildJournalObserver }>();
  private watchers: FSWatcher[] = [];
  private refreshing?: Promise<void>;
  private dirty = false;
  private hintedPaths = new Set<string>();
  private scanAll = false;
  private timer: NodeJS.Timeout;
  constructor(private publish: (session: SessionSummary) => void) {
    this.timer = setInterval(() => { void this.refresh(); }, 5000); this.timer.unref();
  }
  async observe(sessions: SessionSummary[]) {
    this.sessions = sessions;
    const paths = new Set(sessions.map(session => session.path));
    for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const directory of new Set(sessions.map(session => dirname(session.path)))) {
      if (this.watchers.length >= 64) break;
      try { const watcher = watch(directory, { persistent: false }, (_event, filename) => { if (filename) this.hintedPaths.add(join(directory, String(filename))); else this.scanAll = true; void this.refresh(); }); watcher.on('error', () => watcher.close()); this.watchers.push(watcher); } catch { /* Periodic reconciliation remains available. */ }
    }
    await this.refresh();
  }
  close() { clearInterval(this.timer); for (const watcher of this.watchers) watcher.close(); this.watchers = []; this.sessions = []; this.cache.clear(); }
  private async refresh(): Promise<void> {
    this.dirty = true;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      do { this.dirty = false; await this.poll(); } while (this.dirty);
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }
  private async poll() {
      const scanAll = this.scanAll; this.scanAll = false;
      const discovery = await discoverPresence();
      const participatingSessions = new Map(discovery.processes.flatMap(proc => (proc.sessions ?? []).flatMap(session => session.sessionFile ? [[session.sessionFile, session] as const] : [])));
      for (const session of this.sessions) {
        if (session.sourceKind !== 'journal') continue;
        const presence = participatingSessions.get(session.path);
        if (presence) {
          if (session.activity !== presence.state || session.activitySource !== 'presence') { session.activity = presence.state; session.activitySource = 'presence'; this.publish(session); }
          continue;
        }
        if (session.activitySource === 'presence') { session.activity = 'unknown'; session.activitySource = undefined; this.publish(session); }
        const hinted = this.hintedPaths.delete(session.path);
        if (!scanAll && !hinted && !this.cache.has(session.path) && Date.now() - Date.parse(session.updatedAt) >= 600_000) continue;
        try {
          const info = await lstat(session.path);
          if (!info.isFile()) continue;
          const now = Date.now();
          let cached = this.cache.get(session.path);
          if (!cached && now - info.mtimeMs >= 600_000) continue;
          const revision = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
          if (cached?.revision !== revision) {
            const file = await open(session.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            let bytes: Buffer;
            const offset = Math.max(0, info.size - 256 * 1024);
            try { bytes = Buffer.alloc(info.size - offset); const read = await file.read(bytes, 0, bytes.length, offset); bytes = bytes.subarray(0, read.bytesRead); } finally { await file.close(); }
            const lines = bytes.toString('utf8').split('\n');
            if (offset) lines.shift();
            lines.pop(); // A partial record is not durable activity evidence.
            const rows: Row[] = [];
            for (const line of lines) { try { const row = object(JSON.parse(line)); if (row) rows.push(row); } catch { /* Partial/malformed source remains unknown. */ } }
            const byId = new Map(rows.filter(row => typeof row.id === 'string').map(row => [String(row.id), row]));
            const signals: ActivitySignal[] = [];
            let row = rows.at(-1);
            const seen = new Set<Row>();
            while (row && !seen.has(row)) {
              seen.add(row); const signal = activitySignal(row);
              if (signal) { signals.push(signal); if (['request', 'stop', 'exit'].includes(signal.kind)) break; }
              row = typeof row.parentId === 'string' ? byId.get(row.parentId) : row.parentId === null ? undefined : rows[rows.indexOf(row) - 1];
            }
            cached = { revision, signals, children: cached?.children ?? new ChildJournalObserver() }; this.cache.set(session.path, cached);
          }
          const children = await cached.children.poll(session.path);
          const hint = inferActivity(cached.signals, { status: 'external', checkedAt: now }, info.mtimeMs, now, children);
          if (hint.state === 'running' && now - Math.max(info.mtimeMs, children.lastGrowthAt ?? 0) >= 120_000) hint.state = 'stale';
          const updatedAt = new Date(info.mtimeMs).toISOString();
          if (session.activity !== hint.state || session.updatedAt !== updatedAt || session.activitySource !== 'journal') { session.activity = hint.state; session.activitySource = 'journal'; session.updatedAt = updatedAt; this.publish(session); }
        } catch { if (session.activity !== 'unknown') { session.activity = 'unknown'; this.publish(session); } }
      }
  }
}

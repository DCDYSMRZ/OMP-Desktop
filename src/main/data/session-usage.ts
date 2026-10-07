import { realpath, stat } from 'node:fs/promises';
import type { SessionUsageSummary } from '../../shared/contracts';
import { HistorySource, sourceRevision } from './history-source';
import { record } from './io';

const MAX_RECORD = 16 * 1024 * 1024;
const MAX_CACHE = 24;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
interface Anchor { parentId: string | null; assistant?: Pick<SessionUsageSummary, 'contextTokens' | 'nonMessageTokens' | 'compactionEpoch' | 'historyRewriteTokensRemoved' | 'model' | 'observedAt' | 'latest'>; compaction?: { tokens?: number }; contextPrompt?: SessionUsageSummary['contextPrompt'] }
interface MissingTask { toolCallId: string; entryId?: string; count: number }
interface OwnUsage { summary: SessionUsageSummary; missingTasks: MissingTask[] }
interface UsageChildren { children: { path: string; toolCallId: string }[]; unrecorded: number }
type ResolveUsageChildren = (options: { path: string; toolCallIds: string[]; taskEntries?: { toolCallId: string; entryId: string }[] }) => Promise<UsageChildren>;

/** Streams journals/archives, retaining only compact ancestry metadata, never messages. */
export class SessionUsageReader {
  private readonly cache = new Map<string, { revision: string; result: Promise<OwnUsage> }>();
  constructor(private readonly resolveChildren?: ResolveUsageChildren) {}
  async read(path: string, leafId?: string | null): Promise<SessionUsageSummary> {
    return this.readTree(path, leafId, new Set(), 0);
  }
  private async readTree(path: string, leafId: string | null | undefined, visited: Set<string>, depth: number): Promise<SessionUsageSummary> {
    const canonical = await realpath(path);
    if (depth >= 64 || visited.has(canonical) || visited.size >= 10000) throw new Error('Session usage child ancestry exceeds its bound or contains a cycle');
    visited.add(canonical);
    const own = await this.readOwn(path, leafId);
    const summary = { ...own.summary };
    if (!own.missingTasks.length) return summary;
    const expected = own.missingTasks.reduce((count, task) => count + task.count, 0);
    if (!this.resolveChildren) { summary.unrecordedSubagents = expected; return summary; }
    let resolved: UsageChildren;
    try {
      resolved = await this.resolveChildren({ path, toolCallIds: own.missingTasks.map(task => task.toolCallId), taskEntries: own.missingTasks.flatMap(task => task.entryId ? [{ toolCallId: task.toolCallId, entryId: task.entryId }] : []) });
    } catch { summary.unrecordedSubagents = expected; return summary; }
    let unrecorded = Math.max(resolved.unrecorded, expected - resolved.children.length);
    for (const child of resolved.children) {
      try {
        const usage = await this.readTree(child.path, undefined, visited, depth + 1);
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'premiumRequests'] as const) if (usage[field] !== undefined) summary[field] = (summary[field] ?? 0) + usage[field];
        if (usage.cost !== undefined) { summary.cost = (summary.cost ?? 0) + usage.cost; summary.subagentCost = (summary.subagentCost ?? 0) + usage.cost; summary.mainCost ??= 0; }
        else unrecorded++;
        unrecorded += usage.unrecordedSubagents ?? 0;
        summary.incomplete ||= usage.incomplete;
      } catch { unrecorded++; }
    }
    if (unrecorded) summary.unrecordedSubagents = unrecorded;
    return summary;
  }
  private async readOwn(path: string, leafId?: string | null): Promise<OwnUsage> {
    const revision = sourceRevision(await stat(path, { bigint: true }));
    const key = JSON.stringify([path, leafId === undefined ? { current: true } : leafId]);
    const cached = this.cache.get(key);
    if (cached?.revision === revision) return cached.result;
    const result = this.summarize(new HistorySource(path, revision), leafId);
    this.cache.delete(key);
    this.cache.set(key, { revision, result });
    while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
    try { return await result; } catch (error) { if (this.cache.get(key)?.result === result) this.cache.delete(key); throw error; }
  }
  private async summarize(source: HistorySource, selectedLeaf?: string | null): Promise<OwnUsage> {
    const summary: SessionUsageSummary = { incomplete: false };
    const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
    const entries = new Map<string, Anchor>();
    const tasks = new Map<string, MissingTask>();
    const coveredTasks = new Set<string>();
    let leaf: string | null = null;
    let sequence = 0;
    const addUsage = (usage: Record<string, unknown>, child: boolean) => {
      let sum = 0, known = false;
      for (const field of fields) { const value = number(usage[field]); if (value !== undefined) { summary[field] = (summary[field] ?? 0) + value; sum += value; known = true; } }
      const total = number(usage.totalTokens) ?? (known ? sum : undefined);
      if (total !== undefined) summary.total = (summary.total ?? 0) + total;
      const cost = record(usage.cost) ? number(usage.cost.total) : undefined;
      if (cost !== undefined) {
        summary.cost = (summary.cost ?? 0) + cost;
        summary.mainCost = (summary.mainCost ?? 0) + (child ? 0 : cost);
        summary.subagentCost = (summary.subagentCost ?? 0) + (child ? cost : 0);
      }
      const premium = number(usage.premiumRequests);
      if (premium !== undefined) summary.premiumRequests = (summary.premiumRequests ?? 0) + premium;
      return { cost, tokens: total };
    };
    let parts: Buffer[] = [], bytes = 0, oversized = false;
    const consume = () => {
      if (oversized) summary.incomplete = true;
      else if (bytes) {
        try {
          const row: unknown = JSON.parse(Buffer.concat(parts, bytes).toString('utf8'));
          if (record(row) && row.type !== 'session' && row.type !== 'header') {
            const id = typeof row.id === 'string' ? row.id : `legacy:${sequence++}`;
            const parentId = row.parentId === null ? null : typeof row.parentId === 'string' ? row.parentId : leaf;
            const anchor: Anchor = { parentId };
            const message = record(row.message) ? row.message : row;
            if (message.role === 'assistant') {
              const usage = record(message.usage) ? message.usage : {};
              const latest = addUsage(usage, false);
              const snapshot = record(message.contextSnapshot) ? message.contextSnapshot : {};
              const prompt = number(snapshot.promptTokens);
              const measured = fields.filter(field => field !== 'output').some(field => number(usage[field]) !== undefined);
              const contextTokens = prompt ?? number(usage.contextTokens) ?? (measured ? (number(usage.input) ?? 0) + (number(usage.cacheRead) ?? 0) + (number(usage.cacheWrite) ?? 0) : undefined);
              const timestamp = message.timestamp ?? row.timestamp;
              const time = typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
              if (message.stopReason !== 'aborted' && message.stopReason !== 'error' && contextTokens !== undefined) anchor.assistant = { contextTokens, nonMessageTokens: number(snapshot.nonMessageTokens), compactionEpoch: number(snapshot.compactionEpoch), historyRewriteTokensRemoved: number(snapshot.historyRewriteTokensRemoved), ...(Number.isFinite(time) ? { observedAt: time } : {}), ...(typeof message.provider === 'string' && typeof message.model === 'string' ? { model: { provider: message.provider, id: message.model } } : {}), latest };
            } else if (message.role === 'toolResult' && message.toolName === 'task') {
              const details = record(message.details) ? message.details : {};
              const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : id;
              const children = new Set<string>();
              for (const child of [...(Array.isArray(details.results) ? details.results : []), ...(Array.isArray(details.progress) ? details.progress : [])]) {
                if (record(child)) children.add(typeof child.index === 'number' ? `index:${child.index}` : typeof child.id === 'string' ? `id:${child.id}` : `unknown:${children.size}`);
              }
              tasks.set(toolCallId, { toolCallId, ...(typeof row.id === 'string' ? { entryId: row.id } : {}), count: Math.max(1, children.size, tasks.get(toolCallId)?.count ?? 0) });
              if (record(details.usage)) {
                // Native aggregate already includes descendants; never add their journals again.
                addUsage(details.usage, true);
                coveredTasks.add(toolCallId);
              }
            } else if (row.type === 'model_usage' && record(row.usage)) {
              // Native durable ledger includes non-transcript calls (judgment, compaction, etc.).
              addUsage(row.usage, false);
            }
            if (row.type === 'compaction') anchor.compaction = { tokens: number(row.tokensAfter) };
            if (row.type === 'session_init') {
              const systemPrompt = typeof row.systemPrompt === 'string' ? [row.systemPrompt] : Array.isArray(row.systemPrompt) && row.systemPrompt.every(part => typeof part === 'string') ? row.systemPrompt as string[] : undefined;
              if (systemPrompt) anchor.contextPrompt = { systemPrompt, dumpTools: Array.isArray(row.dumpTools) ? row.dumpTools : [], partial: !Array.isArray(row.dumpTools) };
            }
            entries.set(id, anchor);
            leaf = id;
          }
        } catch { summary.incomplete = true; }
      }
      parts = []; bytes = 0; oversized = false;
    };
    for await (const chunk of source.chunks()) {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const stop = end < 0 ? chunk.length : end;
        if (!oversized) { bytes += stop - offset; if (bytes > MAX_RECORD) { oversized = true; parts = []; } else parts.push(chunk.subarray(offset, stop)); }
        if (end >= 0) consume();
        offset = stop + 1;
      }
    }
    if (bytes || oversized) summary.incomplete = true;
    const visited = new Set<string>();
    let cursor = selectedLeaf === undefined ? leaf : selectedLeaf;
    let compaction: Anchor['compaction'];
    while (cursor !== null) {
      if (visited.has(cursor)) { summary.incomplete = true; break; }
      visited.add(cursor);
      const entry = entries.get(cursor);
      if (!entry) { summary.incomplete = true; break; }
      if (!summary.contextState && !compaction && entry.compaction) compaction = entry.compaction;
      if (!summary.contextState && entry.assistant) { Object.assign(summary, entry.assistant); summary.contextState = compaction ? 'compacted' : 'measured'; }
      if (summary.contextState && entry.contextPrompt) { summary.contextPrompt = entry.contextPrompt; break; }
      cursor = entry.parentId;
    }
    if (compaction) { summary.contextState = 'compacted'; if (compaction.tokens !== undefined) summary.compactedTokens = compaction.tokens; }
    return { summary, missingTasks: [...tasks.values()].filter(task => !coveredTasks.has(task.toolCallId)) };
  }
}

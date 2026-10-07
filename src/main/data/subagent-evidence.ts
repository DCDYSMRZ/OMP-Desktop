import { stat } from 'node:fs/promises';
import type { NativeSubagent } from '../../shared/contracts';
import { evidenceTime, normalizeAgent, object, terminalPhase, agentPhase, reportedFindings } from '../../shared/subagent-evidence';
import { HistorySource, sourceRevision } from './history-source';
import { nativeHarnessNotice } from '../../shared/native-harness-notice';

interface Entry { id: string; parentId?: string; row: Record<string, unknown> }
/** Receives only a journal path already authorized by SessionResources.childSource. */
export class ChildEvidenceReader {
  private cache = new Map<string, { revision: string; agent: NativeSubagent }>();
  async read(path: string, before?: number): Promise<NativeSubagent> {
    const revision = sourceRevision(await stat(path, { bigint: true }));
    const key = `${path}:${before ?? 'latest'}`;
    const cached = this.cache.get(key);
    if (cached?.revision === revision) return cached.agent;
    const source = new HistorySource(path, revision);
    const entries = new Map<string, Entry>();
    let pending: Buffer = Buffer.alloc(0), leaf: string | undefined;
    try {
      for await (const chunk of source.chunks()) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let start = 0, end: number;
        while ((end = pending.indexOf(10, start)) >= 0) {
          if (end - start > 16 * 1024 * 1024) throw new Error('Child evidence record exceeds the safe parsing bound.');
          const line = pending.toString('utf8', start, end); start = end + 1;
          if (!line.trim()) continue;
          const row = object(JSON.parse(line));
          if (typeof row.id !== 'string' || row.type === 'session') continue;
          const message = object(row.message);
          // Retain metadata only: no report bodies, prompts, tool arguments, or transcript copies.
          const content = Array.isArray(message.content) ? message.content.map(object).filter(block => block.type === 'toolCall').map(block => { const args = object(block.arguments); return { id: block.id, type: block.type, name: block.name, arguments: { type: args.type, complete: args.complete, issueCount: reportedFindings(args.data), ...(args.error !== undefined ? { error: true } : {}) } }; }) : [];
          const details = object(message.details);
          const harnessNotice = nativeHarnessNotice(message)?.tone === 'info';
          const compact = { type: row.type, timestamp: row.timestamp, customType: row.customType ?? message.customType, data: row.data, message: { role: message.role, timestamp: message.timestamp, toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError, harnessNotice, stopReason: message.stopReason, usage: message.usage, details: message.toolName === 'yield' ? { status: details.status, complete: details.complete, issueCount: reportedFindings(details.data), ...(details.error !== undefined ? { error: true } : {}) } : undefined, content } };
          if (before !== undefined && (evidenceTime(message.timestamp) ?? evidenceTime(row.timestamp) ?? Infinity) > before) continue;
          entries.set(row.id, { id: row.id, parentId: typeof row.parentId === 'string' ? row.parentId : undefined, row: compact });
          leaf = row.id;
          if (entries.size > 100000) throw new Error('Child evidence exceeds the 100,000-entry bound.');
        }
        pending = pending.subarray(start);
        if (pending.length > 16 * 1024 * 1024) throw new Error('Child evidence record exceeds the safe parsing bound.');
      }
      const branch: Record<string, unknown>[] = []; const seen = new Set<string>();
      while (leaf) {
        if (seen.has(leaf)) throw new Error('Child journal ancestry contains a cycle.');
        seen.add(leaf); const entry = entries.get(leaf); if (!entry) break;
        branch.push(entry.row); leaf = entry.parentId;
      }
      const agent = childJournalEvidence(branch.reverse());
      if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { revision, agent });
      return agent;
    } finally { source.close(); }
  }
}

/** Accepted yield is an outcome; requesting yield, normal disposal, and silence are not. */
export function childJournalEvidence(rows: readonly Record<string, unknown>[]): NativeSubagent {
  let status = 'unknown', reason = 'The child journal has no accepted terminal yield.', observedAt: number | undefined, generationStartedAt: number | undefined;
  let generation = 0, tokens = 0, cost = 0, hasTokens = false, hasCost = false, first: number | undefined, lastWork: number | undefined;
  let journalOpen = false, cleanStop = false, followupCompleted = false, issueCount = 0;
  const pending = new Set<string>();
  const currentTools = new Map<string, { name?: string; intent?: string }>();
  const tools = new Set<string>(), failures = new Set<string>(), yields = new Map<string, Record<string, unknown>>();
  const reopen = (time: number | undefined, why: string) => { journalOpen = true; cleanStop = false; followupCompleted = false; if (terminalPhase(agentPhase({ status }))) { generation++; generationStartedAt = time; } status = 'unknown'; reason = why; };
  for (const row of rows) {
    const message = object(row.message);
    const time = evidenceTime(message.timestamp) ?? evidenceTime(row.timestamp);
    if (time !== undefined) observedAt = time;
    const custom = row.customType ?? message.customType;
    const data = object(row.data);
    if (custom === 'async-result') reopen(time, 'A later background result invalidated the accepted yield; a fresh terminal yield is required.');
    if (custom === 'tool_execution_start') {
      journalOpen = true;
      if (typeof data.toolCallId === 'string') { tools.add(data.toolCallId); pending.add(data.toolCallId); }
      if (typeof data.toolCallId === 'string') currentTools.set(data.toolCallId, { name: typeof data.toolName === 'string' ? data.toolName : undefined, intent: typeof data.intent === 'string' ? data.intent : undefined });
      lastWork = time;
    }
    if (custom === 'session_exit') {
      journalOpen = false;
      if (data.kind === 'error' || data.kind === 'crash') { status = 'failed'; reason = String(data.reason ?? 'Child session exited with an error.'); }
      else if (data.kind === 'abort' || data.kind === 'signal' || data.kind === 'aborted') { status = 'aborted'; reason = String(data.reason ?? 'Child session was interrupted.'); }
      else if (generation > 0 && cleanStop && !pending.size && (!Array.isArray(data.pendingToolCalls) || data.pendingToolCalls.length === 0)) { status = 'completed'; reason = ''; followupCompleted = true; }
      else if (!terminalPhase(agentPhase({ status }))) reason = 'The child session exited without a validated terminal outcome.';
      continue;
    }
    if (message.role === 'user' || message.role === 'assistant') {
      journalOpen = true;
      if (first === undefined) first = time;
      lastWork = time;
      if (terminalPhase(agentPhase({ status }))) reopen(time, 'The child resumed after its previous yield; no newer terminal result was recorded.');
      cleanStop = false;
    }
    if (message.role === 'assistant') {
      const usage = object(message.usage);
      const parts = ['input', 'output', 'cacheWrite'];
      for (const key of parts) if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) { tokens += usage[key]; hasTokens = true; }
      const total = object(usage.cost).total ?? usage.cost;
      if (typeof total === 'number' && Number.isFinite(total)) { cost += total; hasCost = true; }
      for (const value of Array.isArray(message.content) ? message.content : []) { const call = object(value); if (call.type !== 'toolCall' || typeof call.id !== 'string') continue; pending.add(call.id); if (/^(?:functions\.)?yield$/.test(String(call.name))) yields.set(call.id, object(call.arguments)); }
      cleanStop = message.stopReason === 'stop' && !pending.size;
      if (message.stopReason === 'aborted') { status = 'aborted'; reason = 'The child assistant run was aborted.'; }
      else if (message.stopReason === 'error') { status = 'failed'; reason = 'The child assistant run failed.'; }
    }
    if (message.role === 'toolResult') {
      const id = String(message.toolCallId ?? ''); if (id) { tools.add(id); pending.delete(id); }
      currentTools.delete(id);
      if (message.isError === true && message.harnessNotice !== true && !nativeHarnessNotice(message)) failures.add(id);
      if (message.toolName !== 'yield' || message.isError === true) continue;
      const details = object(message.details), args = yields.get(id);
      if (!args) continue;
      if (details.status === 'aborted') { status = 'aborted'; reason = 'The terminal yield was aborted.'; continue; }
      if (details.status !== 'success' || Array.isArray(args.type) && args.complete !== true && details.complete !== true) continue;
      status = args.error !== undefined || details.error !== undefined ? 'failed' : 'completed'; reason = ''; lastWork = time; followupCompleted = generation > 0; issueCount = Math.max(reportedFindings(args.data), reportedFindings(details.data), Number(args.issueCount ?? 0), Number(details.issueCount ?? 0));
    }
  }
  let currentTool: { name?: string; intent?: string } | undefined;
  for (const tool of currentTools.values()) currentTool = tool;
  return normalizeAgent({ id: '', status, followupCompleted, journalOpen: journalOpen && !terminalPhase(agentPhase({ status })), issueCount, progress: { currentTool: currentTool?.name, lastIntent: currentTool?.intent, toolCount: tools.size, toolFailureCount: failures.size, ...(hasTokens ? { tokens } : {}), ...(hasCost ? { cost } : {}), ...(first !== undefined && lastWork !== undefined ? { durationMs: Math.max(0, lastWork - first) } : {}), issueCount } }, { source: 'journal', historical: true, observedAt, generation, generationStartedAt, reason: reason || undefined });
}

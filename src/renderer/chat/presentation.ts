import type { NativeMessage, NativeSubagent, RecordedFileChange } from '../../shared/contracts';
import { parseNativeAsyncDelivery, resolveNativeTaskOwnership, subsetNativeAsyncDelivery, type NativeAsyncDelivery } from '../../shared/native-task-results';
import { messageSemantics, nativeMessageNotice } from './native-message-semantics';
import { nativeHarnessNotice } from '../../shared/native-harness-notice';
import { record, text, type ChatMessage, type ToolActivity } from './model';
import { parseFileTarget } from '../lib/file-target';
import { type ToolSummary } from './tools/tool-model';
import { normalizeToolEvidence, resolveFinalChanges } from '../../shared/change-net';
import { plainMarkdownLine } from '../lib/markdown-plain';
import type { SubmissionReceipt } from './submissions';
import { messageText } from './model';
import { subagentResultFields } from '../workspace/subagent-model';
import { subagentMetrics, subagentTitle } from '../workspace/subagent-model';

/** Match once, in submission order; old identical prompts never acknowledge new intent. */
export function projectSubmissions(receipts: readonly SubmissionReceipt[], messages: readonly ChatMessage[], runtimeId: string, sessionId: string) {
  const matched = new Map<string, SubmissionReceipt>();
  const pending: SubmissionReceipt[] = [];
  for (const receipt of receipts) {
    if (receipt.runtimeId !== runtimeId || receipt.sessionId !== sessionId) continue;
    const row = messages.find(row => row.raw.role === 'user' && !matched.has(row.id) && typeof row.raw.timestamp === 'number' && row.raw.timestamp >= receipt.submittedAt && messageText(row.raw).trim() === receipt.input.text.trim());
    if (row) matched.set(row.id, receipt);
    else if (!['submitting', 'completed', 'local', 'aborted'].includes(receipt.status)) pending.push(receipt);
  }
  return { pending, matched };
}

export function isStoppedMessage(raw: NativeMessage): boolean {
  return raw.role === 'assistant' && (raw.stopReason === 'aborted' || raw.errorMessage === 'Interrupted by user' || (typeof raw.errorId === 'number' && (raw.errorId & 0x04000000) !== 0));
}

/** Display parts retain native tool-call identity across live/history message replacement. */
export type TurnActivity = { row: ChatMessage; delivery?: NativeAsyncDelivery; canonicalAnchor: boolean };
export type TurnPart =
  | { kind: 'text'; key: string; row: ChatMessage; value: string; continuations?: TurnPart[] }
  | { kind: 'thinking'; key: string; row: ChatMessage; value: string; redacted?: boolean; continuations?: TurnPart[] }
  | { kind: 'content'; key: string; row: ChatMessage; block: unknown }
  | { kind: 'tool'; key: string; row: ChatMessage; tool: ToolActivity; resultRow?: ChatMessage; activities?: TurnActivity[]; agents?: readonly NativeSubagent[] }
  | { kind: 'activity'; key: string; row: ChatMessage; delivery?: NativeAsyncDelivery }
  | { kind: 'boundary'; key: string; row: ChatMessage; trigger?: 'reminder' | 'background-result'; delivery?: NativeAsyncDelivery }
  | { kind: 'error'; key: string; row: ChatMessage; value: string };
export type AssistantTurnEntry = { kind: 'assistant-turn'; id: string; rows: ChatMessage[]; parts: TurnPart[]; nextPromptId?: string; presentation?: { id: string; disclosureId: string } };
export type TranscriptEntry = AssistantTurnEntry | { kind: 'message'; id: string; row: ChatMessage };

export interface TimelineSegment { key: string; narration: TurnPart[]; steps: TurnPart[] }

const thinkingGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** The latest complete summary heading wins; otherwise show the latest paragraph. */
export function thinkingPreview(value: string): string {
  const paragraphs = value.trim().split(/\n\s*\n/).map(paragraph => paragraph.trim()).filter(Boolean);
  for (let index = paragraphs.length - 1; index >= 0; index--) {
    const heading = /^\*\*([^\n]+)\*\*$/.exec(paragraphs[index]);
    if (heading) return plainMarkdownLine(heading[1]);
  }
  const paragraph = plainMarkdownLine(paragraphs.at(-1) ?? '');
  let title = '', count = 0;
  for (const item of thinkingGraphemes.segment(paragraph)) {
    if (count++ === 40) break;
    title += item.segment;
  }
  return title;
}

export function turnOutcome(rows: ChatMessage[], outcome?: string): 'aborted' | 'error' | undefined {
  const latest = rows.findLast(row => row.raw.role === 'assistant')?.raw;
  return (latest && isStoppedMessage(latest)) || outcome === 'aborted' ? 'aborted' : latest?.stopReason === 'error' || outcome === 'error' ? 'error' : undefined;
}

/** The final retry outcome belongs to the failed request's turn, regardless of provider wrappers. */
export function retryNoticeHasTurnError(notice: { category?: string; values?: Record<string, unknown>; diagnostic?: unknown }, messages: readonly ChatMessage[], running: boolean): boolean {
  if (running || notice.category !== 'retry') return false;
  const latest = messages.findLast(row => row.raw.role === 'assistant' || row.raw.role === 'user');
  return !!latest && latest.raw.role === 'assistant' && latest.raw.stopReason === 'error' && !isStoppedMessage(latest.raw);
}

/** Narration introduces the work that follows, without synthetic process rows. */
export function buildTurnTimeline(process: TurnPart[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const part of process) {
    if (part.kind === 'boundary') continue;
    let segment = segments.at(-1);
    if (!segment || (part.kind === 'text' && segment.steps.length > 0)) {
      segment = { key: part.key, narration: [], steps: [] };
      segments.push(segment);
    }
    const previous = segment.steps.at(-1);
    if (part.kind === 'thinking' && previous?.kind === 'thinking' && part.redacted === previous.redacted) {
      segment.steps[segment.steps.length - 1] = { ...previous, value: `${previous.value}\n\n${part.value}`, continuations: [...(previous.continuations ?? []), part] };
    } else (part.kind === 'text' ? segment.narration : segment.steps).push(part);
  }
  return segments;
}

export interface TurnSummary {
  steps: number; readFiles: string[]; editedFiles: string[]; commands: number; searches: number; agents: number; messages: number; failures: number; startedAt?: number; endedAt?: number;
}

/** Completed outcomes have no actionable issue badge; failed attempts remain inspectable. */
export function unresolvedToolFailureIds(parts: readonly TurnPart[]): Set<string> {
  const lastAssistant = parts.findLast(part => part.row.raw.role === 'assistant')?.row.raw;
  if (lastAssistant && (isStoppedMessage(lastAssistant) || lastAssistant.stopReason === 'stop')) return new Set();
  const finalTool = parts.findLast(part => part.kind === 'tool');
  if (finalTool?.kind === 'tool' && finalTool.tool.name.split(/[/.]/).at(-1) === 'yield' && finalTool.tool.status === 'complete' && !Array.isArray(record(finalTool.tool.args).type) && !record(finalTool.tool.args).error) return new Set();
  const positions = new Map<string, number>();
  for (let index = 0; index < parts.length; index++) if (!positions.has(parts[index].row.id)) positions.set(parts[index].row.id, index);
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(record(value)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  const successes = new Map<string, { index: number; timestamp?: number }>();
  const seen = new Set<string>(), unresolved = new Set<string>();
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part.kind !== 'tool' || seen.has(part.tool.id)) continue;
    seen.add(part.tool.id);
    const tool = part.tool;
    if (nativeHarnessNotice(tool.result) || record(record(tool.result).details).expectedFailure === true) continue;
    const args = Object.fromEntries(Object.entries(record(tool.args)).filter(([key]) => key !== 'i'));
    const action = Object.keys(args).length ? `${tool.name}:${JSON.stringify(canonical(args))}` : undefined;
    if (tool.status === 'complete' && action && !successes.has(action)) {
      const timestamp = part.row.raw.timestamp;
      successes.set(action, { index, timestamp: typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' ? Date.parse(timestamp) : undefined });
    }
    if (tool.status !== 'error') continue;
    const success = action ? successes.get(action) : undefined;
    const resultIndex = part.resultRow ? positions.get(part.resultRow.id) : undefined;
    const rawTime = part.resultRow?.raw.timestamp;
    const finishedAt = typeof rawTime === 'number' ? rawTime : typeof rawTime === 'string' ? Date.parse(rawTime) : undefined;
    const retriedAfterResult = success && ((resultIndex !== undefined && success.index > resultIndex) || (finishedAt !== undefined && success.timestamp !== undefined && success.timestamp > finishedAt));
    if (!retriedAfterResult) unresolved.add(tool.id);
  }
  return unresolved;
}

/** The descriptor is injected so projection and tests stay independent of UI. */
export function summarizeTurn(parts: TurnPart[], describe: (tool: ToolActivity) => Pick<ToolSummary, 'family' | 'file'>, unresolvedFailures = unresolvedToolFailureIds(parts)): TurnSummary {
  const summary: TurnSummary = { steps: 0, readFiles: [], editedFiles: [], commands: 0, searches: 0, agents: 0, messages: 0, failures: 0 };
  const readFiles = new Set<string>();
  const editedFiles = new Set<string>();
  const tools = new Set<string>();
  const messages = new Set<string>();
  const timestamp = (row: ChatMessage) => {
    const value = row.raw.timestamp;
    const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(time)) return;
    summary.startedAt = Math.min(summary.startedAt ?? time, time);
    const completed = typeof row.raw.completedAt === 'number' ? row.raw.completedAt : NaN;
    summary.endedAt = Math.max(summary.endedAt ?? time, Number.isFinite(completed) ? completed : time);
  };
  for (const part of parts) {
    timestamp(part.row);
    if (part.kind === 'activity' && messageSemantics(part.row.raw).actor === 'agent') messages.add(part.row.id);
    if (part.kind !== 'tool') continue;
    if (part.resultRow) timestamp(part.resultRow);
    for (const activity of part.activities ?? []) timestamp(activity.row);
    if (tools.has(part.tool.id)) continue;
    tools.add(part.tool.id);
    summary.steps++;
    const tool = part.tool;
    const info = describe(tool);
    const args = record(tool.args);
    const details = record(record(tool.result).details);
    if (unresolvedFailures.has(tool.id)) summary.failures++;
    if (info.family === 'read' || info.family === 'write' || info.family === 'edit') {
      const files = info.family === 'read' ? readFiles : editedFiles;
      const paths = [info.file?.path, text(details.path), ...(Array.isArray(details.perFileResults) ? details.perFileResults.map(value => text(record(value).path)) : [])];
      for (const path of paths) if (path) files.add(parseFileTarget(path).path);
    }
    if (info.family === 'command' || info.family === 'eval') summary.commands++;
    if (info.family === 'search' || info.family === 'find' || info.family === 'web') summary.searches++;
    if (info.family === 'message') messages.add(`tool:${tool.id}`);
    if (info.family === 'task') {
      const planned = Array.isArray(args.tasks) ? args.tasks.length : args.task || args.agent || args.name ? 1 : 0;
      const results = Array.isArray(details.results) ? details.results.length : 0;
      summary.agents += Math.max(planned, results);
    }
  }
  summary.readFiles = [...readFiles];
  summary.editedFiles = [...editedFiles];
  summary.messages = messages.size;
  return summary;
}

export type TurnChangedFile = RecordedFileChange;

/** Turn-local content knowledge is never substituted with today's filesystem or Git state. */
export function turnChangedFiles(parts: readonly TurnPart[], cwd = ''): TurnChangedFile[] {
  return resolveFinalChanges(parts.flatMap((part, sequence) => part.kind === 'tool' ? normalizeToolEvidence({
    source: { sessionId: 'transcript', cwd }, toolId: part.tool.id, entryId: part.row.id, resultEntryId: part.resultRow?.id,
    name: part.tool.name, args: part.tool.args, result: part.tool.result, status: part.tool.status, sequence,
  }) : []), [], cwd);
}

export function contentBlocks(raw: NativeMessage): unknown[] {
  if (typeof raw.content === 'string') return [{ type: 'text', text: raw.content }];
  if (Array.isArray(raw.content)) return raw.content;
  if (raw.content !== undefined && raw.content !== null) return [raw.content];
  return [];
}

/** Native instructions remain available in source, not as conversation prose. */
export function isConversationMessage(raw: NativeMessage): boolean {
  return messageSemantics(raw).visible;
}

/** Native request boundaries and ordered process activity, without prose matching. */
export function buildTranscriptEntries(messages: readonly ChatMessage[], tools: Record<string, ToolActivity>, agents: readonly NativeSubagent[] = []) {
  const entries: TranscriptEntry[] = [];
  const renderedTools = new Set<string>();
  const results = new Map<string, ChatMessage>();
  for (const row of messages) {
    const id = text(row.raw.toolCallId);
    if (row.raw.role === 'toolResult' && id) results.set(id, row);
  }
  const anchors = messages.flatMap((row, messageIndex) => contentBlocks(row.raw).flatMap(value => {
    const block = record(value);
    return block.type === 'toolCall' && block.name === 'task' && text(block.id) ? [{ toolCallId: text(block.id), messageIndex }] : [];
  }));
  const taskParts = new Map<string, Extract<TurnPart, { kind: 'tool' }>>();
  let turn: AssistantTurnEntry | undefined;
  for (const [messageIndex, row] of messages.entries()) {
    const raw = row.raw;
    const semantics = messageSemantics(raw);
    if (!semantics.visible) {
      if (turn && semantics.trigger) { turn.rows.push(row); turn.parts.push({ kind: 'boundary', key: row.id, row, trigger: semantics.trigger }); }
      continue;
    }
    const delivery = parseNativeAsyncDelivery(raw);
    if (delivery) {
      const ownership = resolveNativeTaskOwnership(delivery, agents, anchors, messageIndex);
      const owned = new Map<string, typeof delivery.jobs>();
      for (const linked of ownership.linked) {
        if (!taskParts.has(linked.toolCallId)) continue;
        const jobs = owned.get(linked.toolCallId) ?? [];
        jobs.push(linked.job); owned.set(linked.toolCallId, jobs);
      }
      const consumed = new Set([...owned.values()].flat());
      const remaining = delivery.jobs.filter(job => !consumed.has(job));
      const residual = remaining.length > 0 || delivery.residualContent.length > 0 || delivery.diagnostics.length > 0 || !owned.size;
      let canonicalAnchor = !residual;
      for (const [toolCallId, jobs] of owned) {
        const part = taskParts.get(toolCallId)!;
        (part.activities ??= []).push({ row, delivery: subsetNativeAsyncDelivery(delivery, jobs), canonicalAnchor });
        canonicalAnchor = false;
      }
      if (!residual) {
        if (turn) { turn.rows.push(row); turn.parts.push({ kind: 'boundary', key: row.id, row, trigger: 'background-result', delivery }); }
        continue;
      }
      const residualDelivery = subsetNativeAsyncDelivery(delivery, remaining, true);
      residualDelivery.diagnostics = [...residualDelivery.diagnostics, ...ownership.unlinked.filter(item => item.job.type === 'task').map(item => `${item.job.id}: ${item.reason}`)];
      const activity: TurnPart = { kind: 'activity', key: row.id, row, delivery: residualDelivery };
      if (turn) { turn.rows.push(row); turn.parts.push(activity); }
      else entries.push({ kind: 'assistant-turn', id: row.id, rows: [row], parts: [activity] });
      continue;
    }
    if (semantics.family === 'boundary' && turn && raw.role === 'compactionSummary') {
      turn.rows.push(row); turn.parts.push({ kind: 'activity', key: row.id, row });
      continue;
    }
    if (semantics.initiatesTurn || semantics.family === 'boundary') {
      if (turn && semantics.initiatesTurn) turn.nextPromptId = row.id;
      turn = undefined;
      entries.push({ kind: 'message', id: row.id, row });
      continue;
    }
    if (raw.role !== 'assistant' && raw.role !== 'toolResult') {
      if (turn) { turn.rows.push(row); turn.parts.push({ kind: 'activity', key: row.id, row }); }
      else entries.push({ kind: 'message', id: row.id, row });
      continue;
    }
    if (!turn) {
      turn = { kind: 'assistant-turn', id: row.id, rows: [], parts: [] };
      entries.push(turn);
    }
    turn.rows.push(row);
    if (raw.historyResourceDeferred === true && raw.role === 'assistant') {
      turn.parts.push({ kind: 'activity', key: row.id, row });
      continue;
    }
    if (raw.role === 'toolResult') {
      const id = text(raw.toolCallId);
      // Even a result already shown at its call ends the preceding narration.
      if (id && renderedTools.has(id)) turn.parts.push({ kind: 'boundary', key: row.id, row });
      else if (id) {
        renderedTools.add(id);
        turn.parts.push({ kind: 'tool', key: id, row, resultRow: row, tool: tools[id] ?? { id, name: text(raw.toolName) || 'Tool', result: raw, status: raw.isError ? 'error' : 'complete' } });
      } else {
        turn.parts.push({ kind: 'content', key: row.id, row, block: raw });
      }
      continue;
    }
    const blocks = contentBlocks(raw);
    for (let index = 0; index < blocks.length; index++) {
      const block = record(blocks[index]);
      const key = `${row.id}:block:${index}`;
      if (block.type === 'thinking' || block.type === 'redactedThinking') {
        const value = block.type === 'thinking' ? text(block.thinking) : '';
        const redacted = !value.trim();
        const previous = turn.parts.at(-1);
        if (previous?.kind === 'thinking' && previous.row === row && previous.redacted === redacted) previous.value += value ? '\n\n' + value : '';
        else turn.parts.push({ kind: 'thinking', key, row, value, redacted });
      } else if (block.type === 'text') {
        if (text(block.text).trim()) turn.parts.push({ kind: 'text', key, row, value: text(block.text) });
      } else if (block.type === 'toolCall' && text(block.id)) {
        const id = text(block.id);
        if (!renderedTools.has(id)) {
          renderedTools.add(id);
          const resultRow = results.get(id);
          const result = resultRow?.raw;
          const part: Extract<TurnPart, { kind: 'tool' }> = { kind: 'tool', key: id, row, resultRow, tool: tools[id] ?? { id, name: text(block.name) || text(result?.toolName) || 'Tool', args: block.arguments, result, status: result ? result.isError ? 'error' : 'complete' : 'pending' } };
          turn.parts.push(part);
          if (part.tool.name === 'task') { part.agents = agents.filter(agent => agent.parentToolCallId === id); taskParts.set(id, part); }
        } else turn.parts.push({ kind: 'boundary', key, row });
      } else {
        turn.parts.push({ kind: 'content', key, row, block: blocks[index] });
      }
    }
    if (!blocks.length && text(raw.text).trim()) turn.parts.push({ kind: 'text', key: `${row.id}:text`, row, value: text(raw.text) });
    const notice = nativeMessageNotice(raw);
    if (notice) turn.parts.push({ kind: 'error', key: `${row.id}:error`, row, value: notice.text });
  }
  return { entries, renderedTools };
}

/** Separate prose from structured facts rather than nesting Markdown fences in JSON. */
export function projectYieldReport(value: unknown) {
  const data = record(value);
  const proseKey = ['report', 'summary', 'result', 'message', 'conclusion', 'finding'].find(key => typeof data[key] === 'string' && text(data[key]).trim());
  const fields = subagentResultFields(value).map(field => ({ name: field.key, label: field.label, value: field.value }));
  return { type: 'yield-report', prose: proseKey ? text(data[proseKey]) : '', fields };
}


/** React/material identity only; part.key remains the canonical reading anchor. */
export function turnPartPresentationKey(part: TurnPart): string {
  if (part.kind === 'tool' || !part.row.presentation) return part.key;
  // Every non-tool key is its row ID plus a native block/error suffix.
  return `${part.row.presentation.id}${part.key.slice(part.row.id.length)}`;
}

/** Keep the enclosing instance too; navigation continues to use entry.id. */
export function assistantTurnKey(entry: AssistantTurnEntry): string {
  if (entry.presentation) return entry.presentation.id;
  const tool = entry.parts.find(part => part.kind === 'tool');
  return tool?.kind === 'tool' ? tool.tool.id : entry.rows[0]?.presentation?.id ?? entry.id;
}

/** Pane-local continuity through whole-turn regrouping; native row IDs remain unchanged. */
export function retainTurnPresentation(entries: readonly TranscriptEntry[], previous: readonly TranscriptEntry[]): TranscriptEntry[] {
  const byRow = new Map<string, AssistantTurnEntry>();
  for (const entry of previous) if (entry.kind === 'assistant-turn') {
    for (const row of entry.rows) {
      byRow.set(row.id, entry);
      if (row.presentation) byRow.set(row.presentation.id, entry);
    }
  }
  const retained = new Set<AssistantTurnEntry>();
  return entries.map((entry, index) => {
    if (entry.kind !== 'assistant-turn') return entry;
    let predecessor: AssistantTurnEntry | undefined;
    for (const row of entry.rows) {
      const candidate = byRow.get(row.id) ?? (row.presentation ? byRow.get(row.presentation.id) : undefined);
      if (candidate && !retained.has(candidate)) { predecessor = candidate; break; }
    }
    // The accepted request owns its empty header before the first provider message.
    const prompt = entries[index - 1];
    if (!predecessor && prompt?.kind === 'message') predecessor = previous.find((candidate): candidate is AssistantTurnEntry => candidate.kind === 'assistant-turn' && candidate.id === `pending-turn:${prompt.id}` && !candidate.rows.length && !retained.has(candidate));
    if (predecessor) retained.add(predecessor);
    const source = predecessor ?? entry;
    return { ...entry, presentation: source.presentation ?? { id: assistantTurnKey(source), disclosureId: source.rows[0]?.presentation?.id ?? source.rows[0]?.id ?? source.id } };
  });
}

const compactCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const finiteCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const usageTokenFields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;


export function formatUsageCost(value: number): string { return value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`; }

/** Closed footers need scalar totals only: no request rows, labels, previews or per-request formatting. */
export function turnUsageTotals(rows: readonly ChatMessage[], agents: readonly NativeSubagent[] = []) {
  const seen = new Set<string>();
  let tokens: number | undefined, cost: number | undefined;
  for (const row of rows) {
    if (row.raw.role !== 'assistant' || seen.has(row.id)) continue;
    seen.add(row.id);
    const usage = record(row.raw.usage);
    let count: number | undefined = finiteCount(usage.totalTokens) ? usage.totalTokens : undefined;
    if (count === undefined) for (const key of usageTokenFields) if (finiteCount(usage[key])) count = (count ?? 0) + usage[key];
    if (count !== undefined) tokens = (tokens ?? 0) + count;
    const amount = record(usage.cost).total;
    if (finiteCount(amount)) cost = (cost ?? 0) + amount;
  }
  for (const agent of agents) {
    const key = `agent:${agent.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const metrics = subagentMetrics(agent);
    if (metrics.tokens !== undefined) tokens = (tokens ?? 0) + metrics.tokens;
    if (metrics.cost !== undefined) cost = (cost ?? 0) + metrics.cost;
  }
  return { tokens, cost, formattedTokens: tokens === undefined ? undefined : compactCount.format(tokens), formattedCost: cost === undefined ? undefined : formatUsageCost(cost) };
}

/** Requests and attributed children are disjoint; deduplicate native identities before adding. */
export function turnUsage(rows: readonly ChatMessage[], agents: readonly NativeSubagent[] = []) {
  const seen = new Set<string>();
  const requests = rows.filter(row => row.raw.role === 'assistant' && Object.keys(record(row.raw.usage)).length > 0 && !seen.has(row.id) && !!seen.add(row.id));
  const metrics = requests.map(row => {
    const usage = record(row.raw.usage);
    const parts = ['input', 'output', 'cacheRead', 'cacheWrite'].map(key => usage[key]).filter(finiteCount);
    return { row, tokens: finiteCount(usage.totalTokens) ? usage.totalTokens : parts.length ? parts.reduce((sum, value) => sum + value, 0) : undefined, cost: finiteCount(record(usage.cost).total) ? record(usage.cost).total as number : undefined };
  });
  const children = agents.filter(agent => !seen.has(`agent:${agent.id}`) && !!seen.add(`agent:${agent.id}`)).map(agent => ({ id: agent.id, name: subagentTitle(agent), ...subagentMetrics(agent) }));
  const sum = (values: (number | undefined)[]) => values.some(value => value !== undefined) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : undefined;
  const tokens = sum([...metrics.map(item => item.tokens), ...children.map(item => item.tokens)]);
  const cost = sum([...metrics.map(item => item.cost), ...children.map(item => item.cost)]);
  return { requests: metrics, children, tokens, cost, formattedTokens: tokens === undefined ? undefined : compactCount.format(tokens), formattedCost: cost === undefined ? undefined : formatUsageCost(cost) };
}

/** Opaque provider signatures stay in raw persistence, never in display fallbacks. */
export function readableNativeData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableNativeData);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => !/signature/i.test(key)).map(([key, item]) => [key, readableNativeData(item)]),
  );
  return value;
}

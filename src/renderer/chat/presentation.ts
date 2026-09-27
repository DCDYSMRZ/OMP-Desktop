import type { NativeMessage } from '../../shared/contracts';
import { record, text, type ChatMessage, type ToolActivity } from './model';
import { isVisibleImage } from './message-details';

/** Display parts retain native tool-call identity across live/history message replacement. */
export type TurnPart =
  | { kind: 'text'; key: string; row: ChatMessage; value: string }
  | { kind: 'thinking'; key: string; row: ChatMessage; value: string }
  | { kind: 'content'; key: string; row: ChatMessage; block: unknown }
  | { kind: 'tool'; key: string; row: ChatMessage; tool: ToolActivity }
  | { kind: 'boundary'; key: string; row: ChatMessage }
  | { kind: 'error'; key: string; row: ChatMessage; value: string };
export type AssistantTurnEntry = { kind: 'assistant-turn'; id: string; rows: ChatMessage[]; parts: TurnPart[] };
export type TranscriptEntry = AssistantTurnEntry | { kind: 'message'; id: string; row: ChatMessage };

export function contentBlocks(raw: NativeMessage): unknown[] {
  if (typeof raw.content === 'string') return [{ type: 'text', text: raw.content }];
  if (Array.isArray(raw.content)) return raw.content;
  return [];
}

/** Native instructions remain available in source, not as conversation prose. */
export function isConversationMessage(raw: NativeMessage): boolean {
  return raw.role !== 'system' && raw.role !== 'developer'
    && !((raw.role === 'custom' || raw.role === 'hookMessage') && raw.display === false);
}

/** PI's user-level turns, retaining native block order and non-assistant roles. */
export function buildTranscriptEntries(messages: readonly ChatMessage[], tools: Record<string, ToolActivity>) {
  const entries: TranscriptEntry[] = [];
  const renderedTools = new Set<string>();
  const results = new Map<string, NativeMessage>();
  for (const row of messages) {
    const id = text(row.raw.toolCallId);
    if (row.raw.role === 'toolResult' && id && !tools[id]) results.set(id, row.raw);
  }
  let turn: AssistantTurnEntry | undefined;
  for (const row of messages) {
    const raw = row.raw;
    if (!isConversationMessage(raw)) {
      if (text(raw.errorMessage)) {
        turn = undefined;
        entries.push({ kind: 'assistant-turn', id: row.id, rows: [row], parts: [{ kind: 'error', key: `${row.id}:error`, row, value: text(raw.errorMessage) }] });
      }
      continue;
    }
    if (raw.historyResourceDeferred === true || (raw.role !== 'assistant' && raw.role !== 'toolResult')) {
      turn = undefined;
      entries.push({ kind: 'message', id: row.id, row });
      continue;
    }
    if (!turn) {
      turn = { kind: 'assistant-turn', id: row.id, rows: [], parts: [] };
      entries.push(turn);
    }
    turn.rows.push(row);
    if (raw.role === 'toolResult') {
      const id = text(raw.toolCallId);
      // Even a result already shown at its call ends the preceding narration.
      if (id && renderedTools.has(id)) turn.parts.push({ kind: 'boundary', key: row.id, row });
      else if (id) {
        renderedTools.add(id);
        turn.parts.push({ kind: 'tool', key: id, row, tool: tools[id] ?? { id, name: text(raw.toolName) || 'Tool', result: raw, status: raw.isError ? 'error' : 'complete' } });
      } else {
        turn.parts.push({ kind: 'content', key: row.id, row, block: raw });
      }
      continue;
    }
    const blocks = contentBlocks(raw);
    for (let index = 0; index < blocks.length; index++) {
      const block = record(blocks[index]);
      const key = `${row.id}:block:${index}`;
      if (block.type === 'thinking') {
        const value = text(block.thinking);
        if (!value.trim()) continue;
        const previous = turn.parts.at(-1);
        if (previous?.kind === 'thinking' && previous.row === row) previous.value += `\n\n${value}`;
        else turn.parts.push({ kind: 'thinking', key, row, value });
      } else if (block.type === 'text') {
        if (text(block.text).trim()) turn.parts.push({ kind: 'text', key, row, value: text(block.text) });
      } else if (block.type === 'toolCall' && text(block.id)) {
        const id = text(block.id);
        if (!renderedTools.has(id)) {
          renderedTools.add(id);
          const result = results.get(id);
          turn.parts.push({ kind: 'tool', key: id, row, tool: tools[id] ?? { id, name: text(block.name) || text(result?.toolName) || 'Tool', args: block.arguments, result, status: result ? result.isError ? 'error' : 'complete' : 'pending' } });
        } else turn.parts.push({ kind: 'boundary', key, row });
      } else {
        turn.parts.push({ kind: 'content', key, row, block: blocks[index] });
      }
    }
    if (!blocks.length && text(raw.text).trim()) turn.parts.push({ kind: 'text', key: `${row.id}:text`, row, value: text(raw.text) });
    if (raw.errorMessage !== undefined) turn.parts.push({ kind: 'error', key: `${row.id}:error`, row, value: text(raw.errorMessage) });
  }
  return { entries, renderedTools };
}

export type TurnProcessPart =
  | { kind: 'process'; key: string; parts: TurnPart[] }
  | { kind: 'stage'; key: string; tool: ToolActivity };

/** Only the trailing text/image run is a response; earlier prose is narration. */
export function projectTurnProcess(entry: AssistantTurnEntry) {
  let responseStart = entry.parts.length;
  const lastRow = entry.parts.at(-1)?.row;
  while (responseStart > 0) {
    const part = entry.parts[responseStart - 1];
    if (part.row === lastRow && (part.kind === 'error' || part.kind === 'text' || (part.kind === 'content' && isVisibleImage(part.block)))) responseStart--;
    else break;
  }
  const process: TurnProcessPart[] = [];
  for (const part of entry.parts.slice(0, responseStart)) {
    if (part.kind === 'error' || part.kind === 'boundary') continue;
    if (part.kind === 'tool' && part.tool.name === 'task') {
      process.push({ kind: 'stage', key: part.tool.id, tool: part.tool });
      continue;
    }
    const previous = process.at(-1);
    if (previous?.kind === 'process') previous.parts.push(part);
    else process.push({ kind: 'process', key: part.key, parts: [part] });
  }
  return {
    process,
    responses: entry.parts.filter((part, index) => part.kind === 'error' || (index >= responseStart && part.kind !== 'boundary')),
  };
}

/** Message IDs are replaced by journal IDs at settlement; a spawning call is not. */
export function assistantTurnKey(entry: AssistantTurnEntry): string {
  const task = entry.parts.find(part => part.kind === 'tool' && part.tool.name === 'task');
  return task?.kind === 'tool' ? task.tool.id : entry.id;
}

const compactCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
const finiteCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Native request scope, not response-only tokens, context occupancy, or a turn sum. */
export function nativeUsageSummary(raw: NativeMessage) {
  const usage = record(raw.usage);
  const cost = record(usage.cost).total;
  return {
    total: finiteCount(usage.totalTokens) ? compactCount.format(usage.totalTokens) : undefined,
    cost: finiteCount(cost) ? cost > 0 && cost < 0.000001 ? '<$0.000001' : dollars.format(cost) : undefined,
    detail: usage,
  };
}

/** Opaque provider signatures stay in raw persistence, never in display fallbacks. */
export function readableNativeData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableNativeData);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => !/signature/i.test(key)).map(([key, item]) => [key, readableNativeData(item)]),
  );
  return value;
}

import type { NativeSubagent } from '../../shared/contracts';
import { messageText, record, text, type ToolActivity } from './model';
import { turnPartPresentationKey, type TranscriptEntry } from './presentation';
import { groupChapterSteps, projectTurn } from './turn-model';
import { describeTool, readDisplay, resultText, stripAnsi } from './tools/tool-model';
import { subagentBrief, subagentTitle } from '../workspace/subagent-model';

export interface FindSource { id: string; entryId: string; messageId: string; partKey?: string; text: string; reveal: string[]; toolDetail?: { scope: string; raw: string } }
export interface FindMatch { source: FindSource; start: number; end: number; occurrence: number }

/** Literal, non-overlapping UTF-16 ranges; escaping keeps punctuation literal. */
export function findTextRanges(source: string, query: string): [number, number][] {
  if (!query.trim()) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return Array.from(source.matchAll(pattern), match => [match.index!, match.index! + match[0].length]);
}
export function findMatches(sources: readonly FindSource[], query: string): FindMatch[] {
  return sources.flatMap(source => findTextRanges(source.text, query).map(([start, end], occurrence) => ({ source, start, end, occurrence })));
}
export function nextFindIndex(current: number, direction: number, count: number): number {
  return count ? ((current + direction) % count + count) % count : -1;
}

/** Search the same loaded projection as the transcript, never deferred resources. */
export function buildFindSources(entries: readonly TranscriptEntry[], agents: readonly NativeSubagent[] = [], unanchored: readonly ToolActivity[] = [], toolVerb: (key: string) => string = () => ''): FindSource[] {
  const sources: FindSource[] = [];
  const add = (source: Omit<FindSource, 'id' | 'text'>, values: string[]) => {
    const value = [...new Set(values.filter(value => value.trim()))].join('\n');
    sources.push({ ...source, id: `${source.partKey ?? source.messageId}:${source.messageId}`, text: value });
  };
  const toolText = (tool: ToolActivity) => {
    const summary = describeTool(tool);
    return [toolVerb(summary.verbKey), tool.name, summary.target || '', summary.intent || '', summary.peer || '', summary.family === 'read' ? readDisplay(tool.result).text : stripAnsi(resultText(tool.result)), stripAnsi(resultText(tool.stream)), ...agents.filter(agent => agent.parentToolCallId === tool.id).flatMap(agent => [subagentTitle(agent), subagentBrief(agent)])];
  };
  for (const entry of entries) {
    if (entry.kind === 'message') {
      add({ entryId: entry.id, messageId: entry.row.id, reveal: [entry.row.presentation?.id ?? entry.row.id] }, [messageText(entry.row.raw)]);
      continue;
    }
    const projection = projectTurn(entry);
    const paths = new Map<string, string[]>();
    const groups = new Map<string, string>();
    const turnIdentity = entry.presentation?.disclosureId ?? entry.rows[0]?.presentation?.id ?? entry.rows[0]?.id ?? entry.id;
    for (const segment of projection.chapters) {
      for (const part of [...segment.narration, ...segment.steps]) paths.set(part.key, [JSON.stringify([turnIdentity, 'process']), JSON.stringify([turnIdentity, `chapter:${segment.id}`])]);
      if (segment.boundary) paths.set(segment.boundary.key, [JSON.stringify([turnIdentity, 'process'])]);
      for (const group of groupChapterSteps(segment.steps)) {
        if (group.length < 5) continue;
        for (const part of group) groups.set(part.key, `group:${turnPartPresentationKey(group[0])}`);
      }
    }
    for (const item of projection.epilogue) for (const part of item.parts) paths.set(part.key, [JSON.stringify([turnIdentity, 'epilogue'])]);
    const projected = [...projection.chapters.flatMap(chapter => [...(chapter.boundary ? [chapter.boundary] : []), ...chapter.narration, ...chapter.steps]), ...projection.answer, ...projection.epilogue.flatMap(item => item.parts), ...projection.liveTail];
    for (const part of projected) {
      if (part.kind === 'boundary') continue;
      const reveal = [...paths.get(part.key) ?? [], ...(groups.has(part.key) ? [JSON.stringify([turnIdentity, groups.get(part.key)])] : [])];
      const scope = turnPartPresentationKey(part);
      const toolDetail = part.kind === 'tool' && part.tool.name !== 'task' ? { scope, raw: JSON.stringify([scope, `tool-raw:${part.tool.id}`]) } : undefined;
      reveal.push(toolDetail && part.kind === 'tool' ? JSON.stringify([scope, `tool:${part.tool.id}`]) : scope);
      if (part.row.raw.role === 'compactionSummary') reveal.push(JSON.stringify([part.row.id, `${part.row.id}:summary`]));
      const values = part.kind === 'tool' ? toolText(part.tool) : part.kind === 'text' || part.kind === 'thinking' || part.kind === 'error' ? [part.value] : part.kind === 'activity' ? [messageText(part.row.raw), text(part.row.raw.summary)] : [text(record(part.block).text), text(record(part.block).prose)];
      add({ entryId: entry.id, messageId: part.kind === 'tool' ? part.resultRow?.id ?? part.row.id : part.row.id, partKey: part.key, reveal, toolDetail }, values);
    }
  }
  for (const tool of unanchored) {
    const scope = `unanchored:${tool.id}`;
    const toolDetail = tool.name !== 'task' ? { scope, raw: JSON.stringify([scope, `tool-raw:${tool.id}`]) } : undefined;
    add({ entryId: 'other-activity', messageId: tool.id, partKey: scope, reveal: ['other-activity', toolDetail ? JSON.stringify([scope, `tool:${tool.id}`]) : scope], toolDetail }, toolText(tool));
  }
  const anchored = new Set([...entries.flatMap(entry => entry.kind === 'assistant-turn' ? entry.parts.flatMap(part => part.kind === 'tool' ? [part.tool.id] : []) : []), ...unanchored.map(tool => tool.id)]);
  for (const agent of agents) if (!agent.parentToolCallId || !anchored.has(agent.parentToolCallId)) add({ entryId: 'other-activity', messageId: agent.id, partKey: 'orphan-agents', reveal: ['other-activity', 'orphan-agents'] }, [subagentTitle(agent), subagentBrief(agent)]);
  return sources;
}

/** Yield between entries; superseded queries never publish. */
export async function buildFindSourcesChunked(entries: readonly TranscriptEntry[], agents: readonly NativeSubagent[], unanchored: readonly ToolActivity[], toolVerb: (key: string) => string, signal: AbortSignal): Promise<FindSource[]> {
  const sources: FindSource[] = [];
  let deadline = performance.now() + 8;
  for (const entry of entries) {
    if (signal.aborted) return [];
    sources.push(...buildFindSources([entry], agents, [], toolVerb).filter(source => source.entryId !== 'other-activity'));
    if (performance.now() >= deadline) { await new Promise(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 8; }
  }
  const anchored = new Set(entries.flatMap(entry => entry.kind === 'assistant-turn' ? entry.parts.flatMap(part => part.kind === 'tool' ? [part.tool.id] : []) : []));
  sources.push(...buildFindSources([], agents.filter(agent => !agent.parentToolCallId || !anchored.has(agent.parentToolCallId)), unanchored, toolVerb));
  return sources;
}

export async function findMatchesChunked(sources: readonly FindSource[], query: string, signal: AbortSignal): Promise<FindMatch[]> {
  if (!query.trim()) return [];
  const matches: FindMatch[] = [];
  let deadline = performance.now() + 8;
  for (const source of sources) {
    let occurrence = 0, consumed = 0;
    for (let offset = 0; offset < source.text.length; offset += 32768) {
      if (signal.aborted) return [];
      const end = Math.min(source.text.length, offset + 32768), base = Math.max(offset, consumed);
      for (const [start, finish] of findTextRanges(source.text.slice(base, end + query.length - 1), query)) {
        if (base + start >= end) break;
        matches.push({ source, start: base + start, end: base + finish, occurrence: occurrence++ });
        consumed = base + finish;
      }
      if (performance.now() >= deadline) { await new Promise(resolve => setTimeout(resolve, 0)); deadline = performance.now() + 8; }
    }
  }
  return matches;
}

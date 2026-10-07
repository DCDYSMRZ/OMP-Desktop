/**
 * Turn reading model contract (2026-09-29 round). TurnModel implements `projectTurn`; TimelineUI renders.
 * A user request becomes: one stable primary report, an ordered chapter outline of the work,
 * and a post-report lane for background results and the replies they provoke.
 */
import { buildTurnTimeline, isStoppedMessage, projectYieldReport, summarizeTurn, unresolvedToolFailureIds, type AssistantTurnEntry, type TimelineSegment, type TurnPart } from './presentation';
import { record, text } from './model';
import { describeTool, toolFamily } from './tools/tool-model';
import { plainMarkdownLine } from '../lib/markdown-plain';
import { isVisibleImage } from './message-details';
import { parseNativeJobSnapshot } from '../../shared/native-task-results';
import { visibleAgentPhase } from '../../shared/subagent-evidence';

export type ChapterStatus = 'running' | 'done' | 'failed' | 'stopped' | 'waiting';

export interface ChapterSummary {
  steps: number;
  reads: number;
  edits: number;
  commands: number;
  searches: number;
  agents: number;
  agentsRunning: number;
  issues: number;
}

export interface TurnChapter {
  /** Stable across re-projection (derived from the first part's identity). */
  id: string;
  /** One-line plain title from the chapter's narration; empty for a leading step-only chapter. */
  title: string;
  /** Narration text parts (assistant prose) that open the chapter. */
  narration: TurnPart[];
  /** Tool/thinking/activity parts performed in the chapter, in order. */
  steps: TurnPart[];
  /** Context epoch boundary rendered separately before this chapter, never an ordinary tool step. */
  boundary?: TurnPart;
  status: ChapterStatus;
  summary: ChapterSummary;
  startedAt?: number;
  endedAt?: number;
  /** The chapter the live turn is currently working in (at most one per turn). */
  current: boolean;
}

export type EpilogueKind =
  /** A background job/subagent/process result delivered after the report (async-result, wait recovery, launch completion). */
  | 'background-result'
  /** Assistant text provoked by a background result, a housekeeping tool result or a hidden reminder, with no substantive work. */
  | 'reply'
  /** Bookkeeping tool calls after the report (e.g. todo completion) and their results. */
  | 'housekeeping';

export interface EpilogueItem {
  id: string;
  kind: EpilogueKind;
  parts: TurnPart[];
  /** Owning task/job when attribution is proven (tool call id, native job id, agent id). */
  origin?: { toolCallId?: string; jobId?: string; agentId?: string; label?: string };
  timestamp?: number;
}

export interface TurnProjection {
  /** Primary report parts shown as the turn's answer (stable once reported). */
  answer: TurnPart[];
  /** Latest streaming prose outside the primary report, never inside a disclosure. */
  liveTail: TurnPart[];
  /**
   * `final`: the last substantive text; `report-before-epilogue`: an earlier report kept despite later replies;
   * `superseded`: later substantive work produced a newer report (previous ones stay in chapters);
   * `yield`: terminal yield projection; `none`: no report yet.
   */
  answerSource: 'final' | 'report-before-epilogue' | 'superseded' | 'yield' | 'none';
  chapters: TurnChapter[];
  epilogue: EpilogueItem[];
  supersededChapterId?: string;
  /** Why a request has no report; absence of runtime evidence never proves it is running. */
  noAnswerReason?: 'continued-by-next-prompt' | 'interrupted' | 'aborted' | 'running' | 'no-report';
}

type ToolPart = Extract<TurnPart, { kind: 'tool' }>;
const nameOf = (part: ToolPart) => part.tool.name.split(/[/.]/).at(-1)!.toLowerCase();
const housekeeping = (part: ToolPart) => toolFamily(part.tool) === 'todo' || ['title', 'set_title', 'session_title'].includes(nameOf(part));
const terminalYield = (part: TurnPart): part is ToolPart => part.kind === 'tool' && nameOf(part) === 'yield' && part.tool.status !== 'error' && !Array.isArray(record(part.tool.args).type);

/** Only repeated, successful inspection steps fold; failures and meaningful actions remain direct. */
export function groupChapterSteps(parts: readonly TurnPart[]): TurnPart[][] {
  const groups: TurnPart[][] = [];
  let run: TurnPart[] = [], previous = '';
  const flush = () => { if (run.length >= 5) groups.push(run); else for (const part of run) groups.push([part]); run = []; };
  for (const part of parts) {
    const family = part.kind === 'tool' && part.tool.status === 'complete' ? toolFamily(part.tool) : '';
    const kind = ['read', 'search', 'find'].includes(family) ? family : '';
    if (!kind || kind !== previous) flush();
    if (kind) run.push(part); else groups.push([part]);
    previous = kind;
  }
  flush();
  return groups;
}

function triggerOf(part: TurnPart): EpilogueKind | 'reminder' | undefined {
  if (part.kind === 'boundary' && part.trigger) return part.trigger;
  if (part.kind === 'tool' && housekeeping(part)) return 'housekeeping';
  const raw = part.kind === 'tool' ? record(part.tool.result) : part.row.raw;
  if (['async-result', 'launch-completion', 'process-completion'].includes(text(raw.customType))) return 'background-result';
  const name = part.kind === 'tool' ? nameOf(part) : text(raw.toolName);
  if (['todo', 'title', 'set_title', 'session_title'].includes(name)) return 'housekeeping';
  if (['wait', 'jobs', 'cancel'].includes(name)) {
    const jobs = record(raw.details).jobs;
    if (Array.isArray(jobs) && jobs.some(job => ['completed', 'failed', 'aborted', 'cancelled'].includes(text(record(job).status)))) return 'background-result';
  }
  return undefined;
}

/** The sole report heuristic: Markdown structure, or >=600 characters AND >=one third of the earlier report. No prose/locale matching. */
function fullReport(value: string, previousLength: number): boolean {
  return /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~)/m.test(value) || (value.length >= 600 && value.length >= previousLength / 3);
}

const savedProjections = new WeakMap<AssistantTurnEntry, TurnProjection>();
const liveProjections = new WeakMap<AssistantTurnEntry, TurnProjection>();

/** Request identity and trigger provenance, not the last provider message, choose the primary report. */
export function projectTurn(entry: AssistantTurnEntry, live = entry.rows.some(row => row.streaming)): TurnProjection {
  const cache = live ? liveProjections : savedProjections;
  const cached = cache.get(entry);
  if (cached) return cached;
  const rows = new Map<string, TurnPart[]>();
  for (const part of entry.parts) { const parts = rows.get(part.row.id) ?? []; parts.push(part); rows.set(part.row.id, parts); }
  let answer: TurnPart[] = [], answerSource: TurnProjection['answerSource'] = 'none';
  let selected = new Set<string>(), answerStart = -1, triggered = false, worked = false, previousReportKey: string | undefined;
  let workSeen = false, provisionalAnswer = false, externalTrigger = false;
  const indices = new Map(entry.parts.map((part, index) => [part.key, index]));
  for (const parts of rows.values()) {
    const assistant = parts[0].row.raw.role === 'assistant';
    const yieldPart = parts.find(terminalYield);
    const substantive = parts.filter((part): part is ToolPart => part.kind === 'tool' && !housekeeping(part) && !terminalYield(part));
    // Before any substantive work, a candidate is provisional. Continuing the original work makes it narration; a genuinely external wake still keeps the report stable.
    if (substantive.length && answer.length && provisionalAnswer && !externalTrigger) {
      answer = []; selected.clear(); answerStart = -1; answerSource = 'none'; triggered = false; worked = false;
    }
    if (substantive.length) workSeen = true;
    const lastWork = substantive.at(-1);
    // A wait call is still work: its later recovered result does not retroactively turn the call's narration into a report.
    const prose = parts.filter(part => (part.kind === 'text' || (part.kind === 'content' && isVisibleImage(part.block)) || (part.kind === 'error' && !isStoppedMessage(part.row.raw))) && (!lastWork || (parts[0].row.raw.stopReason !== 'toolUse' && parts.indexOf(part) > parts.indexOf(lastWork))));
    if (substantive.some(part => triggerOf(part) !== 'background-result')) worked = true;
    let candidate = assistant ? prose : [];
    const consumed = new Set(candidate.map(part => part.key));
    if (yieldPart) {
      const texts = parts.filter((part): part is Extract<TurnPart, { kind: 'text' }> => part.kind === 'text');
      const args = record(yieldPart.tool.args), value = args.error ?? args.data ?? record(record(yieldPart.tool.result).details).data;
      if (!texts.length && value === undefined) {
        let index = (indices.get(yieldPart.key) ?? 0) - 1;
        while (index >= 0 && entry.parts[index].kind === 'text') texts.unshift(entry.parts[index--] as Extract<TurnPart, { kind: 'text' }>);
      }
      candidate = texts.length ? [{ ...texts[0], value: texts.map(part => part.value).join(''), continuations: texts.slice(1) }] : [];
      for (const part of texts) consumed.add(part.key);
      if (value !== undefined) {
        if (typeof value === 'string') { if (!texts.length) candidate.push({ kind: 'text', key: `${yieldPart.row.id}:report`, row: yieldPart.row, value }); }
        else { const block = projectYieldReport(value); if (texts.length) block.prose = ''; if (block.prose || block.fields.length) candidate.push({ kind: 'content', key: `${yieldPart.row.id}:report`, row: yieldPart.row, block }); }
      }
    }
    if (candidate.length) {
      const value = candidate.map(part => part.kind === 'text' ? part.value : part.kind === 'content' ? text(record(part.block).prose) : '').join('\n');
      const previousLength = answer.reduce((length, part) => length + (part.kind === 'text' ? part.value.length : part.kind === 'content' ? text(record(part.block).prose).length : 0), 0);
      const supersedes = answer.length > 0 && triggered && worked && fullReport(value, previousLength);
      if (!answer.length || !triggered || supersedes || yieldPart) {
        if (supersedes) previousReportKey = answer[0]?.key;
        answer = candidate; selected = consumed;
        answerStart = Math.min(...[...consumed].map(key => indices.get(key) ?? Infinity), indices.get(yieldPart?.key ?? candidate[0].key) ?? Infinity);
        answerSource = yieldPart ? 'yield' : supersedes ? 'superseded' : 'final';
        provisionalAnswer = !workSeen && parts.some(part => part.kind === 'tool' && housekeeping(part)); externalTrigger = false;
        triggered = false; worked = false;
      }
    }
    for (const part of parts) {
      const trigger = triggerOf(part);
      if (trigger) triggered = true;
      if (trigger === 'background-result' || trigger === 'reminder') externalTrigger = true;
    }
  }
  // A running request has work and a visible newest-text tail, not a settled report or epilogue.
  if (live) { answer = []; selected.clear(); answerStart = -1; answerSource = 'none'; }
  const process: TurnPart[] = [], epilogue: EpilogueItem[] = [];
  const lastToolIndex = entry.parts.findLastIndex(part => part.kind === 'tool');
  const latestTextRow = live ? entry.parts.findLast((part, index) => index > lastToolIndex && part.kind === 'text')?.row.id : undefined;
  const liveTail = latestTextRow ? entry.parts.filter(part => part.row.id === latestTextRow && part.kind === 'text' && !selected.has(part.key)) : [];
  const liveKeys = new Set(liveTail.map(part => part.key));
  let origin: EpilogueItem['origin'];
  for (let index = 0; index < entry.parts.length; index++) {
    const part = entry.parts[index];
    if (selected.has(part.key) || liveKeys.has(part.key)) continue;
    const trigger = triggerOf(part);
    const delivery = (part.kind === 'activity' || part.kind === 'boundary') ? part.delivery ?? parseNativeJobSnapshot(part.row.raw) : part.kind === 'tool' ? parseNativeJobSnapshot({ ...record(part.tool.result), role: 'toolResult', toolName: nameOf(part) }) : undefined;
    const job = delivery?.jobs.length === 1 && !delivery.jobs[0].ambiguous ? delivery.jobs[0] : undefined;
    if (job) origin = { jobId: job.id, agentId: job.agentId, label: job.label };
    else if (trigger) {
      const toolCallId = part.kind === 'tool' ? part.tool.id : text(part.row.raw.toolCallId);
      origin = toolCallId ? { toolCallId } : undefined;
    }
    const after = answerStart >= 0 && index > answerStart && !terminalYield(part) && !(part.kind === 'thinking' && answer.some(answerPart => answerPart.row === part.row)) && !(part.kind === 'error' && isStoppedMessage(part.row.raw));
    if (part.kind === 'boundary' && !(after && part.delivery)) continue;
    const visible: TurnPart = part.kind === 'boundary' ? { kind: 'activity', key: part.key, row: part.row, delivery: part.delivery } : part;
    if (!after) { process.push(visible); continue; }
    const kind = trigger === 'background-result' ? 'background-result' : trigger === 'housekeeping' ? 'housekeeping' : 'reply';
    const previous = epilogue.at(-1);
    if (previous && kind === 'reply' && previous.kind === kind && previous.origin === origin) previous.parts.push(visible);
    else epilogue.push({ id: part.key, kind, parts: [visible], origin, timestamp: typeof part.row.raw.timestamp === 'number' ? part.row.raw.timestamp : typeof part.row.raw.timestamp === 'string' ? Date.parse(part.row.raw.timestamp) : undefined });
  }
  if (answerSource === 'final' && epilogue.length) answerSource = 'report-before-epilogue';
  const segments: (TimelineSegment & { boundary?: TurnPart })[] = [];
  let chunk: TurnPart[] = [], boundary: TurnPart | undefined;
  const flush = () => {
    const next = buildTurnTimeline(chunk);
    if (boundary && !next.length) next.push({ key: boundary.key, narration: [], steps: [] });
    if (next.length) segments.push(...next.map((segment, index) => index === 0 && boundary ? { ...segment, boundary } : segment));
    chunk = []; boundary = undefined;
  };
  for (const part of process) {
    if (part.row.raw.role === 'compactionSummary') { flush(); boundary = part; }
    else chunk.push(part);
  }
  flush();
  const first = segments[0], second = segments[1];
  if (first && second && !first.boundary && !second.boundary && !first.narration.length && first.steps.length > 0 && first.steps.every(part => part.kind === 'thinking')) {
    second.steps = [...first.steps, ...second.steps];
    segments.shift();
  }
  const unresolvedFailures = unresolvedToolFailureIds(entry.parts);
  const chapters = segments.map((segment, index): TurnChapter => {
    const parts = [...segment.narration, ...segment.steps], summary = summarizeTurn(parts, describeTool, unresolvedFailures);
    const pending = segment.steps.some(part => part.kind === 'tool' && ['pending', 'running'].includes(part.tool.status));
    const agents = segment.steps.flatMap(part => part.kind === 'tool' ? part.agents ?? [] : []);
    const agentsRunning = agents.filter(agent => visibleAgentPhase(agent) === 'running').length;
    const waiting = agents.some(agent => visibleAgentPhase(agent) === 'queued');
    const current = index === segments.length - 1;
    const stopped = parts.some(part => isStoppedMessage(part.row.raw) || part.kind === 'tool' && part.tool.status === 'interrupted');
    const running = pending || agentsRunning > 0 || parts.some(part => part.row.streaming);
    const firstLine = segment.narration.map(part => part.kind === 'text' ? part.value : '').join(' ').split(/[\r\n]/)[0];
    const inherited = segment.boundary ? segments.slice(0, index).findLast(item => item.narration.length)?.narration.find(part => part.kind === 'text') : undefined;
    const contentTitle = firstLine || (inherited?.kind === 'text' ? inherited.value.split(/[\r\n]/)[0] : '');
    const title = plainMarkdownLine(contentTitle).split(/(?<=[.!?])(?:\s|$)|(?<=[。！？])/)[0].trim();
    return { id: segment.key, title, narration: segment.narration, steps: segment.steps, boundary: segment.boundary, current, status: stopped ? 'stopped' : running ? 'running' : summary.failures ? 'failed' : waiting ? 'waiting' : 'done', summary: { steps: summary.steps, reads: summary.readFiles.length, edits: summary.editedFiles.length, commands: summary.commands, searches: summary.searches, agents: Math.max(summary.agents, agents.length), agentsRunning, issues: summary.failures }, startedAt: summary.startedAt, endedAt: summary.endedAt };
  });
  const lastAssistant = entry.rows.findLast(row => row.raw.role === 'assistant');
  const noAnswerReason: TurnProjection['noAnswerReason'] = answer.length ? undefined : live ? 'running' : lastAssistant && isStoppedMessage(lastAssistant.raw) ? 'aborted' : lastAssistant?.raw.stopReason === 'error' ? 'interrupted' : entry.nextPromptId ? 'continued-by-next-prompt' : 'no-report';
  const projection: TurnProjection = { answer, liveTail, answerSource, chapters, epilogue, noAnswerReason, supersededChapterId: previousReportKey ? chapters.find(chapter => chapter.narration.some(part => part.key === previousReportKey))?.id : undefined };
  cache.set(entry, projection);
  return projection;
}

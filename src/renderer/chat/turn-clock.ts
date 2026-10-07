import type { ObservedActivity } from '../../shared/contracts';
import type { TurnPart } from './presentation';
import { record, text } from './model';

export interface WaitingInterval { start: number; end: number }
const time = (value: unknown): number | undefined => {
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : undefined;
};

/** Only user-blocking receipts qualify; ordinary tool runtime is never inferred as waiting. */
export function savedWaitingIntervals(parts: readonly TurnPart[]): WaitingInterval[] {
  const intervals: WaitingInterval[] = [];
  const pending = new Map<string, number>();
  const seen = new Set<string>();
  const add = (start: number | undefined, end: number | undefined) => { if (start !== undefined && end !== undefined && end > start) intervals.push({ start, end }); };
  for (const part of parts) {
    if (part.kind === 'tool' && part.tool.name.split(/[/.]/).at(-1) === 'ask') {
      add(time(part.row.raw.completedAt) ?? time(part.row.raw.timestamp), time(part.resultRow?.raw.timestamp));
    }
    if (seen.has(part.row.id)) continue;
    seen.add(part.row.id);
    const raw = part.row.raw, kind = text(raw.customType) || text(raw.type);
    const data = record(raw.data ?? raw.details ?? raw);
    const at = time(raw.timestamp);
    const approval = kind === 'tool_approval_requested' || kind === 'tool_approval_resolved';
    const identity = approval ? text(data.toolCallId) : text(data.id);
    if (!identity || at === undefined) continue;
    const key = `${approval ? 'approval' : 'extension'}:${identity}`;
    if (kind === 'tool_approval_requested' || kind === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(text(data.method))) pending.set(key, at);
    else if (kind === 'tool_approval_resolved' || kind === 'extension_ui_response') { add(pending.get(key), at); pending.delete(key); }
  }
  return mergeWaitingIntervals(intervals);
}

/** Union overlapping live and durable receipts before subtracting their clipped duration. */
export function mergeWaitingIntervals(intervals: readonly WaitingInterval[]): WaitingInterval[] {
  const result: WaitingInterval[] = [];
  for (const interval of [...intervals].filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start).sort((a, b) => a.start - b.start)) {
    const previous = result.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else result.push({ ...interval });
  }
  return result;
}

export function activeTurnDuration(start: number | undefined, end: number | undefined, intervals: readonly WaitingInterval[]): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const waiting = intervals.reduce((total, interval) => total + Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start)), 0);
  return Math.max(0, end - start - waiting);
}

export interface TurnClockSource { startedAt?: number; endedAt?: number; running: boolean; stale: boolean }

/** Observation elapsed time belongs to the request, never the newest persisted provider step. */
export function selectTurnClock(activity: ObservedActivity | undefined, fallback: Omit<TurnClockSource, 'stale'>): TurnClockSource {
  if (activity?.state === 'running') return { startedAt: activity.requestStartedAt ?? fallback.startedAt, running: true, stale: false };
  if (activity?.state === 'stale') return { startedAt: activity.requestStartedAt ?? fallback.startedAt, endedAt: activity.lastAppendAt ?? fallback.endedAt, running: false, stale: true };
  return { ...fallback, stale: false };
}

export function turnClockElapsed(clock: TurnClockSource, now: number): number | undefined {
  if (clock.startedAt === undefined) return clock.running ? 0 : undefined;
  return Math.max(0, (clock.running ? now : clock.endedAt ?? clock.startedAt) - clock.startedAt);
}

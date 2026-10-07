import type { TFunction } from 'i18next';
import type { ChatState } from './model';
import { record, text } from './model';
import type { AssistantTurnEntry } from './presentation';
import { toolStepLabel } from './tools/tool-model';

export interface LiveStatus {
  kind: 'hidden' | 'latest' | 'attention' | 'retry' | 'stale' | 'running';
  label: string;
  paused: boolean;
  announcementKey: string;
  announcementReady: boolean;
  waitingChoice?: boolean;
}

export function deriveLiveStatus(chat: ChatState, entry: AssistantTurnEntry | undefined, following: boolean, observedLive: boolean, t: TFunction): LiveStatus {
  const prompt = chat.prompts[0];
  const observed = record(chat.state.observedActivity);
  if (!observedLive || !chat.isRunning && !prompt && observed.state !== 'stale') return { kind: following ? 'hidden' : 'latest', label: '', paused: true, announcementKey: 'idle', announcementReady: false } as const;
  if (prompt) return { kind: 'attention', label: [t(['select', 'confirm'].includes(prompt.method) ? 'omp.live.waitingChoice' : 'omp.live.waitingReply'), prompt.message || prompt.title].filter(Boolean).join(' · '), paused: true, waitingChoice: ['select', 'confirm'].includes(prompt.method), announcementKey: `attention:${prompt.id}`, announcementReady: true };
  const retry = record(chat.state.providerRetry);
  if (Object.keys(retry).length) {
    const error = text(retry.errorMessage);
    const code = /(?:status(?: code)?[: ]*|HTTP[ /]*|\b)([45]\d{2})\b/i.exec(error)?.[1];
    const refused = /ECONNREFUSED|connection refused|unable to connect/i.test(error);
    return { kind: 'retry', label: refused ? t('omp.live.refused') : t(code ? 'omp.live.retryStatus' : 'omp.live.retry', { code, seconds: Math.ceil(Number(retry.delayMs ?? 0) / 1000), attempt: retry.attempt, max: retry.maxAttempts }), paused: false, announcementKey: `retry:${retry.attempt}:${refused ? 'refused' : code ?? ''}`, announcementReady: true } as const;
  }
  const part = entry?.parts.findLast(part => part.kind === 'text' || part.kind === 'thinking' || part.kind === 'tool');
  const pendingTool = part?.kind === 'tool' && part.tool.status === 'pending';
  return { kind: observed.state === 'stale' ? 'stale' : 'running', label: observed.state === 'stale' ? t('omp.observe.stale') : chat.state.isCompacting ? t('omp.timeline.compacting') : pendingTool ? t('omp.live.preparingTool') : part?.kind === 'tool' ? toolStepLabel(part.tool, t) : t(part?.kind === 'text' ? 'omp.timeline.responding' : 'omp.timeline.thinkingLive'), paused: observed.state === 'stale', announcementKey: observed.state === 'stale' ? 'stale' : chat.state.isCompacting ? 'compacting' : part?.kind === 'tool' ? `tool:${part.tool.id}` : part?.kind === 'text' ? 'responding' : 'thinking', announcementReady: !pendingTool } as const;
}

/** Waiting time is excluded, including after the choice resumes the run. */
export function advanceActiveClock(previous: { at: number; elapsed: number; paused: boolean }, now: number, paused: boolean) {
  return { at: now, elapsed: previous.elapsed + (previous.paused ? 0 : Math.max(0, now - previous.at)), paused };
}

/** An unknown intersection starts hidden, preventing a duplicate status on acceptance. */
export function showFloatingLiveStatus(running: boolean, headerVisible: boolean | undefined): boolean {
  return running && headerVisible === false;
}

export function inlineLiveHeading(status: LiveStatus, hasWork: boolean, elapsed: number | undefined, duration: string, t: TFunction): string {
  if (status.kind === 'attention') return t(status.waitingChoice ? 'omp.live.waitingChoice' : 'omp.live.waitingReply');
  if (status.kind === 'retry' || status.kind === 'stale') return status.label;
  const label = t(hasWork ? 'omp.timeline.workingShort' : 'omp.timeline.thinkingLive');
  return elapsed !== undefined && elapsed >= 1000 ? `${label} · ${duration}` : label;
}

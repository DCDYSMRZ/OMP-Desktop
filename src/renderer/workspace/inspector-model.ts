import type { NativeState } from '../../shared/contracts';

export type InspectorActivity = 'offline' | 'compacting' | 'working' | 'settled' | 'background' | 'queued' | 'unknown';
export interface InspectorSummary {
  live: boolean;
  activity: InspectorActivity;
  animated: boolean;
  context: { tokens?: number; window?: number; percent?: number; ringPercent?: number; autoCompaction?: boolean };
  generation: { model?: string; provider?: string; thinking?: string; speed?: number; queued?: number };
}
const measured = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Rates are meaningful only during observed generation, never during compaction or after disconnect. */
export function deriveInspectorSummary(state: NativeState | null, live: boolean): InspectorSummary {
  live = live && state !== null;
  const queued = measured(state?.queuedMessageCount);
  const activity: InspectorActivity = !live ? 'offline' : state?.isCompacting === true ? 'compacting' : state?.isStreaming ? 'working' : state?.isSettled === true ? 'settled' : state?.hasPendingAsyncWork === true ? 'background' : (queued ?? 0) > 0 ? 'queued' : 'unknown';
  const percent = measured(state?.contextUsage?.percent);
  return {
    live, activity, animated: live && (activity === 'working' || activity === 'compacting' || activity === 'background'),
    context: { tokens: measured(state?.contextUsage?.tokens), window: measured(state?.contextUsage?.contextWindow), percent, ringPercent: percent === undefined ? undefined : Math.min(100, percent), autoCompaction: typeof state?.autoCompactionEnabled === 'boolean' ? state.autoCompactionEnabled : undefined },
    generation: { model: state?.model?.name || state?.model?.id, provider: state?.model?.provider, thinking: state?.thinkingLevel, speed: live && state?.isStreaming && state.isCompacting !== true ? measured(state.tokensPerSecond) : undefined, queued },
  };
}

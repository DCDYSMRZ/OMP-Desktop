import { formatCurrency } from '../lib/format-cost';
import type { SessionModelCapacity, SessionUsageSummary } from '../../shared/contracts';
import type { CompactionPolicy } from '../../main/data/compaction-policy';
import { record, type ChatState } from '../chat/model';
import { subagentActivity, subagentObservedLive, subagentPhase, subagentTitle } from '../workspace/subagent-model';

/**
 * Session meter contract: the composer-adjacent session status (context occupancy, spend, background work).
 * Data slice implements `buildSessionMeter` / `useSessionMeter`; UI slice renders `SessionMeterModel` only.
 */

/** Mirrors omp's TUI context levels (oh-my-pi/packages/tui/src/chrome/context-thresholds.ts). */
export type ContextLevel = 'normal' | 'warning' | 'purple' | 'error';

export interface MeterModelIdentity { provider: string; id: string; name?: string }

export interface ContextMeter {
  /**
   * `known`: tokens and a positive window; `windowUnknown`: tokens without a trustworthy window;
   * `compacting`: compaction in progress; `compacted`: a compaction happened after the last measured request
   * (no new measurement yet); `none`: nothing observed.
   */
  state: 'known' | 'windowUnknown' | 'compacting' | 'compacted' | 'none';
  /** Prompt tokens occupying context, using omp's prompt-anchor definition (never generated output). */
  tokens?: number;
  /** Positive model context window; absent when unknown. */
  window?: number;
  /** Unclamped tokens / window × 100; renderers clamp only the visual fill. */
  percent?: number;
  level: ContextLevel;
  source: 'live' | 'saved';
  windowSource?: 'runtime' | 'catalog' | 'config';
  model?: MeterModelIdentity;
  /** Saved: timestamp of the measured request. Live: time of the latest state refresh. */
  observedAt?: number;
  /** Tokens after the latest compaction when recorded (state `compacted`). */
  compactedTokens?: number;
  autoCompaction?: boolean;
  composition?: ContextComposition;
  policy?: CompactionPolicy;
  requestObservedAt?: number;
}

export interface MeterTokens { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }

export interface SpendMeter {
  /** `pending`: first read in flight; `none`: no billable usage observed. */
  state: 'known' | 'pending' | 'none';
  /** Whole-session cost: main agent plus subagents. */
  total?: number;
  main?: number;
  subagents?: number;
  tokens?: MeterTokens;
  /** cacheRead / (input + cacheRead + cacheWrite) × 100. */
  cacheHitRate?: number;
  latest?: { cost?: number; tokens?: number };
  unrecordedSubagents?: number;
  premiumRequests?: number;
  /** A refresh is in flight or failed; values are the last successful observation. */
  stale: boolean;
  unavailable: boolean;
  source: 'live' | 'saved';
}

export interface WorkMeter {
  runningAgents: { id: string; title: string; activity?: string; startedAt?: number }[];
  backgroundWork: boolean;
  queuedMessages: number;
}

export interface SessionMeterModel {
  context: ContextMeter;
  spend: SpendMeter;
  /** Null unless a live session has running subagents, background work or queued messages. */
  work: WorkMeter | null;
}

export interface ContextComposition {
  categories: { id: 'systemPrompt' | 'systemContext' | 'systemTools' | 'skills' | 'messages' | 'nonMessage'; tokens: number }[];
  estimated: boolean; source: 'live' | 'request'; basis: 'snapshot' | 'request' | 'characters' | 'partial';
}
export type ContextPrompt = NonNullable<SessionUsageSummary['contextPrompt']>;
const promptWeights = new WeakMap<ContextPrompt, { weights: number[]; total: number }>();
/** Provider occupancy anchors the total; character proportions never claim tokenizer precision. */
export function contextComposition(used: number | undefined, nonMessage: number | undefined, prompt?: ContextPrompt, source: 'live' | 'request' = 'request', basis: ContextComposition['basis'] = 'snapshot'): ContextComposition | undefined {
  if (used === undefined) return;
  if (!prompt && nonMessage === undefined) return;
  if (!prompt) {
    const overhead = Math.min(used, nonMessage!);
    return { categories: [{ id: 'nonMessage', tokens: overhead }, { id: 'messages', tokens: used - overhead }], estimated: true, source, basis };
  }
  let sizes = promptWeights.get(prompt);
  if (!sizes) {
    let skills = 0;
    const parts = prompt.systemPrompt.map(part => part.replace(/<skills(?:\s[^>]*)?>[\s\S]*?<\/skills>/gi, block => { skills += block.length; return ''; }));
    const tools = prompt.dumpTools.reduce<number>((sum, tool) => sum + JSON.stringify(tool).length, 0);
    const weights = [parts[0]?.length ?? 0, parts.slice(1).reduce((sum, part) => sum + part.length, 0), tools, skills];
    sizes = { weights, total: weights.reduce((sum, value) => sum + value, 0) };
    promptWeights.set(prompt, sizes);
  }
  const overhead = Math.min(used, nonMessage ?? Math.ceil(sizes.total / 4));
  if (!sizes.total) return nonMessage === undefined ? undefined : contextComposition(used, nonMessage, undefined, source, basis);
  // session_init persists prompt text but only tool names, not schemas. Preserve the unallocated remainder explicitly.
  const allocatable = prompt.partial ? Math.min(overhead, Math.ceil(sizes.total / 4)) : overhead;
  let allocated = 0;
  const categories: ContextComposition['categories'] = (['systemPrompt', 'systemContext', 'systemTools', 'skills'] as const).map((id, index) => {
    const tokens = index === 3 ? allocatable - allocated : Math.floor(allocatable * sizes.weights[index] / sizes.total);
    allocated += tokens;
    return { id, tokens };
  });
  if (prompt.partial && overhead > allocated) categories.push({ id: 'nonMessage', tokens: overhead - allocated });
  categories.push({ id: 'messages', tokens: used - overhead });
  return { categories, estimated: true, source, basis: prompt.partial ? 'partial' : nonMessage === undefined ? 'characters' : basis };
}

const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const positive = (value: unknown): number | undefined => { const n = number(value); return n && n > 0 ? n : undefined; };

/** Port of omp/packages/tui/src/chrome/context-thresholds.ts; highest threshold wins. */
export function contextLevel(percent: number | undefined, window?: number): ContextLevel {
  if (percent === undefined || !Number.isFinite(percent) || percent <= 0) return 'normal';
  const reaches = (ratio: number, tokens: number) => percent >= (positive(window) ? Math.min(ratio, tokens / window! * 100) : ratio);
  return reaches(90, 500_000) ? 'error' : reaches(70, 270_000) ? 'purple' : reaches(50, 150_000) ? 'warning' : 'normal';
}
export function formatContextPercent(value: number): string { return `${value.toFixed(value > 0 && value < 1 ? 1 : 0)}%`; }
export function formatTokensCompact(value: number): string {
  const divisor = value >= 1_000_000 ? 1_000_000 : value >= 1000 ? 1000 : 1;
  return `${Number((value / divisor).toFixed(divisor === 1 ? 0 : 1))}${divisor === 1_000_000 ? 'M' : divisor === 1000 ? 'K' : ''}`;
}
export function formatCost(value: number, locale = 'en-US'): string { return formatCurrency(value, locale); }

export interface BuildSessionMeterArgs { chat: ChatState | null; live: boolean; usage?: SessionUsageSummary; capacity?: SessionModelCapacity; prompt?: ContextPrompt; policy?: CompactionPolicy; pending?: boolean; unavailable?: boolean }
export function buildSessionMeter({ chat, live, usage, capacity, prompt, policy, pending = false, unavailable = false }: BuildSessionMeterArgs): SessionMeterModel {
  const state = chat?.state;
  const source = live ? 'live' : 'saved';
  const model = live ? state?.model : usage?.model;
  const nativeWindow = live ? positive(state?.contextUsage?.contextWindow) : undefined;
  const matchingCapacity = live && capacity?.provider === model?.provider && capacity?.id === model?.id ? capacity : undefined;
  const catalogModel = live ? chat?.models.find(candidate => candidate.provider === model?.provider && candidate.id === model?.id) : undefined;
  const savedWindow = !live || usage?.model?.provider === model?.provider && usage?.model?.id === model?.id ? positive(usage?.contextWindow) : undefined;
  const window = nativeWindow ?? (live ? positive(state?.model?.contextWindow) : undefined) ?? positive(catalogModel?.contextWindow) ?? matchingCapacity?.contextWindow ?? savedWindow;
  const tokens = live ? number(state?.contextUsage?.tokens) : usage?.contextTokens;
  const percent = nativeWindow ? number(state?.contextUsage?.percent) ?? (tokens === undefined ? undefined : tokens / nativeWindow * 100) : window && tokens !== undefined ? tokens / window * 100 : undefined;
  const context: ContextMeter = { state: live && state?.isCompacting ? 'compacting' : !live && usage?.contextState === 'compacted' ? 'compacted' : tokens === undefined ? 'none' : window ? 'known' : 'windowUnknown', tokens, window, percent, level: contextLevel(percent, window), source, model, windowSource: nativeWindow || live && positive(state?.model?.contextWindow) ? 'runtime' : positive(catalogModel?.contextWindow) ? 'catalog' : matchingCapacity?.windowSource ?? usage?.windowSource, observedAt: usage?.observedAt, compactedTokens: usage?.compactedTokens, autoCompaction: state?.autoCompactionEnabled };
  if (live) context.observedAt = number(state?.contextUsageObservedAt);
  let nonMessage = usage?.nonMessageTokens;
  let basis: ContextComposition['basis'] = live ? 'request' : 'snapshot';
  if (live && chat) for (let index = chat.messages.length - 1; index >= 0; index--) {
    const row = chat.messages[index];
    if (row.raw.role !== 'assistant' || row.streaming || row.raw.stopReason === 'error' || row.raw.stopReason === 'aborted') continue;
    const snapshot = record(row.raw.contextSnapshot);
    if (number(snapshot.nonMessageTokens) !== undefined && (usage?.observedAt === undefined || (number(row.raw.timestamp) ?? 0) >= usage.observedAt)) { nonMessage = number(snapshot.nonMessageTokens); basis = 'snapshot'; break; }
  }
  if (context.state === 'known' || context.state === 'windowUnknown') context.composition = contextComposition(tokens, nonMessage, live ? prompt : usage?.contextPrompt, live ? 'live' : 'request', basis);
  context.requestObservedAt = usage?.observedAt;
  context.policy = policy ? { ...policy, enabled: state?.autoCompactionEnabled ?? policy.enabled } : undefined;
  if (context.policy && !context.policy.enabled) { delete context.policy.threshold; delete context.policy.speculationStart; }
  context.autoCompaction = context.policy?.enabled ?? context.autoCompaction;
  const denominator = usage?.input !== undefined && usage.cacheRead !== undefined && usage.cacheWrite !== undefined ? usage.input + usage.cacheRead + usage.cacheWrite : undefined;
  let latest = usage?.latest;
  if (!latest && chat) for (let i = chat.messages.length - 1; i >= 0; i--) {
    const row = chat.messages[i];
    if (row.raw.role === 'assistant' && !row.streaming) { const value = record(row.raw.usage); latest = { cost: number(record(value.cost).total), tokens: number(value.totalTokens) }; break; }
  }
  const spend: SpendMeter = { state: usage?.cost !== undefined ? 'known' : pending ? 'pending' : 'none', total: usage?.cost, main: usage?.mainCost, subagents: usage?.subagentCost, tokens: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.total } : undefined, cacheHitRate: denominator ? usage!.cacheRead! / denominator * 100 : undefined, latest, premiumRequests: usage?.premiumRequests, stale: pending || unavailable || !!usage?.incomplete || live && !!state?.isStreaming, unavailable, source };
  spend.unrecordedSubagents = usage?.unrecordedSubagents;
  return { context, spend, work: selectWorkMeter(chat, live) };
}

export function selectWorkMeter(chat: ChatState | null, live: boolean): WorkMeter | null {
  const state = chat?.state;
  const runningAgents = live ? (chat?.subagents ?? []).filter(agent => subagentObservedLive(agent, true) && subagentPhase(agent) === 'running').map(agent => ({ id: agent.id, title: subagentTitle(agent), activity: subagentActivity(agent) })) : [];
  const backgroundWork = live && !!state?.hasPendingAsyncWork;
  const queuedMessages = live ? number(state?.queuedMessageCount) ?? 0 : 0;
  return live && (runningAgents.length > 0 || backgroundWork || queuedMessages > 0) ? { runningAgents, backgroundWork, queuedMessages } : null;
}

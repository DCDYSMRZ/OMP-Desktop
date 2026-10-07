import type { NativeSubagent, ObservedActivity } from './contracts';
import { parseNativeAsyncDelivery, parseNativeJobSnapshot, type NativeAsyncDeliveryJob } from './native-task-results';

export type AgentPhase = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
export interface SubagentEvidence {
  phase: AgentPhase; source: 'task' | 'progress' | 'lifecycle' | 'snapshot' | 'delivery' | 'journal';
  observedAt?: number; generationStartedAt?: number; generation: number;
  observation: 'live' | 'inferred' | 'historical' | 'lost'; reason?: string;
  delivery: 'pending' | 'delivered' | 'unknown'; findings: number;
  metricsSource?: 'spawn' | 'native' | 'journal';
  metricSources?: Partial<Record<'tokens' | 'toolCount' | 'cost' | 'durationMs', 'native' | 'journal'>>;
}
export const SUBAGENT_FRESH_MS = 120_000;
export const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
export const evidenceTime = (v: unknown): number | undefined => { const n = typeof v === 'string' ? Date.parse(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : undefined; };
export function agentPhase(value: unknown): AgentPhase {
  const row = object(value);
  if (row.aborted === true) return 'stopped';
  if (row.error || typeof row.exitCode === 'number' && row.exitCode !== 0) return 'failed';
  if (row.exitCode === 0) return 'completed';
  const status = row.status ?? object(row.progress).status;
  if (status === 'pending' || status === 'queued') return 'queued';
  if (status === 'started' || status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (['failed', 'timed_out', 'denied'].includes(String(status))) return 'failed';
  if (['aborted', 'cancelled', 'stopped'].includes(String(status))) return 'stopped';
  return 'unknown';
}
export const terminalPhase = (phase: AgentPhase): boolean => phase === 'completed' || phase === 'failed' || phase === 'stopped';
export function evidenceOf(agent: NativeSubagent): SubagentEvidence {
  const saved = object(agent.evidence);
  const phase = agentPhase(agent);
  return { phase, source: 'snapshot', generation: 0, observation: agent.historical ? 'historical' : 'live', delivery: 'unknown', findings: 0, ...saved } as SubagentEvidence;
}
export function visibleAgentPhase(agent: NativeSubagent): AgentPhase {
  const evidence = evidenceOf(agent);
  if (evidence.observation === 'inferred' && evidence.observedAt !== undefined && Date.now() - evidence.observedAt < SUBAGENT_FRESH_MS && !agent.observationLost) return evidence.phase;
  if (!terminalPhase(evidence.phase) && (agent.historical || agent.observationLost || evidence.observation !== 'live')) return 'unknown';
  return evidence.phase;
}
export function unknownAgentReason(agent: NativeSubagent): string | undefined {
  if (visibleAgentPhase(agent) !== 'unknown') return undefined;
  if (typeof agent.ownershipReason === 'string') return agent.ownershipReason;
  return evidenceOf(agent).reason ?? (agent.observationLost ? 'Live observation ended without a terminal result.' : agent.historical ? 'Historical evidence has no validated terminal result; current execution is not observed.' : 'No unambiguous execution evidence is available.');
}
export function normalizeAgent(row: Record<string, unknown>, options: { id?: string; source: SubagentEvidence['source']; observedAt?: number; historical?: boolean; generation?: number; generationStartedAt?: number; reason?: string }): NativeSubagent {
  const progress = object(row.progress);
  const id = options.id ?? string(row.id) ?? string(progress.id) ?? '';
  const phase = agentPhase(row);
  const metrics = Object.keys(progress).length ? progress : row;
  const spawn = phase === 'queued' && ['tokens', 'toolCount', 'requests', 'cost', 'durationMs'].every(key => metrics[key] === undefined || metrics[key] === 0);
  const evidence: SubagentEvidence = { phase, source: options.source, observedAt: options.observedAt ?? evidenceTime(row.timestamp), generation: options.generation ?? 0, generationStartedAt: options.generationStartedAt, observation: options.historical ? 'historical' : 'live', reason: options.reason, delivery: options.source === 'delivery' ? 'delivered' : 'unknown', findings: Number(row.issueCount ?? progress.issueCount ?? 0), metricsSource: spawn ? 'spawn' : options.source === 'journal' ? 'journal' : 'native' };
  return { ...row, id, status: row.aborted === true || row.error || typeof row.exitCode === 'number' ? (phase === 'stopped' ? 'aborted' : phase) : string(row.status) ?? (phase === 'queued' ? 'pending' : phase === 'stopped' ? 'aborted' : phase), ...(options.historical ? { historical: true } : {}), evidence };
}
/** Evidence ordering, not the transport, owns status. Only a proven later generation reopens terminal work. */
export function reconcileAgent(previous: NativeSubagent | undefined, incoming: NativeSubagent, restart = false): NativeSubagent {
  if (!previous) return incoming;
  const old = evidenceOf(previous), next = evidenceOf(incoming);
  const differentOwner = previous.parentToolCallId && incoming.parentToolCallId ? previous.parentToolCallId !== incoming.parentToolCallId : previous.sessionFile && incoming.sessionFile ? previous.sessionFile !== incoming.sessionFile : false;
  if (differentOwner && !restart) return previous;
  if (restart) return { ...incoming, evidence: { ...next, generation: old.generation + 1, generationStartedAt: next.observedAt } };
  const newerGeneration = next.generationStartedAt !== undefined && (old.observedAt === undefined || next.generationStartedAt > old.observedAt);
  const olderGeneration = old.generationStartedAt !== undefined && (next.observedAt === undefined || next.observedAt < old.generationStartedAt);
  const older = old.observedAt !== undefined && next.observedAt !== undefined && next.observedAt < old.observedAt;
  const recoversUnknown = old.phase === 'unknown' && terminalPhase(next.phase) && !olderGeneration;
  const retain = olderGeneration || older && !recoversUnknown || terminalPhase(old.phase) && !terminalPhase(next.phase) && !newerGeneration;
  const winner = retain ? previous : incoming;
  const result: NativeSubagent = { ...previous, ...incoming, status: winner.status, historical: winner.historical, observationLost: winner.observationLost, error: winner.error, abortReason: winner.abortReason, exitCode: winner.exitCode, aborted: winner.aborted, evidence: winner.evidence ?? evidenceOf(winner), progress: retain ? previous.progress : { ...previous.progress, ...incoming.progress } };
  if (old.phase === 'unknown' && terminalPhase(next.phase)) result.unverifiedObservation = { status: previous.status, evidence: old };
  else if (next.phase === 'unknown' && terminalPhase(old.phase)) result.unverifiedObservation = { status: incoming.status, evidence: next };
  // A spawn snapshot is not a measurement and cannot erase measured journal/native totals.
  if (next.metricsSource === 'spawn' && old.metricsSource !== 'spawn') {
    result.progress = previous.progress;
    for (const key of ['toolCount', 'tokens', 'cost', 'durationMs', 'requests']) result[key] = previous[key];
  }
  return result;
}
export function normalizeAgentFrame(previous: NativeSubagent | undefined, type: string, payload: unknown, observedAt = Date.now()): NativeSubagent | undefined {
  const row = object(payload), progress = object(row.progress);
  const id = string(row.id) ?? string(progress.id);
  if (!id) return undefined;
  if (type === 'subagent_event') return { ...previous, id, lastEvent: row.event, eventCount: Number(previous?.eventCount ?? 0) + 1 };
  const restart = type === 'subagent_lifecycle' && row.status === 'started';
  const source = type === 'subagent_lifecycle' ? 'lifecycle' : type === 'subagent_progress' ? 'progress' : 'snapshot';
  const base = restart ? { id, agent: previous?.agent, description: previous?.description, task: previous?.task, assignment: previous?.assignment, sessionFile: previous?.sessionFile, parentToolCallId: previous?.parentToolCallId } : previous;
  const incoming = normalizeAgent({ ...base, ...row, id, exitCode: row.exitCode, error: row.error, aborted: row.aborted, historical: false, observationLost: false, status: row.status ?? progress.status ?? base?.status, ...(Object.keys(progress).length ? { progress: { ...(!restart ? previous?.progress : undefined), ...progress } } : {}) }, { source, observedAt, generation: previous ? evidenceOf(previous).generation : 0, generationStartedAt: restart ? observedAt : previous ? evidenceOf(previous).generationStartedAt : undefined });
  return reconcileAgent(previous, incoming, restart);
}
export function jobEvidence(agent: NativeSubagent, job: NativeAsyncDeliveryJob, observedAt?: number): NativeSubagent {
  const duration = taskDuration(job.duration);
  const progress = { ...agent.progress, result: job.result, error: job.error, abortReason: job.abortReason, deliveryDurationMs: job.durationMs, ...(duration !== undefined ? { durationMs: duration } : {}), duration: job.duration };
  const incoming = normalizeAgent({ ...agent, exitCode: undefined, aborted: undefined, status: job.status, progress, error: job.error, abortReason: job.abortReason }, { source: 'delivery', observedAt, historical: agent.historical, reason: job.ambiguous ? 'The delivery identity or result is ambiguous.' : job.status === 'unknown' ? 'The job snapshot does not establish a terminal outcome.' : undefined });
  return incoming;
}
export function taskDuration(value?: string): number | undefined {
  if (!value) return undefined;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  return parts.length && parts.map(part => part[0]).join('') === value.replace(/\s/g, '') ? parts.reduce((sum, part) => sum + Number(part[1]) * units[part[2]!]!, 0) : undefined;
}
export function settleAgentJobs(agents: readonly NativeSubagent[], message: unknown, observedAt?: number): NativeSubagent[] {
  const delivery = parseNativeAsyncDelivery(message) ?? parseNativeJobSnapshot(message);
  if (!delivery) return [...agents];
  return agents.map(agent => {
    const alias = agent.nativeId ?? agent.id;
    const jobs = delivery.jobs.filter(job => job.agentId === alias);
    if (!jobs.length) return agent;
    if (jobs.length !== 1 || agents.filter(candidate => (candidate.nativeId ?? candidate.id) === alias).length !== 1) return normalizeAgent({ ...agent, status: 'unknown' }, { source: 'delivery', observedAt, historical: agent.historical, reason: 'The native alias matches multiple task owners or deliveries.' });
    return reconcileAgent(agent, jobEvidence(agent, jobs[0]!, observedAt));
  });
}

/** Recent child activity requires independently verified active parent ownership. Copies cannot appear live. */
export function inferChildActivity(agent: NativeSubagent, parent: ObservedActivity | undefined, now = Date.now()): NativeSubagent {
  const evidence = evidenceOf(agent);
  if (parent?.state !== 'running' || agent.journalOpen !== true || terminalPhase(evidence.phase) || evidence.source !== 'journal' || evidence.observedAt === undefined || now - evidence.observedAt >= SUBAGENT_FRESH_MS || now < evidence.observedAt) return agent;
  return { ...agent, status: 'running', evidence: { ...evidence, phase: 'running', observation: 'inferred', reason: 'Inferred from recent child journal activity while the parent session is active.' } };
}

/** Task arrays and job snapshots share exactly the same interpretation in both registries. */
export function settleAgentMessage(agents: readonly NativeSubagent[], value: unknown, observedAt = Date.now()): NativeSubagent[] {
  const message = object(value);
  if (message.role !== 'toolResult' || message.toolName !== 'task' || typeof message.toolCallId !== 'string') return settleAgentJobs(agents, value, evidenceTime(message.timestamp) ?? observedAt);
  const details = object(message.details);
  const rows = [...(Array.isArray(details.results) ? details.results : []), ...(Array.isArray(details.progress) ? details.progress : [])].map(object);
  return agents.map(agent => {
    if (agent.parentToolCallId !== message.toolCallId) return agent;
    const row = rows.find(row => typeof row.id === 'string' ? row.id === agent.id || row.id === agent.nativeId : typeof row.index === 'number' && row.index === (agent.index ?? agent.progress?.index));
    if (!row) return agent;
    const previous = evidenceOf(agent);
    return reconcileAgent(agent, normalizeAgent({ ...agent, ...row, id: agent.id, progress: { ...agent.progress, ...row } }, { source: 'task', observedAt: evidenceTime(message.timestamp) ?? observedAt, generation: previous.generation, generationStartedAt: previous.generationStartedAt }));
  });
}

/** Only explicit reported findings belong in the outcome headline, never cumulative tool-error counters. */
export function reportedFindings(value: unknown): number {
  const row = object(value);
  return Math.max(0, ...['issueCount', 'errorCount'].map(key => typeof row[key] === 'number' && Number.isFinite(row[key]) ? Math.max(0, Math.floor(row[key])) : 0), ...['issues', 'errors'].map(key => Array.isArray(row[key]) ? row[key].length : 0));
}

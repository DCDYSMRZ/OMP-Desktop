import type { NativeSubagent } from '../../shared/contracts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
export type SubagentPhase = 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown';
export function subagentPhase(agent: NativeSubagent): SubagentPhase {
  const status = agent.status || string(agent.progress?.status);
  if (status === 'started') return 'running';
  if (status === 'cancelled' || status === 'stopped') return 'aborted';
  if (status === 'timed_out' || status === 'denied') return 'failed';
  return status === 'pending' || status === 'running' || status === 'completed' || status === 'failed' || status === 'aborted' ? status : 'unknown';
}
const firstLine = (value: unknown): string => string(value).trim().split(/\r?\n/, 1)[0];
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export function subagentTitle(agent: NativeSubagent): string {
  return firstLine(agent.description) || firstLine(agent.assignment) || firstLine(agent.progress?.assignment) || firstLine(agent.task) || firstLine(agent.progress?.task) || string(agent.agent) || string(agent.progress?.agent);
}
export interface SubagentMetrics { toolCount?: number; tokens?: number; cost?: number; durationMs?: number }
export function subagentMetrics(agent: NativeSubagent): SubagentMetrics {
  const phase = subagentPhase(agent);
  const terminal = phase === 'completed' || phase === 'failed' || phase === 'aborted';
  return {
    toolCount: finite(agent.progress?.toolCount) ?? finite(agent.toolCount),
    tokens: finite(agent.progress?.tokens) ?? finite(agent.tokens),
    cost: finite(agent.progress?.cost) ?? finite(agent.cost),
    durationMs: terminal ? finite(agent.durationMs) ?? finite(agent.progress?.durationMs) : finite(agent.progress?.durationMs) ?? finite(agent.durationMs),
  };
}
export function subagentActivity(agent: NativeSubagent): string | undefined {
  if (subagentPhase(agent) !== 'running') return undefined;
  const progress = agent.progress ?? agent;
  const intent = firstLine(progress.lastIntent);
  if (intent) return intent;
  const tool = string(progress.currentTool);
  if (!tool) return undefined;
  const args = progress.currentToolArgs;
  const preview = typeof args === 'string' ? firstLine(args) : Object.values(object(args)).filter(value => typeof value === 'string').map(firstLine).join(' · ');
  return preview ? `${tool} · ${preview.slice(0, 100)}` : tool;
}
export function subagentError(agent: NativeSubagent): string | undefined {
  return string(agent.error) || string(agent.abortReason) || string(agent.progress?.error) || string(agent.progress?.abortReason) || string(object(agent.progress?.retryFailure).errorMessage) || string(object(agent.retryFailure).errorMessage) || undefined;
}
export interface PlannedSubagent { index: number; name?: string; agent?: string; task?: string }
export function plannedSubagents(args: unknown): PlannedSubagent[] {
  const input = object(args);
  const tasks = 'tasks' in input ? input.tasks : [input];
  if (!Array.isArray(tasks) || !tasks.length) return [];
  if (tasks.some(value => { const task = object(value); return !string(task.task).trim() || ('agent' in task && !string(task.agent).trim()) || ('name' in task && typeof task.name !== 'string'); })) return [];
  return tasks.map((value, index) => {
    const task = object(value);
    return { index, name: string(task.name) || undefined, agent: string(task.agent) || undefined, task: string(task.task) };
  });
}
/** A terminal parent cannot leave an unspawned slot looking active. */
export function plannedSubagentPhase(toolStatus: string | undefined): SubagentPhase {
  if (!toolStatus || toolStatus === 'pending' || toolStatus === 'running' || toolStatus === 'started') return 'pending';
  if (toolStatus === 'complete' || toolStatus === 'completed' || toolStatus === 'interrupted' || toolStatus === 'aborted' || toolStatus === 'cancelled' || toolStatus === 'stopped') return 'aborted';
  return 'failed';
}

export function subagentIndex(agent: NativeSubagent): number | undefined {
  const value = finite(agent.index) ?? finite(agent.progress?.index);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}
export function groupSubagentsByToolCall(agents: NativeSubagent[], anchoredToolCallIds: ReadonlySet<string>): { byToolCall: Map<string, NativeSubagent[]>; orphans: NativeSubagent[]; resolvedTrees: SubagentNode[] } {
  const byToolCall = new Map<string, NativeSubagent[]>();
  const orphans: NativeSubagent[] = [];
  const resolvedTrees = subagentTree(agents);
  for (const { agent } of resolvedTrees) {
    const id = agent.parentToolCallId;
    if (!id || !anchoredToolCallIds.has(id)) { orphans.push(agent); continue; }
    const group = byToolCall.get(id);
    if (group) group.push(agent); else byToolCall.set(id, [agent]);
  }
  const compare = (a: NativeSubagent, b: NativeSubagent) => (subagentIndex(a) ?? Infinity) - (subagentIndex(b) ?? Infinity);
  for (const group of byToolCall.values()) group.sort(compare);
  orphans.sort(compare);
  return { byToolCall, orphans, resolvedTrees };
}
export interface SubagentNode { agent: NativeSubagent; children: SubagentNode[] }
function nestedAgents(agent: NativeSubagent): NativeSubagent[] {
  const progress = agent.progress ?? agent;
  const extracted = object(progress.extractedToolData);
  const details = [...(Array.isArray(extracted.task) ? extracted.task : []), progress.inflightTaskDetails].filter(Boolean);
  const children = new Map<string, NativeSubagent>();
  for (const raw of details) {
    const detail = object(raw);
    for (const item of Array.isArray(detail.progress) ? detail.progress : []) {
      const child = object(item); const id = string(child.id);
      if (id) children.set(id, { ...child, id, progress: child } as NativeSubagent);
    }
    for (const item of Array.isArray(detail.results) ? detail.results : []) {
      const child = object(item); const id = string(child.id);
      if (id) children.set(id, { ...child, id, status: child.aborted === true ? 'aborted' : child.error || (typeof child.exitCode === 'number' && child.exitCode !== 0) ? 'failed' : child.exitCode === 0 ? 'completed' : 'unknown' } as NativeSubagent);
    }
  }
  return [...children.values()];
}
/** Nest only explicit native task details; dotted IDs do not prove ancestry. */
export function subagentTree(agents: NativeSubagent[]): SubagentNode[] {
  const live = new Map(agents.map(agent => [agent.id, agent]));
  const aliases = new Map<string, NativeSubagent | undefined>();
  for (const agent of agents) if (agent.nativeId) aliases.set(agent.nativeId, aliases.has(agent.nativeId) ? undefined : agent);
  for (const [id, agent] of aliases) if (agent && !live.has(id)) live.set(id, agent);
  const nested = new Set<string>();
  const visit = (agent: NativeSubagent, ancestors: Set<string>): SubagentNode => {
    const path = new Set(ancestors).add(agent.id);
    const children = nestedAgents(agent).map(child => live.get(child.id) ?? child).filter(child => !path.has(child.id)).map(child => {
      nested.add(child.id);
      return visit(child, path);
    });
    return { agent, children };
  };
  const trees = agents.map(agent => visit(agent, new Set()));
  // Malformed cross-linked data must not hide every task.
  const roots = trees.filter(node => !nested.has(node.agent.id));
  return roots.length ? roots : trees;
}
export function findSubagent(agents: NativeSubagent[], id: string): NativeSubagent | undefined {
  const aliases: NativeSubagent[] = [];
  const visit = (nodes: SubagentNode[]): NativeSubagent | undefined => {
    for (const node of nodes) {
      if (node.agent.id === id || node.agent.savedId === id) return node.agent;
      if (node.agent.nativeId === id) aliases.push(node.agent);
      const child = visit(node.children);
      if (child) return child;
    }
  };
  const exact = visit(subagentTree(agents));
  return exact ?? (aliases.length === 1 ? aliases[0] : undefined);
}

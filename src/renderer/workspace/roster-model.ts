import type { TFunction } from 'i18next';
import type { NativeSubagent } from '../../shared/contracts';
import type { NativeAsyncDeliveryJob } from '../../shared/native-task-results';
import { jobEvidence, reconcileAgent } from '../../shared/subagent-evidence';
import type { SubagentNode } from './subagent-model';
import { record, text } from '../chat/model';
import { toolStepLabel } from '../chat/tools/tool-model';
import { subagentBrief, subagentMetrics, subagentPhase, subagentPreview } from './subagent-model';

export function rosterScope(agent: NativeSubagent, siblings: readonly NativeSubagent[]): string {
  const brief = subagentBrief(agent);
  if (!siblings.some(other => other.id !== agent.id && subagentBrief(other) === brief)) return brief;
  const own = text(agent.assignment) || text(agent.progress?.assignment) || agent.task || text(agent.progress?.task);
  const scopes = own.split(/\r?\n/).map(line => subagentPreview(line, 1)).filter(Boolean);
  return scopes.find(line => line !== brief && !siblings.some(other => other.id !== agent.id && (text(other.assignment) || other.task || '').includes(line))) || scopes.find(line => line !== brief) || brief;
}
export function rosterActivity(agent: NativeSubagent, t: TFunction): string | undefined {
  if (subagentPhase(agent) !== 'running') return;
  const progress = agent.progress ?? agent;
  const name = text(progress.currentTool);
  if (!name) return t('omp.timeline.thinkingLive');
  let args = progress.currentToolArgs;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = name === 'bash' ? { command: args } : name === 'read' ? { path: args } : {}; } }
  return toolStepLabel({ id: agent.id, name, args: record(args), status: 'running' }, t);
}
export function composeRosterRow(agent: NativeSubagent, siblings: readonly NativeSubagent[], t: TFunction) {
  return { scope: rosterScope(agent, siblings), activity: rosterActivity(agent, t), type: agent.agent && agent.agent !== 'task' ? agent.agent : undefined, metrics: subagentMetrics(agent) };
}

/** Reconcile once before deriving heading counts, row state, duration and disclosure. */
export function reconcileRosterDeliveries(nodes: SubagentNode[], deliveries?: ReadonlyMap<string, readonly { job: NativeAsyncDeliveryJob }[]>): SubagentNode[] {
  if (!deliveries?.size) return nodes;
  return nodes.map(node => {
    const delivery = deliveries.get(node.agent.id)?.at(-1)?.job;
    return { ...node, agent: delivery ? reconcileAgent(node.agent, jobEvidence(node.agent, delivery)) : node.agent, children: reconcileRosterDeliveries(node.children, deliveries) };
  });
}

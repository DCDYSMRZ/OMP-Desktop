import { useEffect, useRef } from 'react';
import type { NativeSubagent } from '../../../shared/contracts';
import { subagentActivity, subagentMetrics, subagentPhase } from '../../workspace/subagent-model';
export type AgentMotionEvent =
  | { type: 'spawn' } | { type: 'start' } | { type: 'tool'; tool: string } | { type: 'output' }
  | { type: 'complete' } | { type: 'fail' } | { type: 'abort' };
const toolOf = (agent: NativeSubagent): string => { const value = agent.progress?.currentTool ?? agent.currentTool; return typeof value === 'string' ? value : ''; };
function outputOf(agent: NativeSubagent): string {
  const value = agent.progress?.recentOutput ?? agent.recentOutput;
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value) ?? '';
}
export function diffAgentSnapshot(prev: NativeSubagent | undefined, next: NativeSubagent): AgentMotionEvent[] {
  if (!prev || prev.id !== next.id) return [{ type: 'spawn' }];
  const events: AgentMotionEvent[] = [];
  const phase = subagentPhase(next), before = subagentPhase(prev);
  if (phase !== before) {
    if (phase === 'running') events.push({ type: 'start' });
    if (phase === 'completed') events.push({ type: 'complete' });
    if (phase === 'failed') events.push({ type: 'fail' });
    if (phase === 'aborted') events.push({ type: 'abort' });
  }
  if (phase === 'running') {
    const tool = toolOf(next);
    if ((tool && tool !== toolOf(prev)) || (subagentMetrics(next).toolCount ?? 0) > (subagentMetrics(prev).toolCount ?? 0)) events.push({ type: 'tool', tool });
    if (outputOf(next) !== outputOf(prev) || subagentActivity(next) !== subagentActivity(prev)) events.push({ type: 'output' });
  }
  return events;
}
export function useAgentMotionEvents(agent: NativeSubagent | undefined, onEvent: (e: AgentMotionEvent) => void): void {
  const previous = useRef<NativeSubagent | undefined>(undefined);
  const callback = useRef(onEvent); callback.current = onEvent;
  useEffect(() => {
    if (!agent) { previous.current = undefined; return; }
    const events = diffAgentSnapshot(previous.current, agent);
    previous.current = { ...agent, progress: agent.progress ? { ...agent.progress } : undefined };
    for (const event of events) callback.current(event);
  });
}

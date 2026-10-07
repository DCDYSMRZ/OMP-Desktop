import { useContext, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeAsyncDeliveryJob } from '../../shared/native-task-results';
import type { NativeSubagent } from '../../shared/contracts';
import { evidenceOf, unknownAgentReason } from '../../shared/subagent-evidence';
import { DisclosureAnchor, DisclosureScope, useAutomaticDisclosure } from '../chat/disclosure';
import { Collapse } from '../ui/Collapse';
import { IconCheck, IconChevronRight, IconCircleDashed, IconCircleSlash, IconCircleX } from '../ui/icons';
import { text } from '../chat/model';
import { flattenSubagentTree, formatSubagentCost, formatSubagentTokens, subagentOutcome, subagentPresentationId, subagentObservedLive, subagentPhase, subagentTitle, type SubagentNode, type SubagentPhase } from './subagent-model';
import { useLiveDuration } from './SubagentStage';
import { AnimatedNumber, Swap, useFlipList } from '../ui/motion';
import { formatElapsed } from '../lib/format-duration';
import { useDisplayPreferences } from '../lib/display-preferences';
import { subagentSummary } from './subagent-model';
import { composeRosterRow } from './roster-model';

export type StageNode = SubagentNode & { plannedIndex?: number };
export interface AgentDelivery { job: NativeAsyncDeliveryJob; anchor?: string }
export interface TaskCardsProps { toolCallId?: string; nodes: StageNode[]; expanded: boolean; visible?: boolean; observedLive?: boolean; snapshotCaption?: boolean; activeSubagentId?: string | null; hoveredId?: string | null; onHover?: (id: string | null) => void; onOpen: (id: string) => void; onBeforeToggle?: (element: HTMLElement) => void; onAfterToggle?: () => void; deliveries?: Map<string, AgentDelivery[]> }
export function AgentStatus({ phase, live = false }: { phase: SubagentPhase; live?: boolean }) {
  const Icon = phase === 'completed' ? IconCheck : phase === 'failed' ? IconCircleX : phase === 'aborted' ? IconCircleSlash : IconCircleDashed;
  return <span className="agent-status-mark" data-phase={phase}><Swap animate={live} swapKey={phase} variant="scale">{phase === 'running' && live ? <span className="ui-spinner" /> : <Icon size="var(--icon-meta)" />}</Swap></span>;
}
export function SubagentStatusText({ agent, issueCount = 0 }: { agent: NativeSubagent; issueCount?: number }) {
  const { t, i18n } = useTranslation();
  const phase = subagentPhase(agent), evidence = evidenceOf(agent);
  const age = useMemo(() => evidence.observedAt === undefined ? undefined : Math.max(0, Date.now() - evidence.observedAt), [evidence.observedAt]);
  const elapsed = useLiveDuration(age, evidence.observation === 'inferred', true);
  const reason = unknownAgentReason(agent);
  const observed = typeof agent.ownershipReason === 'string' ? t('omp.subagent.unlinked') : evidence.observedAt === undefined ? t('omp.subagent.observedUnknown') : t('omp.subagent.observedAt', { time: new Date(evidence.observedAt).toLocaleString(i18n.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) });
  return <span title={reason ? t('omp.subagent.unknownReason', { reason }) : undefined}>{phase === 'completed' && issueCount > 0 ? t('omp.subagent.completedIssues', { count: issueCount }) : t(`omp.subagent.stage.phase.${phase}`)}{phase === 'completed' && agent.followupCompleted === true && <> · {t('omp.subagent.followupCompleted')}</>}{phase === 'unknown' && <> · {observed}</>}{phase === 'running' && evidence.observation === 'inferred' && <> · {(elapsed ?? 0) < 5000 ? t('omp.subagent.updatedJustNow') : t('omp.subagent.inferredAge', { seconds: Math.floor((elapsed ?? 0) / 1000) })}</>}</span>;
}
export function TaskCards(props: TaskCardsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const agents = flattenSubagentTree(props.nodes);
  const known = useRef(new Set(agents.map(subagentPresentationId)));
  const animate = props.observedLive === true && agents.every(agent => known.current.has(subagentPresentationId(agent)) || subagentObservedLive(agent, true));
  useFlipList(ref, agents.map(subagentPresentationId), { animate });
  useLayoutEffect(() => { for (const agent of agents) known.current.add(subagentPresentationId(agent)); }, [agents]);
  useLayoutEffect(() => { props.onAfterToggle?.(); }, [props.nodes, props.onAfterToggle]);
  return <div ref={ref} className="task-tree"><RosterList {...props} depth={0} /></div>;
}
function RosterList({ nodes, depth, ...props }: TaskCardsProps & { depth: number }) {
  const siblings = nodes.map(item => item.agent);
  return <ul className={`task-tree-list${depth ? ' task-tree-children' : ''}`}>{nodes.map(node => <RosterBranch key={subagentPresentationId(node.agent)} node={node} depth={depth} {...props} siblings={siblings} />)}</ul>;
}
function RosterBranch({ node, depth, siblings, ...props }: Omit<TaskCardsProps, 'nodes'> & { node: StageNode; depth: number; siblings: NativeSubagent[] }) {
  const { t } = useTranslation();
  const anchor = useContext(DisclosureAnchor);
  const id = useId();
  const descendants = flattenSubagentTree(node.children);
  const summary = subagentSummary(descendants);
  const selected = descendants.some(agent => agent.id === props.activeSubagentId);
  const disclosure = useAutomaticDisclosure(selected || summary.attention > 0 || props.observedLive === true && summary.counts.running > 0, `branch:${subagentPresentationId(node.agent)}`);
  return <li className="task-tree-item" data-depth={depth} data-flip-key={subagentPresentationId(node.agent)}>
    <RosterRow node={node} siblings={siblings} {...props} />
    {descendants.length > 0 && <><button ref={disclosure.titleRef} type="button" className="task-child-bundle" aria-expanded={disclosure.open} aria-controls={id} onClick={event => { anchor(event.currentTarget); props.onBeforeToggle?.(event.currentTarget); disclosure.toggle(); }}><IconChevronRight size="var(--icon-caption)" /><span>{t('omp.roster.children', { count: descendants.length })}</span><span className="task-branch-summary">{(Object.keys(summary.counts) as SubagentPhase[]).filter(phase => summary.counts[phase]).map(phase => <span key={phase} data-phase={phase}>{summary.counts[phase]} {t(`omp.subagent.stage.phase.${phase}`)}</span>)}</span></button><DisclosureScope disclosure={disclosure}><Collapse id={id} open={disclosure.open} bodyRef={disclosure.bodyRef} {...disclosure.bodyEvents}><RosterList {...props} nodes={node.children} depth={depth + 1} expanded={props.expanded && disclosure.open} /></Collapse></DisclosureScope></>}
  </li>;
}
function RosterRow({ node, siblings, visible = true, expanded, observedLive = false, activeSubagentId, hoveredId, onHover, onOpen, deliveries }: Omit<TaskCardsProps, 'nodes'> & { node: StageNode; siblings: NativeSubagent[] }) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  const jobs = deliveries?.get(node.agent.id) ?? [];
  const delivery = jobs.at(-1)?.job;
  const agent = node.agent;
  const phase = subagentPhase(agent);
  const live = subagentObservedLive(agent, observedLive);
  const row = composeRosterRow(agent, siblings, t);
  const metrics = row.metrics;
  const elapsed = useLiveDuration(metrics.durationMs, phase === 'running' && live, visible && expanded);
  const activity = row.activity;
  const outcome = subagentOutcome({ ...agent, error: delivery?.error || agent.error, abortReason: delivery?.abortReason || agent.abortReason }, [], delivery?.result || delivery?.content);
  const preview = outcome.summary?.split('\n')[0];
  const error = phase === 'failed' || phase === 'aborted';
  const brief = row.scope;
  const metadata = [metrics.toolCount ? t('omp.roster.steps', { count: metrics.toolCount }) : '', metrics.tokens ? t('omp.roster.tokens', { value: formatSubagentTokens(metrics.tokens) }) : '', metrics.cost ? formatSubagentCost(metrics.cost) : ''].filter(Boolean).join(' · ');
  const content = <>
    <span className="task-card-heading"><AgentStatus phase={phase} live={live} /><strong data-agent-identity={agent.id} title={subagentTitle(agent)}>{subagentTitle(agent) || t('chat.subagentUnnamed')}</strong>{row.type && <span className="agent-type-chip">{row.type}</span>}<span className="task-card-meta" title={metadata}><span className="task-card-phase" data-phase={phase}><SubagentStatusText agent={agent} issueCount={outcome.issueCount} /></span>{elapsed !== undefined && elapsed >= 1000 && <AnimatedNumber animate={live} value={elapsed} format={n => formatElapsed(n, durationStyle, i18n.language)} />}</span></span>
    {brief && <span className="task-card-brief" title={text(agent.description) || text(agent.assignment) || agent.task || text(agent.progress?.task) || brief}>{brief}</span>}
    <span className="task-card-second"><span className={error ? 'task-card-error-preview' : 'task-card-activity'} title={activity ?? preview}>{phase === 'running' ? activity : preview}</span>{jobs.length > 0 && <span className="task-card-result-link">{t('omp.roster.result')}</span>}</span>
  </>;
  return <div className="task-card" data-agent-id={agent.id} data-phase={phase} data-selected={agent.id === activeSubagentId || undefined} data-highlighted={agent.id === hoveredId || undefined} title={[metadata, !live && node.plannedIndex === undefined ? t('omp.subagent.lastObservedHint') : ''].filter(Boolean).join(' · ')} onPointerEnter={() => onHover?.(agent.id)} onPointerLeave={() => onHover?.(null)}>{jobs.filter(item => item.anchor).map(item => <span key={item.anchor} data-message-id={item.anchor} />)}{node.plannedIndex !== undefined ? <div className="task-card-face">{content}</div> : <button type="button" className="task-card-face" onClick={() => onOpen(agent.id)} aria-label={`${subagentTitle(agent)} · ${t(`omp.subagent.stage.phase.${phase}`)}`}>{content}</button>}</div>;
}

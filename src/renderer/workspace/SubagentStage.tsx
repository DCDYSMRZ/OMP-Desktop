import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeSubagent } from '../../shared/contracts';
import { IconBraces, IconChevronRight, IconUsers } from '../ui/icons';
import { Collapse } from '../ui/Collapse';
import { DisclosureAnchor, DisclosureScope, useAutomaticDisclosure } from '../chat/disclosure';
import { flattenSubagentTree, plannedSlotStatus, subagentActive, subagentObservedLive, subagentIndex, subagentMetrics, subagentPhase, subagentOutcome, subagentSummary, subagentTitle, subagentTree, type PlannedSubagent, type SubagentNode, type SubagentPhase } from './subagent-model';
import { AgentStatus, TaskCards, type AgentDelivery, type StageNode } from './TaskCards';
import { AnimatedNumber, isMotionPaused } from '../ui/motion';
import { formatElapsed } from '../lib/format-duration';
import { useDisplayPreferences } from '../lib/display-preferences';
import { useInView } from '../lib/useInView';
import { nextStageFoldState, recallStageFoldState, rememberStageFoldState, type StageFoldEvent } from './stage-fold-state';
import '../styles/subagent-stage.css';
import { fittedSubagentCount } from './subagent-model';
import { evidenceOf } from '../../shared/subagent-evidence';
import { reconcileRosterDeliveries } from './roster-model';

// One presentation clock for visible task surfaces, never a timer per card.
const clockListeners = new Set<() => void>();
let clockNow = Date.now();
let clockTimer: number | undefined;
function updateClock() { clockNow = Date.now(); for (const notify of clockListeners) notify(); }
function clockVisibility() {
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
  clockTimer = undefined;
  if (!document.hidden && clockListeners.size) { updateClock(); clockTimer = window.setInterval(updateClock, 1000); }
}
function subscribeClock(notify: () => void) {
  clockListeners.add(notify);
  if (clockListeners.size === 1) { document.addEventListener('visibilitychange', clockVisibility); clockVisibility(); }
  return () => {
    clockListeners.delete(notify);
    if (!clockListeners.size) { document.removeEventListener('visibilitychange', clockVisibility); if (clockTimer !== undefined) window.clearInterval(clockTimer); clockTimer = undefined; }
  };
}
const idleClock = () => () => {};
const clockSnapshot = () => clockNow;
export function useLiveDuration(durationMs: number | undefined, running: boolean, visible: boolean): number | undefined {
  const anchor = useMemo(() => ({ at: Date.now(), duration: durationMs }), [durationMs, running]);
  const now = useSyncExternalStore(running && visible && durationMs !== undefined ? subscribeClock : idleClock, clockSnapshot);
  // No native measurement is not a zero-second measurement.
  return durationMs === undefined ? undefined : running ? anchor.duration! + Math.max(0, now - anchor.at) : durationMs;
}

function stageObservation(nodes: StageNode[], observedLive: boolean) {
  let live = 0;
  let saved = 0;
  let running = 0;
  const visit = (node: StageNode) => {
    if (node.plannedIndex === undefined) {
      if (subagentObservedLive(node.agent, observedLive)) {
        live++;
        if (subagentPhase(node.agent) === 'running') running++;
      } else saved++;
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return { live, saved, running, snapshot: saved > 0 && live === 0 };
}

/** Measurement is isolated from the visible row; one read pass per resize, followed by one state update. */
function CollapsedAgentStrip({ agents, selectedId, observedLive, onOpen, onExpand }: { agents: NativeSubagent[]; selectedId?: string | null; observedLive: boolean; onOpen: (id: string) => void; onExpand: () => void }) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(0);
  const labels = agents.map(agent => subagentTitle(agent) || t('chat.subagentUnnamed'));
  const measurementKey = JSON.stringify(labels);
  useLayoutEffect(() => {
    const row = root.current, probe = measure.current;
    if (!row || !probe) return;
    let frame = 0, disposed = false;
    const measureRow = () => {
      frame = 0;
      const style = getComputedStyle(row);
      const available = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const widths = Array.from(probe.querySelectorAll<HTMLElement>('[data-chip-measure]'), element => element.getBoundingClientRect().width);
      const overflowWidths = Array.from(probe.querySelectorAll<HTMLElement>('[data-overflow-measure]'), element => element.getBoundingClientRect().width);
      const count = fittedSubagentCount(widths, overflowWidths, available, parseFloat(style.columnGap) || 0);
      setVisibleCount(previous => previous === count ? previous : count);
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(measureRow); };
    const observer = new ResizeObserver(schedule);
    observer.observe(row); observer.observe(probe);
    measureRow();
    void document.fonts.ready.then(schedule);
    return () => { disposed = true; observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [measurementKey]);
  const count = Math.min(visibleCount, agents.length);
  const remaining = agents.length - count;
  return <div className="agent-stage-strip" ref={root}>
    {agents.slice(0, count).map((agent, index) => <button type="button" className="agent-stage-chip" key={agent.id} data-selected={agent.id === selectedId || undefined} disabled={agent.id.startsWith('planned:')} onClick={() => onOpen(agent.id)}><AgentStatus phase={subagentPhase(agent)} live={subagentObservedLive(agent, observedLive)} />{labels[index]}</button>)}
    {remaining > 0 && <button type="button" className="agent-stage-chip agent-stage-overflow" title={labels.slice(count).join('\n')} aria-label={t('omp.subagent.expandRemaining', { count: remaining })} onClick={onExpand}>+{remaining}</button>}
    <div className="agent-stage-strip-measure" ref={measure} aria-hidden="true">{agents.map((agent, index) => <span className="agent-stage-chip" data-chip-measure key={agent.id}><AgentStatus phase={subagentPhase(agent)} />{labels[index]}</span>)}{agents.map((agent, index) => <span className="agent-stage-chip agent-stage-overflow" data-overflow-measure key={`more:${agent.id}`}>+{index + 1}</span>)}</div>
  </div>;
}

export interface SubagentStageProps {
  toolCallId?: string; agents: NativeSubagent[]; resolvedTrees?: SubagentNode[]; planned?: PlannedSubagent[]; toolStatus?: string; toolError?: string; title?: string; activeSubagentId?: string | null; hoveredId?: string | null; onHover?: (id: string | null) => void; onOpen: (id: string) => void; onBeforeToggle?: (element: HTMLElement) => void; rawDetails?: ReactNode; visible?: boolean; observedLive?: boolean;
  activityContent?: ReactNode; activityCount?: number; activityAttention?: boolean; deliveries?: Map<string, AgentDelivery[]>;
}
export function SubagentStage({ toolCallId, agents, resolvedTrees, planned = [], toolStatus, toolError, title, activeSubagentId, hoveredId, onHover, onOpen, onBeforeToggle, rawDetails, activityContent, activityAttention = false, visible: surfaceVisible = true, observedLive = false, deliveries }: SubagentStageProps) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  const bodyId = useId();
  const anchor = useContext(DisclosureAnchor);
  const raw = useAutomaticDisclosure(false, `task-raw:${toolCallId ?? bodyId}`);
  const card = useRef<HTMLElement>(null);
  const inView = useInView(card);
  const visible = surfaceVisible && inView;
  const header = useRef<HTMLButtonElement>(null);
  const [protectedByInteraction, setProtectedByInteraction] = useState(false);
  const parentFailed = toolStatus === 'error' || toolStatus === 'failed' || toolStatus === 'denied' || toolStatus === 'timed_out';
  const nodes = useMemo(() => {
    const resolvedById = resolvedTrees && new Map(resolvedTrees.map(node => [node.agent.id, node]));
    const roots: StageNode[] = resolvedById ? agents.flatMap(agent => { const node = resolvedById.get(agent.id); return node ? [node] : subagentTree([agent]); }) : subagentTree(agents);
    const used = new Set<StageNode>();
    const slots: StageNode[] = planned.map(plan => {
      const child = roots.find(node => !used.has(node) && (subagentIndex(node.agent) === plan.index || !!plan.name && [node.agent.id, node.agent.nativeId, subagentTitle(node.agent)].includes(plan.name)));
      if (child) { used.add(child); return child; }
      return { plannedIndex: plan.index, agent: { id: `planned:${toolCallId ?? bodyId}:${plan.index}`, name: plan.name, agent: plan.agent, task: plan.task, ...plannedSlotStatus(toolStatus, observedLive) }, children: [] };
    });
    return reconcileRosterDeliveries([...slots, ...roots.filter(node => !used.has(node))], deliveries);
  }, [agents, resolvedTrees, planned, toolStatus, observedLive, toolCallId, bodyId, deliveries]);
  const all = useMemo(() => flattenSubagentTree(nodes), [nodes]);
  const summary = useMemo(() => subagentSummary(all), [all]);
  const hasActiveWork = (node: StageNode): boolean => (node.plannedIndex === undefined && subagentActive(node.agent, observedLive)) || node.children.some(hasActiveWork);
  const active = nodes.some(hasActiveWork) || (observedLive && !all.length && toolStatus === 'running');
  const observation = useMemo(() => stageObservation(nodes, observedLive), [nodes, observedLive]);
  const attention = summary.attention > 0 || parentFailed || activityAttention;
  const selected = !!activeSubagentId && all.some(agent => agent.id === activeSubagentId);
  const [fold, setFold] = useState(() => nextStageFoldState(recallStageFoldState(toolCallId), { type: 'mount', active, defaultExpanded: active || attention || selected || all.length <= 4 }));
  const foldRef = useRef(fold);
  const previousActive = useRef(active);
  const dispatchFold = useCallback((event: StageFoldEvent) => {
    const previous = foldRef.current;
    const next = nextStageFoldState(previous, event);
    foldRef.current = next;
    rememberStageFoldState(toolCallId, next);
    if (next !== previous) setFold(next);
  }, [toolCallId]);
  const disclosure = useAutomaticDisclosure(fold.expanded, `task-stage:${toolCallId ?? bodyId}`);
  const expanded = disclosure.open;
  const aggregateDuration = all.reduce<number | undefined>((value, agent) => { const duration = subagentMetrics(agent).durationMs; return duration === undefined ? value : Math.max(value ?? 0, duration); }, undefined);
  const elapsed = useLiveDuration(aggregateDuration, active, visible);
  useLayoutEffect(() => {
    rememberStageFoldState(toolCallId, foldRef.current);
    if (previousActive.current !== active) { previousActive.current = active; dispatchFold(active ? { type: 'active' } : { type: 'settle', canFold: !attention && all.length > 4 }); }
    if (attention || selected) dispatchFold({ type: 'attention' });
    else if (protectedByInteraction || !visible) dispatchFold({ type: 'interact' });
    else if (!active && all.length > 4) dispatchFold({ type: 'idle', now: Date.now(), protected: false });
  }, [active, attention, selected, all.length, protectedByInteraction, visible, dispatchFold, toolCallId]);
  useEffect(() => {
    if (!visible || active || attention || selected || protectedByInteraction || fold.foldDueAt === undefined || fold.manual) return;
    const timer = window.setTimeout(() => {
      if (isMotionPaused() || card.current?.matches(':hover') || card.current?.contains(document.activeElement)) { dispatchFold({ type: 'interact' }); return; }
      if (header.current) { anchor(header.current); onBeforeToggle?.(header.current); }
      dispatchFold({ type: 'deadline', now: Date.now(), protected: false });
    }, Math.max(0, fold.foldDueAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [visible, active, attention, selected, protectedByInteraction, fold.foldDueAt, fold.manual, dispatchFold, onBeforeToggle]);
  const totalLabel = t('omp.roster.delegated', { count: summary.total });
  const phases = (Object.keys(summary.counts) as SubagentPhase[]).filter(phase => summary.counts[phase]);
  return <section ref={card} className={`agent-stage${attention ? ' has-attention' : ''}`} data-phase={parentFailed && summary.phase !== 'running' ? 'failed' : summary.phase} aria-label={title || totalLabel} onPointerEnter={() => setProtectedByInteraction(true)} onPointerLeave={() => setProtectedByInteraction(!!card.current?.contains(document.activeElement))} onFocusCapture={() => setProtectedByInteraction(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setProtectedByInteraction(!!card.current?.matches(':hover')); }}>
    <div className="agent-stage-top"><button ref={element => { header.current = element; disclosure.titleRef.current = element; }} type="button" className="agent-stage-header" title={observation.saved ? t('omp.subagent.lastObservedHint') : undefined} aria-expanded={expanded} aria-controls={bodyId} onClick={event => { anchor(event.currentTarget); onBeforeToggle?.(event.currentTarget); dispatchFold({ type: 'manual', expanded: !expanded }); disclosure.toggle(); }}>
      <IconUsers size="var(--icon-ui)" /><span className="agent-stage-header-copy"><strong>{toolCallId ? totalLabel : title || totalLabel}</strong><span className="agent-stage-summary">{phases.map(phase => <span key={phase} data-phase={phase}>{summary.counts[phase]} {t(`omp.subagent.stage.phase.${phase}`)}</span>)}</span></span>
      {all.some(agent => evidenceOf(agent).observation === 'inferred') && <span className="subagent-inferred-tag" title={t('omp.subagent.inferredHint')}>{t('omp.subagent.inferred')}</span>}
      {elapsed !== undefined && elapsed >= 1000 && <span className="agent-stage-elapsed"><AnimatedNumber animate={observedLive} value={elapsed} format={n => formatElapsed(n, durationStyle, i18n.language)} /></span>}<IconChevronRight size="var(--icon-meta)" className="agent-stage-caret" />
    </button>{rawDetails && <button type="button" className="agent-stage-raw-button" ref={raw.titleRef} aria-label={t('omp.roster.raw')} title={t('omp.roster.raw')} aria-expanded={raw.open} aria-controls={`${bodyId}-raw`} onClick={raw.toggle}><IconBraces size="var(--icon-meta)" /></button>}</div>
    {(active || summary.counts.running > 0 || summary.counts.pending > 0) && <div className="agent-stage-progress" role="progressbar" aria-label={totalLabel} aria-valuemin={0} aria-valuemax={summary.total || 1} aria-valuenow={summary.counts.completed}><span style={{ transform: `scaleX(${summary.total ? summary.counts.completed / summary.total : 0})` }} /></div>}
    <Collapse open={!expanded}><CollapsedAgentStrip agents={all} selectedId={activeSubagentId} observedLive={observedLive} onOpen={onOpen} onExpand={() => header.current?.click()} /></Collapse>
    <DisclosureScope disclosure={disclosure}><Collapse id={bodyId} open={expanded} bodyRef={disclosure.bodyRef} {...disclosure.bodyEvents}>
      <TaskCards toolCallId={toolCallId} nodes={nodes} expanded={expanded} visible={visible} observedLive={observedLive} activeSubagentId={activeSubagentId} hoveredId={hoveredId} onHover={onHover} onOpen={onOpen} onBeforeToggle={onBeforeToggle} deliveries={deliveries} />
      {parentFailed && <p className="agent-stage-failure" role="status">{toolError || t(agents.length ? 'omp.subagent.stage.phase.failed' : 'omp.subagent.stage.spawnFailed')}</p>}
      {!nodes.length && active && <p className="agent-stage-empty">{t('omp.subagent.stage.preparing')}</p>}
      {activityContent}
    </Collapse></DisclosureScope>
    {rawDetails && <DisclosureScope disclosure={raw}><Collapse id={`${bodyId}-raw`} open={raw.open} bodyRef={raw.bodyRef} {...raw.bodyEvents}><div className="agent-stage-raw">{rawDetails}</div></Collapse></DisclosureScope>}
  </section>;
}

export interface TaskOverviewProps {
  agents: NativeSubagent[]; selectedAgentId?: string | null; onOpenAgent: (agent: NativeSubagent) => void; onHoverAgent?: (id: string | null) => void; onBeforeLayoutChange?: () => void; onAfterLayoutChange?: () => void; visible?: boolean; observedLive?: boolean;
}
/** The same native hierarchy as an inline stage, without a second visual root. */
export function TaskOverview({ agents, selectedAgentId, onOpenAgent, onHoverAgent, onBeforeLayoutChange, onAfterLayoutChange, visible = true, observedLive = false }: TaskOverviewProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<'all' | 'running' | 'attention' | 'completed'>('all');
  const trees = useMemo(() => subagentTree(agents), [agents]);
  const byId = useMemo(() => new Map(flattenSubagentTree(trees).map(agent => [agent.id, agent])), [trees]);
  const matches = (agent: NativeSubagent) => {
    const outcome = subagentOutcome(agent);
    return filter === 'all' || (filter === 'running' ? subagentActive(agent, observedLive) : filter === 'attention' ? outcome.issueCount > 0 || outcome.phase === 'failed' || outcome.phase === 'aborted' : outcome.phase === 'completed');
  };
  const filterTree = (nodes: SubagentNode[]): SubagentNode[] => nodes.flatMap(node => {
    const children = filterTree(node.children);
    return matches(node.agent) || children.length ? [{ ...node, children }] : [];
  });
  const groups = new Map<string, SubagentNode[]>();
  for (const node of trees) { const key = node.agent.parentToolCallId ?? ''; const group = groups.get(key) ?? []; group.push(node); groups.set(key, group); }
  useLayoutEffect(() => { onAfterLayoutChange?.(); }, [trees, filter, onAfterLayoutChange]);
  const shown = [...groups].map(([key, nodes], index) => ({ key, index, nodes: filterTree(nodes) })).filter(group => group.nodes.length);
  return <div className="task-overview"><div className="task-overview-filters" aria-label={t('omp.panel.tasks')}>{(['all', 'running', 'attention', 'completed'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { onBeforeLayoutChange?.(); setFilter(value); }}>{t(`shell.tasks.${value}`)}</button>)}</div>
    {shown.length ? shown.map(group => <section className="task-overview-group" key={group.key}><h3>{t(group.key ? 'shell.tasks.delegation' : 'shell.tasks.other', { number: group.index + 1 })}<span>{flattenSubagentTree(group.nodes).length}</span></h3>
      <TaskCards nodes={group.nodes} expanded visible={visible} observedLive={observedLive} activeSubagentId={selectedAgentId} onHover={onHoverAgent} onOpen={id => { const agent = byId.get(id); if (agent) onOpenAgent(agent); }} />
      {flattenSubagentTree(group.nodes).map(agent => {
        const output = typeof agent.output === 'object' && agent.output !== null ? agent.output as Record<string, unknown> : undefined;
        const files = agent.changedFiles ?? output?.changedFiles;
        const count = Array.isArray(files) ? new Set(files.filter((path): path is string => typeof path === 'string')).size : typeof agent.changedFileCount === 'number' ? agent.changedFileCount : undefined;
        return count !== undefined && Number.isFinite(count) && count >= 0 ? <button type="button" className="task-overview-files" key={agent.id} onClick={() => onOpenAgent(agent)}>{subagentTitle(agent)} · {t('shell.tasks.files', { count })}</button> : null;
      })}
    </section>) : <div className="work-tab-empty"><IconUsers size="var(--icon-heading)" /><p>{t('shell.tasks.empty')}</p></div>}
  </div>;
}

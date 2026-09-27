import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeSubagent } from '../../shared/contracts';
import { IconChevronRight } from '../ui/icons';
import { plannedSubagentPhase, subagentIndex, subagentMetrics, subagentPhase, subagentTree, type PlannedSubagent, type SubagentNode, type SubagentPhase } from './subagent-model';
import { LiquidStage, type StageNode } from './LiquidStage';
import { DropletPill } from '../ui/liquid/DropletPill';
import { LiquidSpring, type LiquidSpringHandle } from '../ui/liquid/LiquidSpring';
import { useInView, useReducedMotion } from '../lib/agent-motion/ticker';
import { nextStageFoldState, recallStageFoldState, rememberStageFoldState, type StageFoldEvent } from './stage-fold-state';
import '../styles/subagent-stage.css';

export function useLiveDuration(durationMs: number | undefined, running: boolean): number | undefined {
  const [elapsed, setElapsed] = useState(durationMs);
  useEffect(() => {
    if (!running) { if (durationMs !== undefined) setElapsed(durationMs); return; }
    const anchor = Date.now() - (durationMs ?? 0);
    setElapsed(Date.now() - anchor);
    const timer = window.setInterval(() => setElapsed(Date.now() - anchor), 1000);
    return () => window.clearInterval(timer);
  }, [durationMs, running]);
  return running ? elapsed ?? durationMs : durationMs ?? elapsed;
}
const elapsedLabel = (duration: number): string => `${Math.floor(duration / 60000).toString().padStart(2, '0')}:${Math.floor(duration / 1000 % 60).toString().padStart(2, '0')}`;

export function SubagentStage({ toolCallId, agents, resolvedTrees, planned = [], toolStatus, toolError, title, activeSubagentId, hoveredId, onHover, modelName, onOpen, onBeforeToggle, rawDetails }: {
  toolCallId?: string; agents: NativeSubagent[]; resolvedTrees?: SubagentNode[]; planned?: PlannedSubagent[]; toolStatus?: string; toolError?: string; title?: string; activeSubagentId?: string | null; hoveredId?: string | null; onHover?: (id: string | null) => void; modelName?: string; onOpen: (id: string) => void; onBeforeToggle?: (element: HTMLElement) => void; rawDetails?: ReactNode;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const card = useRef<HTMLElement>(null);
  const spring = useRef<LiquidSpringHandle>(null);
  const visible = useInView(card);
  const [documentHidden, setDocumentHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setDocumentHidden(document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const header = useRef<HTMLButtonElement>(null);
  const anchorNotify = useRef(onBeforeToggle);
  anchorNotify.current = onBeforeToggle;
  const [pointerOver, setPointerOver] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [returnsPending, setReturnsPending] = useState(false);
  const unspawnedPhase = plannedSubagentPhase(toolStatus);
  const parentFailed = unspawnedPhase === 'failed';
  const nodes = useMemo(() => {
    const resolvedById = resolvedTrees && new Map(resolvedTrees.map(node => [node.agent.id, node]));
    const roots: StageNode[] = resolvedById ? agents.flatMap(agent => { const node = resolvedById.get(agent.id); return node ? [node] : []; }) : subagentTree(agents);
    const used = new Set<StageNode>();
    const slots: StageNode[] = planned.map(plan => {
      const child = roots.find(node => !used.has(node) && subagentIndex(node.agent) === plan.index);
      if (child) { used.add(child); return child; }
      return { plannedIndex: plan.index, agent: { id: `planned:${plan.index}`, agent: plan.agent, task: plan.task, description: plan.name, status: unspawnedPhase }, children: [] };
    });
    return [...slots, ...roots.filter(node => !used.has(node))];
  }, [agents, resolvedTrees, planned, unspawnedPhase]);
  const all: NativeSubagent[] = [];
  const collect = (items: SubagentNode[]) => { for (const node of items) { all.push(node.agent); collect(node.children); } };
  collect(nodes);
  const counts = new Map<SubagentPhase, number>();
  for (const node of nodes) { const phase = subagentPhase(node.agent); counts.set(phase, (counts.get(phase) ?? 0) + 1); }
  const active = all.some(agent => ['running', 'pending'].includes(subagentPhase(agent))) || (!all.length && (toolStatus === 'pending' || toolStatus === 'running'));
  const failed = parentFailed || all.some(agent => subagentPhase(agent) === 'failed');
  const [fold, setFold] = useState(() => nextStageFoldState(recallStageFoldState(toolCallId), { type: 'mount', active, defaultExpanded: active || failed || all.length <= 3 }));
  const foldRef = useRef(fold);
  const previousActive = useRef(active);
  const dispatchFold = useCallback((event: StageFoldEvent) => {
    const previous = foldRef.current;
    const next = nextStageFoldState(previous, event);
    foldRef.current = next;
    rememberStageFoldState(toolCallId, next);
    if (next !== previous) setFold(next);
  }, [toolCallId]);
  const expanded = fold.expanded;
  const reduced = useReducedMotion();
  const [bodyOpen, setBodyOpen] = useState(expanded);
  const unfold = expanded;
  useLayoutEffect(() => {
    // A pointer already over a remounted card does not produce a fresh enter event.
    if (card.current?.matches(':hover')) setPointerOver(true);
    if (card.current?.contains(document.activeElement)) setFocusWithin(true);
    rememberStageFoldState(toolCallId, foldRef.current);
  }, [toolCallId]);
  useLayoutEffect(() => {
    if (previousActive.current !== active) {
      previousActive.current = active;
      dispatchFold(active ? { type: 'active' } : { type: 'settle', canFold: all.length > 3 });
    }
    const protectedNow = pointerOver || focusWithin || !!card.current?.matches(':hover') || !!card.current?.contains(document.activeElement);
    if (protectedNow) dispatchFold({ type: 'hover-in' });
    else if (returnsPending) dispatchFold({ type: 'returns-pending' });
    else if (!active && all.length > 3) dispatchFold({ type: 'absorb-done', now: Date.now(), protected: false, returnsPending: false });
  }, [active, all.length, pointerOver, focusWithin, returnsPending, dispatchFold]);
  useEffect(() => {
    if (active || returnsPending || pointerOver || focusWithin || fold.foldDueAt === undefined || fold.manual) return;
    const timer = window.setTimeout(() => {
      const protectedNow = !!card.current?.matches(':hover') || !!card.current?.contains(document.activeElement);
      if (protectedNow) { dispatchFold({ type: 'hover-in' }); return; }
      if (header.current) anchorNotify.current?.(header.current);
      dispatchFold({ type: 'deadline', now: Date.now(), protected: false, returnsPending: false });
    }, Math.max(0, fold.foldDueAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [active, returnsPending, pointerOver, focusWithin, fold.foldDueAt, fold.manual, dispatchFold]);
  useEffect(() => {
    if (unfold || reduced) { setBodyOpen(unfold); return; }
    const timer = window.setTimeout(() => setBodyOpen(false), 520 + Math.min(all.length, 8) * 40);
    return () => window.clearTimeout(timer);
  }, [unfold, reduced, all.length]);
  const measuredDurations = all.map(agent => subagentMetrics(agent).durationMs).filter((value): value is number => value !== undefined);
  const duration = useLiveDuration(measuredDurations.length ? Math.max(...measuredDurations) : undefined, active);
  const summary = [...counts].map(([phase, count]) => t(`omp.subagent.stage.summary.${phase}`, { count })).join(' · ');
  const nestedCount = all.length - nodes.length;
  return <section ref={card} className={`agent-stage${active ? ' is-active' : ''}${failed ? ' has-failure' : ''}${!visible || documentHidden ? ' is-offscreen' : ''}`} aria-label={title || t('omp.subagent.stage.title', { count: nodes.length })} onPointerEnter={() => { dispatchFold({ type: 'hover-in' }); setPointerOver(true); }} onPointerLeave={() => setPointerOver(false)} onFocusCapture={() => { dispatchFold({ type: 'hover-in' }); setFocusWithin(true); }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false); }}>
    <button ref={header} type="button" className="agent-stage-header" aria-expanded={expanded} aria-controls={bodyId} onClick={event => { onBeforeToggle?.(event.currentTarget); dispatchFold({ type: 'manual', expanded: !expanded }); }}>
      <span className="agent-stage-spring" title={modelName ? `${t('omp.subagent.stage.main')} · ${modelName}` : t('omp.subagent.stage.main')}><LiquidSpring ref={spring} size={16} active={all.some(agent => subagentPhase(agent) === 'running')} /></span>
      <span className="agent-stage-header-copy"><strong>{title || t('omp.subagent.stage.title', { count: nodes.length })}</strong><span className="agent-stage-summary">{summary || t(`omp.subagent.stage.phase.${unspawnedPhase}`)}{nestedCount > 0 && ` · ${t('omp.subagent.stage.nested', { count: nestedCount })}`}</span></span>
      {!expanded && <DropletPill agents={all} planned={planned.length} />}
      {duration !== undefined && <span className="agent-stage-elapsed">{elapsedLabel(duration)}</span>}
      <IconChevronRight size={14} className="agent-stage-caret" aria-hidden />
    </button>
    <div id={bodyId} className={`agent-stage-reveal${expanded || bodyOpen ? ' is-open' : ''}`} inert={!expanded}><div>
      <LiquidStage toolCallId={toolCallId} nodes={nodes} expanded={unfold} activeSubagentId={activeSubagentId} hoveredId={hoveredId} onHover={onHover} onOpen={onOpen} onBeforeToggle={onBeforeToggle} onComplete={() => spring.current?.pulse()} onReturnsPending={setReturnsPending} />
      {parentFailed && <p className="agent-stage-failure" role="status">{toolError?.trim().split(/\r?\n/, 1)[0] || t(agents.length ? 'omp.subagent.stage.phase.failed' : 'omp.subagent.stage.spawnFailed')}</p>}
      {!nodes.length && active && <p className="agent-stage-empty">{t('omp.subagent.stage.preparing')}</p>}
    </div></div>
    {rawDetails && <details className="agent-stage-raw native-disclosure"><summary>{t('omp.subagent.stage.rawCall')}<IconChevronRight size={12} className="native-disclosure-caret" aria-hidden /></summary>{rawDetails}</details>}
  </section>;
}

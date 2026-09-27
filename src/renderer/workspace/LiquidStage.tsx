import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeSubagent } from '../../shared/contracts';
import { LavaCrack, CrackKnot } from '../ui/liquid/LavaCrack';
import { liuliInclusions } from '../ui/liquid/liuli-seed';
import { GlassBead } from '../ui/liquid/GlassBead';
import { LiquidPool } from '../ui/liquid/LiquidPool';
import { launchCapsuleMorph } from '../ui/liquid/capsule-morph';
import { IconChevronRight } from '../ui/icons';
import { diffAgentSnapshot } from '../lib/agent-motion/agent-events';
import { useReducedMotion } from '../lib/agent-motion/ticker';
import { subagentActivity, subagentError, subagentMetrics, subagentPhase, subagentTitle, type SubagentNode } from './subagent-model';
import { useLiveDuration } from './SubagentStage';
import { liquidCapsuleMetrics, liquidFloorHeight, liquidStageLayout, type LiquidLayoutNode, type LiquidPlacement } from './liquid-stage-layout';

export type StageNode = SubagentNode & { plannedIndex?: number };
interface DisplayNode extends LiquidLayoutNode { agent: NativeSubagent; planned?: boolean; bundle?: { count: number; expanded: boolean }; children: DisplayNode[] }
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const elapsedLabel = (duration: number) => `${Math.floor(duration / 60000).toString().padStart(2, '0')}:${Math.floor(duration / 1000 % 60).toString().padStart(2, '0')}`;
const completedTree = (node: SubagentNode): boolean => subagentPhase(node.agent) === 'completed' && node.children.every(completedTree);

export function LiquidStage({ toolCallId, nodes, expanded, activeSubagentId, hoveredId, onHover, onOpen, onBeforeToggle, onComplete, onReturnsPending }: { toolCallId?: string; nodes: StageNode[]; expanded: boolean; activeSubagentId?: string | null; hoveredId?: string | null; onHover?: (id: string | null) => void; onOpen: (id: string) => void; onBeforeToggle?: (element: HTMLElement) => void; onComplete?: () => void; onReturnsPending?: (pending: boolean) => void }) {
  const { t } = useTranslation();
  const generatedSeed = useId();
  const toolSeed = toolCallId ?? generatedSeed;
  const host = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(640);
  const [bundles, setBundles] = useState<ReadonlySet<string>>(new Set());
  const [localHover, setLocalHover] = useState<string | null>(null);
  const highlighted = hoveredId ?? localHover;
  const snapshots = useRef(new Map<string, NativeSubagent>());
  const completionTimers = useRef(new Map<string, number>());
  const [signals, setSignals] = useState<ReadonlyMap<string, number>>(new Map());
  const [completionRevision, refreshCompletions] = useState(0);
  const callbacks = useRef({ onComplete, onReturnsPending });
  callbacks.current = { onComplete, onReturnsPending };
  const all = useMemo(() => {
    const result: NativeSubagent[] = [];
    const collect = (items: SubagentNode[]) => { for (const node of items) { result.push(node.agent); collect(node.children); } };
    collect(nodes);
    return result;
  }, [nodes]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const ids = new Set(all.map(agent => agent.id));
    let nextSignals: Map<string, number> | undefined;
    let completed = false;
    for (const agent of all) {
      for (const event of diffAgentSnapshot(snapshots.current.get(agent.id), agent)) {
        if (event.type === 'tool') {
          nextSignals ??= new Map(signals);
          nextSignals.set(agent.id, (nextSignals.get(agent.id) ?? 0) + 1);
        }
        if (event.type === 'complete') {
          completed = true;
          callbacks.current.onComplete?.();
          const old = completionTimers.current.get(agent.id);
          if (old !== undefined) window.clearTimeout(old);
          if (!reduced && expanded) completionTimers.current.set(agent.id, window.setTimeout(() => {
            completionTimers.current.delete(agent.id);
            callbacks.current.onReturnsPending?.(completionTimers.current.size > 0);
            refreshCompletions(value => value + 1);
          }, 650));
        }
      }
      snapshots.current.set(agent.id, { ...agent, progress: agent.progress ? { ...agent.progress } : undefined });
    }
    for (const id of snapshots.current.keys()) if (!ids.has(id)) {
      snapshots.current.delete(id);
      const timer = completionTimers.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      completionTimers.current.delete(id);
      if (signals.has(id)) { nextSignals ??= new Map(signals); nextSignals.delete(id); }
    }
    if (nextSignals) setSignals(nextSignals);
    if (completed) refreshCompletions(value => value + 1);
    callbacks.current.onReturnsPending?.(completionTimers.current.size > 0);
  }, [all, expanded, reduced, signals]);
  useEffect(() => () => {
    for (const timer of completionTimers.current.values()) window.clearTimeout(timer);
    completionTimers.current.clear();
    callbacks.current.onReturnsPending?.(false);
  }, []);
  const display = useMemo(() => {
    const collectDisplay = (siblings: StageNode[], parent: string): DisplayNode[] => {
      const ready = (node: SubagentNode): boolean => completedTree(node) && !completionTimers.current.has(node.agent.id) && (!snapshots.current.has(node.agent.id) || subagentPhase(snapshots.current.get(node.agent.id)!) === 'completed') && node.children.every(ready);
      const completed = siblings.filter(ready);
      const hidden = new Set(completed.length > 6 ? completed.slice(3) : []);
      const bundleId = `bundle:${parent}`;
      const result: DisplayNode[] = [];
      let added = false;
      for (const node of siblings) {
        if (hidden.has(node) && !added) {
          added = true;
          result.push({ id: bundleId, agent: { id: bundleId, status: 'completed' }, phase: 'completed', kind: 'bundle', bundle: { count: hidden.size, expanded: bundles.has(bundleId) }, children: [] });
        }
        if (hidden.has(node) && !bundles.has(bundleId)) continue;
        result.push({ id: node.agent.id, agent: node.agent, planned: node.plannedIndex !== undefined, kind: node.plannedIndex !== undefined ? 'ghost' : 'agent', phase: subagentPhase(node.agent), children: collectDisplay(node.children, node.agent.id) });
      }
      return result;
    };
    return collectDisplay(nodes, 'root');
  }, [nodes, bundles, completionRevision]);
  const lookup = new Map<string, DisplayNode>();
  const signalTotals = new Map<string, number>();
  const index = (items: DisplayNode[]): number => {
    let total = 0;
    for (const node of items) {
      lookup.set(node.id, node);
      const subtotal = (signals.get(node.id) ?? 0) + index(node.children);
      signalTotals.set(node.id, subtotal);
      total += subtotal;
    }
    return total;
  };
  const totalSignals = index(display);
  const layout = useMemo(() => liquidStageLayout(display, width, toolSeed), [display, width, toolSeed]);
  const hover = (id: string | null) => { setLocalHover(id); onHover?.(id); };
  const emphasis = (id: string) => activeSubagentId === id ? 'selected' : highlighted === id ? 'hover' : highlighted ? 'dim' : 'normal';
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.agent-slab:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return <div ref={host} className={`liquid-stage${expanded ? '' : ' is-offscreen'}`} style={{ height: layout.height }} onKeyDown={navigate}>
    <svg className="liquid-stage-field" width={layout.width} height={layout.height} aria-hidden>
      {layout.trunks.map(trunk => <LavaCrack key={trunk.parentId === undefined ? 'trunk:root' : `trunk:agent:${trunk.parentId}`} d={trunk.d} spurs={trunk.spurs} phase={trunk.phase} width={trunk.depth ? trunk.phase === 'running' ? 1.5 : 1.2 : trunk.phase === 'running' ? 2.2 : 1.8} grow={trunk.phase === 'running' || trunk.phase === 'pending'} glintKey={trunk.parentId === undefined ? totalSignals : (signalTotals.get(trunk.parentId) ?? 0) - (signals.get(trunk.parentId) ?? 0)} />)}
      {layout.nodes.map(place => {
        const phase = subagentPhase(lookup.get(place.id)!.agent);
        const width = place.depth ? phase === 'running' ? 1.5 : 1.2 : phase === 'running' ? 1.8 : 1.5;
        return <g key={place.id}>
          <LavaCrack d={place.branch.d} phase={phase} width={width} emphasis={emphasis(place.id)} grow={phase === 'running' || phase === 'pending'} glintKey={signals.get(place.id) ?? 0} />
          <CrackKnot x={place.branch.from.x} y={place.branch.from.y} phase={phase} width={width} />
        </g>;
      })}
    </svg>
    {layout.nodes.map(place => <Capsule key={place.id} node={lookup.get(place.id)!} place={place} rippleKey={signals.get(place.id) ?? 0} emphasis={emphasis(place.id)} selected={activeSubagentId === place.id} onHover={hover} onOpen={onOpen} onBundle={element => {
      onBeforeToggle?.(element);
      setBundles(old => { const next = new Set(old); if (next.has(place.id)) next.delete(place.id); else next.add(place.id); return next; });
    }} />)}
    {!layout.nodes.length && <span className="sr-only">{t('omp.subagent.stage.preparing')}</span>}
  </div>;
}

function Capsule({ node, place, rippleKey, emphasis, selected, onHover, onOpen, onBundle }: { node: DisplayNode; place: LiquidPlacement; rippleKey: number; emphasis: string; selected: boolean; onHover: (id: string | null) => void; onOpen: (id: string) => void; onBundle: (element: HTMLElement) => void }) {
  const { t } = useTranslation();
  const { agent } = node;
  const phase = subagentPhase(agent);
  const slab = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion();
  const previousPulse = useRef(rippleKey);
  const initialLive = useRef(phase === 'pending' || phase === 'running');
  const [pulse, setPulse] = useState(false);
  const inclusions = useMemo(() => liuliInclusions(agent.id), [agent.id]);
  useLayoutEffect(() => {
    const animate = initialLive.current;
    initialLive.current = false;
    if (!animate || reduced || !slab.current) return;
    const motion = slab.current.animate([{ opacity: 0, transform: 'translateX(-10px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.9,.25,1.12)' });
    return () => motion.cancel();
  }, [reduced]);
  useLayoutEffect(() => {
    const changed = rippleKey !== previousPulse.current;
    previousPulse.current = rippleKey;
    if (!changed || reduced || document.hidden || slab.current?.closest('.is-offscreen')) { setPulse(false); return; }
    setPulse(true);
    const timer = window.setTimeout(() => setPulse(false), 400);
    return () => window.clearTimeout(timer);
  }, [rippleKey, reduced]);
  const metrics = subagentMetrics(agent);
  const elapsed = useLiveDuration(metrics.durationMs, phase === 'running');
  const title = node.bundle ? t('omp.subagent.stage.moreCompleted', { count: node.bundle.count }) : subagentTitle(agent) || t('chat.subagentUnnamed');
  const activity = subagentActivity(agent);
  const error = subagentError(agent)?.trim().split(/\r?\n/, 1)[0] || (phase === 'failed' || phase === 'aborted' ? t(`omp.subagent.stage.reason.${phase}`) : undefined);
  const metricText = [metrics.toolCount !== undefined ? t('omp.subagent.stage.tools', { count: metrics.toolCount }) : '', metrics.tokens !== undefined ? t('omp.subagent.stage.tokens', { value: compact.format(metrics.tokens) }) : ''].filter(Boolean).join(' · ');
  const geometry = liquidCapsuleMetrics[node.bundle ? 'bundle' : place.depth ? 'nested' : 'root'];
  const style = {
    left: place.x, top: place.y, width: place.width, height: place.height,
    ...inclusions,
    '--capsule-text-top': `${geometry.paddingTop}px`,
    '--capsule-title-height': `${geometry.titleHeight}px`,
    '--capsule-detail-gap': `${geometry.detailGap}px`,
    '--capsule-floor-gap': `${geometry.floorGap}px`,
  } as CSSProperties;
  return <button ref={slab} type="button" className={`liuli agent-slab${node.bundle ? ' is-bundle' : ''}`} data-agent-id={agent.id} data-phase={phase} data-selected={selected ? 'true' : undefined} data-pulse={pulse ? 'true' : undefined} data-emphasis={emphasis} data-nested={place.depth > 0} disabled={node.planned} aria-label={`${title} · ${t(`omp.subagent.stage.phase.${phase}`)}${metricText ? ` · ${metricText}` : ''}${error ? ` · ${error}` : ''}`} aria-current={selected ? 'true' : undefined} aria-expanded={node.bundle?.expanded} title={`${title} · ${t(`omp.subagent.stage.phase.${phase}`)}${metricText ? ` · ${metricText}` : ''}`} style={style} onPointerEnter={() => onHover(place.id)} onPointerLeave={() => onHover(null)} onFocus={() => onHover(place.id)} onBlur={() => onHover(null)} onClick={event => { if (node.bundle) onBundle(event.currentTarget); else { launchCapsuleMorph(agent.id, event.currentTarget, agent); onOpen(agent.id); } }}>
    <LiquidPool phase={phase} rippleKey={rippleKey} radius={16} height={liquidFloorHeight} />
    <span className="liquid-stage-bead"><GlassBead agent={agent} size={22} ghost={node.planned && phase === 'pending'} /></span>
    <span className="liquid-stage-copy">
      <span className="liquid-stage-heading"><strong title={title}>{title}</strong>{!node.bundle && agent.agent && <span className="agent-stage-role lg-static lg-thin lg-capsule" title={agent.agent}>{agent.agent}</span>}{!node.bundle && elapsed !== undefined && <span className="agent-stage-elapsed">{elapsedLabel(elapsed)}</span>}<IconChevronRight size={12} className="liquid-stage-chevron" aria-hidden /></span>
      {!node.bundle && (phase === 'running' ? <ActivityLine text={activity || t('omp.subagent.stage.phase.running')} /> : <span className="liquid-stage-meta">{phase === 'pending' ? t('omp.subagent.stage.waiting') : metricText || t(`omp.subagent.stage.phase.${phase}`)}</span>)}
      {(phase === 'failed' || phase === 'aborted') && <span key={error} className="agent-stage-error" title={error}>{error}</span>}
    </span>
  </button>;
}

export function ActivityLine({ text, className }: { text: string; className?: string }) {
  const reduced = useReducedMotion();
  const [transition, setTransition] = useState({ current: text, outgoing: null as string | null, revision: 0 });
  useLayoutEffect(() => {
    setTransition(previous => {
      if (previous.current === text) return reduced && previous.outgoing ? { ...previous, outgoing: null } : previous;
      return { current: text, outgoing: reduced ? null : previous.current, revision: previous.revision + 1 };
    });
  }, [text, reduced]);
  return <span className={`agent-stage-activity${className ? ` ${className}` : ''}`} title={text}>
    <span key={transition.revision} className={`liquid-stage-activity-current${transition.revision && !reduced ? ' is-entering' : ''}`}>{transition.current}</span>
    {transition.outgoing && !reduced && <span key={`out:${transition.revision}`} className="liquid-stage-activity-outgoing" aria-hidden onAnimationEnd={() => setTransition(previous => ({ ...previous, outgoing: null }))}>{transition.outgoing}</span>}
  </span>;
}

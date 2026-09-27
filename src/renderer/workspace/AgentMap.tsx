import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeSubagent } from '../../shared/contracts';
import { LiquidSpring } from '../ui/liquid/LiquidSpring';
import { GlassBead } from '../ui/liquid/GlassBead';
import { LavaCrack, CrackKnot } from '../ui/liquid/LavaCrack';
import { crackPath, crackPoints, crackSpurs } from '../ui/liquid/crack-geometry';
import { launchCapsuleMorph } from '../ui/liquid/capsule-morph';
import { pointAt, tendrilBetween, type Tendril } from '../lib/agent-motion/bezier';
import { createSpring, isSpringSettled, springs, type Spring } from '../lib/agent-motion/spring';
import { subscribeTicker, useInView, useReducedMotion } from '../lib/agent-motion/ticker';
import { layoutAgentMap, type MapPoint } from './agent-map-layout';
import { subagentPhase, subagentTitle } from './subagent-model';

export interface AgentMapBatch { id: string; agents: NativeSubagent[]; label: string }
type MapMotion = { x: Spring; y: Spring };
function radialTrunk(from: MapPoint, to: MapPoint): Tendril {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1;
  return { p0: { x: from.x + dx / length * 22, y: from.y + dy / length * 22 }, c1: { x: from.x + dx * .4, y: from.y + dy * .4 }, c2: { x: from.x + dx * .7, y: from.y + dy * .7 }, p1: to };
}

function sampleMapCrack(curve: Tendril, seed: string, trunk = false) {
  const points = crackPoints([0, .25, .5, .75, 1].map(t => pointAt(curve, t)), seed, { amplitude: trunk ? 1.8 : 1.2 });
  return { d: crackPath(points), spurs: trunk ? crackSpurs(points, seed) : [] };
}

export function AgentMap({ batches, sessionTitle, hoveredId, onHover, activeSubagentId, onOpen }: { batches: AgentMapBatch[]; sessionTitle?: string; hoveredId: string | null; onHover: (id: string | null) => void; activeSubagentId: string | null; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  const reduced = useReducedMotion();
  const visible = useInView(container);
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const labels = useRef(new Map<string, HTMLSpanElement>());
  const paths = useRef(new Map<string, SVGGElement>());
  const trunks = useRef(new Map<string, SVGGElement>());
  const knots = useRef(new Map<string, SVGGElement>());
  const pills = useRef(new Map<string, HTMLSpanElement>());
  const motion = useRef(new Map<string, MapMotion>());
  const knotMotion = useRef(new Map<string, MapMotion>());
  const layout = useMemo(() => layoutAgentMap(batches.map((batch, index) => ({ id: batch.id, leafIds: batch.agents.map(agent => agent.id), label: t('omp.panel.batch', { number: index + 1, count: batch.agents.length }) })), width), [batches, width, t]);
  const agents = useMemo(() => new Map(batches.flatMap(batch => batch.agents.map(agent => [agent.id, agent] as const))), [batches]);
  const running = [...agents.values()].some(agent => subagentPhase(agent) === 'running');
  const scale = Math.min(width / layout.viewBox.width, layout.height / layout.viewBox.height);
  const offsetX = (width - layout.viewBox.width * scale) / 2 - layout.viewBox.x * scale;
  const offsetY = (layout.height - layout.viewBox.height * scale) / 2 - layout.viewBox.y * scale;
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => { const next = entries[0]?.contentRect.width; if (next) setWidth(next); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const place = (states: Map<string, MapMotion>, id: string, point: MapPoint) => {
      let state = states.get(id);
      if (!state) { state = { x: createSpring(springs.gentle, point.x), y: createSpring(springs.gentle, point.y) }; states.set(id, state); }
      state.x.setTarget(point.x); state.y.setTarget(point.y);
      if (reduced || !visible) { state.x.jump(point.x); state.y.jump(point.y); }
    };
    for (const branch of layout.branches) {
      place(knotMotion.current, branch.id, branch.knot);
      for (const leaf of branch.leaves) place(motion.current, leaf.id, leaf);
    }
    for (const id of motion.current.keys()) if (!agents.has(id)) motion.current.delete(id);
    for (const id of knotMotion.current.keys()) if (!layout.branches.some(branch => branch.id === id)) knotMotion.current.delete(id);
    // Cache all crack layers once; only geometry springs require JS frames.
    const trunkPaths = new Map(layout.branches.map(branch => [branch.id, { main: trunks.current.get(branch.id)?.querySelectorAll('[data-crack-main]'), spurs: trunks.current.get(branch.id)?.querySelectorAll('[data-crack-spur]') }]));
    const twigPaths = new Map(layout.branches.flatMap(branch => branch.leaves.map(leaf => [leaf.id, paths.current.get(leaf.id)?.querySelectorAll('[data-crack-main]')] as const)));
    const draw = (dt: number) => {
      let animating = false;
      for (const branch of layout.branches) {
        const knot = knotMotion.current.get(branch.id)!;
        knot.x.step(dt); knot.y.step(dt);
        const junction = { x: knot.x.value, y: knot.y.value };
        const trunk = sampleMapCrack(radialTrunk(layout.core, junction), `${branch.id}:trunk`, true);
        trunkPaths.get(branch.id)?.main?.forEach(path => path.setAttribute('d', trunk.d));
        trunkPaths.get(branch.id)?.spurs?.forEach(path => path.setAttribute('d', trunk.spurs[Number(path.getAttribute('data-crack-spur'))] ?? ''));
        knots.current.get(branch.id)?.setAttribute('transform', `translate(${junction.x} ${junction.y})`);
        const pill = pills.current.get(branch.id); if (pill) pill.style.transform = `translate(${junction.x - branch.knot.x}px, ${junction.y - branch.knot.y}px)`;
        animating ||= !isSpringSettled(knot.x) || !isSpringSettled(knot.y);
        for (const leaf of branch.leaves) {
          const state = motion.current.get(leaf.id)!;
          state.x.step(dt); state.y.step(dt);
          const destination = { x: state.x.value, y: state.y.value };
          const twig = sampleMapCrack(tendrilBetween(junction, destination), `${branch.id}:${leaf.id}`);
          twigPaths.get(leaf.id)?.forEach(path => path.setAttribute('d', twig.d));
          const node = nodes.current.get(leaf.id); if (node) { node.style.left = `${destination.x}px`; node.style.top = `${destination.y}px`; }
          const label = labels.current.get(leaf.id); if (label) label.style.transform = `translate(${destination.x - leaf.x}px, ${destination.y - leaf.y}px)`;
          animating ||= !isSpringSettled(state.x) || !isSpringSettled(state.y);
        }
      }
      return animating;
    };
    if (!draw(0) || reduced || !visible) return;
    const stop = subscribeTicker(dt => { if (!draw(dt)) stop(); });
    return stop;
  }, [layout, agents, visible, reduced]);
  const bind = <T,>(map: Map<string, T>, id: string, element: T | null) => { if (element) map.set(id, element); else map.delete(id); };
  const emphasis = (selected: boolean, highlighted: boolean) => selected ? 'selected' as const : highlighted ? 'hover' as const : hoveredId ? 'dim' as const : 'normal' as const;
  return <section className={`agent-map${visible ? '' : ' is-offscreen'}`} aria-label={t('omp.panel.map')} data-has-hover={hoveredId ? 'true' : undefined}>
    <div ref={container} className="agent-map-field" style={{ height: layout.height }}>
      <svg className="agent-map-lines" viewBox={`${layout.viewBox.x} ${layout.viewBox.y} ${layout.viewBox.width} ${layout.viewBox.height}`} aria-hidden="true">
        <circle className="agent-map-guide" cx={layout.core.x} cy={layout.core.y} r={layout.knotRadius} />
        <circle className="agent-map-guide" cx={layout.core.x} cy={layout.core.y} r={layout.leafRadius} />
        {layout.branches.map(branch => {
          const batch = batches.find(item => item.id === branch.id)!;
          const phases = batch.agents.map(subagentPhase);
          const phase = phases.includes('running') ? 'running' : phases.every(value => value === 'pending') ? 'pending' : 'completed';
          const trunk = sampleMapCrack(radialTrunk(layout.core, branch.knot), `${branch.id}:trunk`, true);
          return <g key={branch.id} className="agent-map-branch" data-phase={phase}>
            <g ref={el => bind(trunks.current, branch.id, el)}><LavaCrack d={trunk.d} spurs={trunk.spurs} phase={phase} width={phase === 'running' ? 2.4 : 2} emphasis={emphasis(branch.leaves.some(leaf => leaf.id === activeSubagentId), branch.leaves.some(leaf => leaf.id === hoveredId))} /></g>
            {branch.leaves.map(leaf => { const phase = subagentPhase(agents.get(leaf.id)!); const twig = sampleMapCrack(tendrilBetween(branch.knot, leaf), `${branch.id}:${leaf.id}`); return <g key={leaf.id} ref={el => bind(paths.current, leaf.id, el)}><LavaCrack d={twig.d} phase={phase} width={phase === 'running' ? 1.6 : 1.4} emphasis={emphasis(activeSubagentId === leaf.id, hoveredId === leaf.id)} /></g>; })}
          </g>;
        })}
        {layout.branches.map(branch => {
          const phases = branch.leaves.map(leaf => subagentPhase(agents.get(leaf.id)!));
          const phase = phases.includes('running') ? 'running' : phases.every(value => value === 'pending') ? 'pending' : 'completed';
          return <g key={branch.id} ref={el => bind(knots.current, branch.id, el)} transform={`translate(${branch.knot.x} ${branch.knot.y})`}><CrackKnot x={0} y={0} phase={phase} width={3} /></g>;
        })}
      </svg>
      <div className="agent-map-scene" style={{ width, height: width, transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})` }}>
        {layout.branches.map((branch, index) => <span key={branch.id} ref={el => bind(pills.current, branch.id, el)} className="agent-map-batch-label lg-static lg-thin lg-capsule" style={{ left: branch.label.x, top: branch.label.y, width: branch.label.width, height: branch.label.height }}>{t('omp.panel.batch', { number: index + 1, count: branch.leaves.length })}</span>)}
        <div className="agent-map-core" style={{ left: layout.core.x, top: layout.core.y }}><LiquidSpring size={44} active={running} /><div className="agent-map-core-label">{t('omp.panel.mainAgent')}<span title={sessionTitle}>{sessionTitle}</span></div></div>
        {layout.branches.flatMap(branch => branch.leaves.map(leaf => { const agent = agents.get(leaf.id)!; const title = subagentTitle(agent) || agent.id; const label = `${title} · ${t(`omp.panel.phase.${subagentPhase(agent)}`)}`; return <div key={leaf.id} className="agent-map-leaf" data-hovered={hoveredId === leaf.id} data-selected={activeSubagentId === leaf.id} data-label={leaf.label.show}>
          <button ref={el => bind(nodes.current, leaf.id, el)} type="button" className="agent-map-node" style={{ left: leaf.x, top: leaf.y, width: leaf.size + 8, height: leaf.size + 8 }} aria-label={label} title={label} onPointerEnter={() => onHover(leaf.id)} onPointerLeave={() => onHover(null)} onFocus={() => onHover(leaf.id)} onBlur={() => onHover(null)} onClick={event => { launchCapsuleMorph(agent.id, event.currentTarget, agent); onOpen(agent.id); }}><GlassBead agent={agent} size={leaf.size} /></button>
          <span ref={el => bind(labels.current, leaf.id, el)} className="agent-map-leaf-label lg-static lg-thin lg-capsule" style={{ left: leaf.label.show ? leaf.label.x : leaf.label.floating.x, top: leaf.label.show ? leaf.label.y : leaf.label.floating.y, width: leaf.label.width, textAlign: leaf.label.show ? leaf.label.align : 'center' }} aria-hidden="true">{title}</span>
        </div>; }))}
      </div>
    </div>
  </section>;
}

import { useLayoutEffect, useRef, type CSSProperties, type JSX } from 'react';
import type { SubagentPhase } from '../../workspace/subagent-model';
import { seededNoise } from '../../lib/agent-motion/noise';
import { subscribeTicker, useInView, useReducedMotion } from '../../lib/agent-motion/ticker';

const layers = ['glow', 'rim', 'body', 'core', 'sparks'] as const;
export function LavaCrack({ d, spurs = [], phase, width = 2, emphasis = 'normal', grow = false, glintKey }: {
  d: string; spurs?: string[]; phase: SubagentPhase; width?: number;
  emphasis?: 'normal' | 'hover' | 'dim' | 'selected'; grow?: boolean; glintKey?: number;
}): JSX.Element {
  const root = useRef<SVGGElement>(null), body = useRef<SVGPathElement>(null), tip = useRef<SVGGElement>(null), pulse = useRef<SVGGElement>(null);
  const previousGlint = useRef(glintKey), hasGrown = useRef(false);
  const visible = useInView(root), reduced = useReducedMotion();
  useLayoutEffect(() => {
    const track = body.current;
    if (!track || !root.current) return;
    const length = track.getTotalLength(), noise = seededNoise(d);
    root.current.querySelectorAll<SVGCircleElement>('[data-crack-ember]').forEach((ember, index) => {
      const point = track.getPointAtLength(length * (index === 2 ? 1 : .18 + (noise(index) + 1) * .3));
      ember.setAttribute('cx', String(point.x)); ember.setAttribute('cy', String(point.y));
    });
  }, [d, phase]);
  useLayoutEffect(() => {
    const node = root.current, track = body.current, spark = tip.current;
    if (!grow || phase !== 'running' || reduced || !visible || hasGrown.current || !node || !track || !spark || node.closest('.is-offscreen') || document.hidden) return;
    hasGrown.current = true;
    const length = track.getTotalLength();
    const paths = node.querySelectorAll<SVGPathElement>('[data-crack-main].liq-crack-rim, [data-crack-main].liq-crack-body, [data-crack-main].liq-crack-core');
    const branches = node.querySelectorAll<SVGGElement>('.liq-crack-spurs');
    paths.forEach(path => { path.style.strokeDasharray = String(length); path.style.strokeDashoffset = String(length); });
    branches.forEach(branch => { branch.style.opacity = '0'; });
    const animations: Animation[] = [];
    let elapsed = 0;
    const stop = subscribeTicker(dt => {
      elapsed += dt * 1000;
      const t = Math.min(1, elapsed / 520), eased = 1 - (1 - t) ** 3;
      paths.forEach(path => { path.style.strokeDashoffset = String(length * (1 - eased)); });
      const point = track.getPointAtLength(length * eased);
      spark.setAttribute('transform', `translate(${point.x} ${point.y})`); spark.style.opacity = t < 1 ? '1' : '0';
      if (t === 1 || node.closest('.is-offscreen')) {
        stop(); spark.style.opacity = '0';
        paths.forEach(path => { path.style.strokeDasharray = ''; path.style.strokeDashoffset = ''; });
        branches.forEach(branch => { branch.style.opacity = ''; if (t === 1) animations.push(branch.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 })); });
      }
    });
    return () => { stop(); spark.style.opacity = '0'; paths.forEach(path => { path.style.strokeDasharray = ''; path.style.strokeDashoffset = ''; }); branches.forEach(branch => { branch.style.opacity = ''; }); for (const animation of animations) animation.cancel(); };
  }, [d, phase, grow, reduced, visible]);
  useLayoutEffect(() => {
    const changed = glintKey !== undefined && previousGlint.current !== glintKey;
    previousGlint.current = glintKey;
    const node = pulse.current, track = body.current;
    if (!changed || phase !== 'running' || reduced || !visible || !node || !track || root.current?.closest('.is-offscreen') || document.hidden) return;
    const length = track.getTotalLength(), duration = document.documentElement.dataset.theme === 'light' ? 500 : 800;
    let elapsed = 0;
    const stop = subscribeTicker(dt => {
      elapsed += dt * 1000;
      const t = Math.min(1, elapsed / duration), point = track.getPointAtLength(length * t);
      node.setAttribute('transform', `translate(${point.x} ${point.y})`); node.style.opacity = t < 1 ? '1' : '0';
      if (t === 1 || root.current?.closest('.is-offscreen')) { node.style.opacity = '0'; stop(); }
    });
    return () => { stop(); node.style.opacity = '0'; };
  }, [d, phase, glintKey, reduced, visible]);
  const widths = [width * 4, width * 1.9, width, width * (phase === 'completed' ? .3 : .42), width * .42];
  return <g ref={root} className={'liq-crack' + (!visible ? ' is-offscreen' : '')} data-phase={phase} data-emphasis={emphasis} style={{ '--crack-width': width } as CSSProperties} aria-hidden="true">
    {layers.map((layer, index) => <g key={layer}><path ref={layer === 'body' ? body : undefined} data-crack-main="true" className={'liq-crack-' + layer} d={d} strokeWidth={widths[index]}/><g className="liq-crack-spurs">{spurs.map((spur, spurIndex) => <path key={spurIndex} data-crack-spur={spurIndex} className={'liq-crack-' + layer} d={spur} strokeWidth={widths[index] * .55}/>)}</g></g>)}
    {phase === 'failed' && <path data-crack-main="true" className="liq-crack-error" d={d} strokeWidth={width} pathLength="100" strokeDasharray="0 70 30 0"/>}
    {(phase === 'aborted' || phase === 'failed') && <><circle data-crack-ember="0" className="liq-crack-ember" r=".8"/><circle data-crack-ember="1" className="liq-crack-ember" r=".8"/>{phase === 'failed' && <circle data-crack-ember="2" className="liq-crack-end" r="1.2"/>}</>}
    <g ref={tip} className="liq-crack-pulse"><circle className="liq-crack-pulse-halo" r={width * 2.4}/><circle r={width * 1.2}/></g>
    <g ref={pulse} className="liq-crack-pulse"><circle className="liq-crack-pulse-halo" r={width * 2.2}/><circle r={width * 1.1}/></g>
  </g>;
}

export function CrackKnot({ x, y, phase, width }: { x: number; y: number; phase: SubagentPhase; width: number }): JSX.Element {
  return <g className="liq-crack-knot" data-phase={phase} aria-hidden="true"><circle className="liq-crack-knot-body" cx={x} cy={y} r={width * .9}/><circle className="liq-crack-knot-core" cx={x} cy={y} r={width * .4}/></g>;
}

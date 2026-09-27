import { useLayoutEffect, useRef, type CSSProperties, type JSX } from 'react';
import type { SubagentPhase } from '../../workspace/subagent-model';
import { useReducedMotion } from '../../lib/agent-motion/ticker';

/** The vein reserves the 12px floor; the slab material supplies the colored glass body. */
export function LiquidPool({ phase, rippleKey = 0, radius = 16, height = 12 }: { phase: SubagentPhase; rippleKey?: number; radius?: number; height?: number }): JSX.Element {
  const root = useRef<HTMLSpanElement>(null), vein = useRef<HTMLSpanElement>(null), pulse = useRef<HTMLSpanElement>(null), sparkle = useRef<HTMLSpanElement>(null);
  const previousPhase = useRef(phase), previousRipple = useRef(rippleKey);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const changed = previousPhase.current !== phase;
    previousPhase.current = phase;
    const band = vein.current, dot = sparkle.current;
    if (!changed || phase !== 'completed' || !band || !dot || reduced || document.hidden || root.current?.closest('.is-offscreen')) return;
    const animation = dot.animate([{ transform: 'translateX(0)', opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 1, offset: .8 }, { transform: `translateX(${Math.max(0, band.clientWidth - 4)}px)`, opacity: 0 }], { duration: 900, easing: 'ease-out' });
    return () => animation.cancel();
  }, [phase, reduced]);
  useLayoutEffect(() => {
    const changed = previousRipple.current !== rippleKey;
    previousRipple.current = rippleKey;
    const band = vein.current, dot = pulse.current;
    if (!changed || !band || !dot || reduced || document.hidden || root.current?.closest('.is-offscreen')) return;
    const slab = root.current?.closest<HTMLElement>('.liuli');
    slab?.setAttribute('data-pulse', 'true');
    const timeout = window.setTimeout(() => slab?.removeAttribute('data-pulse'), 400);
    const animation = dot.animate([{ transform: 'translateX(0)', opacity: 0 }, { opacity: 1, offset: .1 }, { opacity: 1, offset: .9 }, { transform: `translateX(${Math.max(0, band.clientWidth - 4)}px)`, opacity: 0 }], { duration: 600, easing: 'linear' });
    return () => { clearTimeout(timeout); slab?.removeAttribute('data-pulse'); animation.cancel(); };
  }, [rippleKey, reduced]);
  return <span ref={root} className="liq-pool" data-phase={phase} style={{ borderRadius: radius, '--liq-floor-height': height + 'px' } as CSSProperties} aria-hidden="true">
    <span className="liq-pool-floor"><span ref={vein} className="liq-vein">
      <span className="liq-vein-body"/>
      {phase === 'running' && <><span className="liq-vein-spark"/><span className="liq-vein-spark"/></>}
      {(phase === 'aborted' || phase === 'failed') && <><span className="liq-vein-ember"/><span className="liq-vein-ember"/><span className="liq-vein-ember"/></>}
      {phase === 'failed' && <><span className="liq-vein-break"/><svg className="liq-pool-cracks" width="40" height="24" viewBox="0 0 40 24"><polyline points="20,24 13,17 18,12 8,3"/><polyline points="20,24 26,16 22,9 31,0"/></svg></>}
      <span ref={pulse} className="liq-vein-pulse"/><span ref={sparkle} className="liq-vein-sparkle"/>
    </span></span>
  </span>;
}

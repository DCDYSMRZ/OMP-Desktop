import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useInView, useReducedMotion } from '../../lib/agent-motion/ticker';

export interface LiquidSpringHandle { pulse(): void }
export const LiquidSpring = forwardRef<LiquidSpringHandle, { size: number; active: boolean }>(function LiquidSpring({ size, active }, ref) {
  const root = useRef<HTMLSpanElement>(null), animation = useRef<Animation | undefined>(undefined);
  const reduced = useReducedMotion(), visible = useInView(root);
  useEffect(() => () => { animation.current?.cancel(); }, [reduced, visible, active]);
  useImperativeHandle(ref, () => ({ pulse() {
    const node = root.current;
    if (!node || reduced || !visible || document.hidden || node.closest('.is-offscreen')) return;
    animation.current?.cancel();
    animation.current = node.animate([{ transform: 'scale(1)', filter: 'brightness(1)' }, { transform: 'scale(1.08)', filter: 'brightness(1.3)', offset: .35 }, { transform: 'scale(1)', filter: 'brightness(1)' }], { duration: 460, easing: 'cubic-bezier(.2,.9,.25,1.12)' });
  } }), [reduced, visible]);
  return <span ref={root} className={'liq-spring liq-cabochon' + (!visible ? ' is-offscreen' : '')} data-phase={active ? 'running' : 'completed'} style={{ width: size, height: size }} aria-hidden="true">
    <span className="liq-cabochon-ember" style={{ width: size * .36, height: size * .36 }}/>
    {active && <svg className="liq-spring-sparks" width={size} height={size} viewBox="0 0 100 100">{[35, 50, 65].map((x, index) => <circle key={x} cx={x} cy="50" r="3" style={{ animationDelay: `${index * -.6}s` }}/>)}</svg>}
  </span>;
});

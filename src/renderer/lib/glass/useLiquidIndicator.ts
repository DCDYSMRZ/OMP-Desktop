import { useLayoutEffect, useRef, type RefObject } from 'react';
import { createSpring, isSpringSettled, springs, type Spring } from '../agent-motion/spring';
import { subscribeTicker, useReducedMotion } from '../agent-motion/ticker';
import { liquidIndicatorScale } from './liquid-indicator-scale';

interface IndicatorMotion {
  x: Spring;
  y: Spring;
  width: Spring;
  height: Spring;
  placed: boolean;
}

/** The positioned container owns keyed children and an aria-hidden indicator. */
export function useLiquidIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: string | null,
  axis: 'x' | 'y',
): RefObject<HTMLDivElement | null> {
  const indicatorRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<IndicatorMotion | null>(null);
  const reducedMotion = useReducedMotion();

  useLayoutEffect(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;
    const motion = motionRef.current ??= {
      x: createSpring(springs.snappy, 0),
      y: createSpring(springs.snappy, 0),
      width: createSpring(springs.snappy, 0),
      height: createSpring(springs.snappy, 0),
      placed: false,
    };
    const values = [motion.x, motion.y, motion.width, motion.height];
    let unsubscribe: (() => void) | undefined;

    function stop() { unsubscribe?.(); unsubscribe = undefined; }

    function paint() {
      const velocity = axis === 'x' ? motion.x.velocity : motion.y.velocity;
      const scaleX = liquidIndicatorScale(velocity, axis === 'y');
      const scaleY = liquidIndicatorScale(velocity, axis === 'x');
      indicator!.style.width = `${Math.max(0, motion.width.value)}px`;
      indicator!.style.height = `${Math.max(0, motion.height.value)}px`;
      indicator!.style.transform = `translate(${motion.x.value}px, ${motion.y.value}px) scale(${scaleX}, ${scaleY})`;
    }

    function measure() {
      const target = activeKey === null ? null : container!.querySelector<HTMLElement>(`[data-liquid-key="${CSS.escape(activeKey)}"]`);
      if (!target || target.closest('[hidden], [aria-hidden="true"]') || !target.getClientRects().length) {
        indicator!.style.opacity = '0';
        motion.placed = false;
        stop();
        return;
      }
      const box = target.getBoundingClientRect();
      const parent = container!.getBoundingClientRect();
      const x = box.left - parent.left - container!.clientLeft + container!.scrollLeft;
      const y = box.top - parent.top - container!.clientTop + container!.scrollTop;
      const jump = !motion.placed || reducedMotion;
      if (jump) {
        motion.x.jump(x);
        motion.y.jump(y);
        motion.width.jump(box.width);
        motion.height.jump(box.height);
        stop();
      } else {
        motion.x.setTarget(x);
        motion.y.setTarget(y);
        motion.width.setTarget(box.width);
        motion.height.setTarget(box.height);
      }
      motion.placed = true;
      indicator!.style.opacity = '1';
      paint();
      if (values.every(isSpringSettled)) { stop(); return; }
      if (!unsubscribe) unsubscribe = subscribeTicker(dt => {
        for (const value of values) value.step(dt);
        paint();
        if (values.every(isSpringSettled)) stop();
      });
    }

    const resize = new ResizeObserver(measure);
    function observeChildren() {
      resize.disconnect();
      resize.observe(container!);
      for (const child of container!.children) if (child !== indicator) resize.observe(child);
      for (const child of container!.querySelectorAll('[data-liquid-key]')) resize.observe(child);
      measure();
    }
    const mutations = new MutationObserver(observeChildren);
    mutations.observe(container, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['data-liquid-key', 'aria-hidden', 'hidden'],
    });
    container.addEventListener('scroll', measure, { passive: true });
    observeChildren();
    return () => {
      stop();
      resize.disconnect();
      mutations.disconnect();
      container.removeEventListener('scroll', measure);
    };
  }, [containerRef, activeKey, axis, reducedMotion]);

  return indicatorRef;
}

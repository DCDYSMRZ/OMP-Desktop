import { useEffect, useState, type RefObject } from 'react';
export type TickFn = (dtSeconds: number, nowMs: number) => void;
const subscribers = new Set<TickFn>();
let frame: number | undefined, last: number | undefined;
function stop() { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; last = undefined; }
function schedule() { if (frame === undefined && subscribers.size && !document.hidden) frame = requestAnimationFrame(tick); }
function tick(now: number) {
  frame = undefined;
  if (document.hidden) { last = undefined; return; }
  const dt = last === undefined ? 0 : Math.min(.05, Math.max(0, (now - last) / 1000));
  last = now;
  try { for (const fn of subscribers) fn(dt, now); } finally { schedule(); }
}
function visibility() { if (document.hidden) stop(); else schedule(); }
export function subscribeTicker(fn: TickFn): () => void {
  const listener: TickFn = (dt, now) => fn(dt, now);
  if (!subscribers.size) document.addEventListener('visibilitychange', visibility);
  subscribers.add(listener); schedule();
  return () => { subscribers.delete(listener); if (!subscribers.size) { stop(); document.removeEventListener('visibilitychange', visibility); } };
}
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}
export function useInView<T extends Element>(ref: RefObject<T | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}
let particleCount = 0;
/** Shared across inline roots and the map; every acquired slot must be released. */
export function acquireParticleSlot(): (() => void) | undefined {
  if (particleCount >= 40) return undefined;
  particleCount++; let released = false;
  return () => { if (!released) { released = true; particleCount--; } };
}

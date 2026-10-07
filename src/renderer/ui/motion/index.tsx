import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { flipDelta, flipSnapshotMode, hiddenTransform, motion, numberColumns, swapMotionMode, type MotionRect, type MotionVariant } from './model';
import { isProgrammaticScroll } from './programmatic-scroll';
export { motion, type MotionVariant } from './model';
let preference: MediaQueryList | undefined;
const media = () => preference ??= window.matchMedia('(prefers-reduced-motion: reduce)');
const subscribe = (notify: () => void) => { media().addEventListener('change', notify); return () => media().removeEventListener('change', notify); };
export function useReducedMotion() { return useSyncExternalStore(subscribe, () => media().matches); }
let scrollUntil = 0;
const running = new Set<Animation>();
let scrollGuardInstalled = false;
export function isMotionPaused() { installScrollGuard(); return performance.now() < scrollUntil; }
function installScrollGuard() {
  if (scrollGuardInstalled) return;
  scrollGuardInstalled = true;
  window.addEventListener('scroll', event => { if (isProgrammaticScroll(event.target)) return; scrollUntil = performance.now() + 140; for (const animation of running) { if (animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.transform && frame.transform !== 'none')) animation.finish(); } }, { capture: true, passive: true });
}

/** Retarget from the currently painted state; never queue an animation. */
export function animateTo(element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
  installScrollGuard();
  element.getAnimations().forEach(animation => animation.cancel());
  const animation = element.animate(frames, options);
  running.add(animation);
  animation.finished.then(() => running.delete(animation), () => running.delete(animation));
  return animation;
}
/** Apply to an already retained/positioned surface; ownership stays with its caller. */
export function useSurfaceMotion<T extends HTMLElement>(ref: RefObject<T | null>, show: boolean, variant: MotionVariant = 'fade', ready = true) {
  const reduced = useReducedMotion(), previous = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !ready) { previous.current = null; return; }
    const initial = previous.current !== element; previous.current = element;
    const style = getComputedStyle(element);
    const spatial = !reduced && !isMotionPaused();
    animateTo(element, [{ opacity: initial ? 0 : Number(style.opacity), transform: spatial ? initial ? hiddenTransform(variant) : style.transform : 'none' }, { opacity: show ? 1 : 0, transform: spatial && !show ? hiddenTransform(variant) : 'none' }], { duration: reduced ? motion.reduced : motion.base, easing: show ? motion.enter : motion.leave, fill: 'both' });
  }, [ref, show, ready, variant, reduced]);
}
export function Presence({ show, children, variant = 'fade', appear = true, className, style, ...props }: HTMLAttributes<HTMLDivElement> & { show: boolean; children: ReactNode; variant?: MotionVariant; appear?: boolean }) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(show);
  const ref = useRef<HTMLDivElement>(null), first = useRef(true), retained = useRef(children);
  if (show) retained.current = children;
  useLayoutEffect(() => {
    if (show && !mounted) { setMounted(true); return; }
    const element = ref.current;
    if (!element) { first.current = true; return; }
    const initial = first.current; first.current = false;
    if (initial && !appear && show) return;
    const computed = getComputedStyle(element);
    const from = { opacity: initial ? '0' : computed.opacity, transform: reduced ? 'none' : initial ? hiddenTransform(variant) : computed.transform };
    const to = { opacity: show ? '1' : '0', transform: reduced || show ? 'none' : hiddenTransform(variant) };
    const animation = animateTo(element, [from, to], { duration: reduced ? motion.reduced : show ? motion.base : motion.exit, easing: show ? motion.enter : motion.leave, fill: 'both' });
    animation.onfinish = () => { if (!show) setMounted(false); else animation.cancel(); };
    // Leave the current animation running until the next effect samples it.
    return () => { animation.onfinish = null; };
  }, [show, mounted, reduced, variant, appear]);
  useEffect(() => () => ref.current?.getAnimations().forEach(animation => animation.cancel()), []);
  return show || mounted ? <div {...props} ref={ref} className={className} style={style} inert={!show} aria-hidden={!show || undefined}>{show ? children : retained.current}</div> : null;
}

// One observer for every label; no layout reads on render, reveal or prepend.
const visibleSwaps = new WeakSet<Element>();
let swapObserver: IntersectionObserver | undefined;
function observeSwap(element: HTMLElement) {
  swapObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0) visibleSwaps.add(entry.target);
      else visibleSwaps.delete(entry.target);
    }
  });
  swapObserver.observe(element);
  return () => { swapObserver?.unobserve(element); visibleSwaps.delete(element); };
}

export function Swap({ swapKey, children, variant = 'fade', className, style, animate = true }: { swapKey: string | number; children: ReactNode; variant?: MotionVariant; className?: string; style?: CSSProperties; animate?: boolean }) {
  const reduced = useReducedMotion(), ref = useRef<HTMLSpanElement>(null);
  const previous = useRef({ key: swapKey, children }), [outgoing, setOutgoing] = useState<ReactNode>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) return observeSwap(element);
  }, []);
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { key: swapKey, children };
    if (old.key === swapKey) return;
    const element = ref.current;
    const mode = swapMotionMode(old.children !== children, animate, !!element && visibleSwaps.has(element), isMotionPaused(), reduced);
    if (!element || mode === 'none') {
      setOutgoing(null);
      element?.getAnimations().forEach(animation => animation.cancel());
      return;
    }
    setOutgoing(old.children);
    // Transform/opacity do not depend on either label's dimensions. Keeping the
    // fixed variant avoids synchronous layout and width-dependent text scaling.
    animateTo(element, [{ opacity: 0, transform: mode === 'spatial' ? hiddenTransform(variant) : 'none' }, { opacity: 1, transform: 'none' }], { duration: reduced ? motion.reduced : motion.fast, easing: motion.enter });
  }, [swapKey, children, reduced, variant, animate]);
  useEffect(() => {
    if (outgoing === null) return;
    const timer = window.setTimeout(() => setOutgoing(null), reduced ? motion.reduced : motion.fast);
    return () => window.clearTimeout(timer);
  }, [outgoing, reduced]);
  return <span className={`motion-swap ${className ?? ''}`} style={style}>{outgoing !== null && <span key={swapKey} className="motion-swap-out" aria-hidden inert>{outgoing}</span>}<span className="motion-swap-current" ref={ref}>{children}</span></span>;
}
export function AnimatedNumber({ value, format = String, className, animate = true }: { value: number; format?: (value: number) => string; className?: string; animate?: boolean }) {
  const text = format(value);
  return <span className={`motion-number ${className ?? ''}`} aria-label={text}><span aria-hidden>{numberColumns(text).map(({ key, character }) => /[0-9]/.test(character) ? <Swap key={key} className="motion-number-digit" swapKey={character} variant="drop" animate={animate}>{character}</Swap> : <span key={key} className="motion-number-literal">{character}</span>)}</span></span>;
}

/** Mark direct or nested keyed rows with data-flip-key. Initial mount is quiet.
 * Reads are batched before writes; scroll cancels spatial motion immediately.
 * Removed rows are inert paint-only clones, never React-owned interactive nodes. */
export function useFlipList<T extends HTMLElement>(ref: RefObject<T | null>, keys: readonly (string | number)[], options: { animate?: boolean; insert?: 'rise' | 'fade' } = {}) {
  const reduced = useReducedMotion(), previous = useRef(new Map<string, { rect: MotionRect; node: HTMLElement }>()), initialized = useRef(false), scrolling = useRef(0);
  const ghosts = useRef(new Set<HTMLElement>());
  const scrollCoordinates = useRef(new Map<HTMLElement, { top: number; left: number }>());
  const signature = JSON.stringify(keys);
  const owned = useMemo(() => new Set(keys.map(String)), [signature]);
  const ownedKeys = useRef(owned);
  ownedKeys.current = owned;
  useLayoutEffect(() => {
    const activeGhosts = ghosts.current;
    const onScroll = (event: Event) => {
      const target = event.target === document ? document.scrollingElement : event.target;
      if (!scrollCoordinates.current.has(target as HTMLElement)) return;
      // Owned corrections also move viewport rectangles, but are not user intent.
      previous.current.clear(); initialized.current = false;
      if (!isProgrammaticScroll(target)) scrolling.current = performance.now() + 140;
      ref.current?.querySelectorAll<HTMLElement>('[data-flip-key]').forEach(node => { if (ownedKeys.current.has(node.dataset.flipKey!)) node.getAnimations().forEach(animation => animation.cancel()); });
      activeGhosts.forEach(node => node.remove()); activeGhosts.clear();
    };
    window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('scroll', onScroll, true); activeGhosts.forEach(node => node.remove()); activeGhosts.clear(); };
  }, [ref]);
  useLayoutEffect(() => {
    // A write and a React commit can precede the browser's queued scroll event.
    for (const [element, position] of scrollCoordinates.current) {
      if (element.scrollTop !== position.top || element.scrollLeft !== position.left) {
        for (const { node } of previous.current.values()) node.getAnimations().forEach(animation => animation.cancel());
        previous.current.clear(); initialized.current = false;
        ghosts.current.forEach(ghost => ghost.remove()); ghosts.current.clear();
        break;
      }
    }
    const mode = flipSnapshotMode(options.animate !== false, initialized.current);
    if (mode === 'skip') {
      previous.current.clear();
      initialized.current = false;
      ghosts.current.forEach(ghost => ghost.remove());
      ghosts.current.clear();
      scrollCoordinates.current.clear();
      return;
    }
    const root = ref.current; if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-flip-key]')).filter(node => ownedKeys.current.has(node.dataset.flipKey!));
    const coordinates = new Map<HTMLElement, { top: number; left: number }>();
    const captureScroll = (element: HTMLElement | null) => {
      for (; element && !coordinates.has(element); element = element.parentElement) coordinates.set(element, { top: element.scrollTop, left: element.scrollLeft });
    };
    captureScroll(root);
    nodes.forEach(node => captureScroll(node.parentElement));
    scrollCoordinates.current = coordinates;
    const next = new Map(nodes.map(node => [node.dataset.flipKey!, { rect: node.getBoundingClientRect(), node }]));
    const active = mode === 'animate' && performance.now() >= scrolling.current;
    if (active) {
      let inserted = 0;
      for (const [key, item] of next) {
        const before = previous.current.get(key);
        if (!before) { animateTo(item.node, [{ opacity: 0, transform: reduced || options.insert === 'fade' ? 'none' : 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: reduced ? motion.reduced : motion.base, delay: reduced ? 0 : Math.min(inserted++ * 20, 160), fill: 'backwards', easing: motion.enter }); continue; }
        const delta = flipDelta(before.rect, item.rect);
        if (!reduced && (Math.abs(delta.x) > 0.5 || Math.abs(delta.y) > 0.5)) animateTo(item.node, [{ transform: `translate(${delta.x}px, ${delta.y}px)` }, { transform: 'none' }], { duration: motion.expand, easing: motion.spring });
      }
      for (const [key, item] of previous.current) if (!next.has(key) && !item.node.isConnected && !item.node.querySelector('.closing')) {
        const ghost = item.node.cloneNode(true) as HTMLElement;
        ghost.removeAttribute('id'); ghost.querySelectorAll('[id]').forEach(node => node.removeAttribute('id')); ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
        Object.assign(ghost.style, { position: 'fixed', left: `${item.rect.left}px`, top: `${item.rect.top}px`, width: `${item.rect.width}px`, height: `${item.rect.height}px`, margin: '0', pointerEvents: 'none', zIndex: '1000' });
        document.body.append(ghost);
        ghosts.current.add(ghost);
        const animation = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? motion.reduced : motion.exit, easing: motion.leave });
        animation.onfinish = animation.oncancel = () => { ghost.remove(); ghosts.current.delete(ghost); };
      }
    }
    previous.current = next; initialized.current = true;
  }, [signature, reduced, options.animate, options.insert, ref]);
}

import { clearProgrammaticScroll, noteProgrammaticScroll } from '../ui/motion/programmatic-scroll';

export interface SmoothFollowOptions {
  tauMs: number;
  maxLagPx: number;
  snapPx: (element: HTMLElement) => number;
  reducedMotion: () => boolean;
}

export interface SmoothFollow {
  contentChanged(): void;
  setFollowing(on: boolean): void;
  returnToBottom(): void;
  interrupt(): void;
  readonly writing: boolean;
  dispose(): void;
}

/** B1: exponential convergence, bounded visible lag, and exact settlement. */
export function glideGap(gap: number, dtMs: number, tauMs: number, maxLagPx: number): number {
  const next = Math.min(maxLagPx, gap * Math.exp(-dtMs / tauMs));
  return next < 1.5 ? 0 : next;
}

/** Invert the x coordinate of cubic-bezier(0.2, 0, 0, 1). */
function returnProgress(progress: number): number {
  if (progress >= 1) return 1;
  if (progress <= 0) return 0;
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const t = (low + high) / 2;
    const x = 0.6 * t * (1 - t) * (1 - t) + t * t * t;
    if (x < progress) low = t; else high = t;
  }
  const t = (low + high) / 2;
  return t * t * (3 - 2 * t);
}

export function createSmoothFollow(element: HTMLElement, options: SmoothFollowOptions): SmoothFollow {
  let following = true, disposed = false;
  let frame: number | undefined;
  let previousTime = 0;
  let tweenStart: number | undefined;
  let tweenFrom = 0;
  let writtenTop: number | undefined;
  const write = (top: number) => {
    element.scrollTop = top;
    // Scroll events are delivered asynchronously; retain the browser-rounded
    // position until a gesture interrupts or another writer changes it.
    writtenTop = element.scrollTop;
    noteProgrammaticScroll(element);
  };
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    tweenStart = undefined;
  };
  const schedule = () => {
    if (frame === undefined) frame = requestAnimationFrame(tick);
  };
  const tick = () => {
    // rAF timestamps precede callbacks; a long layout/commit can leave them
    // older than a ResizeObserver clamp. Use the same clock for both writes.
    const now = performance.now();
    frame = undefined;
    if (disposed || !following) return;
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    const gap = bottom - element.scrollTop;
    if (options.reducedMotion()) { write(bottom); tweenStart = undefined; return; }
    if (tweenStart !== undefined) {
      const progress = returnProgress((now - tweenStart) / 300);
      write(tweenFrom + (bottom - tweenFrom) * progress);
      if (progress < 1) schedule(); else tweenStart = undefined;
    } else if (gap > 0) {
      const next = glideGap(gap, now - previousTime, options.tauMs, options.maxLagPx);
      write(bottom - next);
      if (next > 0) schedule();
    }
    previousTime = now;
  };
  const contentChanged = () => {
    if (disposed || !following) return;
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    const gap = bottom - element.scrollTop;
    if (options.reducedMotion()) { cancel(); write(bottom); return; }
    if (tweenStart !== undefined) return;
    if (gap > options.snapPx(element) || gap > options.maxLagPx) {
      write(bottom - options.maxLagPx);
      previousTime = performance.now();
    }
    if (gap > 0) {
      if (frame === undefined) previousTime = performance.now();
      schedule();
    }
  };
  return {
    contentChanged,
    setFollowing(on) {
      following = on;
      if (!on) cancel();
    },
    returnToBottom() {
      if (disposed) return;
      cancel();
      following = true;
      const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
      const gap = bottom - element.scrollTop;
      if (options.reducedMotion() || gap > 2 * element.clientHeight || gap <= 0) { write(bottom); return; }
      tweenFrom = element.scrollTop;
      tweenStart = performance.now();
      schedule();
    },
    interrupt() { cancel(); writtenTop = undefined; clearProgrammaticScroll(element); },
    get writing() { return writtenTop !== undefined && element.scrollTop === writtenTop; },
    dispose() { disposed = true; cancel(); writtenTop = undefined; clearProgrammaticScroll(element); },
  };
}

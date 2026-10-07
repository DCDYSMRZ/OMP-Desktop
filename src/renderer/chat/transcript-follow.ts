import { noteProgrammaticScroll } from '../ui/motion/programmatic-scroll';

export function interruptTranscriptNavigation(viewport: HTMLElement): void {
  viewport.dispatchEvent(new Event('transcript-navigation-interrupt'));
}

/** Shared turn navigation is scoped to its containing main or child viewport. */
export function scheduleTranscriptNavigation(origin: HTMLElement | null, run: () => void, delay: number): () => void {
  const viewport = origin?.closest<HTMLElement>('.thread-scroll, .subagent-transcript-scroll');
  if (!viewport) return () => {};
  viewport.dispatchEvent(new Event('transcript-navigation-start'));
  interruptTranscriptNavigation(viewport);
  const cancel = () => { window.clearTimeout(timer); viewport.removeEventListener('transcript-navigation-interrupt', cancel); };
  const timer = window.setTimeout(() => {
    cancel();
    run();
    noteProgrammaticScroll(viewport);
  }, delay);
  viewport.addEventListener('transcript-navigation-interrupt', cancel);
  return cancel;
}

/** Layout, selection and focus are not evidence of a user's scroll intent. */
export function followAfterScroll(following: boolean, userInitiated: boolean, bottomGap: number, deltaY: number): boolean {
  if (!userInitiated || deltaY === 0) return following;
  return deltaY > 0 && bottomGap <= 80;
}


/** Source refresh may resolve a request, but cannot reissue its scroll intent. */
export function createNavigationRequest() {
  let key: string | undefined;
  let epoch = 0;
  let claimed = false;
  let cancelLanding: (() => void) | undefined;
  return {
    observe(next: string | undefined, intent: number) {
      if (next === key) return;
      cancelLanding?.();
      cancelLanding = undefined;
      key = next; epoch = intent; claimed = false;
    },
    take(next: string, intent: number) {
      if (next !== key || epoch !== intent || claimed) return false;
      claimed = true;
      return true;
    },
    retain(cancel: () => void) { cancelLanding = cancel; },
  };
}

/** A vertical gesture belongs to the first nested scroller that can consume it. */
export function scrollGestureReachesViewport(viewport: HTMLElement, target: EventTarget | null, deltaY: number): boolean {
  if (!deltaY || !(target instanceof Element) || !viewport.contains(target)) return false;
  for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    if (!/^(auto|scroll|overlay)$/.test(style.overflowY) || node.scrollHeight <= node.clientHeight) continue;
    if (deltaY < 0 ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight) return false;
    if (/^(contain|none)$/.test(style.overscrollBehaviorY)) return false;
  }
  return true;
}

export function scrollKeyDirection(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>, target: EventTarget | null): -1 | 0 | 1 {
  if (event.metaKey || event.ctrlKey || event.altKey || (target instanceof Element && target.closest('button, summary, input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]'))) return 0;
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) return -1;
  return ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) ? 1 : 0;
}

/** Resume the viewport before any I/O; an already-live window needs no reload. */
export async function returnToLatest(history: { following?: boolean; latest?: () => Promise<void> } | undefined, resume: () => void, isCurrent: () => boolean): Promise<void> {
  resume();
  // Reloading live history races every streamed event's snapshot version.
  if (history?.following === true || !history?.latest) return;
  await history.latest();
  if (isCurrent()) resume();
}

/** Coalesce notifications; ResizeObserver can flush the pending pin before paint. */
export function coalesceFrame(run: () => void, request: (callback: FrameRequestCallback) => number, cancel: (id: number) => void) {
  let frame: number | undefined;
  return {
    schedule() {
      if (frame !== undefined) return;
      frame = request(() => { frame = undefined; run(); });
    },
    flush() { if (frame !== undefined) cancel(frame); frame = undefined; run(); },
    cancel() { if (frame !== undefined) cancel(frame); frame = undefined; },
  };
}

import { Component, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { PagingGate } from './history-paging-model';
import { captureViewportReadingAnchors, restoreViewportReadingAnchor, type ViewportReadingAnchor } from './viewport-reading-anchor';
import { Swap } from '../ui/motion';
import { UserErrorNotice } from '../lib/UserErrorNotice';
import { isProgrammaticScroll } from '../ui/motion/programmatic-scroll';

export function HistoryPaging({ scrollRef, cursor, busy, error, load, enabled = true }: { scrollRef: RefObject<HTMLDivElement | null>; cursor?: string; busy: boolean; error?: Error | string; load: () => Promise<void>; enabled?: boolean }) {
  const { t } = useTranslation();
  const sentinel = useRef<HTMLDivElement>(null);
  const gate = useRef(new PagingGate());
  const latest = useRef({ cursor, busy, error, load, enabled });
  latest.current = { cursor, busy, error, load, enabled };
  const [failed, setFailed] = useState(false);
  const [near, setNear] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const paged = useRef(false);
  const retry = () => { gate.current.retry(); setFailed(false); setAttempt(value => value + 1); };
  useEffect(() => {
    const root = scrollRef.current, target = sentinel.current;
    if (!root || !target) return;
    let observer: IntersectionObserver;
    const observe = () => { observer?.disconnect(); observer = new IntersectionObserver(entries => setNear(entries[0].isIntersecting), { root, rootMargin: `${Math.ceil(root.clientHeight * 1.5)}px 0px 0px` }); observer.observe(target); };
    observe(); const resize = new ResizeObserver(observe); resize.observe(root);
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0 && gate.current.failed) retry(); };
    let previousTop = root.scrollTop;
    const scroll = () => { const top = root.scrollTop; if (top < previousTop && gate.current.failed) retry(); previousTop = top; };
    root.addEventListener('wheel', wheel, { passive: true });
    root.addEventListener('scroll', scroll, { passive: true });
    return () => { observer.disconnect(); resize.disconnect(); root.removeEventListener('wheel', wheel); root.removeEventListener('scroll', scroll); };
  }, [scrollRef]);
  useEffect(() => {
    if (!enabled || !gate.current.begin(cursor, near, busy)) return;
    paged.current = true;
    let rejected = false;
    void load().catch(() => { rejected = true; }).finally(() => { const failure = rejected || !!latest.current.error; gate.current.finish(failure); setFailed(failure); setAttempt(value => value + 1); });
  }, [cursor, near, busy, enabled, attempt]);
  const beginning = !cursor && enabled && paged.current;
  return <div ref={sentinel} className="history-paging-status" role="status" aria-live="polite"><Swap swapKey={busy ? 'loading' : failed ? 'failed' : beginning ? 'beginning' : 'idle'}>{busy ? t('omp.paging.loading') : failed ? <UserErrorNotice error={error} onRetry={retry}/> : beginning ? t('omp.paging.beginning') : null}</Swap></div>;
}

type Snapshot = ViewportReadingAnchor[] | null;
type AnchorProps = { scrollRef: RefObject<HTMLDivElement | null>; first?: string; enabled?: boolean; children: ReactNode; onRestore?: (element: HTMLElement, anchor: ViewportReadingAnchor) => void; onReveal?: (messageId: string) => void };
/** Each DOM prepend owns only its commit, never the surrounding page request. */
export class PrependAnchor extends Component<AnchorProps> {
  private snapshot: Snapshot = null;
  private frame: number | undefined;
  private root: HTMLDivElement | null = null;
  private capturedScrollTop = 0;
  get active() { return this.snapshot !== null; }
  cancel = () => {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.snapshot = null;
  };
  private onScroll = () => { if (!isProgrammaticScroll(this.props.scrollRef.current)) this.cancel(); };
  componentDidMount() {
    this.root = this.props.scrollRef.current;
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) this.root?.addEventListener(event, this.cancel, { passive: true });
    this.root?.addEventListener('scroll', this.onScroll, { passive: true });
  }
  getSnapshotBeforeUpdate(previous: AnchorProps): Snapshot {
    const root = this.props.scrollRef.current;
    if (!root || this.props.enabled === false) { this.cancel(); return null; }
    if (previous.first === this.props.first || !previous.first) return null;
    this.cancel();
    this.capturedScrollTop = root.scrollTop;
    const anchors = captureViewportReadingAnchors(root);
    this.snapshot = anchors.length ? anchors : null;
    return this.snapshot;
  }
  private restore(): boolean {
    const root = this.props.scrollRef.current;
    if (!root || !root.isConnected || this.props.enabled === false || root.scrollTop !== this.capturedScrollTop) { this.cancel(); return false; }
    for (const anchor of this.snapshot ?? []) {
      const element = restoreViewportReadingAnchor(root, anchor);
      if (!element) continue;
      this.cancel();
      this.props.onRestore?.(element, anchor);
      return true;
    }
    return false;
  }
  componentDidUpdate(_previous: AnchorProps, _state: unknown, snapshot: Snapshot) {
    if (!this.snapshot || this.restore()) return;
    if (!this.snapshot || !snapshot || this.frame !== undefined) return;
    const message = snapshot.find(anchor => anchor.messageId || anchor.scopeAttribute === 'data-message-id');
    const messageId = message?.messageId ?? message?.scopeId;
    if (!messageId || !this.props.onReveal) { this.cancel(); return; }
    // Revealing a regrouped fragment may commit descendants without updating us.
    // Permit one pre-paint retry, invalidated immediately by input/navigation.
    this.frame = requestAnimationFrame(() => {
      if (this.snapshot !== snapshot) return;
      this.frame = undefined;
      if (!this.restore()) this.cancel();
    });
    this.props.onReveal(messageId);
    this.restore();
  }
  componentWillUnmount() {
    this.cancel();
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) this.root?.removeEventListener(event, this.cancel);
    this.root?.removeEventListener('scroll', this.onScroll);
  }
  render() { return this.props.children; }
}

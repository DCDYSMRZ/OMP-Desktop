import { createContext, useCallback, useContext, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref, type RefObject } from 'react';
import { DisclosureChoices } from './disclosure-choices';
import { isMotionPaused } from '../ui/motion';
import { noteProgrammaticScroll } from '../ui/motion/programmatic-scroll';

export const DisclosureAnchor = createContext<(element: HTMLElement | null, options?: { automatic?: boolean }) => void>(() => {});
const Choices = createContext<DisclosureChoices | null>(null);
const Parent = createContext({ claim: () => {}, visible: true });
const Identity = createContext('');
/** Opens an identity, including later mounts; exclusions preserve separate detail choices. */
export interface TranscriptDisclosureApi { reveal: (identity: string, options?: { exclude?: readonly string[] }) => void; revealMany: (identities: readonly string[]) => void }
export function useTranscriptDisclosureApi(): TranscriptDisclosureApi | null {
  return useContext(Choices);
}
export function TranscriptDisclosureProvider({ children, apiRef }: { children: ReactNode; apiRef?: Ref<TranscriptDisclosureApi> }) {
  const [choices] = useState(() => new DisclosureChoices());
  useImperativeHandle(apiRef, () => ({ reveal: choices.reveal, revealMany: choices.revealMany }), [choices]);
  return <Choices.Provider value={choices}>{children}</Choices.Provider>;
}
export function DisclosureIdentity({ identity, children }: { identity: string; children: ReactNode }) {
  return <Identity.Provider value={identity}>{children}</Identity.Provider>;
}
export interface AutomaticDisclosure {
  open: boolean; manual: boolean; claim: () => void; toggle: () => void; collapse: () => void; parentVisible: boolean;
  titleRef: RefObject<HTMLButtonElement | null>; bodyRef: RefObject<HTMLDivElement | null>;
  bodyEvents: { onPointerDownCapture: () => void; onFocusCapture: () => void; onKeyDownCapture: () => void };
}
export function useAutomaticDisclosure(automaticOpen: boolean, identity?: string, immediate = false): AutomaticDisclosure {
  const shared = useContext(Choices);
  const [local] = useState(() => new DisclosureChoices());
  const choices = shared ?? local;
  const source = useContext(Identity);
  const fallback = useId();
  const key = JSON.stringify([source, identity ?? fallback]);
  const parent = useContext(Parent);
  const subscribe = useCallback((listener: () => void) => choices.subscribe(key, listener), [choices, key]);
  const snapshot = useCallback(() => choices.get(key), [choices, key]);
  const choice = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [automatic, setAutomatic] = useState(automaticOpen);
  useLayoutEffect(() => {
    if (choice !== undefined || automatic === automaticOpen) return;
    let timer: number;
    const apply = () => {
      if (!immediate && isMotionPaused()) { timer = window.setTimeout(apply, 160); return; }
      setAutomatic(automaticOpen);
    };
    apply();
    return () => window.clearTimeout(timer);
  }, [automaticOpen, automatic, choice, immediate]);
  const open = choice ?? automatic;
  const titleRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const notify = useContext(DisclosureAnchor);
  const current = useRef(open); current.current = open;
  const claim = useCallback(() => {
    if (choices.get(key) === undefined) choices.set(key, current.current);
    parent.claim();
  }, [choices, key, parent.claim]);
  const previous = useRef(open);
  useLayoutEffect(() => {
    const wasOpen = previous.current;
    previous.current = open;
    if (!wasOpen || open || choice !== undefined) return;
    const body = bodyRef.current;
    const selection = window.getSelection();
    const reading = body && (body.contains(document.activeElement) || (selection && !selection.isCollapsed && (body.contains(selection.anchorNode) || body.contains(selection.focusNode))));
    if (reading) { choices.set(key, true); parent.claim(); }
    else notify(titleRef.current, { automatic: true });
  }, [open, choice, choices, key, parent.claim, notify]);
  const set = useCallback((next: boolean) => {
    parent.claim(); notify(titleRef.current);
    if (!next && bodyRef.current?.contains(document.activeElement)) titleRef.current?.focus({ preventScroll: true });
    choices.set(key, next);
  }, [choices, key, notify, parent.claim]);
  return { open, manual: choice !== undefined, claim, titleRef, bodyRef, parentVisible: parent.visible, toggle: () => set(!current.current), collapse: () => set(false), bodyEvents: { onPointerDownCapture: claim, onFocusCapture: claim, onKeyDownCapture: claim } };
}
export function DisclosureScope({ disclosure, children }: { disclosure: AutomaticDisclosure; children: ReactNode }) {
  const value = useMemo(() => ({ claim: disclosure.claim, visible: disclosure.parentVisible && disclosure.open }), [disclosure.claim, disclosure.parentVisible, disclosure.open]);
  return <Parent.Provider value={value}>{children}</Parent.Provider>;
}

export interface DisclosureViewportAnchor { element: HTMLElement; top: number; automatic?: boolean }
const viewportReserves = new WeakMap<HTMLElement, { top: number; bottom: number; before: number; after: number; originalTop: string; originalBottom: string }>();

/** Pin a surviving visible fragment, never a process row that is being hidden. */
export function automaticDisclosureAnchor(viewport: HTMLElement, trigger: HTMLElement | null): DisclosureViewportAnchor | null {
  const closing = trigger?.closest('.turn-timeline') ?? trigger?.parentElement;
  const bounds = viewport.getBoundingClientRect();
  const candidates = Array.from(viewport.querySelectorAll<HTMLElement>('[data-presentation-key], [data-message-id]')).filter(node => {
    const rect = node.getBoundingClientRect();
    return !closing?.contains(node) && !node.closest('[hidden]') && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
  }).sort((left, right) => Math.abs(left.getBoundingClientRect().top - bounds.top) - Math.abs(right.getBoundingClientRect().top - bounds.top));
  const element = candidates[0];
  return element ? { element, top: element.getBoundingClientRect().top - bounds.top, automatic: true } : null;
}

/** Short transcripts need a bounded edge reserve when the browser would clamp the restored offset. */
export function restoreDisclosureAnchor(viewport: HTMLElement, content: HTMLElement, anchor: DisclosureViewportAnchor) {
  const viewportTop = viewport.getBoundingClientRect().top;
  const desired = viewport.scrollTop + anchor.element.getBoundingClientRect().top - viewportTop - anchor.top;
  const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  if (anchor.automatic && (desired < -0.5 || desired > maximum + 0.5)) {
    let reserve = viewportReserves.get(content);
    if (!reserve) {
      const style = getComputedStyle(content);
      reserve = { top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0, before: 0, after: 0, originalTop: content.style.paddingTop, originalBottom: content.style.paddingBottom };
      viewportReserves.set(content, reserve);
    }
    if (desired < 0) { reserve.before -= desired; content.style.paddingTop = `${reserve.top + reserve.before}px`; }
    else { reserve.after += desired - maximum; content.style.paddingBottom = `${reserve.bottom + reserve.after}px`; }
  }
  const target = viewport.scrollTop + anchor.element.getBoundingClientRect().top - viewportTop - anchor.top;
  viewport.scrollTop = target;
  noteProgrammaticScroll(viewport);
  // Reserve gets the first chance to preserve the held fragment. Only an owned
  // write that still clamps may retire an impossible target.
  if (Math.abs(viewport.scrollTop - target) > 0.5) anchor.top = anchor.element.getBoundingClientRect().top - viewportTop;
}

export function clearDisclosureAnchorReserve(content: HTMLElement | null) {
  if (!content) return;
  const reserve = viewportReserves.get(content);
  if (!reserve) return;
  content.style.paddingTop = reserve.originalTop; content.style.paddingBottom = reserve.originalBottom;
  viewportReserves.delete(content);
}

/** Retire temporary prepend space only when doing so cannot clamp the reader. */
export function releaseDisclosureAnchorReserve(viewport: HTMLElement, content: HTMLElement): void {
  const reserve = viewportReserves.get(content);
  if (!reserve) return;
  const top = viewport.scrollTop;
  const before = Math.min(reserve.before, Math.max(0, top));
  if (before > 0) {
    reserve.before -= before;
    content.style.paddingTop = `${reserve.top + reserve.before}px`;
    viewport.scrollTop = top - before;
    noteProgrammaticScroll(viewport);
  }
  const after = Math.min(reserve.after, Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop));
  if (after > 0) { reserve.after -= after; content.style.paddingBottom = `${reserve.bottom + reserve.after}px`; }
  if (reserve.before === 0 && reserve.after === 0) clearDisclosureAnchorReserve(content);
}

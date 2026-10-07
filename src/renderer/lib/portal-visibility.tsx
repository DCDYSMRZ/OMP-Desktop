import { createContext, useContext, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useBlockingOverlay } from './blocking-overlay';

export const PortalVisibilityContext = createContext(true);
const ModalOwnerContext = createContext<string | null>(null);

export function PortalVisibilityProvider({ visible, children }: { visible: boolean; children: ReactNode }) {
  const parentVisible = useContext(PortalVisibilityContext);
  return <PortalVisibilityContext.Provider value={parentVisible && visible}>{children}</PortalVisibilityContext.Provider>;
}

function PortalSurface({ children, modal = false }: { children: ReactNode; modal?: boolean }) {
  const visible = useContext(PortalVisibilityContext);
  const inheritedOwner = useContext(ModalOwnerContext);
  const id = useId();
  const owner = modal ? id : inheritedOwner;
  return visible ? <ModalOwnerContext.Provider value={owner}><div className="portal-surface" data-modal-owner={owner ?? undefined} data-modal-root={modal ? id : undefined}>{children}</div></ModalOwnerContext.Provider> : null;
}

export function portalToBody(node: ReactNode) {
  return typeof document === 'undefined' ? node : createPortal(<PortalSurface>{node}</PortalSurface>, document.body);
}

export function portalModal(node: ReactNode) {
  return typeof document === 'undefined' ? node : createPortal(<PortalSurface modal>{node}</PortalSurface>, document.body);
}

type ModalEntry = { element: HTMLElement; host: HTMLElement; owner: string | undefined; close: () => void };
const modals: ModalEntry[] = [];
const inerted = new Map<HTMLElement, { inert: boolean; hidden: string | null }>();
const focusSelector = 'button:not(:disabled), input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), a[href], summary, [contenteditable=true], [tabindex]:not([tabindex="-1"])';

export function canRestoreFocus(element: HTMLElement | null | undefined): element is HTMLElement {
  return !!element?.isConnected && !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
}

function ownedHosts(entry: ModalEntry) {
  return Array.from(document.querySelectorAll<HTMLElement>('.portal-surface')).filter(host => host === entry.host || (!!entry.owner && host.dataset.modalOwner === entry.owner));
}

function restoreBackground() {
  for (const [element, previous] of inerted) {
    element.inert = previous.inert;
    if (previous.hidden === null) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', previous.hidden);
  }
  inerted.clear();
}

function syncModalBackground() {
  restoreBackground();
  const top = modals.at(-1);
  if (!top) return;
  const allowed = ownedHosts(top);
  const isolate = (parent: HTMLElement) => {
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (allowed.includes(child)) continue;
      if (allowed.some(host => child.contains(host))) { isolate(child); continue; }
      inerted.set(child, { inert: child.inert, hidden: child.getAttribute('aria-hidden') });
      child.inert = true;
      child.setAttribute('aria-hidden', 'true');
    }
  };
  isolate(document.body);
  modals.forEach((entry, depth) => {
    for (const host of ownedHosts(entry)) {
      host.style.zIndex = `calc(var(--ds-layer-overlay) + ${depth * 2 + (host === entry.host ? 0 : 1)})`;
    }
  });
}

/** One topmost focus boundary; child portals belong to the modal that rendered them. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, { onClose, initialFocus }: { onClose: () => void; initialFocus?: RefObject<HTMLElement | null> }) {
  const visible = useContext(PortalVisibilityContext);
  const latest = useRef(onClose);
  latest.current = onClose;
  useBlockingOverlay(visible);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!visible || !element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const host = element.closest<HTMLElement>('.portal-surface') ?? element;
    const entry: ModalEntry = { element, host, owner: host.dataset.modalOwner, close: () => latest.current() };
    const oldTabIndex = element.getAttribute('tabindex');
    if (oldTabIndex === null) element.tabIndex = -1;
    modals.push(entry);
    syncModalBackground();
    const targets = () => ownedHosts(entry).flatMap(root => Array.from(root.querySelectorAll<HTMLElement>(focusSelector))).filter(canRestoreFocus);
    const focusFirst = () => (targets()[0] ?? element).focus({ preventScroll: true });
    if (canRestoreFocus(initialFocus?.current)) initialFocus.current.focus({ preventScroll: true });
    else focusFirst();
    const onFocus = (event: FocusEvent) => {
      if (modals.at(-1) !== entry || !(event.target instanceof Node)) return;
      if (!ownedHosts(entry).some(root => root.contains(event.target as Node))) focusFirst();
    };
    const onKey = (event: KeyboardEvent) => {
      if (modals.at(-1) !== entry || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); entry.close(); }
      if (event.key !== 'Tab') return;
      const items = targets();
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length) { event.preventDefault(); element.focus(); }
      else if (event.shiftKey && current <= 0) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && (current < 0 || current === items.length - 1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('keydown', onKey);
    const observer = new MutationObserver(syncModalBackground);
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('keydown', onKey);
      const wasTop = modals.at(-1) === entry;
      const index = modals.indexOf(entry);
      if (index !== -1) modals.splice(index, 1);
      if (oldTabIndex === null) element.removeAttribute('tabindex');
      syncModalBackground();
      if (wasTop && canRestoreFocus(previous)) previous.focus({ preventScroll: true });
      else if (wasTop) modals.at(-1)?.element.focus({ preventScroll: true });
    };
  }, [visible, ref, initialFocus]);
}

import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEventHandler, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PortalVisibilityContext, portalToBody } from '../lib/portal-visibility';
import { plainMarkdownLine } from '../lib/markdown-plain';
import { useSurfacePresence } from '../ui/ui';
import { formatSessionRelativeTime, useSessionMinute } from './session-relative-time';
import type { SidebarSession } from './sidebar-session';
import { sidebarStatus } from './sidebar-status';
import { useModelDisplayName } from '../lib/use-model-display-name';

export function SessionPreviewCard({ session, disabled = false, className, onContextMenu, children }: {
  session: SidebarSession;
  disabled?: boolean;
  className: string;
  onContextMenu: MouseEventHandler<HTMLDivElement>;
  children: (preview: { descriptionId?: string; relativeTime: string }) => ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const modelDisplayName = useModelDisplayName();
  const visible = useContext(PortalVisibilityContext);
  const id = useId();
  const row = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const focused = useRef(false);
  const hovered = useRef(false);
  const [requested, setRequested] = useState(false);
  const now = useSessionMinute();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const open = requested && visible && !disabled;
  const { present, leaving } = useSurfacePresence(open);
  const relativeTime = formatSessionRelativeTime(session.updatedAt, i18n.resolvedLanguage || i18n.language, now) ?? t('sidebar.timeUnknown');
  const title = plainMarkdownLine(session.title).replace(/\s+/g, ' ').trim() || t('omp.shell.newSession');
  const status = sidebarStatus(session);
  const statusLabel = status ? t(status === 'running' && session.activity === 'running' && (!session.running || session.closed) ? session.activitySource === 'presence' ? 'sidebar.status.presenceRunning' : 'sidebar.status.observedRunning' : `sidebar.status.${status}`, { time: relativeTime }) : undefined;
  const clearTimer = () => { window.clearTimeout(timer.current); timer.current = undefined; };
  const close = () => { clearTimer(); setRequested(false); };
  const leave = () => {
    hovered.current = false;
    clearTimer();
    if (!focused.current) timer.current = window.setTimeout(() => setRequested(false), 100);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (disabled || !visible) { clearTimer(); setRequested(false); } }, [disabled, visible]);
  useEffect(() => { if (!present) setPosition(null); }, [present]);
  useEffect(() => {
    if (!requested) return;
    const dismiss = () => { clearTimer(); setRequested(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    const visibility = () => { if (document.hidden) dismiss(); };
    window.addEventListener('keydown', key);
    window.addEventListener('blur', dismiss);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [requested]);
  useLayoutEffect(() => {
    if (!open) return;
    const positionCard = () => {
      const anchor = row.current;
      const surface = card.current;
      if (!anchor || !surface) return;
      const rect = anchor.getBoundingClientRect();
      if (!anchor.isConnected || anchor.closest('[inert]') || rect.bottom <= 0 || rect.top >= window.innerHeight) { setRequested(false); return; }
      const width = surface.offsetWidth;
      const height = surface.offsetHeight;
      const preferred = rect.right + 8 + width <= window.innerWidth - 8 ? rect.right + 8 : rect.left - width - 8;
      setPosition({ left: Math.max(8, Math.min(preferred, window.innerWidth - width - 8)), top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)) });
    };
    positionCard();
    const observer = new ResizeObserver(positionCard);
    if (card.current) observer.observe(card.current);
    if (row.current) observer.observe(row.current);
    const scroll = (event: Event) => {
      if (event.target instanceof Node && card.current?.contains(event.target)) return;
      // A scrolled row may be clipped by a project list even when still inside the window.
      setRequested(false);
    };
    window.addEventListener('resize', positionCard);
    window.addEventListener('scroll', scroll, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', positionCard); window.removeEventListener('scroll', scroll, true); };
  }, [open, session]);

  return <div ref={row} data-flip-key={session.runtimeId||session.path||session.id} className={className} onContextMenu={event => { close(); onContextMenu(event); }}
    onPointerEnter={event => {
      if (event.pointerType === 'touch') return;
      hovered.current = true; clearTimer();
      if (!disabled) timer.current = window.setTimeout(() => setRequested(true), 350);
    }} onPointerLeave={leave} onPointerDown={close}
    onFocus={event => {
      if (!(event.target instanceof Element) || !event.target.closest('.thread-item-main')) { close(); return; }
      focused.current = true; clearTimer(); setRequested(true);
    }} onBlur={() => { focused.current = false; if (!hovered.current) close(); }}>
    {children({ descriptionId: open ? id : undefined, relativeTime })}
    {present && visible && portalToBody(<div ref={card} id={id} role="tooltip" aria-hidden={leaving || undefined}
      className={`session-preview-card ui-floating-presence${position ? ' is-open' : ''}${leaving ? ' is-leaving' : ''}`}
      style={position ?? undefined} onPointerEnter={() => { hovered.current = true; clearTimer(); }} onPointerLeave={leave}>
      <div className="session-preview-heading"><strong>{title}</strong>{status && <span className={`session-preview-status ${status}`} title={statusLabel}><span className={`thread-item-status ${status}`} aria-hidden />{t(`sidebar.status.${status}`)}</span>}</div>
      <div className="session-preview-meta"><span className="session-preview-project">{session.cwd || t('sidebar.projectUnknown')}</span><span>{relativeTime}</span></div>
      {session.preview && <section><span className="session-preview-label">{t('sidebar.firstRequest')}</span><p>{plainMarkdownLine(session.preview)}</p></section>}
      {session.lastAssistantExcerpt && <section><span className="session-preview-label">{t('sidebar.lastReply')}</span><p>{plainMarkdownLine(session.lastAssistantExcerpt)}</p></section>}
      <div className="session-preview-footer"><span>{session.modelId && modelDisplayName(session.modelProvider, session.modelId)}</span><span>{t('sidebar.openHint')}</span></div>
    </div>)}
  </div>;
}

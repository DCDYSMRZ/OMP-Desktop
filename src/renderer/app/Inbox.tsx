import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnchoredMenu } from '../ui/AnchoredMenu';
import { IconCheck, IconCircleAlert, IconClock, IconUsers } from '../ui/icons';
import type { InboxItem, InboxKind } from './runtime-store';
import { plainMarkdownLine } from '../lib/markdown-plain';
import { formatElapsed } from '../lib/format-duration';
import { useDisplayPreferences } from '../lib/display-preferences';
import { useFlipList } from '../ui/motion';
import { formatSessionRelativeTime, useSessionMinute } from './session-relative-time';
import { inboxPreview } from './inbox-preview';
import '../styles/inbox.css';

export const inboxLabel: Record<InboxKind, string> = { prompt: 'shell.inboxPrompt', failed: 'shell.inboxFailed', completed: 'shell.inboxCompleted', child: 'shell.inboxChild' };
export function Inbox({ items, sources, onOpen, onRead }: { items: readonly InboxItem[]; sources: Record<string, { title: string; project: string }>; onOpen: (item: InboxItem) => void; onRead: (id?: number) => void }) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  const list = useRef<HTMLDivElement>(null);
  useFlipList(list, items.map(item=>item.id));
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const minute = useSessionMinute();
  const timed = items.some(item => item.kind === 'prompt' && item.deadlineAt !== undefined);
  useEffect(() => {
    if (!open || !timed) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, timed]);
  const unread = items.filter(item => !item.read).length;
  const groups = new Map<string, InboxItem[]>();
  for (const item of [...items].reverse()) { const group = groups.get(item.runtimeId) ?? []; group.push(item); groups.set(item.runtimeId, group); }
  return <AnchoredMenu open={open} onClose={() => setOpen(false)} menuClassName="inbox-menu" role="dialog" label={t('shell.inbox')} align="end" trigger={ref => <button ref={ref} type="button" className="ct-icon-btn inbox-trigger no-drag" aria-label={t('shell.inboxUnread', { count: unread })} title={t('shell.inbox')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}><svg width="var(--icon-ui)" height="var(--icon-ui)" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{unread > 0 && <span className="inbox-badge">{unread > 99 ? '99+' : unread}</span>}</button>}>
    <div className="inbox-heading"><strong>{t('shell.inbox')}</strong><button type="button" disabled={!unread} onClick={() => onRead()}>{t('shell.markAllRead')}</button></div>
    {!items.length && <p className="inbox-empty">{t('shell.inboxEmpty')}</p>}
    <div className="inbox-groups" ref={list}>{[...groups].map(([runtimeId, entries]) => {
      const source = sources[runtimeId];
      const title = plainMarkdownLine(source?.title || t('omp.shell.startingRuntime'));
      return <section key={runtimeId} className="inbox-group" aria-label={title}>{source?.project && <div className="inbox-source" title={source.project}>{source.project.split(/[/\\]/).filter(Boolean).pop()}</div>}
        {entries.map(item => {
          const seconds = item.deadlineAt === undefined ? null : Math.max(0, Math.ceil((item.deadlineAt - now) / 1000));
          const Icon = item.kind === 'completed' ? IconCheck : item.kind === 'child' ? IconUsers : item.kind === 'prompt' ? IconClock : IconCircleAlert;
          const snippet = inboxPreview(item) || t(inboxLabel[item.kind]);
          return <div data-flip-key={item.id} className={`inbox-row inbox-${item.kind}${item.read ? ' is-read' : ''}`} key={item.id}><button type="button" className="inbox-open" aria-label={`${title} · ${t(inboxLabel[item.kind])} · ${snippet}`} onClick={() => { onRead(item.id); setOpen(false); onOpen(item); }}><span className="inbox-kind" title={t(inboxLabel[item.kind])}><Icon size="var(--icon-ui)" /></span><span className="inbox-copy"><strong className="inbox-title" title={title}>{title}</strong><span className="inbox-detail"><span className="inbox-snippet" title={snippet}>{snippet}</span>{seconds !== null && <small>{seconds === 0 ? t('shell.promptExpired') : t('shell.promptRemaining', { time: formatElapsed(seconds*1000,durationStyle,i18n.language) })}</small>}<small title={new Date(item.createdAt).toLocaleString(i18n.language)}>{formatSessionRelativeTime(new Date(item.createdAt).toISOString(),i18n.language,minute)??t('sidebar.timeUnknown')}</small></span></span>{!item.read && <i className="inbox-unread" aria-hidden />}</button>{!item.read && <button type="button" className="inbox-read" aria-label={t('shell.markRead')} title={t('shell.markRead')} onClick={() => onRead(item.id)}><IconCheck size="var(--icon-meta)" /></button>}</div>;
        })}
      </section>;
    })}</div>
  </AnchoredMenu>;
}

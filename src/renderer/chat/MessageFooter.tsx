import { numberFormat } from '../lib/format-number';
import { timeFormats } from '../lib/format-time';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HighlightedCode } from '../ui/Markdown';
import { IconCheck, IconChevronRight, IconCircleAlert, IconCopy, IconFileText } from '../ui/icons';
import { AnchoredMenu } from '../ui/AnchoredMenu';
import '../styles/message-footer.css';
import { messageText, printable, record, text, type ChatMessage } from './model';
import { formatUsageCost, turnUsage, turnUsageTotals, readableNativeData } from './presentation';
import type { NativeSubagent } from '../../shared/contracts';
import { plainMarkdownLine } from '../lib/markdown-plain';
import { useDisplayPreferences } from '../lib/display-preferences';
import { presentUserError } from '../lib/user-errors';
import { useModelDisplayName } from '../lib/use-model-display-name';

export function NativeData({ value }: { value: unknown }) {
  return <HighlightedCode code={printable(readableNativeData(value))} lang="json" />;
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(0), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = error || t(copied ? 'omp.transcript.copied' : 'omp.transcript.copyAnswer');
  return <><button type="button" className={`copy-btn icon${copied ? ' copied' : ''}`} title={label} aria-label={label} onClick={() => { void window.ompDesktop.copyText(value).then(() => { setCopied(Date.now()); setError(''); }, cause => setError(presentUserError(cause).message)); }}>{copied ? <IconCheck size="var(--icon-meta)" /> : error ? <IconCircleAlert size="var(--icon-meta)" /> : <IconCopy size="var(--icon-meta)" />}</button>{error && <span className="message-error" role="alert">{error}</span>}</>;
}


function MessageTime({ timestamp }: { timestamp: unknown }) {
  const { i18n } = useTranslation();
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp), today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const formats = timeFormats(i18n.language);
  return <time className="message-timestamp" dateTime={date.toISOString()} title={formats.exact.format(date)}>{(sameDay ? formats.time : date.getFullYear() === today.getFullYear() ? formats.date : formats.year).format(date)}</time>;
}

function Usage({ rows, agents }: { rows: ChatMessage[]; agents: readonly NativeSubagent[] }) {
  const { t } = useTranslation();
  const modelDisplayName = useModelDisplayName();
  const [open, setOpen] = useState(false);
  const usage = useMemo(() => turnUsageTotals(rows, agents), [rows, agents]);
  const latest = useMemo(() => rows.findLast(row => !!text(row.raw.model)), [rows]);
  if (!latest && usage.tokens === undefined && usage.cost === undefined) return null;
  if (!(usage.tokens && usage.tokens > 0) && !(usage.cost && usage.cost > 0)) return latest ? <span className="message-meta-chip model">{modelDisplayName(text(latest.raw.provider), text(latest.raw.model))}</span> : null;
  const title = t('omp.timeline.turnUsage');
  return <AnchoredMenu open={open} onClose={() => setOpen(false)} className="message-footer-anchor usage-details" menuClassName="message-footer-menu message-usage-menu" role="dialog" label={title} side="top" align="end" trigger={ref => <button ref={ref} type="button" className="message-usage-chips" title={title} aria-label={title} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
    {latest && <span className="message-meta-chip model" title={text(latest.raw.model)}>{modelDisplayName(text(latest.raw.provider), text(latest.raw.model))}</span>}
    {usage.formattedTokens && <span className="message-meta-chip">{t('omp.timeline.turnTokens', { value: usage.formattedTokens })}</span>}
    {usage.formattedCost && <span className="message-meta-chip">{usage.formattedCost}</span>}
    <IconChevronRight size="var(--icon-caption)" className="native-disclosure-caret" aria-hidden />
  </button>}>
    {open && <UsageDetails rows={rows} agents={agents} />}
  </AnchoredMenu>;
}

const UsageDetails = memo(function UsageDetails({ rows, agents }: { rows: ChatMessage[]; agents: readonly NativeSubagent[] }) {
  const { t, i18n } = useTranslation();
  const modelDisplayName = useModelDisplayName();
  const usage = useMemo(() => turnUsage(rows, agents), [rows, agents]);
  const [rawOpen, setRawOpen] = useState(false);
  const numbers = numberFormat(i18n.language);
  const table = useMemo(() => <><p className="message-meta">{usage.formattedTokens} tokens · {usage.formattedCost} · {t('omp.timeline.usageRequests', { count: usage.requests.length })} · {t('omp.timeline.usageAgents', { count: usage.children.length })}</p>
    <div className="usage-table-scroll"><table className="usage-table"><thead><tr><th scope="col">#</th>{['input', 'output', 'cacheRead', 'cacheWrite', 'cost'].map(key => <th scope="col" key={key}>{t(`omp.timeline.usage.${key}`)}</th>)}</tr></thead><tbody>{usage.requests.map(({ row, cost }, index) => <tr key={row.id}><th scope="row" title={modelDisplayName(text(row.raw.provider), text(row.raw.model))}>{index + 1}</th>{['input', 'output', 'cacheRead', 'cacheWrite'].map(key => <td key={key}>{typeof record(row.raw.usage)[key] === 'number' ? numbers.format(Number(record(row.raw.usage)[key])) : '—'}</td>)}<td>{cost === undefined ? '—' : formatUsageCost(cost)}</td></tr>)}</tbody></table></div>
    {usage.children.length > 0 && <div className="usage-agents">{usage.children.map(child => <div key={child.id}><strong>{child.name}</strong><span>{child.tokens === undefined ? t('omp.timeline.usageUnknown') : `${numbers.format(child.tokens)} tokens`}{child.cost !== undefined && ` · ${formatUsageCost(child.cost)}`}</span></div>)}</div>}</>, [usage, t, modelDisplayName, numbers]);
  return <div className="message-action-detail-body">{table}<details className="usage-raw" onToggle={event => setRawOpen(event.currentTarget.open)}><summary>{t('omp.timeline.technicalDetails')}</summary>{rawOpen && <NativeData value={usage.requests.map(({ row }) => row.raw.usage)} />}</details></div>;
});

function SavedSources({ rows, onOpen }: { rows: ChatMessage[]; onOpen?: (reference: string) => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasSources = useMemo(() => rows.some(row => row.resourceReference && row.raw.role !== 'toolResult'), [rows]);
  const content = useMemo(() => {
    if (!open) return null;
    const timeFormat = timeFormats(i18n.language).time;
    return rows.filter(row => row.resourceReference && row.raw.role !== 'toolResult').map((row, index) => {
      const role = text(row.raw.role), timestamp = row.raw.timestamp;
      const time = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timeFormat.format(timestamp) : t('omp.timeline.sourceTimeUnknown');
      const preview = plainMarkdownLine(messageText(row.raw)).slice(0, 72) || (Array.isArray(row.raw.content) ? row.raw.content.map(block => text(record(block).name)).filter(Boolean).join(', ') : '');
      const label = t('omp.timeline.source', { number: index + 1, role: t(`omp.timeline.sourceRole.${role}`, { defaultValue: role }), time, preview });
      return <button type="button" role="menuitem" className="saved-source-action" key={row.id} disabled={!onOpen} onClick={() => { setOpen(false); onOpen?.(row.resourceReference!); }}><IconFileText size="var(--icon-meta)" aria-hidden /><span>{label}</span></button>;
    });
  }, [open, rows, i18n.language, t, onOpen]);
  if (!hasSources) return null;
  return <AnchoredMenu open={open} onClose={() => setOpen(false)} className="message-footer-anchor source-details" menuClassName="message-footer-menu message-source-menu" role="menu" label={t('omp.timeline.more')} side="top" align="end" onMenuKeyDown={event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  }} trigger={ref => <button ref={ref} type="button" className="copy-btn icon" title={t('omp.timeline.more')} aria-label={t('omp.timeline.more')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>⋯</button>}>
    {content}
  </AnchoredMenu>;
}

const noAgents: readonly NativeSubagent[] = [];

/** Time · model · usage · copy · sources, shared by message rows and assistant turns. */
export function MessageFooter({ rows, agents = noAgents, timestamp, copyText, onOpenSessionResource }: { rows: ChatMessage[]; agents?: readonly NativeSubagent[]; timestamp: unknown; copyText?: string; onOpenSessionResource?: (reference: string) => void }) {
  const { messageMeta } = useDisplayPreferences();
  return <div className="message-actions" data-visibility={rows[0]?.raw.role === 'user' ? 'hover' : messageMeta}><MessageTime timestamp={timestamp} /><Usage rows={rows} agents={agents} />{copyText && <CopyButton value={copyText} />}<SavedSources rows={rows} onOpen={onOpenSessionResource} /></div>;
}

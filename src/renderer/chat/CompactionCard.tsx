import { useContext, useId, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapse } from '../ui/Collapse';
import { IconChevronRight, IconLayers } from '../ui/icons';
import { DisclosureAnchor, DisclosureScope, useAutomaticDisclosure } from './disclosure';
import { compactionPreview } from './message-details';
import '../styles/compaction.css';
import { numberFormat, compactNumberFormat } from '../lib/format-number';

export interface CompactionCardProps {
  kind: 'context' | 'branch' | 'handoff';
  identity: string;
  summary: string;
  shortSummary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  children: ReactNode;
  details?: ReactNode;
}

/** Shares transcript disclosure identities and anchors, including search-driven reveals. */
export function CompactionCard({ kind, identity, summary, shortSummary = '', tokensBefore, tokensAfter, children, details }: CompactionCardProps) {
  const { t, i18n } = useTranslation();
  const disclosure = useAutomaticDisclosure(false, identity);
  const anchor = useContext(DisclosureAnchor);
  const bodyId = useId();
  const summaryId = useId();
  const [summaryElement, setSummaryElement] = useState<HTMLDivElement | null>(null);
  const [fullText, setFullText] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const preview = useMemo(() => compactionPreview(shortSummary, summary), [shortSummary, summary]);
  const tokenFormat = compactNumberFormat;
  const label = t(`omp.compaction.${kind}`);
  const before = tokensBefore === undefined ? t('omp.compaction.unknownTokens') : tokenFormat.format(tokensBefore);
  const after = tokensAfter === undefined ? t('omp.compaction.unknownTokens') : tokenFormat.format(tokensAfter);
  useLayoutEffect(() => {
    const element = summaryElement;
    if (!disclosure.open || !element) return;
    const measure = () => { if (!fullText) setOverflowing(element.scrollHeight > Math.min(window.innerHeight * .6, 640) + 1); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [disclosure.open, fullText, summary, summaryElement]);
  const toggleFullText = () => {
    anchor(disclosure.titleRef.current);
    setFullText(value => !value);
  };
  return <section className={`compaction-card${disclosure.open ? ' open' : ''}`} data-compaction-kind={kind}>
    <button type="button" ref={disclosure.titleRef} className="compaction-card-header" aria-label={label} aria-expanded={disclosure.open} aria-controls={bodyId} onClick={disclosure.toggle}>
      <IconLayers size="var(--icon-ui)" /><span className="compaction-card-label">{label}</span>
      <span className="compaction-card-preview" title={preview}>{preview}</span>
      {(tokensBefore !== undefined || tokensAfter !== undefined) && <span className="compaction-card-tokens" title={t('omp.compaction.tokens', { before: tokensBefore === undefined ? t('omp.compaction.unknownTokens') : numberFormat(i18n.language).format(tokensBefore), after: tokensAfter === undefined ? t('omp.compaction.unknownTokens') : numberFormat(i18n.language).format(tokensAfter) })}>{before} → {after}</span>}
      <span className="compaction-card-caret" aria-hidden><IconChevronRight size="var(--icon-meta)" /></span>
    </button>
    <Collapse open={disclosure.open} bodyRef={disclosure.bodyRef} id={bodyId} {...disclosure.bodyEvents}>
      <DisclosureScope disclosure={disclosure}>
        <div className="compaction-card-body">
          <div className={`compaction-card-summary-wrap${overflowing || fullText ? ' is-expandable' : ''}${fullText ? ' is-full' : overflowing ? ' is-capped' : ''}`}>
            <div id={summaryId} ref={setSummaryElement} className={`compaction-card-summary${fullText ? ' is-full' : ''}`} tabIndex={overflowing && !fullText ? 0 : undefined} role="region" aria-label={label}>{children}</div>
          </div>
          {(overflowing || fullText) && <button type="button" className="compaction-card-action" aria-expanded={fullText} aria-controls={summaryId} onClick={toggleFullText}>{t(fullText ? 'omp.compaction.showLess' : 'omp.compaction.showAll')}</button>}
          {details && <div className="compaction-card-details">{details}</div>}
          <div className="compaction-card-footer"><button type="button" className="compaction-card-action" onClick={disclosure.collapse}>{t('omp.compaction.collapse')}</button></div>
        </div>
      </DisclosureScope>
    </Collapse>
  </section>;
}

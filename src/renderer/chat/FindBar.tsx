import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSurfacePresence } from '../ui/ui';
import { AnimatedNumber } from '../ui/motion';

export interface FindBarProps { open: boolean; sequence: number; query: string; current: number; count: number; onQuery: (query: string) => void; onNavigate: (direction: number) => void; onClose: () => void; onSearchAll?: (query: string) => void }
export function FindBar({ open, sequence, query, current, count, onQuery, onNavigate, onClose, onSearchAll }: FindBarProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const presence = useSurfacePresence(open);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus({ preventScroll: true }); input.current?.select();
    return () => {
      const active = document.activeElement, scope = input.current?.closest('[role=search]');
      if ((active === document.body || !!scope?.contains(active)) && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [open, sequence]);
  if (!presence.present) return null;
  return <section className={`transcript-find${presence.leaving ? ' is-leaving' : ''}`} role="search" aria-label={t('omp.find.label')} inert={presence.leaving} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onNavigate(event.shiftKey ? -1 : 1); }
  }}>
    <div className="transcript-find-controls"><input ref={input} value={query} aria-label={t('omp.find.label')} placeholder={t('omp.find.label')} onChange={event => onQuery(event.target.value)} /><output aria-live="polite" aria-atomic="true"><AnimatedNumber value={count ? current + 1 : 0}/>/<AnimatedNumber value={count}/></output><button type="button" disabled={!count} title={t('omp.find.previous')} aria-label={t('omp.find.previous')} onClick={() => onNavigate(-1)}>↑</button><button type="button" disabled={!count} title={t('omp.find.next')} aria-label={t('omp.find.next')} onClick={() => onNavigate(1)}>↓</button><button type="button" title={t('omp.find.close')} aria-label={t('omp.find.close')} onClick={onClose}>×</button></div>
    <div className="transcript-find-scope"><span>{t('omp.find.loaded')}</span>{onSearchAll && <button type="button" onClick={() => onSearchAll(query)}>{t('omp.find.all')}</button>}</div>
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ExtensionRequest, ExtensionResponse } from '../../shared/contracts';
import { useTranslation } from 'react-i18next';
import { useGlassExit } from '../lib/portal-visibility';

export function ExtensionDialog({ request, originLabel, onRespond }: { request: ExtensionRequest; originLabel?: string; onRespond: (response: ExtensionResponse) => Promise<void> }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(request.prefill ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const deadline = typeof request.deadlineAt === 'number' && Number.isFinite(request.deadlineAt) ? request.deadlineAt : null;
  const expired = deadline !== null && Date.now() >= deadline;
  const metadata = request.nativeMetadata;
  const nativeOrigin = typeof request.origin === 'string' ? request.origin : metadata && typeof metadata === 'object' && 'origin' in metadata && typeof metadata.origin === 'string' ? metadata.origin : '';
  const origin = [originLabel, nativeOrigin].filter(Boolean).join(' · ') || t('omp.chat.nativeOrigin');
  const dialog = useRef<HTMLDivElement>(null);
  useGlassExit(dialog, true, true);
  const sent = useRef(false);
  const responder = useRef(onRespond);
  responder.current = onRespond;
  async function respond(answer: Omit<ExtensionResponse, 'id'>) {
    if (sent.current || (deadline !== null && Date.now() >= deadline)) return;
    sent.current = true; setBusy(true); setError('');
    try { await responder.current({ id: request.id, ...answer }); }
    catch (cause) { sent.current = false; setBusy(false); setError(String(cause)); }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('input,textarea,button')?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(<div className="modal-backdrop lg-dialog-backdrop"><div ref={dialog} className="modal native-extension-dialog lg-thick lg-refract lg-sheet lg-sheet-in" role="dialog" aria-modal="true" aria-labelledby={`extension-${request.id}`} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); void respond({ cancelled: true }); }
    if (event.key === 'Tab') {
      const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? []);
      if (!targets.length) return;
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <div className="modal-header"><h2 id={`extension-${request.id}`}>{request.title || t('omp.chat.interaction')}</h2></div>
    <form onSubmit={event => { event.preventDefault(); if (request.method === 'confirm') void respond({ confirmed: true }); else if (request.method !== 'select') void respond({ value }); }}>
      <div className="modal-body">
        <p>{t('omp.chat.origin', { origin })}</p>
        {request.message && <p>{request.message}</p>}
        {deadline === null ? <p>{t('omp.chat.untimed')}</p> : <p><time dateTime={new Date(deadline).toISOString()}>{t('omp.chat.deadline', { time: new Date(deadline).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }) })}</time></p>}
        {request.method === 'select' && <div className="native-extension-options">{request.options?.map((option, index) => <button type="button" className="btn" disabled={busy || expired} key={`${index}:${option}`} onClick={() => void respond({ value: option })}><span>{option}</span>{request.optionDetails?.[index]?.description && <small>{request.optionDetails[index].description}</small>}</button>)}</div>}
        {request.method === 'input' && <input className="input" aria-label={request.title || t('omp.chat.response')} placeholder={request.placeholder} value={value} disabled={busy || expired} onChange={event => setValue(event.target.value)} />}
        {request.method === 'editor' && <textarea className="textarea" aria-label={request.title || t('omp.chat.editor')} rows={12} value={value} disabled={busy || expired} onChange={event => setValue(event.target.value)} />}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><button type="button" className="btn" disabled={busy || expired} onClick={() => void respond({ cancelled: true })}>{t('common.cancel')}</button>
        {request.method === 'confirm' && <button type="button" className="btn" disabled={busy || expired} onClick={() => void respond({ confirmed: false })}>{t('omp.chat.no')}</button>}
        {request.method !== 'select' && <button type="submit" className="btn primary" disabled={busy || expired}>{t(request.method === 'confirm' ? 'omp.chat.confirm' : 'omp.chat.submit')}</button>}
      </div>
    </form>
  </div></div>, document.body);
}

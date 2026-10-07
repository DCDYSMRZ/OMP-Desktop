import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ExtensionRequest, ExtensionResponse } from '../../shared/contracts';
import { useTranslation } from 'react-i18next';
import { portalOverlay, useModalFocus, useOverlayLeaving } from '../ui/ui';
import { displayExtensionOption } from '../app/native-labels';
import { formatElapsed } from '../lib/format-duration';
import { useDisplayPreferences } from '../lib/display-preferences';
import { useSurfaceMotion } from '../ui/motion';
import { extensionPromptHeading } from './extension-prompt';


export function ExtensionDialog({ request, originLabel, inlineRuntimeId, onRespond, onDismiss }: { request: ExtensionRequest; originLabel?: string; inlineRuntimeId?: string; onRespond: (response: ExtensionResponse) => Promise<void>; onDismiss: () => void }) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  const leaving = useOverlayLeaving();
  const heading = extensionPromptHeading(request.title ?? '', request.method);
  const subtitle = request.message && request.message.normalize('NFKC').replace(/\s+/g, ' ').trim() !== heading.title.normalize('NFKC').replace(/\s+/g, ' ').trim() ? request.message : undefined;
  const [value, setValue] = useState(request.prefill ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const deadline = typeof request.deadlineAt === 'number' && Number.isFinite(request.deadlineAt) ? request.deadlineAt : null;
  const [now, setNow] = useState(Date.now);
  const expired = deadline !== null && now >= deadline;
  const remainingSeconds = deadline === null ? 0 : Math.ceil(Math.max(0, deadline - now) / 1000);
  useEffect(() => {
    if (deadline === null || now >= deadline) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(1000, deadline - Date.now())));
    return () => window.clearTimeout(timer);
  }, [deadline, now]);
  const metadata = request.nativeMetadata;
  const nativeOrigin = typeof request.origin === 'string' ? request.origin : metadata && typeof metadata === 'object' && 'origin' in metadata && typeof metadata.origin === 'string' ? metadata.origin : '';
  const origin = nativeOrigin || originLabel || t('shell.promptOrigin');
  const dialog = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!inlineRuntimeId) return;
    const locate = () => setHost(Array.from(document.querySelectorAll<HTMLElement>('[data-question-host]')).find(node => node.dataset.questionHost === inlineRuntimeId) ?? null);
    locate();
    const observer = new MutationObserver(locate); observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [inlineRuntimeId]);
  useEffect(() => {
    if (!host || document.activeElement?.matches('input,textarea,[contenteditable=true]')) return;
    dialog.current?.querySelector<HTMLElement>('button:not(:disabled),input,textarea')?.focus({ preventScroll: true });
  }, [host]);
  useSurfaceMotion(dialog, !leaving, 'scale');
  useSurfaceMotion(backdrop, !leaving);
  const sent = useRef(false);
  const responder = useRef(onRespond);
  responder.current = onRespond;
  async function respond(answer: Omit<ExtensionResponse, 'id'>) {
    if (sent.current || (deadline !== null && Date.now() >= deadline)) return;
    sent.current = true; setBusy(true); setError('');
    try { await responder.current({ id: request.id, ...answer }); }
    catch (cause) { sent.current = false; setBusy(false); setError(String(cause)); }
  }
  const close = () => { if (deadline !== null && Date.now() >= deadline) onDismiss(); else void respond({ cancelled: true }); };
  const body = <div ref={dialog} className={inlineRuntimeId ? 'native-extension-dialog inline-question-card' : 'dialog native-extension-dialog motion-managed'} role={inlineRuntimeId ? 'region' : 'dialog'} data-attention-target={inlineRuntimeId ? request.id : undefined} aria-modal={inlineRuntimeId ? undefined : true} aria-busy={busy || undefined} aria-labelledby={`extension-${request.id}`} onKeyDown={event => {
    if (event.key === 'Escape' && inlineRuntimeId) { event.stopPropagation(); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || request.method !== 'select') return;
    const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.native-extension-options button:not(:disabled)'));
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    if (choices.length) { event.preventDefault(); choices[(index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus(); }
  }}>
    <div className="modal-header"><h2 id={`extension-${request.id}`}>{heading.title || t('omp.chat.interaction')}</h2></div>
    <form onSubmit={event => { event.preventDefault(); if (request.method === 'confirm') void respond({ confirmed: true }); else if (request.method !== 'select') void respond({ value }); }}>
      <div className="modal-body">
        {subtitle && <p className="extension-question extension-question-secondary">{subtitle}</p>}
        <div className="extension-metadata">{!inlineRuntimeId && <span className="extension-origin" title={[originLabel, nativeOrigin].filter(Boolean).join(' · ')}>{origin}</span>}
          {deadline !== null && <time className={expired ? 'extension-expired' : ''} dateTime={new Date(deadline).toISOString()} title={new Date(deadline).toLocaleString(i18n.resolvedLanguage || i18n.language, { dateStyle: 'medium', timeStyle: 'long' })}>{expired ? t('shell.promptExpired') : t('shell.promptRemaining', { time: formatElapsed(remainingSeconds * 1000, durationStyle, i18n.language) })}</time>}
        </div>
        {request.method === 'select' && <div className="native-extension-options">{request.options?.map((option, index) => <button type="button" className="btn" disabled={busy || expired} key={`${index}:${option}`} onClick={() => void respond({ value: option })}><span>{displayExtensionOption(option, t)}</span>{request.optionDetails?.[index]?.description && <small>{request.optionDetails[index].description}</small>}</button>)}</div>}
        {request.method === 'select' && !request.options?.length && <p role="status">{t('omp.chat.noOptions')}</p>}
        {request.method === 'input' && <input className="field-input" aria-label={heading.custom ? t('motion.customResponse') : heading.title || t('omp.chat.response')} placeholder={request.placeholder} value={value} disabled={busy || expired} onChange={event => setValue(event.target.value)} />}
        {request.method === 'editor' && <textarea className="field-textarea" aria-label={heading.custom ? t('motion.customResponse') : heading.title || t('omp.chat.editor')} rows={12} value={value} disabled={busy || expired} onChange={event => setValue(event.target.value)} />}
        {heading.custom && <details className="extension-prompt-context"><summary>{t('motion.promptContext')}</summary><pre>{request.title}</pre></details>}
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">{t('omp.chat.responding')}</p>}
      </div>
      <div className="modal-footer">{(!inlineRuntimeId || expired) && <button type="button" className="btn" disabled={busy && !expired} onClick={close}>{t(expired ? 'common.close' : 'common.cancel')}</button>}
        {!expired && request.method === 'confirm' && <button type="button" className="btn" disabled={busy} onClick={() => void respond({ confirmed: false })}>{t('omp.chat.no')}</button>}
        {!expired && request.method !== 'select' && <button type="submit" className="btn primary" disabled={busy}>{t(request.method === 'confirm' ? 'omp.chat.confirm' : 'omp.chat.submit')}</button>}
      </div>
    </form>
  </div>;
  if (inlineRuntimeId) return host ? createPortal(body, host) : null;
  return portalOverlay(<ModalQuestionFocus dialog={dialog} onClose={close}><div className={`overlay motion-managed motion-dialog-overlay${leaving ? ' is-leaving' : ''}`}><div ref={backdrop} className="motion-dialog-backdrop" aria-hidden />{body}</div></ModalQuestionFocus>);
}
function ModalQuestionFocus({ dialog, onClose, children }: { dialog: RefObject<HTMLDivElement | null>; onClose: () => void; children: ReactNode }) {
  useModalFocus(dialog, { onClose });
  return children;
}

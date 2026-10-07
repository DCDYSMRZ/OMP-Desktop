import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { submissions, submissionReceiptVisible } from './submissions';

export function SubmissionReceipts({ runtimeId }: { runtimeId: string }) {
  const { t } = useTranslation();
  const [copyError, setCopyError] = useState('');
  const allReceipts = useSyncExternalStore(submissions.subscribe, submissions.getSnapshot);
  const [now, setNow] = useState(Date.now);
  const receipts = allReceipts.filter(item => item.runtimeId === runtimeId && submissionReceiptVisible(item, now));
  useEffect(() => {
    const next = allReceipts.reduce((deadline, item) => item.runtimeId === runtimeId && item.status === 'submitting' && item.submittedAt + 3000 > now ? Math.min(deadline, item.submittedAt + 3000) : deadline, Infinity);
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [allReceipts, runtimeId, now]);
  if (!receipts.length) return null;
  return <details className="composer-status native-disclosure">
    <summary>{t('composer.submissionDetails')}{receipts.some(item => item.status === 'error') && <> · {t('omp.intent.status.error')}</>}</summary>
    <p>{t('omp.intent.explanation')}</p>
    {copyError && <p role="alert">{copyError}</p>}
    <div style={{ maxHeight: 240, overflow: 'auto' }}>{receipts.map(item => <section key={item.id}>
      <strong role={item.status === 'error' ? 'alert' : undefined}>{t(`omp.intent.status.${item.status}`)}</strong>
      <small> · {item.input.mode ?? 'prompt'} · {item.sessionId}</small>
      {item.sessionSettled === false && <span> · {t('omp.intent.unsettled')}</span>}
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.input.text}</pre>
      {!!item.input.attachmentIds?.length && <p>{t('omp.intent.attachments', { count: item.input.attachmentIds.length })}</p>}
      {item.error && <p role="alert">{item.error}</p>}
      <button type="button" onClick={() => { void window.ompDesktop.copyText(item.input.text).catch(cause => setCopyError(cause instanceof Error ? cause.message : String(cause))); }}>{t('omp.intent.copy')}</button>
      <button type="button" disabled={item.status === 'submitting'} onClick={() => submissions.dismiss(item.id)}>{t('omp.intent.dismiss')}</button>
    </section>)}</div>
  </details>;
}

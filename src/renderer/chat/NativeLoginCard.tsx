import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/ui';
import { presentUserError } from '../lib/user-errors';

export function NativeLoginCard({ details, checking, onRecheck, active = true }: { details?: string; checking: boolean; onRecheck: () => void; active?: boolean }) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<unknown>();
  const loginOpened = useRef(false);
  useEffect(() => {
    const focus = () => { if (active && loginOpened.current) { loginOpened.current = false; onRecheck(); } };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [active, onRecheck]);
  const login = async () => {
    setOpening(true); setError(undefined);
    try { await window.ompDesktop.openNativeLogin(); loginOpened.current = true; }
    catch (cause) { setError(cause); }
    finally { setOpening(false); }
  };
  return <section className="home-readiness native-login-card" aria-label={t('composer.noModel')}>
    <h2>{t('composer.noModel')}</h2>
    <div className="native-login-actions" aria-live="polite"><Button variant="primary" disabled={opening || checking} onClick={() => void login()}>{t('composer.terminalLogin')}</Button><Button disabled={opening || checking} onClick={onRecheck}>{t(checking ? 'composer.rechecking' : 'composer.recheck')}</Button></div>
    <p>{t('composer.apiKeyHint')}</p>
    {error !== undefined && <p role="alert">{presentUserError(error).message}</p>}
    {(details || error !== undefined) && <details><summary>{t('home.details')}</summary><pre>{error !== undefined ? String(error) : details}</pre></details>}
  </section>;
}

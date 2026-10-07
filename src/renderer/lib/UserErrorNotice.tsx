import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { presentUserError, type UserError } from './user-errors';

export interface UserErrorNoticeProps {
  error: unknown;
  presentation?: UserError;
  context?: 'turn' | 'compaction' | 'operation';
  operation?: string;
  onRetry?: () => void;
  onOpenSettings?: () => void;
  actions?: ReactNode;
  details?: unknown;
}

/** The same error anatomy inside a turn, toast, or transcript notice. */
export function UserErrorNotice({ error, presentation, context = 'operation', operation, onRetry, onOpenSettings, actions, details }: UserErrorNoticeProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const presented = presentation ?? presentUserError(error);
  const title = presented.kind !== 'generic' ? presented.message : operation || t(context === 'turn' ? 'omp.errors.turnFailed' : context === 'compaction' ? 'omp.errors.compactionFailedTitle' : 'omp.errors.generic');
  const specificAdvice = presented.kind !== 'generic' && presented.kind !== 'runtime' ? presented.action : '';
  const technical = details === undefined ? presented.details : typeof details === 'string' ? details : JSON.stringify(details, null, 2);
  return <div className="user-error-notice" role="alert">
    <p className="user-error-title">{title}</p>
    {presented.nativeMessage && <p className="user-error-native selectable">omp：{presented.nativeMessage}</p>}
    {specificAdvice && <p className="user-error-advice">{specificAdvice}</p>}
    {(onRetry || onOpenSettings || actions || technical) && <div className="user-error-actions">
      {onRetry && <button type="button" onClick={onRetry}>{t('omp.timeline.retryTurn')}</button>}
      {onOpenSettings && ['provider', 'credentials', 'connection', 'thinking', 'rateLimit', 'quota'].includes(presented.kind) && <button type="button" onClick={onOpenSettings}>{t('omp.timeline.openSettings')}</button>}
      {actions}
      {technical && <button type="button" className="user-error-details-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>{t('omp.errors.details')} <span aria-hidden>{expanded ? '⌄' : '›'}</span></button>}
    </div>}
    {expanded && technical && <pre id={detailsId} className="user-error-details selectable">{technical}</pre>}
  </div>;
}

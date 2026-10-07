import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Attachment } from '../../../shared/contracts';
import { IconFileText, IconImage, IconCircleAlert, IconClose } from '../../ui/icons';
import { formatAttachmentSize } from './catalog';
import type { PreviewOrigin } from '../ImagePreview';
import { presentUserError } from '../../lib/user-errors';

export interface RejectedAttachment { id: string; name: string; size: number; kind: 'image' | 'text'; reason: string }
export function AttachmentChip({ item, expired, busy, onPreview, onRemove, onReattach }: { item: Attachment | RejectedAttachment; expired?: boolean; busy?: boolean; onPreview?: (origin: PreviewOrigin) => void; onRemove: () => void; onReattach?: () => void }) {
  const { t } = useTranslation();
  const [dimensions, setDimensions] = useState('');
  const rejected = 'reason' in item;
  const preview = 'previewUrl' in item ? item.previewUrl : undefined;
  const Icon = item.kind === 'image' ? IconImage : IconFileText;
  return <div data-flip-key={item.id} className={`composer-chip composer-attachment${expired || rejected ? ' is-expired' : ''}`}>
    {preview ? <button className="composer-attachment-preview" aria-label={`${t('chat.imagePreview.title')}: ${item.name}`} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); onPreview?.({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); }}><img src={preview} alt="" onLoad={event => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} /></button> : <Icon size="var(--icon-heading)" aria-hidden="true" />}
    <span className="composer-attachment-copy"><strong title={item.name}>{item.name}</strong><span>{t(item.kind === 'image' ? 'composer.image' : 'composer.file')} · {formatAttachmentSize(item.size)}{dimensions && ` · ${dimensions}`}</span>
      {rejected && <span className="composer-attachment-error" role="alert"><IconCircleAlert size="var(--icon-caption)" />{presentUserError(item.reason).message}<details><summary>{t('home.details')}</summary>{item.reason}</details></span>}
      {expired && <span className="composer-attachment-error">{t('omp.chat.attachmentExpired')}</span>}
    </span>
    {expired && onReattach && <button disabled={busy} onClick={onReattach}>{t('omp.chat.reattach')}</button>}
    <button className="composer-chip-remove" aria-label={t('chat.removeFileReference', { name: item.name })} disabled={busy} onClick={onRemove}><IconClose size="var(--icon-caption)" /></button>
  </div>;
}

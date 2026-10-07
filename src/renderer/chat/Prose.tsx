import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Markdown, type MarkdownImageMarkers } from '../ui/Markdown';
import { useSmoothText } from './useSmoothText';
import { sessionResourceReferences } from './message-details';
import type { BodyProps } from './body-props';

export function Prose({ source, cwd, onOpenFile, onOpenSessionResource, thinking = false, streaming = false, imageMarkers }: BodyProps & { source: string; thinking?: boolean; streaming?: boolean; imageMarkers?: MarkdownImageMarkers }) {
  const { source: displaySource, reveal } = useSmoothText(source, streaming);
  const references = useMemo(() => sessionResourceReferences(displaySource), [displaySource]);
  return <div className={`prose-chat${thinking ? ' thinking-prose' : ''}`}><Markdown source={displaySource} streaming={streaming || displaySource.length < source.length} reveal={reveal} renderDiagrams={!thinking} baseDir={cwd} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} imageMarkers={imageMarkers} />{references.length > 0 && <div className="message-attachments">{references.map(reference => <ResourceButton key={reference} reference={reference} onOpen={onOpenSessionResource} label={reference} />)}</div>}</div>;
}

export function ResourceButton({ reference, onOpen, label }: { reference: string; onOpen?: (reference: string) => void; label?: string }) {
  const { t } = useTranslation();
  return <button type="button" className="composer-chip chat-file-chip" disabled={!onOpen} title={onOpen ? reference : t('omp.chat.sourceUnavailable')} onClick={() => onOpen?.(reference)}>{label || t('omp.timeline.fullContent')}</button>;
}

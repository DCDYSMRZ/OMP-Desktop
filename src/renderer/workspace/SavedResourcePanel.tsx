import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionResourcePage } from '../../shared/contracts';
import { ImagePreview } from '../chat/ImagePreview';
import { partitionSourceDiagnostics } from '../chat/message-details';
import { HighlightedCode } from '../ui/Markdown';
import { IconChevronLeft, IconChevronRight } from '../ui/icons';
import { Button, TooltipButton } from '../ui/ui';

interface ReadingState { index: number; cursors: (string | undefined)[]; positions: { top: number; left: number }[] }
// Retain navigation metadata, never an accumulating copy of saved output.
const readingStates = new Map<string, ReadingState>();

interface SavedResourcePanelProps {
  resourceId: string;
  parentPath?: string;
  subagentId?: string;
  leafId?: string | null;
  reference?: string;
  visible: boolean;
  onName: (resourceId: string, name: string) => void;
  onOpenSessionResource?: (reference: string) => void;
}

export function SavedResourcePanel({ resourceId, parentPath, subagentId, leafId, reference, visible, onName, onOpenSessionResource }: SavedResourcePanelProps) {
  const { t } = useTranslation();
  const readingKey = JSON.stringify({ parentPath, subagentId, leafId, reference });
  const reading = useRef<ReadingState>(readingStates.get(readingKey) ?? { index: 0, cursors: [undefined], positions: [] });
  const [index, setIndex] = useState(reading.current.index);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<SessionResourcePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [imageError, setImageError] = useState(false);
  const [preview, setPreview] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const missingSource = !parentPath || !reference;

  useEffect(() => () => {
    readingStates.delete(readingKey); readingStates.set(readingKey, reading.current);
    if (readingStates.size > 64) readingStates.delete(readingStates.keys().next().value!);
  }, [readingKey]);

  useEffect(() => {
    let active = true;
    ready.current = false; setLoading(true); setPage(null); setError(''); setImageError(false); setPreview(false);
    if (!parentPath || !reference) { setLoading(false); return; }
    const cursor = reading.current.cursors[index];
    void window.ompDesktop.readSessionArtifact({ parentPath, reference, ...(subagentId === undefined ? {} : { subagentId }), ...(leafId === undefined ? {} : { leafId }), ...(cursor === undefined ? {} : { cursor }) }).then(value => {
      if (!active) return;
      // A changed continuation invalidates only forward navigation, not the current reading anchor.
      if (reading.current.cursors[index + 1] !== value.nextCursor) {
        reading.current.cursors.length = index + 1;
        reading.current.positions.length = Math.min(reading.current.positions.length, index + 1);
      }
      setPage(value); setLoading(false);
    }, cause => { if (active) { setError(String(cause)); setLoading(false); } });
    return () => { active = false; };
  }, [parentPath, subagentId, leafId, reference, index, attempt]);
  useEffect(() => { if (page?.name) onName(resourceId, page.name); }, [page?.name, resourceId, onName]);

  const restorePosition = () => {
    const node = scrollRef.current;
    if (!node || !visible || !page || loading) return;
    const position = reading.current.positions[index];
    node.scrollTop = position?.top ?? 0; node.scrollLeft = position?.left ?? 0;
    ready.current = true;
  };
  useLayoutEffect(restorePosition, [visible, page, loading, index]);
  useEffect(() => { if (!visible) setPreview(false); }, [visible]);

  const navigate = (next: number) => {
    ready.current = false; setLoading(true); setPreview(false);
    reading.current.index = next; setIndex(next);
  };
  const restart = () => {
    reading.current = { index: 0, cursors: [undefined], positions: [] };
    ready.current = false; setLoading(true); setIndex(0); setAttempt(value => value + 1);
  };
  const repeatedCursor = !!page?.nextCursor && reading.current.cursors.slice(0, index + 1).includes(page.nextCursor);
  // Only backend-provided raster bytes are previewed; saved text is never interpreted as HTML, links or remote images.
  const imageSource = page?.kind === 'image' && /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i.test(page.dataUrl ?? '') ? page.dataUrl : undefined;
  const earlier = t('omp.resource.earlier', { defaultValue: 'Earlier page' });
  const later = t('omp.resource.later', { defaultValue: 'Later page' });
  const diagnostics = partitionSourceDiagnostics(page?.diagnostics ?? []);

  return <section className="file-viewer saved-resource-panel" aria-label={t('omp.resource.title', { defaultValue: 'Saved output' })}>
    <header className="file-viewer-header"><span className="file-viewer-path" title={page?.name ?? reference}>{page?.name ?? t('omp.resource.title', { defaultValue: 'Saved output' })}</span>{page && (diagnostics.material.length > 0 || imageError) && <Button disabled={loading} onClick={() => setAttempt(value => value + 1)}>{t('omp.resource.retry', { defaultValue: 'Retry' })}</Button>}</header>
    <div ref={scrollRef} className="file-viewer-body saved-resource-body" tabIndex={0} aria-busy={loading} onScroll={event => {
      if (visible && ready.current && !loading) reading.current.positions[index] = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft };
    }}>
      {loading ? <p className="file-tree-note" role="status">{t('omp.resource.loading', { defaultValue: 'Loading saved output…' })}</p> : missingSource ? <p className="file-tree-note" role="alert">{t('omp.resource.missingSource', { defaultValue: 'Saved output requires an authorized parent session and reference.' })}</p> : error ? <div className="saved-resource-notice"><p role="alert">{error}</p><Button onClick={() => setAttempt(value => value + 1)}>{t('omp.resource.retry', { defaultValue: 'Retry' })}</Button></div> : page && <>
        <details className="saved-resource-source"><summary>{page.sourceLabel}</summary><div>{parentPath}</div><code>{reference}</code>{diagnostics.information.map(message => <p key={message}>{message}</p>)}</details>
        {diagnostics.material.length > 0 && <ul className="saved-resource-diagnostics" aria-live="polite">{diagnostics.material.map(message => <li key={message}>{message}</li>)}</ul>}
        {!!page.imageReferences?.length && <div className="message-attachments">{page.imageReferences.map((image, index) => <button type="button" key={image.reference} className="composer-chip chat-file-chip" disabled={!onOpenSessionResource} title={image.reference} onClick={() => onOpenSessionResource?.(image.reference)}>{t('omp.chat.viewSavedImage')}{page.imageReferences!.length > 1 ? ` ${index + 1}` : ''}</button>)}</div>}
        {page.kind === 'text' ? page.content ? <pre className="file-viewer-code saved-resource-code"><code><HighlightedCode code={page.content} /></code></pre> : <p className="file-tree-note">{t('omp.resource.empty', { defaultValue: 'This saved text page is empty.' })}</p> : page.kind === 'image' ? imageSource && !imageError ? <div className="file-viewer-image"><button type="button" className="saved-resource-image" aria-label={t('omp.resource.preview', { defaultValue: 'Enlarge saved image' })} onClick={() => setPreview(true)}><img src={imageSource} alt={page.name} onLoad={restorePosition} onError={() => setImageError(true)} /></button></div> : <p className="file-tree-note" role="alert">{imageError ? t('omp.resource.imageError', { defaultValue: 'The saved image could not be decoded.' }) : t('omp.resource.imageUnavailable', { defaultValue: 'The saved image is unavailable or exceeds the preview limit.' })}</p> : <p className="file-tree-note">{t('omp.resource.binary', { defaultValue: 'Binary saved output cannot be displayed as text.' })}</p>}
        {repeatedCursor && <p className="saved-resource-notice" role="alert">{t('omp.resource.cursorError', { defaultValue: 'The source returned a repeated page cursor. Read from the beginning to reload it.' })}</p>}
      </>}
    </div>
    <footer className="file-viewer-header saved-resource-navigation">
      <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={earlier} ariaLabel={earlier} disabled={loading || index === 0} onClick={() => navigate(index - 1)}><IconChevronLeft size={16} /></TooltipButton>
      <div className="saved-resource-page" role="status"><span>{t('omp.resource.page', { defaultValue: 'Page {{page}}', page: index + 1 })}</span>{page && !loading && <span>{page.nextCursor ? t('omp.resource.more', { defaultValue: 'More saved output available' }) : t('omp.resource.end', { defaultValue: 'Last available page' })}</span>}</div>
      <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={later} ariaLabel={later} disabled={loading || !page?.nextCursor || repeatedCursor} onClick={() => { if (page?.nextCursor) { reading.current.cursors[index + 1] = page.nextCursor; navigate(index + 1); } }}><IconChevronRight size={16} /></TooltipButton>
      {(error || repeatedCursor) && !missingSource && <Button disabled={loading} onClick={restart}>{t('omp.resource.restart', { defaultValue: 'Read from beginning' })}</Button>}
    </footer>
    {preview && visible && imageSource && page && <ImagePreview source={imageSource} name={page.name} onClose={() => setPreview(false)} />}
  </section>;
}

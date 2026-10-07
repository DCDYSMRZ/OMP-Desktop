import { useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeView } from '../../ui/CodeView';
import { Collapse } from '../../ui/Collapse';
import { IconCheck, IconCircleAlert, IconCircleDashed, IconCircleSlash, IconCircleX, IconChevronRight } from '../../ui/icons';
import { DisclosureAnchor, DisclosureScope, useAutomaticDisclosure } from '../disclosure';
import { formatFileTarget, type FileTarget } from '../../lib/file-target';
import { useFileObject } from '../../lib/file-object';
import { visibleImage } from '../message-details';
import { object, string, resultImages } from './tool-model';
import { ImagePreview, type PreviewImage, type PreviewOrigin } from '../ImagePreview';
import type { BodyProps } from '../body-props';

export function FileLink({ file, onOpenFile, children }: { file: FileTarget; onOpenFile: BodyProps['onOpenFile']; children?: ReactNode }) {
  const { t } = useTranslation(), target = formatFileTarget(file), files = useFileObject('');
  return <button type="button" className="tool-file-link" title={t('tools.openCurrentFile')} {...files.dragProps(target)} onContextMenu={event => files.contextMenu(target, event)} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) { if (event.key === ' ') files.quickLook(target); else files.openInEditor(target); } } }} onClick={event => { event.stopPropagation(); onOpenFile(target); }}>{children ?? target}</button>;
}
export function Literal({ children, className = '' }: { children: string; className?: string }) {
  return children ? <pre className={`tool-literal ${className}`}>{children}</pre> : null;
}
export function DetailFold({ identity, title, children, automatic = false }: { identity: string; title: ReactNode; children: ReactNode; automatic?: boolean }) {
  const disclosure = useAutomaticDisclosure(automatic, identity), anchor = useContext(DisclosureAnchor), id = useId();
  return <DisclosureScope disclosure={disclosure}><button type="button" ref={disclosure.titleRef} className="tool-detail-toggle" aria-expanded={disclosure.open} aria-controls={id} onClick={() => { anchor(disclosure.titleRef.current); disclosure.toggle(); }}>{title}<IconChevronRight size="var(--icon-meta)" className={disclosure.open ? 'is-open' : ''} /></button><Collapse id={id} open={disclosure.open} bodyRef={disclosure.bodyRef} {...disclosure.bodyEvents}>{children}</Collapse></DisclosureScope>;
}
export function BoundedCode({ code, limit, lang, identity }: { code: string; limit: number; lang?: string; identity: string }) {
  const { t } = useTranslation();
  const disclosure = useAutomaticDisclosure(false, identity), anchor = useContext(DisclosureAnchor), id = useId();
  const lines = code.replace(/\n$/, '').split('\n');
  if (lines.length <= limit) return <CodeView code={code} lang={lang} maxHeight={360} />;
  return <DisclosureScope disclosure={disclosure}><CodeView code={lines.slice(0, limit).join('\n')} lang={lang} /><Collapse id={id} open={disclosure.open} bodyRef={disclosure.bodyRef} {...disclosure.bodyEvents}><CodeView code={lines.slice(limit).join('\n')} startLine={limit + 1} lang={lang} maxHeight={360} /></Collapse><button type="button" className="tool-detail-toggle" ref={disclosure.titleRef} aria-expanded={disclosure.open} aria-controls={id} onClick={() => { anchor(disclosure.titleRef.current); disclosure.toggle(); }}>{t(disclosure.open ? 'tools.collapse' : 'tools.expandAll', { count: lines.length })}</button></DisclosureScope>;
}
export function StatusIcon({ status }: { status: string }) {
  if (status === 'running' || status === 'in_progress') return <span className="ui-live-dot" />;
  if (status === 'completed' || status === 'complete') return <IconCheck size="var(--icon-meta)" />;
  if (status === 'failed' || status === 'error') return <IconCircleX size="var(--icon-meta)" />;
  if (status === 'blocked') return <IconCircleAlert size="var(--icon-meta)" />;
  if (status === 'abandoned' || status === 'cancelled' || status === 'interrupted') return <IconCircleSlash size="var(--icon-meta)" />;
  return <IconCircleDashed size="var(--icon-meta)" />;
}
export function ResultImages({ result, onOpenSessionResource }: { result: unknown; onOpenSessionResource?: BodyProps['onOpenSessionResource'] }) {
  const { t } = useTranslation(), identity = useId();
  const [preview, setPreview] = useState<{ index: number; origin: PreviewOrigin } | null>(null);
  const images = useMemo(() => resultImages(result).map(block => ({ block: object(block), image: visibleImage(block)! })), [result]);
  const resolvedPath = string(object(object(result).details).resolvedPath);
  const gallery: PreviewImage[] = images.flatMap(({ block, image }) => image.dataUrl ? [{ source: image.dataUrl, name: string(block.alt) || t('tools.image'), ...(images.length === 1 && resolvedPath ? { path: resolvedPath } : {}) }] : []);
  let availableIndex = 0;
  return <><div className="tool-images">{images.map(({ block, image }, index) => {
    if (!image.dataUrl) return <div key={index} className="tool-note">{t(image.deferred ? 'tools.imageDeferred' : 'tools.imageUnavailable')}{image.deferred && onOpenSessionResource && <button className="tool-toolbar-button" type="button" onClick={() => onOpenSessionResource(string(block.resourceReference))}>{t('tools.fullOutput')}</button>}{image.reason && <DetailFold identity={`tool-image-reason:${identity}:${index}`} title={t('tools.details')}><Literal>{image.reason}</Literal></DetailFold>}</div>;
    const galleryIndex = availableIndex++;
    return <button key={index} type="button" className="tool-image-thumbnail" aria-label={t('tools.openImage', { index: galleryIndex + 1 })} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setPreview({ index: galleryIndex, origin: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }); }}><img className="tool-image" loading="lazy" decoding="async" src={image.dataUrl} alt={string(block.alt) || t('tools.image')} /></button>;
  })}</div>{preview && gallery[preview.index] && <ImagePreview source={gallery[preview.index].source} name={gallery[preview.index].name} images={gallery} initialIndex={preview.index} origin={preview.origin} onClose={() => setPreview(null)} />}</>;
}
export function ErrorBlock({ text }: { text: string }) {
  const [first, ...rest] = text.split('\n');
  return <div className="tool-error" role="note"><strong>{first}</strong>{rest.length > 0 && <Literal>{rest.join('\n')}</Literal>}</div>;
}

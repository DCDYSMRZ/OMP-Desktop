import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { IconClose } from '../ui/icons';
import { useTranslation } from 'react-i18next';
import { portalOverlay, useModalFocus } from '../ui/ui';
import '../styles/tools.css';
import { useFileObject } from '../lib/file-object';
import { animateTo, motion, useReducedMotion } from '../ui/motion';

export interface PreviewImage { source: string; name: string; path?: string; cwd?: string }
export interface PreviewOrigin { x: number; y: number; width: number; height: number }
export interface ImagePreviewProps extends PreviewImage { onClose: () => void; images?: readonly PreviewImage[]; initialIndex?: number; origin?: PreviewOrigin }
export function ImagePreview({ source, name, path, cwd, onClose, images, initialIndex = 0, origin }: ImagePreviewProps) {
  const { t } = useTranslation();
  const gallery = images?.length ? images : [{ source, name, path, cwd }];
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, gallery.length - 1)));
  const current = gallery[Math.min(index, gallery.length - 1)];
  const files = useFileObject(current.cwd || '');
  const button = useRef<HTMLButtonElement>(null), overlay = useRef<HTMLDivElement>(null);
  useModalFocus(overlay, { onClose, initialFocus: button });
  const move = (delta: number) => setIndex(value => Math.max(0, Math.min(gallery.length - 1, value + delta)));
  return portalOverlay(<div ref={overlay} className="tool-image-viewer" role="dialog" aria-modal="true" aria-label={current.name} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1); } }}><header className="tool-viewer-header"><span>{current.name}</span>{gallery.length > 1 && <span aria-live="polite">{index + 1} / {gallery.length}</span>}{current.path && <button type="button" onClick={() => files.reveal(current.path!)}>{t('objects.reveal')}</button>}<button ref={button} type="button" aria-label={t('common.close')} onClick={onClose}><IconClose size="var(--icon-heading)" /></button></header>
    <ImageCanvas key={current.source} image={current} origin={index === initialIndex ? origin : undefined} />
    {gallery.length > 1 && <nav className="tool-viewer-filmstrip" aria-label={t('tools.gallery')}><button type="button" disabled={index === 0} aria-label={t('tools.previousImage')} onClick={() => move(-1)}>←</button>{gallery.map((image, i) => <button type="button" key={`${image.source}:${i}`} aria-label={t('tools.openImage', { index: i + 1 })} aria-pressed={i === index} onClick={() => setIndex(i)}><img src={image.source} alt={image.name} loading="lazy" /></button>)}<button type="button" disabled={index === gallery.length - 1} aria-label={t('tools.nextImage')} onClick={() => move(1)}>→</button></nav>}
  </div>);
}

function ImageCanvas({ image, origin }: { image: PreviewImage; origin?: PreviewOrigin }) {
  const { t } = useTranslation();
  const stage = useRef<HTMLDivElement>(null), frame = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion(), entered = useRef(false);
  const [failed, setFailed] = useState(false), [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0, fit: true });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const fit = dimensions.width ? Math.min(1, viewport.width / dimensions.width, viewport.height / dimensions.height) : 1;
  const zoom = view.fit ? fit : view.zoom;
  const bound = (value: number, extent: number) => Math.max(-extent, Math.min(extent, value));
  const limitX = Math.max(0, (dimensions.width * zoom - viewport.width) / 2), limitY = Math.max(0, (dimensions.height * zoom - viewport.height) / 2);
  const x = bound(view.x, limitX), y = bound(view.y, limitY);
  const zoomAt = (next: number, px = 0, py = 0) => {
    const scale = Math.max(Math.min(fit, 0.1), Math.min(8, next));
    setView({ zoom: scale, fit: false, x: bound(px - (px - x) * scale / zoom, Math.max(0, (dimensions.width * scale - viewport.width) / 2)), y: bound(py - (py - y) * scale / zoom, Math.max(0, (dimensions.height * scale - viewport.height) / 2)) });
  };
  const wheelHandler = useRef<((event: WheelEvent) => void) | null>(null);
  wheelHandler.current = event => { event.preventDefault(); const rect = stage.current!.getBoundingClientRect(); zoomAt(zoom * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX - rect.x - rect.width / 2, event.clientY - rect.y - rect.height / 2); };
  useLayoutEffect(() => {
    const element = stage.current!;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }));
    observer.observe(element);
    const wheel = (event: WheelEvent) => wheelHandler.current?.(event);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, []);
  useLayoutEffect(() => {
    if (!frame.current || !dimensions.width || viewport.width <= 1 || entered.current) return;
    entered.current = true;
    const rect = frame.current.getBoundingClientRect();
    const start = origin ? `translate(${origin.x + origin.width / 2 - rect.x - rect.width / 2}px, ${origin.y + origin.height / 2 - rect.y - rect.height / 2}px) scale(${Math.max(0.01, origin.width / rect.width)}, ${Math.max(0.01, origin.height / rect.height)})` : 'scale(.97)';
    animateTo(frame.current, reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: start }, { opacity: 1, transform: 'none' }], { duration: reduced ? motion.reduced : motion.gentle, easing: motion.spring });
  }, [dimensions.width, dimensions.height, origin, viewport.width, viewport.height, reduced]);
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
    if (other) {
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      if (before > 0) zoomAt(zoom * after / before);
    } else setView(value => ({ ...value, x: bound(x + event.clientX - previous.x, limitX), y: bound(y + event.clientY - previous.y, limitY) }));
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  return <><div className="tool-viewer-toolbar"><button type="button" aria-pressed={view.fit} onClick={() => setView({ zoom: fit, x: 0, y: 0, fit: true })}>{t('tools.fitImage')}</button><button type="button" aria-pressed={!view.fit && zoom === 1} onClick={() => setView({ zoom: 1, x: 0, y: 0, fit: false })}>100%</button><button type="button" aria-label={t('tools.zoomOut')} onClick={() => zoomAt(zoom / 1.25)}>−</button><output>{Math.round(zoom * 100)}%</output><button type="button" aria-label={t('tools.zoomIn')} onClick={() => zoomAt(zoom * 1.25)}>+</button>{dimensions.width > 0 && <span>{dimensions.width} × {dimensions.height}</span>}</div>
    <div ref={stage} className={`tool-viewer-stage${limitX || limitY ? ' is-zoomed' : ''}`} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); }} onPointerMove={pointerMove} onPointerUp={event => pointers.current.delete(event.pointerId)} onPointerCancel={event => pointers.current.delete(event.pointerId)} onLostPointerCapture={event => pointers.current.delete(event.pointerId)} onDoubleClick={() => setView({ zoom: 1, x: 0, y: 0, fit: !view.fit })}>
      {failed ? <p role="alert">{t('omp.chat.imageUnavailable', { defaultValue: 'This image could not be displayed.' })}</p> : <div ref={frame} className="tool-viewer-image-frame" style={{ width: dimensions.width * zoom || undefined, height: dimensions.height * zoom || undefined }}><img src={image.source} alt={image.name} draggable={false} onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)} style={{ width: dimensions.width || undefined, height: dimensions.height || undefined, transform: `translate(${x}px, ${y}px) scale(${zoom})` }} /></div>}
    </div></>;
}

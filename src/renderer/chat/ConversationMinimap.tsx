import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { buildConversationMinimapMarkers } from '../lib/conversation-minimap';
import { messageText } from './model';
import { projectTurnProcess, type TranscriptEntry } from './presentation';

export function ConversationMinimap({ entries, scrollRef, contentRef, overflows, atBottom, onJump }: {
  entries: readonly TranscriptEntry[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  overflows: boolean;
  atBottom: boolean;
  onJump: (id: string) => void;
}) {
  const { t } = useTranslation();
  const rail = useRef<HTMLElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const centers = useRef<{ element: HTMLButtonElement; center: number }[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [active, setActive] = useState<string>();
  const previewId = useId();
  const markers = useMemo(() => buildConversationMinimapMarkers(entries.map(entry => {
    if (entry.kind !== 'assistant-turn') return { id: entry.id, role: entry.row.raw.role, content: messageText(entry.row.raw) };
    const answers = projectTurnProcess(entry).responses.flatMap(part => part.kind === 'text' ? [part.value] : []);
    // Prefer the actual answer, then assistant narration, and only then output.
    const content = answers.join('\n\n') || entry.rows.filter(row => row.raw.role === 'assistant').map(row => messageText(row.raw)).filter(Boolean).join('\n\n') || entry.rows.map(row => messageText(row.raw)).join('\n\n');
    return { id: entry.id, role: 'assistant', content };
  })), [entries]);
  const visible = overflows && markers.length > 1;
  const hoveredMarker = markers.find(marker => marker.id === hovered);

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || !visible) return;
    const ids = new Set(markers.map(marker => marker.id));
    let pending = 0;
    const update = () => {
      const top = viewport.getBoundingClientRect().top + 32;
      let current: string | undefined;
      for (const node of viewport.querySelectorAll<HTMLElement>('[data-minimap-id]')) {
        if (!ids.has(node.dataset.minimapId!)) continue;
        if (!current || node.getBoundingClientRect().top <= top) current = node.dataset.minimapId;
        else break;
      }
      setActive(current);
    };
    const schedule = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(update); };
    update();
    viewport.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    if (contentRef.current) observer.observe(contentRef.current, { box: 'border-box' });
    return () => { cancelAnimationFrame(pending); observer.disconnect(); viewport.removeEventListener('scroll', schedule); };
  }, [markers, visible, scrollRef, contentRef]);

  useLayoutEffect(() => {
    const element = rail.current;
    if (!element) return;
    const measure = () => {
      const top = element.getBoundingClientRect().top;
      centers.current = Array.from(element.querySelectorAll<HTMLButtonElement>('.minimap-marker')).map(button => {
        const rect = button.getBoundingClientRect();
        return { element: button, center: rect.top + rect.height / 2 - top };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); };
  }, [markers, visible]);

  const magnify = (y: number | null) => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let nearest: HTMLButtonElement | undefined;
    let distance = 12;
    for (const { element, center } of centers.current) {
      const delta = y === null ? Infinity : Math.abs(center - y);
      const scale = !reduce && delta < 48 ? 1 + 0.8 * Math.cos(delta / 48 * Math.PI / 2) : 1;
      element.style.setProperty('--magnify', scale.toFixed(3));
      if (delta < distance) { nearest = element; distance = delta; }
    }
    setHovered(nearest?.dataset.markerId ?? null);
  };

  useLayoutEffect(() => {
    const popover = preview.current;
    const element = rail.current;
    const viewport = element?.parentElement;
    const marker = centers.current.find(item => item.element.dataset.markerId === hovered)?.element;
    if (!popover || !element || !viewport || !marker) return;
    const jump = viewport.querySelector<HTMLButtonElement>('.jump-latest-btn');
    const position = () => {
      const railRect = element.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const column = contentRef.current?.getBoundingClientRect();
      const gutter = column ? column.left + 32 - railRect.left - 8 : 0;
      // A wide pane has a real reading gutter. Otherwise use a smaller card
      // above/below the hovered line rather than covering its text.
      const inGutter = gutter >= 154;
      popover.style.left = inGutter ? '0px' : '28px';
      const left = railRect.left + (inGutter ? 0 : 28);
      popover.style.width = `${Math.min(inGutter ? gutter : 208, 208, Math.max(0, viewportRect.right - left - 8))}px`;
      let availableHeight = railRect.height;
      if (jump) {
        const rect = jump.getBoundingClientRect();
        const jumpLeft = (rect.left + rect.right - jump.offsetWidth) / 2;
        const jumpTop = (rect.top + rect.bottom - jump.offsetHeight) / 2;
        if (left + popover.offsetWidth > jumpLeft && left < jumpLeft + jump.offsetWidth) availableHeight = Math.min(availableHeight, jumpTop - railRect.top - 8);
      }
      availableHeight = Math.max(0, availableHeight);
      popover.style.maxHeight = `${availableHeight}px`;
      const height = popover.getBoundingClientRect().height;
      const markerRect = marker.getBoundingClientRect();
      const below = markerRect.bottom - railRect.top + 12;
      const above = markerRect.top - railRect.top - height - 12;
      const preferred = inGutter ? markerRect.top - railRect.top - 36 : below + height <= availableHeight ? below : above;
      popover.style.top = `${Math.max(0, Math.min(preferred, availableHeight - height))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    for (const target of [element, viewport, popover, marker]) observer.observe(target, { box: 'border-box' });
    if (contentRef.current) observer.observe(contentRef.current, { box: 'border-box' });
    if (jump) observer.observe(jump, { box: 'border-box' });
    return () => observer.disconnect();
  }, [hovered, markers, visible, atBottom, contentRef]);

  if (!visible) return null;
  return <nav ref={rail} className="minimap-rail" style={{ '--minimap-marker-count': markers.length } as CSSProperties} aria-label={t('omp.minimap.label')} onPointerMove={event => {
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => magnify(y));
  }} onPointerLeave={event => {
    cancelAnimationFrame(frame.current);
    const focused = centers.current.find(item => item.element === document.activeElement);
    magnify(focused && event.currentTarget.contains(document.activeElement) ? focused.center : null);
  }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { cancelAnimationFrame(frame.current); magnify(null); } }} onKeyDown={event => { if (event.key === 'Escape') { cancelAnimationFrame(frame.current); magnify(null); } }}>
    {markers.map(marker => <button type="button" key={marker.id} data-marker-id={marker.id} className={`minimap-marker ${marker.role}${active === marker.id ? ' active' : ''}`} aria-current={active === marker.id ? 'true' : undefined} aria-describedby={hovered === marker.id ? previewId : undefined} aria-label={t('omp.minimap.jump', { role: t(marker.role === 'user' ? 'chat.speakerYou' : 'chat.speakerAssistant') })} onFocus={() => {
      cancelAnimationFrame(frame.current);
      const item = centers.current.find(item => item.element.dataset.markerId === marker.id);
      if (item) magnify(item.center);
    }} onClick={() => onJump(marker.id)} />)}
    {hoveredMarker && <div ref={preview} id={previewId} className="minimap-popover lg-regular lg-morph-in" role="tooltip"><span className="minimap-popover-role">{t(hoveredMarker.role === 'user' ? 'chat.speakerYou' : 'chat.speakerAssistant')}</span><span className="minimap-popover-text">{hoveredMarker.preview}</span></div>}
  </nav>;
}

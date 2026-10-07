import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { activeMinimapIndex, buildConversationMinimapMarkers, type ConversationMinimapMarker, type MinimapMessage } from '../lib/conversation-minimap';
import { messageText, record, text } from './model';
import { contentBlocks, type TranscriptEntry } from './presentation';
import { projectTurn } from './turn-model';
import { Presence } from '../ui/motion';
import { timeFormats } from '../lib/format-time';

export function ConversationMinimap({ entries: incomingEntries, paging = false, scrollRef, contentRef, overflows, atBottom, onJump, earlier, matchCounts }: {
  entries: readonly TranscriptEntry[];
  paging?: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  overflows: boolean;
  atBottom: boolean;
  onJump: (id: string) => void;
  earlier?: { onJump: () => void };
  matchCounts?: ReadonlyMap<string, number>;
}) {
  const { t, i18n } = useTranslation();
  const settledEntries = useRef(incomingEntries);
  useEffect(() => { if (!paging) settledEntries.current = incomingEntries; }, [incomingEntries, paging]);
  // Only history prepends freeze the rail. Live turns must appear in their first paint.
  const entries = paging ? settledEntries.current : incomingEntries;
  const rail = useRef<HTMLElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const centers = useRef<{ element: HTMLButtonElement; center: number }[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [readingActive, setReadingActive] = useState<string>();
  const previewId = useId();
  const markerCache = useRef(new WeakMap<TranscriptEntry, ConversationMinimapMarker[]>());
  const markers = useMemo(() => {
    const projected = entries.flatMap(entry => {
      const cached = markerCache.current.get(entry);
      if (cached) return cached;
      let message: MinimapMessage;
      if (entry.kind !== 'assistant-turn') message = { id: entry.id, role: entry.row.raw.role, content: messageText(entry.row.raw), hasContent: entry.row.raw.historyResourceDeferred === true || contentBlocks(entry.row.raw).some(value => { const block = record(value); return block.type !== 'text' || !!text(block.text).trim(); }) };
      else {
        const projection = projectTurn(entry);
        const answers = projection.answer.flatMap(part => part.kind === 'text' ? [part.value] : part.kind === 'content' && record(part.block).type === 'yield-report' ? [text(record(part.block).prose)] : []);
        const content = answers.join('\n\n') || projection.chapters.map(chapter => chapter.title).filter(Boolean).join(' · ') || entry.rows.map(row => messageText(row.raw)).join('\n\n');
        message = { id: entry.id, role: 'assistant', content, hasContent: entry.parts.some(part => part.kind !== 'boundary') };
      }
      const result = buildConversationMinimapMarkers([message]);
      markerCache.current.set(entry, result);
      return result;
    });
    if (matchCounts?.has('other-activity')) projected.push(...buildConversationMinimapMarkers([{ id: 'other-activity', role: 'assistant', content: t('omp.timeline.other'), hasContent: true }]));
    return projected;
  }, [entries, matchCounts?.has('other-activity'), t]);
  const { labels, turn } = useMemo(() => {
    const labels = new Map<string, string>();
    const byId = new Map(markers.map(marker => [marker.id, marker]));
    const clock = timeFormats(i18n.language).time;
    let turn = 0;
    for (const entry of entries) {
      if (entry.kind === 'message' && entry.row.raw.role === 'user') turn++;
      const raw = entry.kind === 'message' ? entry.row.raw : entry.rows[0]?.raw;
      const timestamp = raw?.timestamp;
      const time = typeof timestamp === 'number' && Number.isFinite(timestamp) ? clock.format(timestamp) : t('omp.timeline.sourceTimeUnknown');
      const marker = byId.get(entry.id);
      if (marker) labels.set(entry.id, t('omp.timeline.minimapTurn', { number: Math.max(1, turn), role: t(marker.role === 'user' ? 'chat.speakerYou' : 'chat.speakerAssistant'), time, preview: marker.preview?.replace(/\s+/g, ' ').slice(0, 72) || t('omp.minimap.nonText') }));
    }
    return { labels, turn };
  }, [entries, markers, i18n.language, t]);
  const visible = turn >= 3 && (!!earlier || overflows || !!matchCounts?.size);
  const hoveredMarker = markers.find(marker => marker.id === hovered);

  const markerIds = markers.map(marker => marker.id).join('\0');
  const active = atBottom ? markers.at(-1)?.id : readingActive;
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || !visible || atBottom) return;
    const ids = new Set(markerIds.split('\0'));
    const nodes = Array.from(viewport.querySelectorAll<HTMLElement>('[data-minimap-id]')).filter(node => ids.has(node.dataset.minimapId!));
    let pending = 0;
    const measure = () => {
      pending = 0;
      const line = viewport.getBoundingClientRect().top + viewport.clientHeight * 0.3;
      // Binary search reads only O(log n) anchors, never every turn on scroll.
      const bottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1;
      const index = activeMinimapIndex(nodes.length, bottom, viewport.scrollTop, line, index => nodes[index].getBoundingClientRect().top);
      setReadingActive(nodes[index]?.dataset.minimapId);
    };
    const schedule = () => { if (!pending) pending = requestAnimationFrame(measure); };
    measure();
    viewport.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    if (contentRef.current) resize.observe(contentRef.current, { box: 'border-box' });
    return () => { cancelAnimationFrame(pending); resize.disconnect(); viewport.removeEventListener('scroll', schedule); };
  }, [markerIds, visible, atBottom, paging, scrollRef, contentRef]);

  useEffect(() => {
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
    element.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure, true); cancelAnimationFrame(frame.current); };
  }, [markers, visible, !!earlier]);

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
    const placement = popover?.parentElement;
    const element = rail.current;
    const viewport = element?.parentElement;
    const marker = centers.current.find(item => item.element.dataset.markerId === hovered)?.element;
    if (!popover || !placement || !element || !viewport || !marker) return;
    const jump = viewport.querySelector<HTMLButtonElement>('.jump-latest-btn');
    const position = () => {
      const railRect = element.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const column = contentRef.current?.getBoundingClientRect();
      const gutter = column ? railRect.left - (column.right - 32) - 12 : 0;
      // A wide pane has a real reading gutter. Otherwise use a smaller card
      // above/below the hovered line rather than covering its text.
      const inGutter = gutter >= 154;
      const width = Math.min(inGutter ? gutter : 208, 208, Math.max(0, viewportRect.width - 32));
      const left = Math.max(viewportRect.left + 8, railRect.left - width - 12);
      placement.style.left = `${left - railRect.left}px`;
      placement.style.right = 'auto';
      placement.style.width = `${width}px`;
      let availableHeight = railRect.height;
      if (jump) {
        const rect = jump.getBoundingClientRect();
        const jumpLeft = (rect.left + rect.right - jump.offsetWidth) / 2;
        const jumpTop = (rect.top + rect.bottom - jump.offsetHeight) / 2;
        if (left + popover.offsetWidth > jumpLeft && left < jumpLeft + jump.offsetWidth) availableHeight = Math.min(availableHeight, jumpTop - railRect.top - 8);
      }
      availableHeight = Math.max(0, availableHeight);
      placement.style.maxHeight = `${availableHeight}px`;
      const height = popover.getBoundingClientRect().height;
      const markerRect = marker.getBoundingClientRect();
      const below = markerRect.bottom - railRect.top + 12;
      const above = markerRect.top - railRect.top - height - 12;
      const preferred = inGutter ? markerRect.top - railRect.top - 36 : below + height <= availableHeight ? below : above;
      placement.style.top = `${Math.max(0, Math.min(preferred, availableHeight - height))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    for (const target of [element, viewport, popover, marker]) observer.observe(target, { box: 'border-box' });
    if (contentRef.current) observer.observe(contentRef.current, { box: 'border-box' });
    if (jump) observer.observe(jump, { box: 'border-box' });
    return () => observer.disconnect();
  }, [hovered, markers, visible, atBottom, contentRef]);

  if (!visible) return null;
  return <nav ref={rail} className="minimap-rail" style={{ '--minimap-marker-count': markers.length + (earlier ? 1 : 0) } as CSSProperties} aria-label={t('omp.minimap.label')} onPointerMove={event => {
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => magnify(y));
  }} onPointerLeave={event => {
    cancelAnimationFrame(frame.current);
    const focused = centers.current.find(item => item.element === document.activeElement);
    magnify(focused && event.currentTarget.contains(document.activeElement) ? focused.center : null);
  }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { cancelAnimationFrame(frame.current); magnify(null); } }} onKeyDown={event => { if (event.key === 'Escape') { cancelAnimationFrame(frame.current); magnify(null); } }}>
    <div className="minimap-markers">
    {earlier && <button type="button" className="minimap-earlier" aria-label={t('omp.paging.start')} title={t('omp.paging.start')} onClick={earlier.onJump}>↑</button>}
    {markers.map(marker => <button type="button" key={marker.id} data-marker-id={marker.id} data-search-matches={matchCounts?.get(marker.id) || undefined} className={`minimap-marker ${marker.role}${active === marker.id ? ' active' : ''}`} aria-current={active === marker.id ? 'true' : undefined} aria-describedby={hovered === marker.id ? previewId : undefined} aria-label={`${labels.get(marker.id) || marker.preview}${matchCounts?.get(marker.id) ? ` · ${t('omp.find.matches', { count: matchCounts.get(marker.id) })}` : ''}`} onFocus={() => {
      cancelAnimationFrame(frame.current);
      const item = centers.current.find(item => item.element.dataset.markerId === marker.id);
      if (item) magnify(item.center);
    }} onClick={() => onJump(marker.id)} />)}
    </div>
    <Presence show={!!hoveredMarker} variant="fade" className="minimap-preview-presence">{hoveredMarker && <div ref={preview} id={previewId} className="minimap-popover" role="tooltip"><span className="minimap-popover-role">{t(hoveredMarker.role === 'user' ? 'chat.speakerYou' : 'chat.speakerAssistant')}</span><span className="minimap-popover-text">{hoveredMarker.preview || t('omp.minimap.nonText')}</span></div>}</Presence>
  </nav>;
}

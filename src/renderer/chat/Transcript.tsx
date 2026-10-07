import { timeFormats } from '../lib/format-time';
import { nativeError } from '../../shared/native-error';
import { UserErrorNotice } from '../lib/UserErrorNotice';
import { Fragment, createContext, useCallback, useContext, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { NativeSubagent, ObservedActivity } from '../../shared/contracts';
import { IconCheck, IconChevronRight, IconCircleAlert, IconCircleSlash, IconLayers, IconMessages } from '../ui/icons';
import { messageText, printable, record, text, type ChatMessage, type ChatState } from './model';
import { assistantTurnKey, buildTranscriptEntries, summarizeTurn, thinkingPreview, turnOutcome, retainTurnPresentation, turnPartPresentationKey, retryNoticeHasTurnError, type AssistantTurnEntry, type TranscriptEntry, type TurnPart } from './presentation';
import { groupChapterSteps, projectTurn, type TurnChapter } from './turn-model';
import { ConversationMinimap } from './ConversationMinimap';
import { createReadingAnchor, readingAnchorAdjustment, recallReadingPosition, rememberReadingPosition, type ReadingAnchor } from '../lib/transcript-reading-position';
import { useInView } from '../lib/useInView';
import { SubagentStage, useLiveDuration } from '../workspace/SubagentStage';
import { selectTurnClock, savedWaitingIntervals, mergeWaitingIntervals, activeTurnDuration } from './turn-clock';
import { TaskStep } from '../workspace/TaskStep';
import { flattenSubagentTree, groupSubagentsByToolCall, subagentActive, type SubagentNode } from '../workspace/subagent-model';
import { visibleImage } from './message-details';
import { messageSemantics } from './native-message-semantics';
import { nativeHarnessNotice } from '../../shared/native-harness-notice';
import { NativeActivityContent, NativeContentBlock, NativeMessageContent, NativeMessageError } from './NativeMessageContent';
import { DisclosureAnchor, DisclosureIdentity, DisclosureScope, TranscriptDisclosureProvider, useAutomaticDisclosure, automaticDisclosureAnchor, restoreDisclosureAnchor, clearDisclosureAnchorReserve, type DisclosureViewportAnchor } from './disclosure';
import type { BodyProps } from './body-props';
import { Collapse, COLLAPSE_DURATION_MS } from '../ui/Collapse';
import { ToolStep } from './tools/ToolStep';
import { describeTool, toolStepLabel, nativeActivityLabel } from './tools/tool-model';
import { isStoppedMessage, projectSubmissions } from './presentation';
import { submissions, type SubmissionReceipt } from './submissions';
import i18next from 'i18next';
import { FindBar } from './FindBar';
import { buildFindSources, buildFindSourcesChunked, findMatchesChunked, findTextRanges, nextFindIndex, type FindMatch, type FindSource } from './find-model';
import { useTranscriptDisclosureApi, type TranscriptDisclosureApi } from './disclosure';
import { Prose, ResourceButton } from './Prose';
import { TurnChanges, type TurnChangesProps } from './TurnChanges';
import './timeline.css';
import { HistoryPaging, PrependAnchor } from './HistoryPaging';
import { unchangedHistoryEntry } from './history-entry-cache';
import { captureViewportReadingAnchors, restoreViewportReadingAnchor, viewportReadingAnchorHandoff, type ViewportReadingAnchor } from './viewport-reading-anchor';
import { isProgrammaticScroll, noteProgrammaticScroll } from '../ui/motion/programmatic-scroll';
import { formatElapsed } from '../lib/format-duration';
import { useDisplayPreferences } from '../lib/display-preferences';
import { Presence, Swap, animateTo, isMotionPaused, motion } from '../ui/motion';
import { MessageFooter, NativeData } from './MessageFooter';
import { coalesceFrame, followAfterScroll, returnToLatest, scrollGestureReachesViewport, scrollKeyDirection, interruptTranscriptNavigation, scheduleTranscriptNavigation, createNavigationRequest } from './transcript-follow';
import { createSmoothFollow, type SmoothFollow } from './smooth-follow';
import { resumeThinkingFollow } from './thinking-follow';
import { createPortal } from 'react-dom';
import { LiveStatusRow } from './LiveStatusRow';
import { deriveLiveStatus, inlineLiveHeading, showFloatingLiveStatus, type LiveStatus } from './live-status-model';

const RunningTurnStatus = createContext<LiveStatus | undefined>(undefined);



/** Manual choices belong to the source pane, not the lifetime of a row. */
export function Disclosure({ identity, className, headerClass = 'tool-row-header', bodyClass = 'tool-row-body', title, label, collapseLabel, autoOpen = false, children }: { identity?: string; className: string; headerClass?: string; bodyClass?: string; title: ReactNode; label?: string; collapseLabel?: string; autoOpen?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const disclosure = useAutomaticDisclosure(autoOpen, identity);
  const detailsId = useId();
  return <section className={`${className}${disclosure.open ? ' open' : ''}`}>
    <button type="button" ref={disclosure.titleRef} className={headerClass} aria-label={label} aria-expanded={disclosure.open} aria-controls={detailsId} onClick={disclosure.toggle}>
      {title}<span className={headerClass === 'tool-activity-header' ? 'tool-activity-caret' : 'tool-row-caret'} aria-hidden><IconChevronRight size="var(--icon-caption)" /></span>
    </button>
    <Collapse open={disclosure.open} bodyRef={disclosure.bodyRef} id={detailsId} {...disclosure.bodyEvents}><div className={bodyClass}>
      <button type="button" className="disclosure-collapse-rail" aria-label={collapseLabel || t('chat.collapseDetails')} title={collapseLabel || t('chat.collapseDetails')} onClick={disclosure.collapse} />
      <DisclosureScope disclosure={disclosure}>{children}</DisclosureScope>
    </div></Collapse>
  </section>;
}


type UnavailableAttachment = { name: string; reason: string; reference?: string };
const AttachmentFailures = createContext<((id: string, failure?: UnavailableAttachment) => void) | undefined>(undefined);

export function AttachmentScope({ children, onOpenSessionResource }: { children: ReactNode; onOpenSessionResource?: (reference: string) => void }) {
  const parent = useContext(AttachmentFailures);
  const [failures, setFailures] = useState<Record<string, UnavailableAttachment>>({});
  const register = useCallback((id: string, failure?: UnavailableAttachment) => {
    setFailures(current => {
      if (!failure && !current[id]) return current;
      const next = { ...current };
      if (failure) next[id] = failure; else delete next[id];
      return next;
    });
  }, []);
  if (parent) return children;
  return <AttachmentFailures.Provider value={register}>{children}<UnavailableAttachments failures={Object.values(failures)} onOpenSessionResource={onOpenSessionResource} /></AttachmentFailures.Provider>;
}

function UnavailableAttachments({ failures, onOpenSessionResource }: { failures: UnavailableAttachment[]; onOpenSessionResource?: (reference: string) => void }) {
  const { t } = useTranslation();
  if (!failures.length) return null;
  return <Disclosure identity="unavailable-attachments" className="tool-row unavailable-attachments" title={<span>{t('omp.timeline.unavailable', { count: failures.length })}</span>}><ul>{failures.map((failure, index) => <li key={index}><strong>{failure.name || t('omp.timeline.attachment', { number: index + 1 })}</strong><p>{t(/limit|exceed|too large/i.test(failure.reason) ? 'omp.timeline.attachmentTooLarge' : /missing|not found|ENOENT/i.test(failure.reason) ? 'omp.timeline.attachmentMissing' : 'omp.timeline.attachmentUnavailable')}</p>{failure.reference && <ResourceButton reference={failure.reference} onOpen={onOpenSessionResource} label={t('omp.timeline.fullContent')} />}<details className="attachment-diagnostic"><summary>{t('omp.timeline.details')}</summary><div className="native-literal-text">{failure.reason}</div></details></li>)}</ul></Disclosure>;
}

export function UnavailableAttachment({ value, reason, onOpenSessionResource }: { value: unknown; reason: string; onOpenSessionResource?: (reference: string) => void }) {
  const id = useId();
  const register = useContext(AttachmentFailures);
  const block = record(value);
  const label = text(block.name) || text(block.filename) || text(block.path);
  const name = label && !/^(?:desktop-image|data|session-resource|artifact):/i.test(label) ? label.split('/').at(-1) || '' : '';
  const reference = text(block.resourceReference) || undefined;
  useLayoutEffect(() => { register?.(id, { name, reason, reference }); return () => register?.(id); }, [register, id, name, reason, reference]);
  return register ? null : <UnavailableAttachments failures={[{ name, reason, reference }]} onOpenSessionResource={onOpenSessionResource} />;
}

export function MessageImage({ value, onOpenSessionResource }: { value: unknown; onOpenSessionResource?: (reference: string) => void }) {
  const { t } = useTranslation();
  const image = useMemo(() => visibleImage(value), [value]);
  const [failed, setFailed] = useState<string>();
  const reference = text(record(value).resourceReference);
  if (image?.deferred) return <div className="message-attachments"><span>{t('omp.chat.savedImage')}</span><ResourceButton reference={reference} onOpen={onOpenSessionResource} label={t('omp.chat.viewSavedImage')} /></div>;
  return image?.dataUrl && failed !== image.dataUrl ? <img className="native-message-image" src={image.dataUrl} alt={t('chat.messageAttachments')} loading="lazy" onError={() => setFailed(image.dataUrl)} /> : <UnavailableAttachment value={value} reason={image?.reason || t('omp.chat.imageDecodeFailed')} onOpenSessionResource={onOpenSessionResource} />;
}

export function DeferredContent({ reference, onOpen }: { reference?: string; onOpen?: (reference: string) => void }) {
  const { t } = useTranslation();
  return <div className="message-attachments"><span>{t('omp.chat.savedContent')}</span>{reference ? <ResourceButton reference={reference} onOpen={onOpen} label={t('omp.chat.viewFullContent')} /> : <span>{t('omp.chat.sourceUnavailable')}</span>}</div>;
}


function ThinkingTitle({ title }: { title: string }) {
  const [previous, setPrevious] = useState<string>();
  const last = useRef(title);
  const current = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (last.current === title) return;
    setPrevious(last.current); last.current = title;
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 80 : 120;
    current.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration });
    const timer = window.setTimeout(() => setPrevious(undefined), duration);
    return () => window.clearTimeout(timer);
  }, [title]);
  return <span className="timeline-thinking-preview">{previous !== undefined && <span key={title} className="thinking-title-out" aria-hidden>{previous}</span>}<span ref={current}>{title}</span></span>;
}

function ThinkingStep({ value, redacted = false, live = false, inline = false, ...body }: BodyProps & { value: string; redacted?: boolean; live?: boolean; inline?: boolean }) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  const readableLive = live && !redacted && !!value.trim();
  const [automatic, setAutomatic] = useState(readableLive);
  const [viewport, setViewport] = useState(readableLive);
  const started = useRef(readableLive ? performance.now() : undefined);
  const [duration, setDuration] = useState<number>();
  const disclosure = useAutomaticDisclosure(automatic, 'thinking', true);
  const id = useId();
  const cancelAutomaticCollapse = useRef(() => {});
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || !viewport || !disclosure.open || inline) return;
    const controller = createSmoothFollow(element, { tauMs: 80, maxLagPx: 12, snapPx: el => el.clientHeight, reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches });
    let inputHeight: number | undefined;
    let layoutHeight = element.scrollHeight;
    let direction = 0, observedTop = element.scrollTop, touchY = 0;
    let pointerDown = false;
    const intent = (event: Event, hint = 0) => {
      event.stopPropagation(); cancelAutomaticCollapse.current();
      direction = hint || Math.sign(element.scrollTop - observedTop);
      // A compositor wheel can arrive after React grew the DOM but before that
      // growth was painted. Use the last laid-out height, not a forced new layout.
      inputHeight = layoutHeight;
      controller.interrupt(); controller.setFollowing(false);
    };
    const wheel = (event: WheelEvent) => intent(event, Math.sign(event.deltaY));
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; intent(event); };
    const touchMove = (event: TouchEvent) => { const y = event.touches[0]?.clientY ?? touchY; intent(event, Math.sign(touchY - y)); touchY = y; };
    const pointerStart = (event: PointerEvent) => { pointerDown = true; intent(event); };
    const pointerMove = (event: PointerEvent) => { if (pointerDown) intent(event); };
    const pointerEnd = () => { pointerDown = false; };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) intent(event, -1);
      else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) intent(event, event.key === ' ' && event.shiftKey ? -1 : 1);
    };
    const scrolled = () => {
      const top = element.scrollTop;
      element.toggleAttribute('data-scrolled', top > 0);
      const movement = top - observedTop;
      observedTop = top;
      if (controller.writing || inputHeight === undefined) return;
      if (movement < 0 || direction === 0 && movement > 0) direction = Math.sign(movement);
      const height = element.scrollHeight;
      const following = resumeThinkingFollow(direction, height - element.clientHeight - top, height - inputHeight);
      controller.setFollowing(following);
      if (following) controller.contentChanged();
    };
    const scrollEnd = () => { scrolled(); inputHeight = undefined; direction = 0; };
    const resize = new ResizeObserver(() => { layoutHeight = element.scrollHeight; controller.contentChanged(); });
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: true });
    element.addEventListener('pointerdown', pointerStart);
    window.addEventListener('pointermove', pointerMove, { passive: true });
    window.addEventListener('pointerup', pointerEnd);
    window.addEventListener('pointercancel', pointerEnd);
    element.addEventListener('keydown', key);
    element.addEventListener('scroll', scrolled, { passive: true });
    element.addEventListener('scrollend', scrollEnd, { passive: true });
    controller.contentChanged();
    return () => {
      controller.dispose(); resize.disconnect();
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('touchstart', touchStart);
      element.removeEventListener('touchmove', touchMove);
      element.removeEventListener('pointerdown', pointerStart);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerEnd);
      window.removeEventListener('pointercancel', pointerEnd);
      element.removeEventListener('keydown', key);
      element.removeEventListener('scroll', scrolled);
      element.removeEventListener('scrollend', scrollEnd);
    };
  }, [viewport, disclosure.open, inline]);
  useLayoutEffect(() => {
    if (readableLive) { started.current ??= performance.now(); setAutomatic(true); setViewport(true); return; }
    if (started.current !== undefined) setDuration(performance.now() - started.current);
    const timer = window.setTimeout(() => setAutomatic(false), 600);
    cancelAutomaticCollapse.current = () => { window.clearTimeout(timer); disclosure.claim(); setAutomatic(false); };
    return () => { window.clearTimeout(timer); cancelAutomaticCollapse.current = () => {}; };
  }, [readableLive]);
  useEffect(() => {
    if (readableLive || automatic || (disclosure.open && !disclosure.manual)) return;
    const timer = window.setTimeout(() => setViewport(false), disclosure.open ? 0 : COLLAPSE_DURATION_MS + 40);
    return () => window.clearTimeout(timer);
  }, [readableLive, automatic, disclosure.open, disclosure.manual]);
  const content = redacted ? <p className="message-meta">{t('omp.native.redactedReasoning')}</p> : <Prose source={value} thinking streaming={readableLive} {...body} />;
  if (inline && !viewport && (!disclosure.manual || disclosure.open)) return content;
  const title = redacted ? t('omp.native.redactedReasoning') : thinkingPreview(value);
  return <section className={`timeline-thinking tool-row${disclosure.open ? ' open' : ''}`} data-thinking-live={readableLive || undefined} onPointerDown={() => cancelAutomaticCollapse.current()} onKeyDown={() => cancelAutomaticCollapse.current()}>
    <button type="button" ref={disclosure.titleRef} className="tool-row-header" aria-expanded={disclosure.open} aria-controls={id} onClick={disclosure.toggle}>
      <span>{t('omp.timeline.thinking')} · </span><ThinkingTitle title={title} />
      {!live && duration !== undefined && duration >= 1000 && <span className="thinking-duration"> · {formatElapsed(duration, durationStyle, i18n.language)}</span>}
      <span className="tool-row-caret" aria-hidden><IconChevronRight size="var(--icon-caption)" /></span>
    </button>
    <Collapse open={disclosure.open} bodyRef={disclosure.bodyRef} id={id}><div className="tool-row-body"><div ref={box} tabIndex={viewport ? 0 : undefined} className={viewport ? 'thinking-viewport' : 'thinking-body'}>{content}</div></div></Collapse>
  </section>;
}


function PendingMessage({ receipt, ...body }: BodyProps & { receipt: SubmissionReceipt }) {
  const { t } = useTranslation();
  const delay = useRef(-Math.min(200, Math.max(0, Date.now() - receipt.submittedAt)));
  return <div className="message-row user pending-message" style={{ animationDelay: `${delay.current}ms` }} data-message-id={`submission:${receipt.id}`} role="article" aria-label={t('chat.userMessage')}><div className="message-col"><div className="message-bubble"><Prose source={receipt.input.text} {...body} /></div><div className={`pending-message-state${receipt.status === 'error' ? ' is-failed' : receipt.status === 'queue-accepted' ? ' is-queued' : ''}`} role="status">{t(receipt.status === 'error' ? 'omp.timeline.sendFailed' : receipt.status === 'queue-accepted' ? 'omp.timeline.sendQueued' : receipt.status === 'unknown' ? 'omp.timeline.sendUnknown' : 'omp.timeline.sending')}</div></div></div>;
}


export function MessageRow({ row, agents, onOpenSubagent, submittedAt, ...body }: BodyProps & { row: ChatMessage; agents: readonly NativeSubagent[]; onOpenSubagent: (id: string) => void; submittedAt?: number }) {
  const { t } = useTranslation();
  const delay = useRef(submittedAt === undefined ? undefined : -Math.min(200, Math.max(0, Date.now() - submittedAt)));
  const raw = row.raw;
  const semantics = messageSemantics(raw);
  const label = t(`omp.native.labels.${semantics.label}`, { defaultValue: semantics.label });
  if (!semantics.visible) return null;
  const deferred = raw.historyResourceDeferred === true;
  const role = semantics.actor === 'user' ? 'user' : semantics.family === 'assistant' ? 'assistant' : 'activity';
  return <DisclosureIdentity identity={row.presentation?.id ?? row.id}><div className={`message-row ${role}${row.streaming ? ' streaming' : ''}${delay.current === undefined ? '' : ' pending-message'}`} style={delay.current === undefined ? undefined : { animationDelay: `${delay.current}ms` }} data-minimap-id={row.id} data-message-id={row.id} data-row-role={raw.role} role="article" aria-label={label}><div className="message-col">
    {!['user', 'assistant', 'compactionSummary', 'branchSummary', 'handoff'].includes(String(raw.role)) && <div className="message-meta">{label}</div>}
    <AttachmentScope onOpenSessionResource={body.onOpenSessionResource}><div className="message-bubble">{deferred ? <DeferredContent reference={row.resourceReference} onOpen={body.onOpenSessionResource} /> : <NativeMessageContent raw={raw} agents={agents} onOpenSubagent={onOpenSubagent} {...body} />}</div></AttachmentScope>
    <NativeMessageError raw={raw} />
    <MessageFooter rows={[row]} timestamp={raw.timestamp} copyText={deferred ? undefined : messageText(raw)} onOpenSessionResource={body.onOpenSessionResource} />
  </div></div></DisclosureIdentity>;
}

function ActivityStep({ part, agents, onOpenSubagent, ...body }: BodyProps & { part: Extract<TurnPart, { kind: 'activity' }>; agents: readonly NativeSubagent[]; onOpenSubagent?: (id: string) => void }) {
  const { t } = useTranslation();
  const raw = part.row.raw;
  const label = nativeActivityLabel(raw, t, part.delivery) || t(`omp.native.labels.${messageSemantics(raw).label}`, { defaultValue: t('omp.timeline.other') });
  return <Disclosure identity="activity" className="timeline-activity tool-row" title={<><IconMessages size="var(--icon-meta)" aria-hidden /><span className="timeline-step-label" title={label}>{label}</span></>}>
    {raw.historyResourceDeferred === true ? <DeferredContent reference={part.row.resourceReference} onOpen={body.onOpenSessionResource} /> : <NativeActivityContent raw={raw} delivery={part.delivery} agents={agents} onOpenSubagent={onOpenSubagent} {...body} />}<NativeMessageError raw={raw} />
  </Disclosure>;
}

function TurnPartView({ part, active = false, smoothText = false, inlineThinking = false, liveThinking = false, agents = [], onOpenSubagent, ...body }: BodyProps & { part: TurnPart; active?: boolean; smoothText?: boolean; inlineThinking?: boolean; liveThinking?: boolean; agents?: readonly NativeSubagent[]; onOpenSubagent?: (id: string) => void }) {
  if (part.kind === 'boundary') return null;
  if (part.kind === 'tool') return <ToolStep tool={part.tool} resultRow={part.resultRow} live={active} {...body} />;
  if (part.kind === 'thinking') return <ThinkingStep value={part.value} redacted={part.redacted} inline={inlineThinking} live={liveThinking} {...body} />;
  if (part.kind === 'error') return isStoppedMessage(part.row.raw) ? <Disclosure identity="stopped-details" className="tool-row" title={<span>{i18next.t('omp.timeline.details')}</span>}><NativeData value={part.row.raw} /></Disclosure> : <NativeMessageError raw={part.row.raw} />;
  if (part.kind === 'activity') return <ActivityStep part={part} agents={agents} onOpenSubagent={onOpenSubagent} {...body} />;
  return <div className={`message-bubble assistant-turn-fragment${part.row.streaming ? ' streaming' : ''}`}>{part.kind === 'text' ? <Prose source={part.value} streaming={smoothText} {...body} /> : <NativeContentBlock value={part.block} {...body} />}</div>;
}

function StepGroup({ parts, renderPart }: { parts: TurnPart[]; renderPart: (part: TurnPart) => ReactNode }) {
  const { t } = useTranslation();
  const read = parts[0].kind === 'tool' && describeTool(parts[0].tool).family === 'read';
  return <Disclosure identity={`group:${turnPartPresentationKey(parts[0])}`} className="timeline-step-group tool-row" bodyClass="timeline-group-body" title={<><IconLayers size="var(--icon-meta)" aria-hidden /><span>{t(read ? 'omp.timeline.read' : 'omp.timeline.searches', { count: parts.length })}</span></>}>{parts.map(renderPart)}</Disclosure>;
}

type TurnPauseState = { at?: number; intervals: { start: number; end: number }[] };
const TurnPause = createContext<TurnPauseState>({ intervals: [] });
function useTurnDuration(startedAt: number | undefined, endedAt: number | undefined, running: boolean) {
  const pause = useContext(TurnPause);
  const paused = running && pause.at !== undefined;
  const measured = useMemo(() => activeTurnDuration(startedAt, paused ? pause.at : running ? Date.now() : endedAt ?? startedAt, pause.intervals), [startedAt, endedAt, running, paused, pause.at, pause.intervals]);
  return useLiveDuration(measured, running && !paused, true);
}

function Chapter({ chapter, active, entering, byToolCall, renderPart }: { chapter: TurnChapter; active: boolean; entering: boolean; byToolCall: Map<string, NativeSubagent[]>; renderPart: (part: TurnPart) => ReactNode }) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  const [ready, setReady] = useState(!entering);
  useEffect(() => { setReady(true); }, []);
  const disclosure = useAutomaticDisclosure(active && chapter.current && ready, `chapter:${chapter.id}`);
  const id = useId();
  const headerPointer = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const runningAgents = chapter.steps.reduce((count, part) => count + (part.kind === 'tool' && part.tool.name === 'task' ? (byToolCall.get(part.tool.id) ?? []).filter(agent => subagentActive(agent, active)).length : 0), 0);
  const running = active && (chapter.current || runningAgents > 0);
  const status = running ? 'running' : chapter.status;
  const duration = useTurnDuration(chapter.startedAt, chapter.endedAt, running);
  const groups = groupChapterSteps(chapter.steps);
  const firstTool = chapter.steps.find(part => part.kind === 'tool');
  const title = chapter.title || (firstTool?.kind === 'tool' ? toolStepLabel(firstTool.tool, t) : t('omp.timeline.chapterWork'));
  return <section className={`timeline-chapter${disclosure.open ? ' open' : ''}${active && chapter.current ? ' is-current' : ''}`} data-chapter-id={chapter.id} data-presentation-key={`chapter:${chapter.id}`} data-current-chapter={active && chapter.current || undefined}>
    <div className="chapter-header"
      onPointerDownCapture={event => { headerPointer.current = event.button === 0 ? { x: event.clientX, y: event.clientY, dragged: false } : null; }}
      onPointerMoveCapture={event => {
        const pointer = headerPointer.current;
        if (pointer && event.buttons && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4) pointer.dragged = true;
      }}
      onPointerCancel={() => { headerPointer.current = null; }}
      onDragStartCapture={() => { if (headerPointer.current) headerPointer.current.dragged = true; }}
      onClick={event => {
        const pointer = headerPointer.current;
        headerPointer.current = null;
        const target = event.target;
        if (event.defaultPrevented || !(target instanceof Element) || !event.currentTarget.contains(target)) return;
        if (target.closest('button, a, input, select, textarea, summary, label, [contenteditable]:not([contenteditable="false"]), [tabindex], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="combobox"], [role="listbox"], [role="textbox"], [role="searchbox"], [role="slider"], [role="spinbutton"], [role="treeitem"], img, video, audio, iframe, object, embed, [role="img"]')) return;
        if (pointer?.dragged) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && (event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode))) return;
        disclosure.toggle();
      }}>
      <button type="button" className="chapter-toggle" ref={disclosure.titleRef} aria-label={title} aria-expanded={disclosure.open} aria-controls={`${id}-title ${id}`} onClick={disclosure.toggle} title={title} />
      <span className={`chapter-status status-${status}`} aria-label={t(`omp.timeline.chapterStatus.${status}`)}>{running ? <span className="chapter-running-dot" /> : status === 'failed' ? <IconCircleAlert size="var(--icon-meta)" /> : status === 'stopped' || status === 'waiting' ? <IconCircleSlash size="var(--icon-meta)" /> : <IconCheck size="var(--icon-meta)" />}</span>
      <div className="chapter-title" id={`${id}-title`}><div className="chapter-title-inner" inert={!disclosure.open} {...disclosure.bodyEvents}>{chapter.narration.length > 0 ? chapter.narration.map(renderPart) : title}</div></div>
      <span className="chapter-facts">{chapter.summary.steps > 0 && t('omp.timeline.steps', { count: chapter.summary.steps })}{chapter.summary.agents > 0 && <> · {t('omp.timeline.agents', { count: chapter.summary.agents })}</>}{chapter.summary.issues > 0 && <span className="chapter-issues" title={t('omp.timeline.unresolvedIssues')}>{t('omp.timeline.failures', { count: chapter.summary.issues })}</span>}</span>
      {duration !== undefined && (active ? duration >= 1000 : duration > 0) && <span className="chapter-duration">{formatElapsed(duration, durationStyle, i18n.language)}</span>}
      <IconChevronRight size="var(--icon-caption)" className="chapter-caret" />
      {runningAgents > 0 && !disclosure.open && <span className="chapter-agents">{t('omp.timeline.chapterAgentsRunning', { count: runningAgents })}</span>}
    </div>
    <Collapse open={disclosure.open} bodyRef={disclosure.bodyRef} id={id} innerClassName="chapter-body" {...disclosure.bodyEvents}><DisclosureScope disclosure={disclosure}>
      <div className="timeline-steps">{groups.map(group => group.length > 1 ? <StepGroup key={turnPartPresentationKey(group[0])} parts={group} renderPart={renderPart} /> : renderPart(group[0]))}</div>
    </DisclosureScope></Collapse>
  </section>;
}

function TurnTimeline({ chapters, allParts, active, hasAssistant, identity, byToolCall, outcome, renderPart, observedActivity, requestTiming }: { chapters: TurnChapter[]; allParts: TurnPart[]; active: boolean; hasAssistant: boolean; identity: string; byToolCall: Map<string, NativeSubagent[]>; outcome?: 'aborted' | 'error'; renderPart: (part: TurnPart) => ReactNode; observedActivity?: ObservedActivity; requestTiming?: ChatState['requestTiming'] }) {
  const { t, i18n } = useTranslation();
  const liveStatus = useContext(RunningTurnStatus);
  const { durationStyle } = useDisplayPreferences();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  const latestReasoning = active && allParts.at(-1)?.kind === 'thinking';
  const [reasoningGrace, setReasoningGrace] = useState(latestReasoning);
  useEffect(() => {
    if (latestReasoning) { setReasoningGrace(true); return; }
    const timer = window.setTimeout(() => setReasoningGrace(false), 600);
    return () => window.clearTimeout(timer);
  }, [latestReasoning]);
  const summary = summarizeTurn(allParts, describeTool);
  const visibleChapters = chapters.filter(chapter => chapter.boundary || chapter.narration.length || chapter.steps.some(part => part.kind !== 'error' && part.kind !== 'thinking'));
  const headerReasoning = chapters.filter(chapter => !visibleChapters.includes(chapter)).flatMap(chapter => chapter.steps.filter(part => part.kind === 'thinking'));
  const thinkingOnly = summary.steps === 0 && headerReasoning.length > 0;
  const disclosure = useAutomaticDisclosure(active || reasoningGrace, 'process', thinkingOnly);
  const api = useTranscriptDisclosureApi();
  const notifyAnchor = useContext(DisclosureAnchor);
  const id = useId();
  const chapterCount = visibleChapters.length;
  const issues = outcome === 'aborted' ? 0 : chapters.reduce((count, chapter) => count + chapter.summary.issues, 0);
  const recovered = allParts.filter(part => part.kind === 'tool' && part.tool.status === 'error' && !nativeHarnessNotice(part.tool.result)).length - issues;
  const clock = selectTurnClock(observedActivity, { startedAt: !active && thinkingOnly ? summary.startedAt : requestTiming?.startedAt ?? summary.startedAt, endedAt: !active && thinkingOnly ? summary.endedAt : requestTiming?.endedAt ?? summary.endedAt, running: active });
  const duration = useTurnDuration(clock.startedAt, clock.endedAt, clock.running);
  const pauseState = useContext(TurnPause);
  const waiting = active && pauseState.at !== undefined;
  const currentChapter = active ? chapters.find(chapter => chapter.current) ?? chapters.at(-1) : undefined;
  const stateKey = outcome === 'error' ? 'failed' : outcome === 'aborted' ? 'aborted' : active ? 'working' : thinkingOnly ? 'thought' : 'processed';
  const heading = active && liveStatus ? inlineLiveHeading(liveStatus, allParts.some(part => part.kind !== 'thinking' && part.kind !== 'error'), duration, duration === undefined ? '' : formatElapsed(duration, durationStyle, i18n.language), t) : waiting ? t('omp.timeline.waitingChoice') : clock.stale ? t('omp.observe.stale') : t(`omp.timeline.${stateKey}${duration === undefined || duration < 1000 ? 'Short' : ''}`, { duration: duration === undefined ? '' : formatElapsed(duration, durationStyle, i18n.language) });
  const cancelJump = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelJump.current?.(), []);
  const revealChapter = (chapter: TurnChapter, part?: TurnPart) => {
    api?.reveal(JSON.stringify([identity, 'process']));
    api?.reveal(JSON.stringify([identity, `chapter:${chapter.id}`]));
    cancelJump.current?.();
    cancelJump.current = scheduleTranscriptNavigation(disclosure.titleRef.current, () => {
      const root = disclosure.bodyRef.current;
      const target = part && Array.from(root?.querySelectorAll<HTMLElement>('[data-presentation-key]') ?? []).find(node => node.dataset.presentationKey === part.key) || Array.from(root?.querySelectorAll<HTMLElement>('[data-chapter-id]') ?? []).find(node => node.dataset.chapterId === chapter.id);
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
      notifyAnchor(target);
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : COLLAPSE_DURATION_MS + 100);
  };
  if (!chapterCount && !headerReasoning.length && !active && !outcome) return null;
  return <section className={`turn-timeline${active ? ' is-live' : ''}${disclosure.open ? ' open' : ''}`}>
    <div className="timeline-header" data-live-turn-header={active || undefined}>
      <button type="button" ref={disclosure.titleRef} className="timeline-toggle" data-presentation-key={`process:${identity}`} aria-label={active ? heading : undefined} aria-expanded={disclosure.open} aria-controls={id} onClick={disclosure.toggle}>
        <span className="timeline-primary">
          <span className="timeline-status-icon">{outcome === 'aborted' ? <IconCircleSlash size="var(--icon-meta)" /> : outcome === 'error' ? <IconCircleAlert size="var(--icon-meta)" className="timeline-error" /> : active ? <span className="chapter-running-dot" /> : <IconCheck size="var(--icon-meta)" />}</span>
          <span className={`timeline-heading${waiting ? ' is-waiting' : ''}`}>{!hasAssistant && !active && `${t('omp.transcript.sessionActivity')} · `}{heading}</span>
          {(active ? chapterCount > 0 || summary.steps > 0 : summary.steps > 0) && <span className="timeline-facts">{chapterCount > 0 && t('omp.timeline.chapters', { count: chapterCount })}{chapterCount > 0 && summary.steps > 0 && ' · '}{summary.steps > 0 && t('omp.timeline.steps', { count: summary.steps })}</span>}
        </span>
        {!active && summary.agents > 0 && <span className="timeline-facts timeline-secondary-facts">{t('omp.timeline.agents', { count: summary.agents })}</span>}
        <IconChevronRight size="var(--icon-caption)" className="timeline-caret" />
      </button>
      {issues > 0 && <button type="button" className="timeline-failures" title={t('omp.timeline.unresolvedIssues')} onClick={() => { const chapter = chapters.find(chapter => chapter.summary.issues > 0); if (chapter) revealChapter(chapter); }}><IconCircleAlert size="var(--icon-meta)" />{t('omp.timeline.failures', { count: issues })}</button>}
    </div>
    <Collapse open={disclosure.open} bodyRef={disclosure.bodyRef} id={id} innerClassName="timeline-body" {...disclosure.bodyEvents}><DisclosureScope disclosure={disclosure}>
      {recovered > 0 && outcome !== 'aborted' && <p className="message-meta">{t('omp.timeline.recoveredFailures', { count: recovered })}</p>}
      {headerReasoning.map(renderPart)}
      {visibleChapters.map(chapter => <Fragment key={chapter.id}>{chapter.boundary && renderPart(chapter.boundary)}{(chapter.narration.length > 0 || chapter.steps.some(part => part.kind !== 'error' && part.kind !== 'thinking')) && <Chapter chapter={chapter === currentChapter && !chapter.current ? { ...chapter, current: true } : chapter} active={active} entering={mounted.current && active} byToolCall={byToolCall} renderPart={renderPart} />}</Fragment>)}
    </DisclosureScope></Collapse>
  </section>;
}

type StageProps = { byToolCall: Map<string, NativeSubagent[]>; resolvedTrees: SubagentNode[]; observedLive: boolean; observedActivity?: ObservedActivity; activeSubagentId?: string | null; onOpenSubagent: (id: string) => void };
export function AssistantTurn({ entry, active, outcome, pauseAt, requestTiming, byToolCall, resolvedTrees, observedLive, observedActivity, activeSubagentId, onOpenSubagent, onOpenChanges, sourceContext, onRevealTool, onRetryTurn, onOpenSettings, ...body }: BodyProps & StageProps & TurnChangesProps & { entry: AssistantTurnEntry; active: boolean; outcome?: string; pauseAt?: number; requestTiming?: ChatState['requestTiming']; onRevealTool?: (toolId: string) => void; onRetryTurn?: () => void; onOpenSettings?: () => void }) {
  const { t, i18n } = useTranslation();
  const wasActive = useRef(active);
  if (active) wasActive.current = true;
  const timing = useRef(requestTiming);
  if (requestTiming && timing.current?.endedAt === undefined) timing.current = requestTiming;
  const pause = useRef<TurnPauseState>({ intervals: [] });
  if (pauseAt !== undefined && pause.current.at === undefined) pause.current.at = pauseAt;
  if (pauseAt === undefined && pause.current.at !== undefined) { pause.current.intervals.push({ start: pause.current.at, end: Date.now() }); pause.current.at = undefined; }
  const durableWaits = useMemo(() => savedWaitingIntervals(entry.parts), [entry.parts]);
  const waitingIntervals = useMemo(() => mergeWaitingIntervals([...durableWaits, ...pause.current.intervals]), [durableWaits, pause.current.intervals.length]);
  const { answer: responses, liveTail, answerSource, chapters, epilogue, supersededChapterId, noAnswerReason } = projectTurn(entry, active);
  const identity = entry.presentation?.disclosureId ?? entry.rows[0]?.presentation?.id ?? entry.rows[0]?.id ?? entry.id;
  const disclosureApi = useTranscriptDisclosureApi();
  const turnRef = useRef<HTMLDivElement>(null);
  const changesVisible = useInView(turnRef);
  const notifyAnchor = useContext(DisclosureAnchor);
  const [localStep, setLocalStep] = useState<{ toolId: string; sequence: number }>();
  const cancelReport = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelReport.current?.(), []);
  useEffect(() => {
    if (!localStep || !disclosureApi) return;
    const part = entry.parts.find(part => part.kind === 'tool' && part.tool.id === localStep.toolId);
    const source = part && buildFindSources([entry]).find(source => source.partKey === part.key);
    if (!source) return;
    disclosureApi.revealMany([...source.reveal.slice(0, -1), JSON.stringify([turnPartPresentationKey(part), `tool:${localStep.toolId}`])]);
    const cancel = scheduleTranscriptNavigation(turnRef.current, () => {
      const target = Array.from(turnRef.current?.querySelectorAll<HTMLElement>('[data-presentation-key]') ?? []).find(node => node.dataset.presentationKey === part.key);
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
      notifyAnchor(target);
      target.classList.remove('ui-flash'); void target.offsetWidth; target.classList.add('ui-flash');
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : COLLAPSE_DURATION_MS + 100);
    return cancel;
  }, [localStep, disclosureApi]);
  const copyText = responses.flatMap(part => {
    if (part.kind === 'text') return [part.value];
    if (part.kind !== 'content') return [];
    const block = record(part.block);
    if (block.type !== 'yield-report') return [];
    const fields = Array.isArray(block.fields) ? block.fields : [];
    return [text(block.prose), ...fields.map(field => `${text(record(field).name)}: ${printable(record(field).value)}`)];
  }).filter(Boolean).join('\n\n');
  const stopped = turnOutcome(entry.rows, outcome) === 'aborted';
  const processParts = chapters.flatMap(chapter => [...(chapter.boundary ? [chapter.boundary] : []), ...chapter.narration, ...chapter.steps]);
  const agents = flattenSubagentTree(resolvedTrees);
  const latest = entry.rows.at(-1);
  const finalError = !active && turnOutcome(entry.rows, outcome) === 'error' ? entry.rows.findLast(row => row.raw.role === 'assistant') : undefined;
  const turnToolIds = new Set(entry.parts.flatMap(part => part.kind === 'tool' ? [part.tool.id] : []));
  const turnAgents = agents.filter(agent => agent.parentToolCallId && turnToolIds.has(agent.parentToolCallId));
  const hasMetadata = typeof latest?.raw.timestamp === 'number' && Number.isFinite(latest.raw.timestamp) || entry.rows.some(row => !!text(row.raw.model) || Object.keys(record(row.raw.usage)).length > 0);
  const hasAssistant = active || entry.rows.some(row => messageSemantics(row.raw).family === 'assistant');
  const firstPart = new Map<string, TurnPart>();
  for (const part of [...responses, ...liveTail, ...processParts, ...epilogue.flatMap(item => item.parts)]) if (!firstPart.has(part.row.id)) firstPart.set(part.row.id, part);
  const renderPart = (part: TurnPart) => {
    if (part.kind === 'error') return null;
    const task = part.kind === 'tool' && part.tool.name === 'task' && !nativeHarnessNotice(part.tool.result);
    const failed = part.kind === 'tool' && part.tool.status === 'error' && !nativeHarnessNotice(part.tool.result);
    if (part.kind === 'activity' && part.row.raw.role === 'compactionSummary') return <DisclosureIdentity key={turnPartPresentationKey(part)} identity={part.row.id}><div className="timeline-boundary" data-presentation-key={part.key} data-message-id={part.row.id}><NativeMessageContent identity={part.row.id} raw={part.row.raw} {...body} /></div></DisclosureIdentity>;
    return <DisclosureIdentity key={turnPartPresentationKey(part)} identity={turnPartPresentationKey(part)}><div className={`timeline-part${task ? ' assistant-turn-stage' : ''}`} data-flip-key={turnPartPresentationKey(part)} data-message-id={firstPart.get(part.row.id)?.key === part.key ? part.row.id : undefined} data-presentation-key={part.key} data-step-failed={failed || undefined}>{(part.kind === 'thinking' || part.kind === 'text') && part.continuations?.map(next => <span key={next.key} className="timeline-thinking-anchor" data-presentation-key={next.key} data-message-id={firstPart.get(next.row.id)?.key === next.key ? next.row.id : undefined} />)}{task ? <TaskStep tool={part.tool} resultRow={part.resultRow} activities={part.activities} byToolCall={byToolCall} resolvedTrees={resolvedTrees} observedLive={observedLive} activeSubagentId={activeSubagentId} onOpenSubagent={onOpenSubagent} live={active} {...body} /> : <TurnPartView inlineThinking={!active && !entry.parts.some(item => item.kind === 'tool')} liveThinking={active && part.kind === 'thinking' && (part.continuations?.at(-1)?.key ?? part.key) === entry.parts.at(-1)?.key && (part.continuations?.at(-1)?.row.streaming ?? part.row.streaming)} part={part} active={active} smoothText={active && (responses.includes(part) || liveTail.includes(part)) && part.row.streaming} agents={agents} onOpenSubagent={onOpenSubagent} {...body} />}</div></DisclosureIdentity>;
  };
  if (!processParts.length && !responses.length && !epilogue.length && !active && !entry.rows.some(row => row.raw.usage || row.resourceReference)) return null;
  return <DisclosureIdentity identity={identity}><div ref={turnRef} className={`message-row ${hasAssistant ? 'assistant' : 'activity'} assistant-turn${active ? ' streaming' : ''}`} data-minimap-id={entry.id} data-row-role={hasAssistant ? 'assistant' : 'activity'} role="article" aria-label={hasAssistant ? t('chat.assistantMessage') : t('omp.transcript.sessionActivity')}><div className="message-col">
    {entry.rows.filter(row => !firstPart.has(row.id)).map(row => <span key={row.id} data-message-id={row.id} hidden />)}
    <AttachmentScope onOpenSessionResource={body.onOpenSessionResource}>
    <TurnPause.Provider value={{ at: pause.current.at, intervals: waitingIntervals }}><TurnTimeline chapters={chapters} allParts={entry.parts} active={active} observedActivity={observedActivity} requestTiming={timing.current} hasAssistant={hasAssistant} identity={identity} byToolCall={byToolCall} outcome={active ? undefined : turnOutcome(entry.rows, outcome)} renderPart={renderPart} /></TurnPause.Provider>
    {answerSource === 'superseded' && supersededChapterId && <button type="button" className="turn-report-updated" onClick={() => {
      disclosureApi?.revealMany([JSON.stringify([identity, 'process']), JSON.stringify([identity, `chapter:${supersededChapterId}`])]);
      cancelReport.current?.();
      cancelReport.current = scheduleTranscriptNavigation(turnRef.current, () => { const target = Array.from(turnRef.current?.querySelectorAll<HTMLElement>('[data-chapter-id]') ?? []).find(node => node.dataset.chapterId === supersededChapterId); if (target) { target.scrollIntoView({ block: 'center', behavior: 'auto' }); notifyAnchor(target); } }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : COLLAPSE_DURATION_MS + 100);
    }}>{t('omp.timeline.reportUpdated')}{typeof responses[0]?.row.raw.timestamp === 'number' && <> · {timeFormats(i18n.language).time.format(responses[0].row.raw.timestamp)}</>} · {t('omp.timeline.previousReport')}</button>}
    {responses.some(part => part.kind !== 'error') && <div className="assistant-turn-response">{responses.map(renderPart)}</div>}
    {finalError && <NativeMessageError raw={finalError.raw} onRetry={onRetryTurn} onOpenSettings={onOpenSettings} />}
    {!active && !responses.length && !finalError && !stopped && noAnswerReason && <p className="turn-no-report">{t(`omp.timeline.noReport.${noAnswerReason}`)}</p>}
    {epilogue.length > 0 && <Disclosure identity="epilogue" className="turn-epilogue tool-row" bodyClass="epilogue-body" title={<span>{t('omp.timeline.epilogue', { count: epilogue.length })}</span>}>{epilogue.map(item => {
      const origin = item.origin?.label || item.origin?.agentId || item.origin?.jobId;
      const kind = t(`omp.timeline.epilogueKind.${item.kind}`);
      const label = origin ? item.kind === 'background-result' ? t('omp.timeline.epilogueOrigin', { name: origin }) : `${kind} · ${origin}` : kind;
      return <section key={item.id} className="epilogue-item"><div className="epilogue-origin">{label}{item.timestamp !== undefined && Number.isFinite(item.timestamp) && <time dateTime={new Date(item.timestamp).toISOString()}> · {timeFormats(i18n.language).time.format(item.timestamp)}</time>}</div>{item.parts.map(renderPart)}</section>;
    })}</Disclosure>}
    {liveTail.length > 0 && <div className="assistant-turn-live-tail">{liveTail.map(renderPart)}</div>}
    </AttachmentScope>
    <TurnChanges query={sourceContext && entry.rows.length ? { context: sourceContext, anchorId: entry.rows[0].id, toolCallIds: entry.parts.flatMap(part => part.kind === 'tool' ? [part.tool.id] : []) } : undefined} enabled={changesVisible} active={active} cwd={body.cwd} onOpenChanges={onOpenChanges} onRevealTool={onRevealTool ?? (toolId => setLocalStep(value => ({ toolId, sequence: (value?.sequence ?? 0) + 1 })))} />
    <Presence show={hasMetadata && !active} variant="rise" appear={wasActive.current}><MessageFooter rows={entry.rows} agents={turnAgents} timestamp={latest?.raw.timestamp} copyText={copyText || undefined} onOpenSessionResource={body.onOpenSessionResource} /></Presence>
  </div></div></DisclosureIdentity>;
}


/** One range may span Markdown or syntax-highlighted text nodes. */
function visibleFindRanges(root: HTMLElement, query: string): Range[] {
  const nodes: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let value = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('[hidden], [inert], button[aria-expanded], .code-view-gutter') || !parent.getClientRects().length) continue;
    const start = value.length; value += node.textContent;
    nodes.push({ node: node as Text, start, end: value.length });
  }
  return findTextRanges(value, query).flatMap(([start, end]) => {
    const first = nodes.find(item => item.end > start), last = nodes.find(item => item.end >= end);
    if (!first || !last) return [];
    const range = document.createRange();
    range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
    return [range];
  });
}
export interface TranscriptHistory { hasMore: boolean; loading: boolean; error?: Error | string; following?: boolean; loadBefore: (entryId: string) => Promise<void>; latest?: () => Promise<void> }
export interface TranscriptHandle { revealLatest(): void; revealAttention(): void }
export interface TranscriptNavigationProps { focusMessage?: { id: string; sequence: number }; findRequest?: { sequence: number; query?: string }; attentionRequest?: { sequence: number }; navigationRef?: Ref<TranscriptHandle>; liveStatusHost?: HTMLElement | null; queuedCount?: number; onRetryTurn?: () => void; onOpenSettings?: () => void; onSearchAll?: (query: string) => void }
export function Transcript({ chat, cwd, onOpenFile, onOpenSessionResource, onOpenSubagent, activeSubagentId, historyHeader, history, returnToTurn, focusMessage, findRequest, attentionRequest, navigationRef, liveStatusHost, queuedCount, onRetryTurn, onOpenSettings, onSearchAll, onOpenChanges, sourceContext, observedLive = false }: BodyProps & TranscriptNavigationProps & TurnChangesProps & { chat: ChatState; observedLive?: boolean; onOpenSubagent: (id: string, originTurnId?: string) => void; activeSubagentId?: string | null; historyHeader?: ReactNode; history?: TranscriptHistory; returnToTurn?: { id: string; sequence: number } | null }) {
  const { t } = useTranslation();
  const receipts = useSyncExternalStore(submissions.subscribe, submissions.getSnapshot, submissions.getSnapshot);
  const { pending, matched } = useMemo(() => projectSubmissions(receipts, chat.messages, chat.runtimeId, chat.state.sessionId), [receipts, chat.messages, chat.runtimeId, chat.state.sessionId]);
  const latestSubmission = receipts.findLast(receipt => receipt.runtimeId === chat.runtimeId && receipt.sessionId === chat.state.sessionId)?.id;
  const previousSubmission = useRef(latestSubmission);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const prepend = useRef<PrependAnchor>(null);
  const disclosures = useRef<TranscriptDisclosureApi>(null);
  const [find, setFind] = useState({ open: false, query: '', index: 0, sequence: 0 });
  const [changeStep, setChangeStep] = useState<{ entryId: string; toolId: string; sequence: number }>();
  const following = useRef(true);
  const smoothFollow = useRef<SmoothFollow | null>(null);
  const userScrolling = useRef(false);
  const anchor = useRef<DisclosureViewportAnchor | null>(null);
  const readingAnchors = useRef<ReadingAnchor[]>([]);
  const readingRestorePending = useRef(false);
  const readingScrollTop = useRef(0);
  const cancelLanding = useRef<(() => void) | undefined>(undefined);
  const readingFragments = useRef<ViewportReadingAnchor[]>([]);
  const scrollIntent = useRef(0);
  const latestIntent = useRef<number | undefined>(undefined);
  const touchY = useRef<number | undefined>(undefined);
  const scrollbarHeld = useRef(false);
  const navigationRequests = useMemo(() => ({ find: createNavigationRequest(), change: createNavigationRequest(), focus: createNavigationRequest() }), []);
  const readingKey = `${chat.runtimeId}:${chat.state.sessionId}`;
  const findNavigationKey = find.open ? JSON.stringify([readingKey, find.query, find.sequence, find.index]) : undefined;
  const changeNavigationKey = changeStep ? JSON.stringify([readingKey, changeStep.entryId, changeStep.toolId, changeStep.sequence]) : undefined;
  const focusNavigationKey = focusMessage ? JSON.stringify([readingKey, focusMessage.id, focusMessage.sequence]) : undefined;
  useLayoutEffect(() => {
    interruptScrollWork();
    navigationRequests.find.observe(findNavigationKey, scrollIntent.current);
    navigationRequests.change.observe(changeNavigationKey, scrollIntent.current);
    navigationRequests.focus.observe(focusNavigationKey, scrollIntent.current);
  }, [findNavigationKey, changeNavigationKey, focusNavigationKey]);
  const [atBottom, setAtBottom] = useState(true);
  const [overflow, setOverflow] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const scrollIdle = useRef<number | undefined>(undefined);
  const originPositions = useRef(new Map<string, { anchors: ReadingAnchor[]; top: number; focus: HTMLElement | null }>());
  const previousWindow = useRef(chat.messages);
  const previousFollowing = useRef(history?.following);
  const previousEntries = useRef<{ key: string; entries: TranscriptEntry[] } | undefined>(undefined);
  const { entries, renderedTools } = useMemo(() => {
    const projection = buildTranscriptEntries(chat.messages, chat.tools, chat.subagents);
    if (observedLive && chat.isRunning && projection.entries.at(-1)?.kind !== 'assistant-turn') {
      const user = projection.entries.at(-1);
      projection.entries.push({ kind: 'assistant-turn', id: `pending-turn:${user?.id ?? readingKey}`, rows: [], parts: [] });
    }
    const previous = previousEntries.current?.key === readingKey ? previousEntries.current.entries : [];
    const byKey = new Map(previous.map(entry => [entry.kind === 'assistant-turn' ? assistantTurnKey(entry) : entry.id, entry]));
    const retained = retainTurnPresentation(projection.entries, previous).map(entry => {
      const old = byKey.get(entry.kind === 'assistant-turn' ? assistantTurnKey(entry) : entry.id);
      return old && unchangedHistoryEntry(old, entry) ? old : entry;
    });
    return { ...projection, entries: retained };
  }, [chat.messages, chat.tools, chat.subagents, readingKey, observedLive, chat.isRunning]);
  const enteringTurn = observedLive && chat.isRunning && previousEntries.current?.key === readingKey && entries.at(-1)?.kind === 'assistant-turn' && !previousEntries.current.entries.some(entry => entry.id === entries.at(-1)?.id) ? entries.at(-1)?.id : undefined;
  useLayoutEffect(() => {
    if (!enteringTurn || isMotionPaused()) return;
    const node = Array.from(content.current?.querySelectorAll<HTMLElement>('.assistant-turn') ?? []).find(element => element.dataset.minimapId === enteringTurn);
    if (!node) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    animateTo(node, [{ opacity: 0, transform: reduced ? 'none' : 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: reduced ? motion.reduced : motion.base, easing: motion.enter });
  }, [enteringTurn]);
  useLayoutEffect(() => { previousEntries.current = { key: readingKey, entries }; }, [readingKey, entries]);
  const lastEntry = entries.at(-1);
  const liveStartedAt = chat.requestTiming?.startedAt ?? (lastEntry?.kind === 'assistant-turn' ? summarizeTurn(lastEntry.parts, describeTool).startedAt : undefined);
  const running = observedLive && chat.isRunning;
  const [headerVisibility, setHeaderVisibility] = useState<{ id: string; visible: boolean }>();
  useEffect(() => {
    if (!running || !lastEntry || !scroll.current) return;
    const header = content.current?.querySelector('[data-live-turn-header]');
    if (!header) return;
    const observer = new IntersectionObserver(([entry]) => {
      setHeaderVisibility({ id: lastEntry.id, visible: entry.isIntersecting });
    }, { root: scroll.current });
    observer.observe(header);
    return () => observer.disconnect();
  }, [running, lastEntry?.id]);
  const floatingStatusVisible = showFloatingLiveStatus(running, headerVisibility?.id === lastEntry?.id ? headerVisibility?.visible : undefined);
  const runningStatus = deriveLiveStatus(chat, lastEntry?.kind === 'assistant-turn' ? lastEntry : undefined, atBottom, observedLive, t);
  const unanchoredTools = Object.values(chat.tools).filter(tool => !renderedTools.has(tool.id));
  const anchoredIds = useMemo(() => new Set([...renderedTools, ...Object.keys(chat.tools)]), [renderedTools, chat.tools]);
  const { byToolCall, orphans, resolvedTrees } = useMemo(() => groupSubagentsByToolCall(chat.subagents, anchoredIds), [chat.subagents, anchoredIds]);
  const [findSources, setFindSources] = useState<FindSource[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    if (!find.open && !focusMessage && !changeStep) { setFindSources([]); return; }
    void buildFindSourcesChunked(entries, flattenSubagentTree(resolvedTrees), unanchoredTools, key => t(key), controller.signal).then(sources => { if (!controller.signal.aborted) setFindSources(sources); });
    return () => controller.abort();
  }, [entries, resolvedTrees, chat.tools, t, find.open, focusMessage, changeStep]);
  const [findResults, setFindResults] = useState<{ query: string; matches: FindMatch[] }>({ query: '', matches: [] });
  const matches = findResults.query === find.query ? findResults.matches : [];
  useEffect(() => {
    const controller = new AbortController();
    setFindResults({ query: find.query, matches: [] });
    if (find.open) void findMatchesChunked(findSources, find.query, controller.signal).then(result => { if (!controller.signal.aborted) setFindResults({ query: find.query, matches: result }); });
    return () => controller.abort();
  }, [findSources, find.open, find.query]);
  const matchIndex = Math.min(find.index, Math.max(0, matches.length - 1));
  const matchCounts = useMemo(() => { const counts = new Map<string, number>(); for (const match of matches) counts.set(match.source.entryId, (counts.get(match.source.entryId) ?? 0) + 1); return counts; }, [matches]);
  const measureReadingAnchors = (visibleOnly: boolean) => {
    const element = scroll.current;
    const candidates: ReadingAnchor[] = [];
    if (!element) return candidates;
    const viewport = element.getBoundingClientRect();
    for (const node of element.querySelectorAll<HTMLElement>('[data-presentation-key], [data-message-id], [data-minimap-id]')) {
      if (node.closest('[hidden], [inert]')) continue;
      if (!visibleOnly && !readingAnchors.current.some(saved => node.getAttribute(saved.attribute) === saved.id)) continue;
      if (visibleOnly) {
        const row = node.closest<HTMLElement>('.message-row');
        const bounds = row?.getBoundingClientRect();
        if (bounds && (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom)) continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.height === 0 || (visibleOnly && (rect.bottom <= viewport.top || rect.top >= viewport.bottom))) continue;
      const candidate = createReadingAnchor({ presentationKey: node.dataset.presentationKey, messageId: node.dataset.messageId, minimapId: node.dataset.minimapId, turnId: node.closest<HTMLElement>('[data-minimap-id]')?.dataset.minimapId }, rect.top - viewport.top);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  };
  const recordScrollWrite = () => {
    if (!scroll.current) return;
    readingScrollTop.current = scroll.current.scrollTop;
    noteProgrammaticScroll(scroll.current);
  };
  const rebaseReadingMotion = () => {
    const element = scroll.current;
    if (!element) return;
    const delta = element.scrollTop - readingScrollTop.current;
    if (delta && !isProgrammaticScroll(element)) {
      readingAnchors.current = readingAnchors.current.map(saved => ({ ...saved, top: saved.top - delta }));
      for (const fragment of readingFragments.current) fragment.top -= delta;
      if (anchor.current) anchor.current.top -= delta;
    }
    readingScrollTop.current = element.scrollTop;
  };
  const interruptScrollWork = () => {
    if (scroll.current) interruptTranscriptNavigation(scroll.current);
    scrollIntent.current++;
    prepend.current?.cancel();
    pin.cancel();
    cancelLanding.current?.();
    cancelLanding.current = undefined;
    clearTimeout(scrollIdle.current);
  };
  const captureReadingAnchors = () => {
    if (readingRestorePending.current) return;
    if (prepend.current?.active) return;
    readingScrollTop.current = scroll.current?.scrollTop ?? 0;
    if (following.current) { readingAnchors.current = []; readingFragments.current = []; return; }
    // Prefer a specific stage/fragment over an enclosing turn, even when the
    // turn's top is closer. Each element contributes only its canonical ID.
    const specificity = { 'data-presentation-key': 0, 'data-message-id': 1, 'data-minimap-id': 2 };
    readingAnchors.current = measureReadingAnchors(true).sort((left, right) => specificity[left.attribute] - specificity[right.attribute] || Math.abs(left.top) - Math.abs(right.top));
    readingFragments.current = scroll.current ? captureViewportReadingAnchors(scroll.current) : [];
  };
  const holdDisclosure = (element: HTMLElement | null, options?: { automatic?: boolean }) => {
    if (options?.automatic && prepend.current?.active) return;
    if (!options?.automatic) { interruptScrollWork(); userScrolling.current = false; }
    if (following.current) { anchor.current = null; sync(); return; }
    if (options?.automatic) {
      anchor.current = !following.current && scroll.current ? automaticDisclosureAnchor(scroll.current, element) : null;
      if (!following.current) captureReadingAnchors();
      return;
    }
    captureReadingAnchors();
    readingFragments.current = [];
    if (element && scroll.current) {
      const viewportTop = scroll.current.getBoundingClientRect().top;
      anchor.current = { element, top: Math.max(0, element.getBoundingClientRect().top - viewportTop) };
    }
  };
  const disclosureHandler = useRef(holdDisclosure);
  disclosureHandler.current = holdDisclosure;
  const stableDisclosureHandler = useCallback((element: HTMLElement | null, options?: { automatic?: boolean }) => disclosureHandler.current(element, options), []);
  const performSync = () => {
    if (prepend.current?.active) return;
    const element = scroll.current;
    if (!element) return;
    if (userScrolling.current && following.current) return;
    // Scroll events can arrive after ResizeObserver. Subtract only native
    // movement before correcting layout, never a registered corrective write.
    if (userScrolling.current) rebaseReadingMotion();
    smoothFollow.current?.setFollowing(following.current);
    if (following.current && !anchor.current) {
      smoothFollow.current?.contentChanged();
      readingAnchors.current = [];
      setOverflow(element.scrollHeight > element.clientHeight + 10);
      return;
    }
    const previousScrollTop = element.scrollTop;
    readingRestorePending.current = false;
    // A regrouped turn may be outside the viewport's intrinsic-size window.
    // Materialize the exact saved fragment's containers before measuring it.
    const materialized = new Set<HTMLElement>();
    if (!following.current) {
      const nodes = Array.from(element.querySelectorAll<HTMLElement>('[data-presentation-key], [data-message-id], [data-minimap-id]'));
      for (const saved of readingAnchors.current) {
        const target = nodes.find(node => node.getAttribute(saved.attribute) === saved.id && !node.closest('[hidden]'));
        if (!target) continue;
        for (let container: HTMLElement | null = target; container && container !== element; container = container.parentElement) {
          if (container.matches('.message-row, .tool-activity-group')) { container.dataset.readingAnchor = 'true'; materialized.add(container); }
        }
        break;
      }
    }
    for (const node of element.querySelectorAll<HTMLElement>('[data-reading-anchor]')) if (!materialized.has(node)) delete node.dataset.readingAnchor;
    const viewportTop = element.getBoundingClientRect().top;
    if (anchor.current?.element.isConnected) {
      if (content.current) restoreDisclosureAnchor(element, content.current, anchor.current);
      else element.scrollTop += anchor.current.element.getBoundingClientRect().top - viewportTop - anchor.current.top;
    } else if (following.current) {
      smoothFollow.current?.contentChanged();
      readingAnchors.current = [];
    } else {
      const fragment = readingFragments.current.find(saved => restoreViewportReadingAnchor(element, saved));
      const adjustment = fragment ? undefined : readingAnchorAdjustment(readingAnchors.current, measureReadingAnchors(false));
      const restored = !!fragment || adjustment !== undefined;
      if (adjustment !== undefined) element.scrollTop += adjustment;
      if (fragment) {
        const saved = viewportReadingAnchorHandoff(element, fragment);
        if (saved) readingAnchors.current = [saved];
      }
      if (!restored && readingAnchors.current.length && chat.runtimeId.startsWith('history:')) {
        if (recallReadingPosition(readingKey)?.following === true) {
          // HistoryStore exhausted a consistent journal without the durable
          // anchor. Only that result permits replacing the saved position.
          following.current = true;
          readingAnchors.current = [];
          element.scrollTop = element.scrollHeight;
          setAtBottom(true);
        } else {
          // Do not learn anchors from an incomplete replacement window.
          readingRestorePending.current = true;
        }
      } else if (!restored) captureReadingAnchors();
    }
    if (element.scrollTop !== previousScrollTop) recordScrollWrite();
    element.parentElement?.classList.toggle('is-scrolled', element.scrollTop > 2);
    setOverflow(element.scrollHeight > element.clientHeight + 10);
  };
  const latestSync = useRef(performSync);
  latestSync.current = performSync;
  const pin = useMemo(() => coalesceFrame(() => latestSync.current(), requestAnimationFrame, cancelAnimationFrame), []);
  const sync = pin.schedule;
  useEffect(() => () => pin.cancel(), [pin]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (element) smoothFollow.current = createSmoothFollow(element, { tauMs: 80, maxLagPx: 64, snapPx: node => node.clientHeight, reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches });
    setNavigationError('');
    clearDisclosureAnchorReserve(content.current);
    const saved = recallReadingPosition(readingKey);
    following.current = saved?.following ?? true;
    userScrolling.current = false;
    latestIntent.current = undefined;
    readingRestorePending.current = false;
    anchor.current = null;
    readingFragments.current = [];
    readingAnchors.current = saved?.anchors ?? [];
    setAtBottom(following.current);
    if (element && saved && !saved.following) element.scrollTop = saved.scrollTop;
    if (element && following.current) element.scrollTop = element.scrollHeight;
    recordScrollWrite();
    smoothFollow.current?.setFollowing(following.current);
    // Resolve durable fragment offsets before this newly mounted pane paints.
    pin.flush();
    // The content's padding is the live composer reserve: content-box misses it.
    const observer = new ResizeObserver(pin.flush);
    const sharedNavigation = () => {
      interruptScrollWork();
      following.current = false; userScrolling.current = false; anchor.current = null;
      smoothFollow.current?.setFollowing(false);
      setAtBottom(false);
      captureReadingAnchors();
    };
    element?.addEventListener('transcript-navigation-start', sharedNavigation);
    if (content.current) observer.observe(content.current, { box: 'border-box' });
    if (element) observer.observe(element, { box: 'border-box' });
    // Descendant stages can resize in opposite directions without changing
    // total content height. Enroll stages added by later chunks/hydration too.
    const stages = new Set<Element>();
    const enrollStages = () => {
      for (const stage of stages) if (!content.current?.contains(stage)) { observer.unobserve(stage); stages.delete(stage); }
      for (const stage of content.current?.querySelectorAll('.assistant-turn-stage, [data-presentation-key]') ?? []) {
        if (stages.has(stage)) continue;
        stages.add(stage);
        observer.observe(stage, { box: 'border-box' });
      }
    };
    enrollStages();
    const mutations = new MutationObserver(() => { enrollStages(); sync(); });
    if (content.current) mutations.observe(content.current, { childList: true, subtree: true, characterData: true });
    return () => {
      element?.removeEventListener('transcript-navigation-start', sharedNavigation);
      interruptScrollWork();
      observer.disconnect();
      mutations.disconnect();
      smoothFollow.current?.dispose();
      smoothFollow.current = null;
      if (element && !readingRestorePending.current) rememberReadingPosition(readingKey, { scrollTop: element.scrollTop, following: following.current, anchors: readingAnchors.current });
    };
  }, [readingKey]);
  useLayoutEffect(() => {
    if (latestSubmission && latestSubmission !== previousSubmission.current) {
      interruptScrollWork();
      clearDisclosureAnchorReserve(content.current);
      following.current = true; userScrolling.current = false; anchor.current = null; readingAnchors.current = []; setAtBottom(true); sync();
    }
    previousSubmission.current = latestSubmission;
  }, [latestSubmission]);
  useLayoutEffect(sync, [chat.messages, chat.tools, chat.subagents, chat.isRunning, entries, atBottom]);
  const scheduleReadingIdle = () => {
    if (scrollbarHeld.current) return;
    clearTimeout(scrollIdle.current);
    scrollIdle.current = window.setTimeout(() => {
      const element = scroll.current;
      if (!element) return;
      pin.flush();
      captureReadingAnchors();
      userScrolling.current = false;
      smoothFollow.current?.setFollowing(following.current);
      if (following.current) smoothFollow.current?.contentChanged();
      element.parentElement?.classList.toggle('is-scrolled', element.scrollTop > 2);
      rememberReadingPosition(readingKey, { scrollTop: element.scrollTop, following: following.current, anchors: readingAnchors.current });
    }, 160);
  };
  const beginReading = (deltaY = 0) => {
    interruptScrollWork();
    smoothFollow.current?.interrupt();
    if (following.current && deltaY < 0) { following.current = false; setAtBottom(false); captureReadingAnchors(); }
    smoothFollow.current?.setFollowing(false);
    anchor.current = null;
    readingRestorePending.current = false;
    userScrolling.current = true;
    scheduleReadingIdle();
  };
  useEffect(() => () => clearTimeout(scrollIdle.current), []);
  useEffect(() => {
    const start = (event: PointerEvent) => { if (event.target === scroll.current) scrollbarHeld.current = true; };
    const release = () => { if (scrollbarHeld.current) { scrollbarHeld.current = false; scheduleReadingIdle(); } };
    window.addEventListener('pointerdown', start, true);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => { window.removeEventListener('pointerdown', start, true); window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); };
  }, []);
  const jumpToMessage = (id: string) => {
    const viewport = scroll.current;
    const element = Array.from(viewport?.querySelectorAll<HTMLElement>('[data-minimap-id]') ?? []).find(node => node.dataset.minimapId === id);
    if (!viewport || !element) return;
    interruptScrollWork();
    clearDisclosureAnchorReserve(content.current);
    following.current = false;
    smoothFollow.current?.setFollowing(false);
    userScrolling.current = false;
    readingAnchors.current = [];
    readingFragments.current = [];
    anchor.current = { element, top: 0 };
    setAtBottom(false);
    // Offscreen intrinsic heights can change while a smooth scroll is running.
    // Navigate directly, then retain the actual row as layout settles.
    element.scrollIntoView({ behavior: 'auto', block: 'start' });
    recordScrollWrite();
    sync();
    captureReadingAnchors();
  };
  const rememberOrigin = (turnId: string) => {
    if (turnId && scroll.current) {
      following.current = false; captureReadingAnchors(); setAtBottom(false);
      originPositions.current.set(turnId, { anchors: [...readingAnchors.current], top: scroll.current.scrollTop, focus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
      if (originPositions.current.size > 64) originPositions.current.delete(originPositions.current.keys().next().value!);
    }
  };
  const openTask = (id: string, turnId?: string) => {
    if (turnId) rememberOrigin(turnId);
    onOpenSubagent(id, turnId);
  };
  useLayoutEffect(() => {
    if (!returnToTurn) return;
    const saved = originPositions.current.get(returnToTurn.id);
    if (!saved || !scroll.current) { jumpToMessage(returnToTurn.id); return; }
    interruptScrollWork();
    following.current = false; userScrolling.current = false; anchor.current = null; readingRestorePending.current = false;
    smoothFollow.current?.setFollowing(false);
    readingFragments.current = [];
    readingAnchors.current = saved.anchors; scroll.current.scrollTop = saved.top; setAtBottom(false); sync();
    recordScrollWrite();
    saved.focus?.isConnected && saved.focus.focus({ preventScroll: true });
  }, [returnToTurn?.sequence]);
  useLayoutEffect(() => {
    if (history?.loading) return;
    const changed = previousWindow.current !== chat.messages;
    const resumed = history?.following === true && previousFollowing.current === false;
    const ids = changed ? new Set(chat.messages.map(row => row.id)) : undefined;
    const overlap = !!ids && previousWindow.current.some(row => ids.has(row.id));
    if (resumed && (latestIntent.current === undefined || latestIntent.current === scrollIntent.current)) { following.current = true; userScrolling.current = false; anchor.current = null; readingAnchors.current = []; setAtBottom(true); sync(); }
    else if (changed && !overlap && history?.following === false && entries.length) jumpToMessage(entries[entries.length - 1].id);
    previousWindow.current = chat.messages; previousFollowing.current = history?.following;
  }, [chat.messages, history?.loading, history?.following]);
  const goLatest = async () => {
    interruptScrollWork();
    const intent = scrollIntent.current;
    latestIntent.current = intent;
    setNavigationError('');
    try {
      await returnToLatest(history, () => {
        following.current = true; userScrolling.current = false;
        clearTimeout(scrollIdle.current);
        readingFragments.current = [];
        anchor.current = null; readingAnchors.current = []; readingRestorePending.current = false;
        clearDisclosureAnchorReserve(content.current);
        setAtBottom(true);
        smoothFollow.current?.returnToBottom();
      }, () => scrollIntent.current === intent);
    } catch (cause) { if (scrollIntent.current === intent) setNavigationError(String(cause)); }
  };
  const revealAttention = () => {
    const target = content.current?.querySelector<HTMLElement>('[data-attention-target]');
    if (!target) { void goLatest(); return; }
    interruptScrollWork();
    following.current = false; userScrolling.current = false; anchor.current = null;
    smoothFollow.current?.setFollowing(false);
    setAtBottom(false);
    target.scrollIntoView({ block: 'nearest' });
    recordScrollWrite();
    captureReadingAnchors();
    target.querySelector<HTMLElement>('button:not(:disabled),input,textarea')?.focus({ preventScroll: true });
  };
  useImperativeHandle(navigationRef, () => ({ revealLatest: () => { void goLatest(); }, revealAttention }));
  useEffect(() => { if (attentionRequest) revealAttention(); }, [attentionRequest?.sequence]);
  useLayoutEffect(() => {
    if (findRequest) { interruptScrollWork(); setFind(value => ({ ...value, open: true, query: findRequest.query ?? value.query, index: 0, sequence: value.sequence + 1 })); }
  }, [findRequest?.sequence]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.shiftKey || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f' || !scroll.current?.checkVisibility()) return;
      event.preventDefault();
      interruptScrollWork();
      flushSync(() => setFind(value => ({ ...value, open: true, sequence: value.sequence + 1 })));
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  const sourceElement = (source: FindSource) => Array.from(content.current?.querySelectorAll<HTMLElement>(source.partKey ? '[data-presentation-key]' : '[data-message-id]') ?? []).find(node => source.partKey ? node.dataset.presentationKey === source.partKey : node.dataset.messageId === source.messageId);
  const land = (source: FindSource, match?: FindMatch) => {
    interruptScrollWork();
    following.current = false; userScrolling.current = false; anchor.current = null; readingAnchors.current = []; setAtBottom(false);
    smoothFollow.current?.setFollowing(false);
    disclosures.current?.revealMany(source.reveal);
    readingFragments.current = [];
    let stage: 'typed' | 'expanded' | 'raw' = 'typed';
    let timer = 0;
    let frame = 0;
    const finish = () => {
      const target = sourceElement(source);
      prepend.current?.cancel();
      if (!target) return;
      for (const previous of content.current?.querySelectorAll('.transcript-search-target, .ui-flash') ?? []) previous.classList.remove('transcript-search-target', 'ui-flash');
      target.closest('.message-row')?.classList.add('transcript-search-target');
      if (!source.toolDetail) for (const details of target.querySelectorAll('details')) details.open = true;
      const ranges = match ? visibleFindRanges(target, find.query) : [];
      if (match && !ranges.length && source.toolDetail && stage !== 'raw') {
        if (stage === 'typed') {
          disclosures.current?.reveal(source.toolDetail.scope, { exclude: [source.toolDetail.raw] });
          stage = 'expanded';
        } else {
          disclosures.current?.reveal(source.toolDetail.raw);
          stage = 'raw';
        }
        timer = window.setTimeout(() => { frame = requestAnimationFrame(finish); }, COLLAPSE_DURATION_MS + 100);
        return;
      }
      const range = ranges[match?.occurrence ?? 0] ?? ranges[0];
      const element = range?.startContainer.parentElement ?? target;
      const viewport = scroll.current;
      if (!viewport) return;
      const rect = range?.getBoundingClientRect() ?? element.getBoundingClientRect();
      const elementTop = range ? element.getBoundingClientRect().top : rect.top;
      const writes: { container: HTMLElement; top: number; left: number }[] = [];
      let displacement = 0;
      let viewportTop = 0;
      for (let container: HTMLElement | null = element.parentElement; container; container = container.parentElement) {
        const style = getComputedStyle(container);
        if (container === viewport || /auto|scroll/.test(style.overflowY)) {
          const bounds = container.getBoundingClientRect();
          const top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + rect.top + rect.height / 2 - displacement - bounds.top - container.clientHeight / 2));
          const left = container.scrollLeft + (/auto|scroll/.test(style.overflowX) ? rect.left < bounds.left ? rect.left - bounds.left - 12 : rect.right > bounds.right ? rect.right - bounds.right + 12 : 0 : 0);
          displacement += top - container.scrollTop;
          writes.push({ container, top, left });
          if (container === viewport) viewportTop = bounds.top;
        }
        if (container === viewport) break;
      }
      // All geometry belongs to the same layout; no read follows a scroll write.
      anchor.current = { element, top: elementTop - displacement - viewportTop };
      for (const write of writes) { write.container.scrollTop = write.top; write.container.scrollLeft = write.left; }
      recordScrollWrite();
      captureReadingAnchors();
      element.classList.add('ui-flash');
    };
    timer = window.setTimeout(() => { frame = requestAnimationFrame(finish); }, COLLAPSE_DURATION_MS + 100);
    const cancel = () => { window.clearTimeout(timer); cancelAnimationFrame(frame); };
    cancelLanding.current = cancel;
    return () => { cancel(); if (cancelLanding.current === cancel) cancelLanding.current = undefined; };
  };
  const activeMatch = matches[matchIndex];
  useEffect(() => { if (activeMatch && findNavigationKey && navigationRequests.find.take(findNavigationKey, scrollIntent.current)) navigationRequests.find.retain(land(activeMatch.source, activeMatch)); }, [activeMatch?.source.id, activeMatch?.start, findNavigationKey]);
  useEffect(() => {
    if (!changeStep || !changeNavigationKey) return;
    const entry = entries.find(entry => entry.id === changeStep.entryId);
    const part = entry?.kind === 'assistant-turn' ? entry.parts.find(part => part.kind === 'tool' && part.tool.id === changeStep.toolId) : undefined;
    const source = part && findSources.find(source => source.entryId === changeStep.entryId && source.partKey === part.key);
    if (source && part && navigationRequests.change.take(changeNavigationKey, scrollIntent.current)) navigationRequests.change.retain(land({ ...source, reveal: [...source.reveal.slice(0, -1), JSON.stringify([turnPartPresentationKey(part), `tool:${changeStep.toolId}`])] }));
  }, [changeNavigationKey, findSources]);
  useEffect(() => {
    if (!focusMessage || !focusNavigationKey) return;
    const source = findSources.find(source => source.messageId === focusMessage.id || source.entryId === focusMessage.id) ?? findSources.find(source => entries.some(entry => entry.kind === 'assistant-turn' && entry.id === source.entryId && entry.parts.some(part => part.key === source.partKey && (part.row.id === focusMessage.id || ((part.kind === 'thinking' || part.kind === 'text') && part.continuations?.some(next => next.row.id === focusMessage.id))))));
    if (!source || !navigationRequests.focus.take(focusNavigationKey, scrollIntent.current)) return;
    navigationRequests.focus.retain(land(source));
  }, [focusNavigationKey, findSources]);
  useEffect(() => {
    const root = content.current;
    if (!root || !('highlights' in CSS) || !('Highlight' in window)) return;
    let frame = 0;
    const update = () => {
      const ranges = find.open && find.query ? visibleFindRanges(root, find.query) : [];
      CSS.highlights.set('transcript-search', new Highlight(...ranges));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    update();
    const observer = new MutationObserver(schedule); observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'inert', 'open'] });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); CSS.highlights.delete('transcript-search'); };
  }, [find.open, find.query, entries]);
  const entryActions = useRef({ rememberOrigin, onOpenFile, onOpenSessionResource, onOpenChanges, openTask, onRetryTurn });
  entryActions.current = { rememberOrigin, onOpenFile, onOpenSessionResource, onOpenChanges, openTask, onRetryTurn };
  const entryCache = useRef(new Map<string, { entry: TranscriptEntry; node: ReactNode }>());
  const entryEnvironment = useRef<unknown[]>([]);
  const observedActivity = chat.state.observedSource === 'external' ? chat.state.observedActivity as ObservedActivity | undefined : undefined;
  const environment = [readingKey, JSON.stringify(sourceContext), cwd, observedLive, observedActivity, chat.isRunning, chat.outcome, chat.subagents, activeSubagentId, observedLive ? matched : undefined, !!onOpenSessionResource, !!onOpenChanges];
  if (environment.some((value, index) => value !== entryEnvironment.current[index])) entryCache.current.clear();
  entryEnvironment.current = environment;
  const renderedEntries = useMemo(() => entries.map((entry, index) => {
    const key = entry.kind === 'assistant-turn' ? assistantTurnKey(entry) : entry.id;
    const cached = entryCache.current.get(key);
    if (!observedLive && cached && unchangedHistoryEntry(cached.entry, entry)) return cached.node;
    const source = { cwd, onOpenSettings, requestTiming: observedLive && index === entries.length - 1 ? chat.requestTiming : undefined, pauseAt: observedLive && index === entries.length - 1 && chat.prompts[0] ? Number(chat.prompts[0].receivedAt) || Date.now() : undefined, onOpenFile: (path: string) => { entryActions.current.rememberOrigin(entry.id); entryActions.current.onOpenFile(path, entry.id); }, onOpenSessionResource: onOpenSessionResource ? (reference: string) => { entryActions.current.rememberOrigin(entry.id); entryActions.current.onOpenSessionResource?.(reference, entry.id); } : undefined };
    const node = entry.kind === 'assistant-turn' ? <AssistantTurn key={assistantTurnKey(entry)} entry={entry} sourceContext={sourceContext} onRetryTurn={index === entries.length - 1 && onRetryTurn ? () => entryActions.current.onRetryTurn?.() : undefined} active={observedLive && chat.isRunning && index === entries.length - 1} observedActivity={index === entries.length - 1 ? observedActivity : undefined} outcome={observedLive && index === entries.length - 1 ? chat.outcome : undefined} byToolCall={byToolCall} resolvedTrees={resolvedTrees} observedLive={observedLive} activeSubagentId={activeSubagentId} onOpenSubagent={id => entryActions.current.openTask(id, entry.id)} onOpenChanges={onOpenChanges ? request => { entryActions.current.rememberOrigin(entry.id); entryActions.current.onOpenChanges?.({ ...request, originTurnId: entry.id }); } : undefined} onRevealTool={toolId => setChangeStep(value => ({ entryId: entry.id, toolId, sequence: (value?.sequence ?? 0) + 1 }))} {...source} /> : <MessageRow key={entry.id} row={entry.row} submittedAt={matched.get(entry.id)?.submittedAt} agents={chat.subagents} onOpenSubagent={id => entryActions.current.openTask(id, entry.id)} {...source} />;
    entryCache.current.set(key, { entry, node });
    return node;
  }), [entries, cwd, JSON.stringify(sourceContext), observedLive, observedActivity, chat.isRunning, chat.outcome, chat.prompts, chat.requestTiming, chat.subagents, byToolCall, resolvedTrees, activeSubagentId, matched, !!onOpenSessionResource, !!onOpenChanges, !!onRetryTurn, onOpenSettings]);
  useLayoutEffect(() => { const keys = new Set(entries.map(entry => entry.kind === 'assistant-turn' ? assistantTurnKey(entry) : entry.id)); for (const key of entryCache.current.keys()) if (!keys.has(key)) entryCache.current.delete(key); }, [entries]);
  return <TranscriptDisclosureProvider key={readingKey} apiRef={disclosures}><DisclosureAnchor.Provider value={stableDisclosureHandler}><div className="thread-wrap" data-following={atBottom}><FindBar open={find.open} sequence={find.sequence} query={find.query} current={matchIndex} count={matches.length} onQuery={query => { interruptScrollWork(); setFind(value => ({ ...value, query, index: 0 })); }} onNavigate={direction => { interruptScrollWork(); setFind(value => ({ ...value, index: nextFindIndex(matchIndex, direction, matches.length), sequence: value.sequence + 1 })); }} onClose={() => { interruptScrollWork(); setFind(value => ({ ...value, open: false, query: '', index: 0 })); }} onSearchAll={onSearchAll} /><div ref={scroll} className="thread-scroll" onWheel={event => { if (!event.defaultPrevented && scrollGestureReachesViewport(event.currentTarget, event.target, event.deltaY)) beginReading(event.deltaY); }} onTouchStart={event => { touchY.current = event.touches[0]?.clientY; }} onTouchMove={event => { const y = event.touches[0]?.clientY; const delta = y === undefined || touchY.current === undefined ? 0 : touchY.current - y; touchY.current = y; if (!event.defaultPrevented && scrollGestureReachesViewport(event.currentTarget, event.target, delta)) beginReading(delta); }} onTouchEnd={() => { touchY.current = undefined; }} onPointerDown={event => { if (event.target === event.currentTarget) beginReading(); }} onKeyDown={event => { const direction = scrollKeyDirection(event, event.target); if (!event.defaultPrevented && scrollGestureReachesViewport(event.currentTarget, event.target, direction)) beginReading(direction); }} onScroll={event => {
    const element = scroll.current!;
    if (event.target !== element) return;
    if (isProgrammaticScroll(element)) return;
    if (!userScrolling.current) { readingScrollTop.current = element.scrollTop; pin.flush(); return; }
    const deltaY = element.scrollTop - readingScrollTop.current;
    rebaseReadingMotion();
    const nextFollowing = followAfterScroll(following.current, userScrolling.current, element.scrollHeight - element.scrollTop - element.clientHeight, deltaY);
    if (following.current !== nextFollowing) { following.current = nextFollowing; setAtBottom(nextFollowing); }
    pin.flush();
    captureReadingAnchors();
    scheduleReadingIdle();
  }}><div className="thread-content" ref={content} onClickCapture={event => { const summary = event.target instanceof Element ? event.target.closest('summary') : null; if (summary instanceof HTMLElement) holdDisclosure(summary); }}>
    {historyHeader && <div onClickCapture={() => { interruptScrollWork(); following.current = false; userScrolling.current = false; anchor.current = null; setAtBottom(false); captureReadingAnchors(); }}>{historyHeader}</div>}
    {history && <HistoryPaging key={readingKey} scrollRef={scroll} cursor={history.hasMore ? chat.messages[0]?.id : undefined} busy={history.loading} error={history.error} enabled={!find.open} load={() => history.loadBefore(chat.messages[0].id)} />}
    {navigationError && <p className="message-error" role="alert">{navigationError}</p>}
    <PrependAnchor ref={prepend} scrollRef={scroll} first={chat.messages[0]?.id} enabled={!atBottom} onReveal={messageId => {
      const entry = entries.find(entry => entry.kind === 'assistant-turn' && entry.rows.some(row => row.id === messageId));
      if (!entry || entry.kind !== 'assistant-turn') return;
      const owner = entry.parts.find(part => part.kind === 'tool' && part.activities?.some(activity => activity.row.id === messageId));
      const sources = buildFindSources([entry]);
      const source = sources.find(source => owner ? source.partKey === owner.key : source.messageId === messageId);
      if (!source) return;
      const reveal = owner?.kind === 'tool' ? [...source.reveal.slice(0, -1), JSON.stringify([turnPartPresentationKey(owner), `task-stage:${owner.tool.id}`])] : source.reveal;
      disclosures.current?.revealMany(reveal);
    }} onRestore={(_element, snapshot) => {
      const saved = scroll.current ? viewportReadingAnchorHandoff(scroll.current, snapshot) : undefined;
      anchor.current = null;
      readingAnchors.current = saved ? [saved] : [];
      readingFragments.current = [snapshot];
      readingRestorePending.current = false;
      recordScrollWrite();
    }}>
    <RunningTurnStatus.Provider value={runningStatus}>{renderedEntries}</RunningTurnStatus.Provider>
    </PrependAnchor>
    {(unanchoredTools.length > 0 || orphans.length > 0) && <div data-minimap-id="other-activity"><Disclosure identity="other-activity" className="transcript-unanchored tool-row" title={<><IconLayers size="var(--icon-meta)" /><span>{t('omp.timeline.other')}</span></>}>
      {unanchoredTools.map(tool => <DisclosureIdentity key={tool.id} identity={`unanchored:${tool.id}`}><div data-presentation-key={`unanchored:${tool.id}`}>{tool.name === 'task' ? <TaskStep tool={tool} byToolCall={byToolCall} resolvedTrees={resolvedTrees} observedLive={observedLive} activeSubagentId={activeSubagentId} onOpenSubagent={openTask} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} live={observedLive && chat.isRunning} /> : <ToolStep tool={tool} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} live={observedLive && chat.isRunning} />}</div></DisclosureIdentity>)}
      {orphans.length > 0 && <DisclosureIdentity identity="orphan-agents"><div data-presentation-key="orphan-agents"><SubagentStage agents={orphans} resolvedTrees={resolvedTrees} observedLive={observedLive} title={t('omp.timeline.other')} activeSubagentId={activeSubagentId} onOpen={openTask} onBeforeToggle={holdDisclosure} /></div></DisclosureIdentity>}
    </Disclosure></div>}
    {chat.notices.filter(item => !retryNoticeHasTurnError(item, chat.messages, chat.isRunning)).map(item => <div className={`native-notice ${item.level}`} key={item.id}>{item.level === 'error' ? <UserErrorNotice error={item.origin === 'omp' ? nativeError(String(item.values?.errorMessage ?? item.nativeMessage ?? item.diagnostic ?? item.text)) : item.diagnostic ?? item.text} context={item.category === 'compaction' ? 'compaction' : 'operation'} details={item.diagnostic} /> : <><div className="composer-status native-notice-summary" role="status">{item.text}</div>{item.diagnostic !== undefined && <Disclosure identity={`notice:${item.id}`} className="tool-row" title={<span className="tool-row-name">{t('omp.timeline.details')}</span>}><NativeData value={item.diagnostic} /></Disclosure>}</>}</div>)}
    {pending.map(receipt => <PendingMessage key={receipt.id} receipt={receipt} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} />)}
    <div data-question-host={chat.runtimeId} />
  </div></div>
  {liveStatusHost && createPortal(<><LiveStatusRow key={readingKey} chat={chat} entry={lastEntry?.kind === 'assistant-turn' ? lastEntry : undefined} startedAt={liveStartedAt} following={atBottom && history?.following !== false} visible={floatingStatusVisible} observedLive={observedLive} queuedCount={queuedCount} onLatest={() => void goLatest()} onOpenSubagent={id => onOpenSubagent(id)} />{!running && (!atBottom || history?.following === false) && <div className="live-status-row live-status-idle"><button type="button" className="live-status-return" onClick={() => void goLatest()} aria-label={t('chat.scrollToBottom')}>{t('omp.timeline.latest')}</button></div>}</>, liveStatusHost)}
  <ConversationMinimap entries={entries} paging={history?.loading} scrollRef={scroll} contentRef={content} overflows={overflow} atBottom={atBottom} matchCounts={matchCounts} onJump={id => { interruptScrollWork(); const index = matches.findIndex(match => match.source.entryId === id); if (index >= 0) setFind(value => ({ ...value, index, sequence: value.sequence + 1 })); else if (id === entries.at(-1)?.id) void goLatest(); else jumpToMessage(id); }} earlier={history?.hasMore ? { onJump: () => { interruptScrollWork(); following.current = false; userScrolling.current = false; smoothFollow.current?.setFollowing(false); anchor.current = null; setAtBottom(false); scroll.current?.scrollTo({ top: 0 }); recordScrollWrite(); captureReadingAnchors(); } } : undefined} />
  </div></DisclosureAnchor.Provider></TranscriptDisclosureProvider>;
}

import { UserErrorNotice } from '../lib/UserErrorNotice';
import { UserFacingError, preserveUserError } from '../lib/user-errors';
// Adapted from PI-Desktop-main SubagentTranscriptTab (LGPL-3.0); display-only native transcript.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChildHistoryRead, HistoryMessage, NativeFrame, NativeSubagent, SavedSubagentEdge, SavedSubagentNavigation, SavedSubagentPage, SessionResourceContext } from '../../shared/contracts';
import { AssistantTurn, DeferredContent, Disclosure, MessageRow } from '../chat/Transcript';
import type { TurnChangesProps } from '../chat/TurnChanges';
import { Prose, ResourceButton } from '../chat/Prose';
import { automaticDisclosureAnchor, clearDisclosureAnchorReserve, DisclosureAnchor, restoreDisclosureAnchor, TranscriptDisclosureProvider, type DisclosureViewportAnchor } from '../chat/disclosure';
import { assistantTurnKey, buildTranscriptEntries, isConversationMessage, turnUsage } from '../chat/presentation';
import { createNativeLiveSequence, messageText, reduceNativeLiveSequence, reconcileNativeLiveSequence, record, text, type ChatMessage } from '../chat/model';
import { IconArrowDown, IconChevronRight, IconLocate, IconRefresh } from '../ui/icons';
import { TooltipButton } from '../ui/ui';
import { SubagentStage, useLiveDuration } from './SubagentStage';
import { AgentStatus, SubagentStatusText } from './TaskCards';
import { useInView } from '../lib/useInView';
import { childHistoryMetrics, formatSubagentCost, formatSubagentTokens, groupSubagentsByToolCall, mergeChildRoster, subagentObservedLive, subagentMetrics, subagentOutcome, subagentPhase, subagentPreview, subagentTitle, subagentTree, type SavedChildRecovery, type SubagentNode } from './subagent-model';
import { rosterActivity } from './roster-model';
import { SourceReadScope } from './source-read-scope';
import { childLiveOverlayAllowed, childTranscriptReadingKey, childReadingAnchorAdjustment, reconcileChildMessages, type ChildReadingState as ReadingState } from './subagent-reading';
import { createReadingAnchor, type ReadingAnchor } from '../lib/transcript-reading-position';
import { HistoryPaging, PrependAnchor } from '../chat/HistoryPaging';
import { AnimatedNumber } from '../ui/motion';
import { formatElapsed } from '../lib/format-duration';
import { useDisplayPreferences } from '../lib/display-preferences';
import { evidenceOf } from '../../shared/subagent-evidence';
import { useModelDisplayName } from '../lib/use-model-display-name';
import { captureViewportReadingAnchors, restoreViewportReadingAnchor, viewportReadingAnchorHandoff, type ViewportReadingAnchor } from '../chat/viewport-reading-anchor';
import { clearProgrammaticScroll, isProgrammaticScroll, noteProgrammaticScroll } from '../ui/motion/programmatic-scroll';
import { followAfterScroll, interruptTranscriptNavigation, scrollGestureReachesViewport, scrollKeyDirection } from '../chat/transcript-follow';
import { rebaseChildReadingAnchors } from './subagent-reading';

interface ChildPageRead { page: SavedSubagentPage; context: SessionResourceContext }
// Provenance stays in details; read diagnostics share one quiet disclosure.
const SOURCE_NOTES: Record<string, true> = {
  'Archive is read-only. Explicit fork stages a bounded private source and artifact snapshot before native creation.': true,
  'Default view follows the last persisted entry, not a verified active native leaf.': true,
};
const readingStates = new Map<string, ReadingState>();
export function SubagentTranscriptTab({ cwd, runtimeId, parentHistoryFollowing, observedLive = false, parentSessionPath, historyLeafId, savedAncestry, savedRecovery, subagent, subagentId, agents, ancestors, visible = true, onOpenFile, onOpenChanges, onOpenSubagent, onOpenSavedSubagent, onSavedNavigation, onOpenSessionResource, onResourceContextChange, onTitleChange, onBack }: TurnChangesProps & { cwd: string; runtimeId: string | null; parentHistoryFollowing: boolean; observedLive?: boolean; parentSessionPath?: string; historyLeafId?: string | null; savedAncestry?: SavedSubagentEdge[]; savedRecovery?: SavedChildRecovery; subagent?: NativeSubagent; subagentId: string; agents: NativeSubagent[]; ancestors: NativeSubagent[]; visible?: boolean; onOpenFile: (path: string) => void; onOpenSubagent: (id: string) => void; onOpenSavedSubagent: (agent: NativeSubagent, ancestry: SavedSubagentEdge[]) => void; onSavedNavigation: (navigation: SavedSubagentNavigation) => void; onOpenSessionResource?: (reference: string) => void; onResourceContextChange: (context: SessionResourceContext) => void; onTitleChange: (title: string) => void; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const modelDisplayName = useModelDisplayName();
  const { durationStyle } = useDisplayPreferences();
  const identityKey = JSON.stringify([runtimeId, parentSessionPath, subagentId, savedAncestry]);
  const knownChild = useRef<{ key: string; agent?: NativeSubagent }>({ key: identityKey, agent: subagent });
  if (knownChild.current.key !== identityKey) knownChild.current = { key: identityKey, agent: subagent };
  else if (subagent) knownChild.current.agent = subagent;
  subagent = subagent ?? knownChild.current.agent;
  const [navigation, setNavigation] = useState<SavedSubagentNavigation>();
  const [sourceTitle, setSourceTitle] = useState('');
  const titleChange = useRef(onTitleChange);
  titleChange.current = onTitleChange;
  const displayName = subagentTitle(subagent ?? { id: subagentId }) || t('chat.subagentUnnamed');
  useEffect(() => { titleChange.current(displayName); }, [displayName]);
  const liveChildAgents = useMemo(() => {
    const find = (nodes: SubagentNode[]): NativeSubagent[] | undefined => {
      for (const node of nodes) { if (node.agent.id === (subagent?.id ?? subagentId)) return node.children.map(child => child.agent); const found = find(node.children); if (found) return found; }
      return undefined;
    };
    return find(subagentTree(agents)) ?? [];
  }, [agents, subagentId, subagent?.id]);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [error, setError] = useState<Error | string>('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const readingKey = childTranscriptReadingKey({ runtimeId, parentSessionPath, parentHistoryFollowing, historyLeafId, savedAncestry, parentToolCallId: subagent?.parentToolCallId, nativeId: subagent?.nativeId, subagentId, historical: subagent?.historical });
  const nativeId = typeof subagent?.nativeId === 'string' ? subagent.nativeId : subagentId;
  const savedId = subagent?.savedId ?? subagent?.id ?? subagentId;
  const savedOnly = subagent?.historical === true;
  const reading = useRef<ReadingState>(readingStates.get(readingKey) ?? { top: 0, follow: true });
  const [showJump, setShowJump] = useState(!reading.current.follow);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const headerInView = useInView(headerRef);
  const prependAnchor = useRef<PrependAnchor>(null);
  const textAnchors = useRef<ViewportReadingAnchor[]>([]);
  const navigationEpoch = useRef(0);
  const pendingReportReveal = useRef(false);
  const observedTop = useRef<number | null>(null);
  const scrollIdle = useRef<number | undefined>(undefined);
  const explicitScrollInput = useRef(false);
  const scrollbarDragging = useRef(false);
  const touchY = useRef<number | undefined>(undefined);
  const ready = useRef(false);
  const [before, setBefore] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [sourceReference, setSourceReference] = useState<string>();
  const [historyMode, setHistoryMode] = useState(!runtimeId || savedOnly);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const historyRevision = useRef<string | undefined>(undefined);
  const paging = useRef(false);
  const disclosureAnchor = useRef<DisclosureViewportAnchor | null>(null);
  const prepended = useRef(false);
  const pageBefore = useRef<ChildHistoryRead | undefined>(reading.current.before);
  const contextChange = useRef(onResourceContextChange);
  contextChange.current = onResourceContextChange;
  const liveSourceKey = readingKey;
  const [liveSequence, setLiveSequence] = useState(createNativeLiveSequence);
  const displayWindow = useRef<ChatMessage[]>([]);
  const acceptLiveFrame = (frame: NativeFrame) => setLiveSequence(previous => reduceNativeLiveSequence(previous, frame, liveSourceKey, liveSourceKey));
  useLayoutEffect(() => { setLiveSequence(createNativeLiveSequence()); displayWindow.current = []; }, [liveSourceKey]);
  const generation = useMemo(() => new SourceReadScope(readingKey), [readingKey, historyLeafId, nativeId, savedId, savedOnly, savedRecovery, revision, historyMode, visible, onSavedNavigation]);
  const currentGeneration = useRef(generation);
  if (currentGeneration.current !== generation) { currentGeneration.current.invalidate(); currentGeneration.current = generation; }
  useLayoutEffect(() => { generation.active = true; paging.current = false; setLoadingEarlier(false); return () => generation.invalidate(); }, [generation]);
  useLayoutEffect(() => {
    clearDisclosureAnchorReserve(contentRef.current); disclosureAnchor.current = null;
    prependAnchor.current?.cancel(); textAnchors.current = []; observedTop.current = null; navigationEpoch.current++; pendingReportReveal.current = false;
    explicitScrollInput.current = false; clearTimeout(scrollIdle.current);
    reading.current = readingStates.get(readingKey) ?? { top: 0, follow: true };
    prepended.current = false;
    pageBefore.current = reading.current.before; historyRevision.current = undefined; ready.current = false;
    setMessages([]); setBefore(undefined); setNavigation(undefined); setSourceReference(undefined); setSourceTitle(''); setDiagnostics([]); setShowJump(!reading.current.follow);
  }, [readingKey]);
  useEffect(() => {
    // Seed a newly opened source once; subsequent frames come from the subscription.
    const frame = record(subagent?.lastEvent);
    if (!subagent?.observationLost && typeof frame.type === 'string') acceptLiveFrame(frame as NativeFrame);
  }, [liveSourceKey]);
  useEffect(() => { if (subagent?.observationLost) acceptLiveFrame({ type: 'runtime_exit' }); }, [subagent?.observationLost, liveSourceKey]);
  const readPage = async (selection?: ChildHistoryRead, savedFallback = false, boundContext?: SessionResourceContext): Promise<ChildPageRead> => {
    const context = boundContext ?? (runtimeId && !savedOnly && !historyMode && !savedFallback
      ? { kind: 'runtime' as const, runtimeId, subagentId: nativeId }
      : parentSessionPath ? { kind: 'saved' as const, parentPath: parentSessionPath, subagentId: savedRecovery?.subagentId ?? savedId, leafId: historyLeafId, ancestry: savedRecovery?.ancestry ?? savedAncestry } : undefined);
    if (!context?.subagentId) throw new UserFacingError(t('omp.subagent.historyUnavailable'));
    const page = context.kind === 'runtime'
      ? await window.ompDesktop.readRuntimeSubagent({ runtimeId: context.runtimeId, subagentId: context.subagentId, ...selection })
      : await window.ompDesktop.readHistorySubagent({ parentPath: context.parentPath, subagentId: context.subagentId, leafId: context.leafId, ancestry: context.ancestry, ...selection });
    return { page, context };
  };
  const publishPage = ({ page, context }: ChildPageRead) => {
    const retainEarlier = ready.current && prepended.current && !pageBefore.current;
    ready.current = true; historyRevision.current = page.revision;
    reading.current = { ...reading.current, before: pageBefore.current, context, childLeafId: page.selectedLeafId, childRevision: page.revision };
    setMessages(current => {
      if (!retainEarlier) return page.messages;
      const ids = new Set(page.messages.map(row => row.id));
      return [...current.filter(row => !ids.has(row.id)), ...page.messages];
    });
    if (!retainEarlier) setBefore(page.hasMore ? page.nextBefore : undefined);
    setDiagnostics(page.diagnostics); setSourceReference(page.sourceReference); setError('');
    setNavigation(page.navigation); setSourceTitle(page.session.title.trim());
    contextChange.current(context);
    if (page.navigation) onSavedNavigation(page.navigation);
    if (context.kind === 'saved' && !historyMode) setHistoryMode(true);
  };
  const measureReadingAnchors = (visibleOnly: boolean): ReadingAnchor[] => {
    const node = scrollRef.current;
    if (!node) return [];
    const viewport = node.getBoundingClientRect();
    const anchors: ReadingAnchor[] = [];
    for (const row of node.querySelectorAll<HTMLElement>('[data-presentation-key], [data-message-id], [data-minimap-id]')) {
      const rect = row.getBoundingClientRect();
      if (rect.height === 0 || (visibleOnly && (rect.bottom <= viewport.top || rect.top >= viewport.bottom))) continue;
      const anchor = createReadingAnchor({ presentationKey: row.dataset.presentationKey, messageId: row.dataset.messageId, minimapId: row.dataset.minimapId, turnId: row.closest<HTMLElement>('[data-minimap-id]')?.dataset.minimapId }, rect.top - viewport.top);
      if (anchor) anchors.push(anchor);
    }
    return anchors;
  };
  const captureReadingAnchors = () => {
    const node = scrollRef.current;
    if (!visible || !node || !node.clientHeight || reading.current.follow) return;
    textAnchors.current = captureViewportReadingAnchors(node);
    reading.current.anchors = measureReadingAnchors(true).sort((left, right) => Math.abs(left.top) - Math.abs(right.top));
    reading.current.top = node.scrollTop;
    observedTop.current = node.scrollTop;
  };
  const acceptNativeMovement = () => {
    const node = scrollRef.current;
    if (!node || !explicitScrollInput.current || observedTop.current === null || isProgrammaticScroll(node)) return;
    const delta = node.scrollTop - observedTop.current;
    if (!delta) return;
    navigationEpoch.current++; pendingReportReveal.current = false; prependAnchor.current?.cancel(); disclosureAnchor.current = null;
    interruptTranscriptNavigation(node);
    rebaseChildReadingAnchors(reading.current, textAnchors.current, delta);
    reading.current.follow = followAfterScroll(reading.current.follow, true, node.scrollHeight - node.scrollTop - node.clientHeight, delta);
    reading.current.top = node.scrollTop; observedTop.current = node.scrollTop;
    setShowJump(!reading.current.follow);
  };
  const syncReading = () => {
    const node = scrollRef.current;
    if (!visible || !node || !node.clientHeight || !ready.current || prependAnchor.current?.active) return;
    acceptNativeMovement();
    if (disclosureAnchor.current?.element.isConnected && contentRef.current) {
      restoreDisclosureAnchor(node, contentRef.current, disclosureAnchor.current);
    } else if (reading.current.follow) {
      clearDisclosureAnchorReserve(contentRef.current);
      node.scrollTop = node.scrollHeight;
      reading.current.anchors = undefined; textAnchors.current = [];
    } else if (!textAnchors.current.some(anchor => restoreViewportReadingAnchor(node, anchor))) {
      const adjustment = childReadingAnchorAdjustment(reading.current.anchors ?? [], measureReadingAnchors(false));
      if (adjustment !== undefined) node.scrollTop += adjustment;
      else if (observedTop.current === null) node.scrollTop = reading.current.top;
    }
    noteProgrammaticScroll(node);
    reading.current.top = node.scrollTop; observedTop.current = node.scrollTop;
    captureReadingAnchors();
  };
  const latestSync = useRef(syncReading);
  latestSync.current = syncReading;
  const navigateLatest = async () => {
    if (loading || paging.current || !generation.active) return;
    const accepts = generation.begin();
    const epoch = ++navigationEpoch.current; prependAnchor.current?.cancel();
    if (scrollRef.current) interruptTranscriptNavigation(scrollRef.current);
    paging.current = true; setLoadingEarlier(true);
    try {
      const result = await readPage(undefined, false, reading.current.context);
      if (!accepts() || epoch !== navigationEpoch.current) return;
      ready.current = false; prepended.current = false; disclosureAnchor.current = null; textAnchors.current = []; observedTop.current = null;
      clearDisclosureAnchorReserve(contentRef.current);
      pageBefore.current = undefined; reading.current = { top: 0, follow: true, context: reading.current.context };
      setShowJump(false); publishPage(result);
    } catch (cause) { if (accepts()) setError(preserveUserError(cause)); }
    finally { if (accepts()) { paging.current = false; setLoadingEarlier(false); } }
  };
  const loadEarlier = async () => {
    if (!before || loading || paging.current || !generation.active) return;
    const accepts = generation.begin();
    paging.current = true; setLoadingEarlier(true); setError('');
    try {
      const result = await readPage({ before }, false, reading.current.context);
      if (!accepts()) return;
      if (historyRevision.current !== result.page.revision) throw new UserFacingError(t('omp.subagent.historyChanged'));
      prepended.current = true;
      const ids = new Set(messages.map(row => row.id));
      setMessages(current => [...result.page.messages.filter(row => !ids.has(row.id)), ...current]);
      setBefore(result.page.hasMore ? result.page.nextBefore : undefined);
    } catch (cause) { if (accepts()) setError(preserveUserError(cause)); throw cause; }
    finally { if (accepts()) { paging.current = false; setLoadingEarlier(false); } }
  };
  const returnLatest = () => { void navigateLatest(); };
  const scheduleReadingIdle = () => {
    clearTimeout(scrollIdle.current);
    scrollIdle.current = window.setTimeout(() => { latestSync.current(); if (!scrollbarDragging.current) explicitScrollInput.current = false; }, 160);
  };
  useEffect(() => () => clearTimeout(scrollIdle.current), []);
  useEffect(() => {
    const release = () => { if (scrollbarDragging.current) { scrollbarDragging.current = false; scheduleReadingIdle(); } };
    window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); };
  }, []);
  const beginReading = () => {
    const node = scrollRef.current;
    if (!node) return;
    navigationEpoch.current++; pendingReportReveal.current = false; prependAnchor.current?.cancel();
    interruptTranscriptNavigation(node);
    acceptNativeMovement();
    explicitScrollInput.current = true;
    scheduleReadingIdle();
    clearProgrammaticScroll(node); disclosureAnchor.current = null;
    reading.current.follow = false; setShowJump(true);
    if (!textAnchors.current.length) captureReadingAnchors();
  };
  const protectReading = () => {
    if (!visible || !ready.current) return;
    navigationEpoch.current++; pendingReportReveal.current = false; prependAnchor.current?.cancel(); disclosureAnchor.current = null;
    explicitScrollInput.current = false; clearTimeout(scrollIdle.current);
    if (scrollRef.current) interruptTranscriptNavigation(scrollRef.current);
    reading.current.follow = false; captureReadingAnchors(); setShowJump(true);
  };
  const latestProtectReading = useRef(protectReading);
  latestProtectReading.current = protectReading;
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !visible) return;
    const navigate = () => latestProtectReading.current();
    node.addEventListener('transcript-navigation-start', navigate);
    return () => node.removeEventListener('transcript-navigation-start', navigate);
  }, [visible, readingKey]);
  useLayoutEffect(() => () => {
    readingStates.delete(readingKey); readingStates.set(readingKey, { ...reading.current });
    if (readingStates.size > 128) readingStates.delete(readingStates.keys().next().value!);
  }, [readingKey]);
  useEffect(() => {
    if (visible) { setError(''); setLoading(true); }
    if (!runtimeId && !parentSessionPath) { setLoading(false); return; }
    let active = true; let busy = false; let pending = false;
    const load = async () => {
      if (!visible || !active || paging.current) return;
      if (busy) { pending = true; return; }
      busy = true;
      do {
        pending = false;
        const requestedBefore = pageBefore.current;
        const accepts = generation.begin();
        try {
          let result: ChildPageRead;
          try { result = await readPage(requestedBefore, false, requestedBefore ? reading.current.context : undefined); }
          catch (cause) {
            if (!active || !accepts()) break;
            if (!runtimeId || savedOnly || historyMode || !parentSessionPath) throw cause;
            try { result = await readPage(requestedBefore, true); }
            catch (fallback) { throw new Error(`${String(cause)}\n${String(fallback)}`); }
          }
          if (active && accepts() && requestedBefore === pageBefore.current) publishPage(result);
        } catch (cause) { if (active && accepts()) setError(preserveUserError(cause)); }
        finally { if (active && accepts()) setLoading(false); }
      } while (pending && active && generation.active && !paging.current);
      busy = false;
    };
    const unsubscribe = window.ompDesktop.onRuntimeEvent(event => {
      if (!active || !generation.active || !observedLive || savedOnly || event.runtimeId !== runtimeId) return;
      if (event.kind === 'exit' || event.kind === 'error') { acceptLiveFrame({ type: event.kind === 'exit' ? 'runtime_exit' : 'runtime_error' }); setError(event.error || t('omp.subagent.runtimeStopped')); return; }
      const payload = record(event.frame?.payload);
      const eventId = payload.id ?? record(payload.progress).id;
      if (event.frame?.type === 'subagent_event' && eventId === nativeId) {
        const frame = record(payload.event);
        if (typeof frame.type === 'string') acceptLiveFrame(frame as NativeFrame);
      }
      const childFrame = text(record(payload.event).type);
      if ((event.frame?.type === 'subagent_lifecycle' && (!eventId || eventId === nativeId)) || (event.frame?.type === 'subagent_event' && eventId === nativeId && ['message_end', 'auto_compaction_end', 'agent_end', 'turn_end'].includes(childFrame)) || event.frame?.type === 'session_settled' || event.frame?.type === 'agent_end') void load();
    });
    void load();
    return () => { active = false; unsubscribe(); };
  }, [runtimeId, observedLive, parentSessionPath, historyLeafId, savedAncestry, subagentId, savedId, savedOnly, nativeId, revision, historyMode, visible, onSavedNavigation, generation, t]);
  useLayoutEffect(() => { latestSync.current(); });
  useEffect(() => {
    const content = contentRef.current;
    const viewport = scrollRef.current;
    if (!content || !viewport || !visible) return;
    const observer = new ResizeObserver(() => latestSync.current());
    const observed = new Set<Element>();
    const enroll = () => {
      const current = new Set<Element>([content, viewport, ...content.querySelectorAll('[data-presentation-key], [data-message-id], [data-minimap-id], .ui-collapse')]);
      for (const element of observed) if (!current.has(element)) { observer.unobserve(element); observed.delete(element); }
      for (const element of current) if (!observed.has(element)) { observer.observe(element, { box: 'border-box' }); observed.add(element); }
    };
    enroll();
    const mutations = new MutationObserver(enroll); mutations.observe(content, { childList: true, subtree: true });
    return () => { mutations.disconnect(); observer.disconnect(); };
  }, [visible, readingKey]);
  const phase = subagent ? subagentPhase(subagent) : 'unknown';
  const historyRows = useMemo(() => messages.map(row => ({ ...row, source: 'history' as const, streaming: false })), [messages]);
  const historyMetrics = useMemo(() => childHistoryMetrics(historyRows), [historyRows]);
  const historyUsage = useMemo(() => turnUsage(historyRows), [historyRows]);
  const snapshotMetrics = subagent ? subagentMetrics(subagent) : {};
  const metrics = { toolCount: snapshotMetrics.toolCount ?? historyMetrics.toolCount, tokens: historyUsage.tokens, cost: snapshotMetrics.cost ?? historyMetrics.cost, durationMs: !before && !pageBefore.current ? historyMetrics.durationMs ?? snapshotMetrics.durationMs : snapshotMetrics.durationMs ?? historyMetrics.durationMs };
  const modelMessage = liveSequence.messages.findLast(row => typeof row.raw.model === 'string') ?? messages.findLast(row => typeof row.raw.model === 'string');
  const live = !!subagent && !!runtimeId && !historyMode && subagentObservedLive(subagent, observedLive);
  const duration = useLiveDuration(metrics.durationMs, live && phase === 'running', visible && headerInView);
  const elapsed = duration === undefined ? undefined : formatElapsed(duration, durationStyle, i18n.language);
  const activity = subagent ? rosterActivity(subagent, t) : undefined;
  const assignment = [subagent?.assignment, subagent?.progress?.assignment, subagent?.task, subagent?.progress?.task].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const instructionRows = messages.filter(row => !isConversationMessage(row.raw));
  const uniqueDiagnostics = [...new Set([...diagnostics, ...(error && !(error instanceof UserFacingError) ? [error instanceof Error ? error.message : error] : []), ...instructionRows.map(row => text(row.raw.errorMessage)).filter(Boolean)])];
  const sourceNotes = uniqueDiagnostics.filter(diagnostic => SOURCE_NOTES[diagnostic] === true);
  const visibleDiagnostics = uniqueDiagnostics.filter(diagnostic => SOURCE_NOTES[diagnostic] !== true);
  const renderProse = (source: string) => <Prose source={source} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} />;
  const body = { cwd, onOpenFile, onOpenSessionResource };
  const liveOverlay = childLiveOverlayAllowed({ runtimeId, observedLive: !!subagent && subagentObservedLive(subagent, observedLive), parentHistoryFollowing, historical: savedOnly, historyMode, before: pageBefore.current });
  const displayRows = reconcileChildMessages(messages, liveSequence.messages, liveSourceKey, liveOverlay, displayWindow.current);
  const assignmentRowId = !before && !pageBefore.current ? displayRows.find(row => row.raw.role === 'user')?.id : undefined;
  const assignmentRow = assignmentRowId ? displayRows.find(row => row.id === assignmentRowId) : undefined;
  const fullAssignment = assignmentRow ? messageText(assignmentRow.raw) : assignment;
  const currentOutcome = subagentOutcome(subagent ?? { id: subagentId }, pageBefore.current ? [] : displayRows);
  const lastOutcome = useRef({ key: readingKey, value: currentOutcome });
  if (lastOutcome.current.key !== readingKey || (!pageBefore.current && currentOutcome.report != null)) lastOutcome.current = { key: readingKey, value: currentOutcome };
  const outcome = pageBefore.current || currentOutcome.report == null ? { ...lastOutcome.current.value, summary: currentOutcome.summary || lastOutcome.current.value.summary, phase: currentOutcome.phase, tone: currentOutcome.phase === 'completed' ? lastOutcome.current.value.issueCount ? 'issues' as const : 'completed' as const : currentOutcome.tone } : currentOutcome;
  const fallbackReport = !pageBefore.current && !outcome.reportRowId && outcome.report != null ? (typeof outcome.report === 'string' ? outcome.report : `\`\`\`json\n${JSON.stringify(outcome.report, null, 2)}\n\`\`\``) : undefined;
  const reportRef = useRef<HTMLDivElement>(null);
  const revealReport = async () => {
    if (pageBefore.current) { pendingReportReveal.current = true; await navigateLatest(); return; }
    const target = outcome.reportRowId ? [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(node => node.dataset.messageId === outcome.reportRowId && node.getBoundingClientRect().height > 0) : reportRef.current;
    if (!target || !scrollRef.current) return;
    navigationEpoch.current++; prependAnchor.current?.cancel(); disclosureAnchor.current = null; reading.current.follow = false;
    interruptTranscriptNavigation(scrollRef.current);
    scrollRef.current.scrollTop += target.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top - 16;
    noteProgrammaticScroll(scrollRef.current); observedTop.current = scrollRef.current.scrollTop;
    target.tabIndex = -1; target.focus({ preventScroll: true }); captureReadingAnchors(); setShowJump(true);
  };
  useLayoutEffect(() => { displayWindow.current = displayRows; });
  useLayoutEffect(() => {
    if (pendingReportReveal.current && !pageBefore.current && !loadingEarlier) { pendingReportReveal.current = false; void revealReport(); }
  });
  useEffect(() => {
    if (!liveOverlay) return;
    const saved: ChatMessage[] = messages.map(row => ({ ...row, source: 'history', streaming: false }));
    setLiveSequence(previous => reconcileNativeLiveSequence(previous, saved, liveSourceKey));
  }, [messages, liveSourceKey, liveOverlay]);
  const childAgents = navigation ? mergeChildRoster(navigation.children, liveChildAgents) : liveChildAgents;
  const { entries, renderedTools } = buildTranscriptEntries(displayRows, {}, childAgents);
  const holdDisclosure = (element: HTMLElement | null, options?: { automatic?: boolean }) => {
    if (!element || !scrollRef.current) return;
    if (options?.automatic) {
      disclosureAnchor.current = reading.current.follow ? null : automaticDisclosureAnchor(scrollRef.current, element);
      if (!reading.current.follow) captureReadingAnchors();
      return;
    }
    disclosureAnchor.current = { element, top: element.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top };
    navigationEpoch.current++; pendingReportReveal.current = false; prependAnchor.current?.cancel(); reading.current.follow = false; captureReadingAnchors(); setShowJump(true);
    interruptTranscriptNavigation(scrollRef.current);
  };
  useLayoutEffect(() => {
    if (phase === 'running') { clearDisclosureAnchorReserve(contentRef.current); disclosureAnchor.current = null; }
  }, [phase]);
  const { byToolCall, resolvedTrees } = groupSubagentsByToolCall(childAgents, renderedTools);
  const openChild = (id: string) => {
    const child = childAgents.find(agent => agent.id === id);
    if (navigation && child && navigation.children.some(saved => saved.id === (child.savedId ?? child.id))) onOpenSavedSubagent({ ...child, id: child.savedId ?? child.id }, navigation.childAncestry);
    else onOpenSubagent(id);
  };
  const displayedAncestors = navigation?.ancestors ?? ancestors;
  const title = displayName;
  const openAncestor = (index: number) => {
    const ancestor = displayedAncestors[index];
    if (navigation) onOpenSavedSubagent(ancestor, navigation.ancestry.slice(0, index));
    else onOpenSubagent(ancestor.id);
  };
  return <div className="subagent-transcript-tab" data-testid="subagent-transcript-tab">
    <header ref={headerRef} className="subagent-detail-header" data-phase={phase}>
      <nav className="subagent-detail-identity" aria-label={t('omp.panel.ancestry')}>
        <button type="button" onClick={onBack}>{t('omp.roster.main')}</button>
        {displayedAncestors.map((ancestor, index) => <span className="subagent-breadcrumb" key={`${index}:${ancestor.id}`}><IconChevronRight size="var(--icon-caption)" /><button type="button" onClick={() => openAncestor(index)}>{subagentTitle(ancestor) || t('chat.subagentUnnamed')}</button></span>)}
        <span className="subagent-breadcrumb"><IconChevronRight size="var(--icon-caption)" /><strong data-agent-identity={subagentId} title={title}>{title}</strong></span>
      </nav>
      <div className="subagent-detail-controls">
        <button type="button" className="icon-btn" title={t('omp.roster.locate')} aria-label={t('omp.roster.locate')} onClick={onBack}><IconLocate size="var(--icon-ui)" /></button>
        <button type="button" className="icon-btn" disabled={(!runtimeId && !parentSessionPath) || loading || loadingEarlier} title={t('omp.workspace.refreshTranscript')} aria-label={t('omp.workspace.refreshTranscript')} onClick={() => { setHistoryMode(!runtimeId || savedOnly); setRevision(value => value + 1); }}><IconRefresh size="var(--icon-ui)" /></button>
      </div>
      <div className="subagent-detail-meta" title={t('omp.roster.historyMetricsScope')}>
        <span className="subagent-detail-status" data-phase={phase}><AgentStatus phase={phase} live={live} /><SubagentStatusText agent={subagent ?? { id: subagentId }} issueCount={outcome.issueCount} /></span>
      {subagent && evidenceOf(subagent).observation === 'inferred' && <span className="subagent-inferred-tag" title={t('omp.subagent.inferredHint')}>{t('omp.subagent.inferred')}</span>}
        {duration !== undefined && duration >= 1000 && <span className="subagent-detail-elapsed" aria-label={t('omp.panel.elapsed', { value: elapsed })}><AnimatedNumber animate={live} value={duration} format={n => formatElapsed(n, durationStyle, i18n.language)} /></span>}
        <span className="subagent-detail-metrics">{modelMessage && <span>{modelDisplayName(text(modelMessage.raw.provider), text(modelMessage.raw.model))}</span>}{metrics.toolCount !== undefined && metrics.toolCount > 0 && <AnimatedNumber animate={live} value={metrics.toolCount} format={n => t('omp.roster.steps', { count: n })} />}{metrics.tokens !== undefined && metrics.tokens > 0 && <AnimatedNumber animate={live} value={metrics.tokens} format={n => t(before || pageBefore.current ? 'omp.roster.loadedTokens' : 'omp.roster.totalTokens', { value: formatSubagentTokens(n) })} />}{metrics.cost !== undefined && metrics.cost > 0 && <AnimatedNumber animate={live} value={metrics.cost} format={formatSubagentCost} />}</span>
      </div>
      <details className="subagent-detail-brief" data-message-id={assignmentRowId}><summary>{t('omp.roster.assignment')}{fullAssignment && <> · {subagentPreview(assignment || fullAssignment, 1)}</>}</summary>{fullAssignment && <div className="subagent-assignment">{assignmentRow?.raw.historyResourceDeferred === true ? <DeferredContent reference={assignmentRow.resourceReference} onOpen={onOpenSessionResource} /> : renderProse(fullAssignment)}</div>}<details className="subagent-detail-metadata"><summary>{t('tools.technicalDetails')}</summary><code className="selectable">{subagentId}</code>{sourceTitle && <p>{sourceTitle}</p>}{historyMode && <p>{t('omp.subagent.savedConversation')}</p>}{sourceNotes.map(diagnostic => <p key={diagnostic}>{diagnostic}</p>)}{liveSequence.uncertain && <p>{t('omp.subagent.liveIdentityProvisional')}</p>}{sourceReference && <ResourceButton reference={sourceReference} onOpen={onOpenSessionResource} />}<pre className="selectable">{JSON.stringify(subagent, null, 2)}</pre>{instructionRows.map(row => <div key={row.id}>{row.raw.historyResourceDeferred === true ? <DeferredContent reference={row.resourceReference} onOpen={onOpenSessionResource} /> : <><pre className="selectable">{JSON.stringify(row.raw, null, 2)}</pre>{row.resourceReference && <ResourceButton reference={row.resourceReference} onOpen={onOpenSessionResource} />}</>}</div>)}</details></details>
      {activity && <span className="subagent-detail-activity">{activity}</span>}
    </header>
    {error instanceof UserFacingError && <UserErrorNotice error={error} />}
    {visibleDiagnostics.length > 0 && <TranscriptDisclosureProvider key={`diagnostics:${readingKey}`}><Disclosure className="subagent-diagnostics" title={<span>{t('omp.outcome.diagnostics', { count: visibleDiagnostics.length })}</span>}>{visibleDiagnostics.map(diagnostic => <pre key={diagnostic} className="selectable">{diagnostic}</pre>)}</Disclosure></TranscriptDisclosureProvider>}
    <div ref={scrollRef} className="subagent-transcript-scroll" style={{ overflowAnchor: 'none' }} role="log" aria-live="off" aria-label={t('omp.workspace.subagentTranscript')} tabIndex={0}
      onWheel={event => { if (event.deltaY && scrollGestureReachesViewport(event.currentTarget, event.target, event.deltaY)) beginReading(); }}
      onTouchStart={event => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMove={event => { const y = event.touches[0]?.clientY; const delta = y !== undefined && touchY.current !== undefined ? touchY.current - y : 0; touchY.current = y; if (delta && scrollGestureReachesViewport(event.currentTarget, event.target, delta)) beginReading(); }}
      onKeyDown={event => { const direction = scrollKeyDirection(event, event.target); if (direction && scrollGestureReachesViewport(event.currentTarget, event.target, direction)) beginReading(); }}
      onPointerDown={event => { if (event.target === event.currentTarget) { scrollbarDragging.current = true; beginReading(); } }}
      onScroll={event => { if (event.target === event.currentTarget && visible) { const nativeInput = explicitScrollInput.current && !isProgrammaticScroll(event.currentTarget); acceptNativeMovement(); latestSync.current(); if (nativeInput) scheduleReadingIdle(); } }}>
      <div ref={contentRef} className="subagent-transcript-list" onPointerDownCapture={event => { const node = scrollRef.current; if (node && scrollGestureReachesViewport(node, event.target, -1) && scrollGestureReachesViewport(node, event.target, 1)) protectReading(); }} onFocusCapture={event => { const node = scrollRef.current; if (node && scrollGestureReachesViewport(node, event.target, -1) && scrollGestureReachesViewport(node, event.target, 1)) protectReading(); }} onClickCapture={event => {
        const summary = event.target instanceof Element ? event.target.closest('summary') : null;
        if (summary instanceof HTMLElement) holdDisclosure(summary);
      }}>
    {pageBefore.current && <button type="button" className="subagent-detail-metadata" onClick={() => void revealReport()}>{t('omp.outcome.report')} <IconArrowDown size="var(--icon-meta)" /></button>}
      <TranscriptDisclosureProvider key={readingKey}><DisclosureAnchor.Provider value={holdDisclosure}>
      {outcome.toolFailureCount > 0 && <Disclosure className="subagent-detail-metadata" title={<span>{t('omp.subagent.toolFailures', { count: outcome.toolFailureCount })}</span>}><p>{t('omp.subagent.toolFailuresHint')}</p></Disclosure>}
      {(before || loadingEarlier || error) && <HistoryPaging key={readingKey} scrollRef={scrollRef} cursor={before} busy={loadingEarlier || loading} error={error} load={loadEarlier} enabled={visible && !loading} />}
      {subagent?.observationLost === true && <div className="subagent-detail-notice" role="status">{text(subagent.observationReason) || t('omp.subagent.runtimeStopped')}</div>}
      {liveSequence.truncated > 0 && <div className="subagent-detail-notice" role="status">{t('omp.subagent.liveWindowTruncated')}</div>}
      {childAgents.length > 0 && <SubagentStage agents={childAgents} observedLive={live} title={t('omp.panel.childTasks')} onOpen={openChild} onBeforeToggle={holdDisclosure} />}
      {!runtimeId && !parentSessionPath ? <div className="subagent-detail-notice">{t('omp.subagent.historyUnavailable')}</div> : loading ? <div className="subagent-loading" role="status" aria-label={t('omp.workspace.loadingTranscript')}><span /><span /><span /></div> : !error && !messages.length && !fallbackReport && <div className="subagent-detail-notice">{t('omp.workspace.noTranscriptEntries')}</div>}
      <PrependAnchor ref={prependAnchor} scrollRef={scrollRef} first={messages[0]?.id} enabled={visible && !reading.current.follow} onRestore={(_element, anchor) => {
        const node = scrollRef.current; if (!node) return;
        const canonical = viewportReadingAnchorHandoff(node, anchor);
        reading.current.anchors = canonical ? [canonical] : []; textAnchors.current = [anchor];
        reading.current.top = node.scrollTop; observedTop.current = node.scrollTop;
      }}>
      {entries.map((entry, index) => entry.kind === 'assistant-turn'
        ? <AssistantTurn key={assistantTurnKey(entry)} entry={entry} sourceContext={reading.current.context} onOpenChanges={onOpenChanges} active={live && phase === 'running' && index === entries.length - 1} byToolCall={byToolCall} resolvedTrees={resolvedTrees} observedLive={live} onOpenSubagent={openChild} {...body} />
        : entry.row.id === assignmentRowId ? null : <MessageRow key={entry.id} row={entry.row} agents={childAgents} onOpenSubagent={openChild} {...body} />)}
      </PrependAnchor>
      {fallbackReport && <div ref={reportRef} className="subagent-final-report" tabIndex={-1}>{renderProse(fallbackReport)}</div>}
      </DisclosureAnchor.Provider></TranscriptDisclosureProvider>
    </div></div>
    {showJump && <TooltipButton type="button" className="jump-latest-btn subagent-transcript-jump" tooltip={t('chat.scrollToBottom')} ariaLabel={t('chat.scrollToBottom')} onClick={() => { if (pageBefore.current) returnLatest(); else { navigationEpoch.current++; pendingReportReveal.current = false; prependAnchor.current?.cancel(); clearDisclosureAnchorReserve(contentRef.current); disclosureAnchor.current = null; reading.current.anchors = undefined; textAnchors.current = []; reading.current.follow = true; const node = scrollRef.current; if (node) { interruptTranscriptNavigation(node); node.scrollTop = node.scrollHeight; noteProgrammaticScroll(node); observedTop.current = node.scrollTop; reading.current.top = node.scrollTop; } setShowJump(false); } }}><IconArrowDown size="var(--icon-meta)" /></TooltipButton>}
  </div>;
}



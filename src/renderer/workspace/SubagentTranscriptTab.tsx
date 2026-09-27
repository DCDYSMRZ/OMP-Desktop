// Adapted from PI-Desktop-main SubagentTranscriptTab (LGPL-3.0); display-only native transcript.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryMessage, NativeMessage, NativeSubagent } from '../../shared/contracts';
import { DeferredContent, Disclosure, DisclosureAnchor, MessageImage, NativeTaskActivity, Prose, ResourceButton, ThinkingRow, ToolCard } from '../chat/Transcript';
import { isVisibleImage } from '../chat/message-details';
import { buildTranscriptEntries, isConversationMessage, type TurnPart } from '../chat/presentation';
import { record, text, type ToolActivity } from '../chat/model';
import { IconArrowDown, IconChevronLeft, IconRefresh } from '../ui/icons';
import { TooltipButton } from '../ui/ui';
import { useLiveDuration } from './SubagentStage';
import { ActivityLine } from './LiquidStage';
import { LiquidSpring } from '../ui/liquid/LiquidSpring';
import { GlassBead } from '../ui/liquid/GlassBead';
import { LavaCrack } from '../ui/liquid/LavaCrack';
import { crackPath, crackPoints } from '../ui/liquid/crack-geometry';
import { LiquidPool } from '../ui/liquid/LiquidPool';
import { registerCapsuleTarget } from '../ui/liquid/capsule-morph';
import { useAgentMotionEvents } from '../lib/agent-motion/agent-events';
import { useInView } from '../lib/agent-motion/ticker';
import { liuliInclusions } from '../ui/liquid/liuli-seed';
import { subagentActivity, subagentError, subagentMetrics, subagentPhase, subagentTitle } from './subagent-model';

interface TranscriptPage { fromByte: number; nextByte: number; reset: boolean; messages: NativeMessage[] }
interface ReadingState { top: number; follow: boolean; anchors?: { id: string; top: number }[] }
// Only known informational provenance belongs in disclosure; unknown diagnostics remain visible.
const SOURCE_NOTES: Record<string, true> = {
  'Archive is read-only. Explicit fork stages a bounded private source and artifact snapshot before native creation.': true,
  'Default view follows the last persisted entry, not a verified active native leaf.': true,
};
const readingStates = new Map<string, ReadingState>();
export function SubagentTranscriptTab({ cwd, runtimeId, parentSessionPath, historyLeafId, subagent, subagentId, visible = true, onOpenFile, onOpenSessionResource, onBack }: { cwd: string; runtimeId: string | null; parentSessionPath?: string; historyLeafId?: string | null; subagent?: NativeSubagent; subagentId: string; visible?: boolean; onOpenFile: (path: string) => void; onOpenSessionResource?: (reference: string) => void; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const readingKey = JSON.stringify([runtimeId, parentSessionPath, historyLeafId, subagentId]);
  const nativeId = typeof subagent?.nativeId === 'string' ? subagent.nativeId : subagentId;
  const savedId = subagent?.savedId ?? subagentId;
  const savedOnly = subagent?.historical === true;
  const reading = useRef<ReadingState>(readingStates.get(readingKey) ?? { top: 0, follow: true });
  const [showJump, setShowJump] = useState(!reading.current.follow);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const headerInView = useInView(headerRef);
  const headerStyle = useMemo(() => liuliInclusions(subagent?.id ?? subagentId) as CSSProperties, [subagent?.id, subagentId]);
  const [rippleKey, setRippleKey] = useState(0);
  useAgentMotionEvents(subagent, event => { if (event.type === 'tool' && visible && headerInView) setRippleKey(value => value + 1); });
  useLayoutEffect(() => {
    if (!subagent?.id) return;
    registerCapsuleTarget(subagent.id, visible ? headerRef.current : null);
    return () => registerCapsuleTarget(subagent.id, null);
  }, [subagent?.id, visible]);
  const userScrolling = useRef(false);
  const scrollIdle = useRef<number | undefined>(undefined);
  const ready = useRef(false);
  const [before, setBefore] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [sourceReference, setSourceReference] = useState<string>();
  const [historyMode, setHistoryMode] = useState(!runtimeId || savedOnly);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const historyRevision = useRef<string | undefined>(undefined);
  const historyIds = useRef(new Set<string>());
  const disclosureAnchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const captureReadingAnchors = () => {
    const node = scrollRef.current;
    if (!visible || !node || !node.clientHeight || reading.current.follow) return;
    const viewport = node.getBoundingClientRect();
    const anchors: NonNullable<ReadingState['anchors']> = [];
    for (const row of node.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const rect = row.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) anchors.push({ id: row.dataset.messageId!, top: rect.top - viewport.top });
    }
    reading.current.anchors = anchors.sort((left, right) => Math.abs(left.top) - Math.abs(right.top));
    reading.current.top = node.scrollTop;
  };
  const syncReading = () => {
    const node = scrollRef.current;
    if (!visible || !node || !node.clientHeight || !ready.current || userScrolling.current) return;
    const viewportTop = node.getBoundingClientRect().top;
    if (disclosureAnchor.current?.element.isConnected) {
      node.scrollTop += disclosureAnchor.current.element.getBoundingClientRect().top - viewportTop - disclosureAnchor.current.top;
    } else if (reading.current.follow) {
      node.scrollTop = node.scrollHeight;
      reading.current.anchors = undefined;
    } else {
      const rows = Array.from(node.querySelectorAll<HTMLElement>('[data-message-id]'));
      let restored = false;
      for (const saved of reading.current.anchors ?? []) {
        const row = rows.find(candidate => candidate.dataset.messageId === saved.id && candidate.getBoundingClientRect().height > 0);
        if (!row) continue;
        node.scrollTop += row.getBoundingClientRect().top - viewportTop - saved.top;
        restored = true;
        break;
      }
      if (!restored) node.scrollTop = reading.current.top;
    }
    reading.current.top = node.scrollTop;
  };
  const latestSync = useRef(syncReading);
  latestSync.current = syncReading;
  const loadEarlier = async () => {
    if (!parentSessionPath || !before || loadingEarlier) return;
    disclosureAnchor.current = null; userScrolling.current = false; reading.current.follow = false; setShowJump(true);
    captureReadingAnchors();
    setLoadingEarlier(true);
    try {
      const page = await window.ompDesktop.readHistorySubagent({ parentPath: parentSessionPath, subagentId: savedId, leafId: historyLeafId, before });
      if (historyRevision.current && historyRevision.current !== page.revision) throw new Error(t('omp.subagent.historyChanged'));
      captureReadingAnchors();
      clearTimeout(scrollIdle.current);
      userScrolling.current = false; reading.current.follow = false; setShowJump(true);
      const added = page.messages.filter(message => !historyIds.current.has(message.id));
      added.forEach(message => historyIds.current.add(message.id));
      setMessages(previous => [...added, ...previous]);
      setBefore(page.hasMore ? page.nextBefore : undefined); setDiagnostics(page.diagnostics); setError('');
      setSourceReference(previous => page.sourceReference ?? previous);
    } catch (cause) { setError(String(cause)); }
    finally { setLoadingEarlier(false); }
  };
  const beginReading = () => {
    disclosureAnchor.current = null; reading.current.anchors = undefined;
    userScrolling.current = true; reading.current.follow = false; setShowJump(true);
    clearTimeout(scrollIdle.current);
    scrollIdle.current = window.setTimeout(() => { userScrolling.current = false; captureReadingAnchors(); }, 180);
  };
  useEffect(() => () => {
    clearTimeout(scrollIdle.current);
    readingStates.delete(readingKey); readingStates.set(readingKey, { ...reading.current });
    if (readingStates.size > 128) readingStates.delete(readingStates.keys().next().value!);
  }, [readingKey]);
  useEffect(() => {
    setError(''); setLoading(true);
    if (!runtimeId && !parentSessionPath) { setLoading(false); return; }
    let active = true; let busy = false; let pending = false; let cursor = 0; let initial = true;
    let usingHistory = !runtimeId || savedOnly;
    const loadHistory = async () => {
      if (!parentSessionPath) return;
      const page = await window.ompDesktop.readHistorySubagent({ parentPath: parentSessionPath, subagentId: savedId, leafId: historyLeafId });
      if (!active) return;
      usingHistory = true;
      ready.current = true; setHistoryMode(true);
      const sameRevision = historyRevision.current === page.revision;
      historyRevision.current = page.revision;
      if (!sameRevision) {
        historyIds.current = new Set(page.messages.map(message => message.id));
        setMessages(page.messages);
        setBefore(page.hasMore ? page.nextBefore : undefined);
      }
      setDiagnostics(page.diagnostics); setError('');
      setSourceReference(previous => sameRevision ? page.sourceReference ?? previous : page.sourceReference);
    };
    const load = async () => {
      if (!active) return;
      if (busy) { pending = true; return; }
      busy = true;
      try {
        if (usingHistory) { await loadHistory(); return; }
        do {
          pending = false;
          const page = await window.ompDesktop.request<TranscriptPage>(runtimeId!, { type: 'get_subagent_messages', subagentId: nativeId, fromByte: cursor });
          if (!active) return;
          if (!Number.isSafeInteger(page.nextByte) || page.nextByte < 0 || (!page.reset && page.nextByte < cursor) || !Array.isArray(page.messages)) throw new Error('Invalid native subagent transcript cursor');
          cursor = page.nextByte;
          const replace = initial || page.reset; initial = false;
          setHistoryMode(false); setBefore(undefined); setDiagnostics([]); setSourceReference(undefined);
          if (replace || page.messages.length) {
            ready.current = true;
            const rows = page.messages.map((raw, index) => ({ id: `rpc:${page.fromByte}:${index}`, raw }));
            setMessages(previous => replace ? rows : [...previous, ...rows]);
          }
          setError('');
        } while (pending && active);
      } catch (cause) {
        if (active && parentSessionPath) {
          try { await loadHistory(); } catch (historyError) { if (active) setError(String(historyError)); }
        } else if (active) setError(String(cause));
      }
      finally { busy = false; if (active) setLoading(false); }
    };
    const unsubscribe = window.ompDesktop.onRuntimeEvent(event => {
      if (event.runtimeId !== runtimeId) return;
      if (usingHistory) return;
      if (event.kind === 'exit' || event.kind === 'error') { setError(event.error || t('omp.subagent.runtimeStopped')); return; }
      const payload = event.frame?.payload as Record<string, unknown> | undefined;
      const progress = payload?.progress as Record<string, unknown> | undefined;
      const eventId = payload?.id ?? progress?.id;
      if ((event.frame?.type.startsWith('subagent_') && (!eventId || eventId === nativeId)) || event.frame?.type === 'session_settled' || event.frame?.type === 'agent_end') void load();
    });
    void load();
    return () => { active = false; unsubscribe(); };
  }, [runtimeId, parentSessionPath, historyLeafId, subagentId, savedId, savedOnly, nativeId, revision, t]);
  useLayoutEffect(() => {
    latestSync.current();
    // content-visibility can replace intrinsic row heights after the commit.
    // Keep the same message/pixel anchor as those measurements settle.
    let secondFrame = 0;
    const frame = requestAnimationFrame(() => { latestSync.current(); secondFrame = requestAnimationFrame(() => latestSync.current()); });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame); };
  });
  useEffect(() => {
    const content = contentRef.current;
    const viewport = scrollRef.current;
    if (!content || !viewport || !visible) return;
    const observer = new ResizeObserver(() => latestSync.current());
    observer.observe(content, { box: 'border-box' });
    observer.observe(viewport, { box: 'border-box' });
    for (const row of content.querySelectorAll<HTMLElement>('[data-message-id]')) observer.observe(row, { box: 'border-box' });
    return () => observer.disconnect();
  }, [visible, messages]);
  const phase = subagent ? subagentPhase(subagent) : 'unknown';
  const metrics = subagent ? subagentMetrics(subagent) : undefined;
  const duration = useLiveDuration(metrics?.durationMs, phase === 'running');
  const elapsed = duration === undefined ? undefined : `${Math.floor(duration / 60000).toString().padStart(2, '0')}:${Math.floor(duration / 1000 % 60).toString().padStart(2, '0')}`;
  const activity = subagent ? subagentActivity(subagent) : undefined;
  const metricItems = [
    metrics?.toolCount === undefined ? undefined : t('omp.panel.tools', { count: metrics.toolCount }),
    metrics?.tokens === undefined ? undefined : t('omp.panel.tokens', { value: new Intl.NumberFormat(i18n.language, { notation: 'compact', maximumFractionDigits: 1 }).format(metrics.tokens) }),
    metrics?.cost === undefined ? undefined : new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(metrics.cost),
  ].filter((value): value is string => value !== undefined);
  const taskError = subagent ? subagentError(subagent) : '';
  const assignment = typeof subagent?.assignment === 'string' ? subagent.assignment : subagent?.task;
  const instructionRows = messages.filter(row => !isConversationMessage(row.raw));
  const conversationRows = messages.filter(row => isConversationMessage(row.raw));
  const firstUserId = conversationRows.find(row => row.raw.role === 'user')?.id;
  const uniqueDiagnostics = [...new Set(diagnostics)];
  const sourceNotes = uniqueDiagnostics.filter(diagnostic => SOURCE_NOTES[diagnostic] === true);
  const visibleDiagnostics = uniqueDiagnostics.filter(diagnostic => SOURCE_NOTES[diagnostic] !== true);
  const renderProse = (source: string) => <Prose source={source} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} />;
  const body = { cwd, onOpenFile, onOpenSessionResource };
  const { entries } = buildTranscriptEntries(conversationRows.map(row => ({ ...row, source: 'history' as const, streaming: false })), {});
  const projectedTools = new Map<string, Extract<TurnPart, { kind: 'tool' }>>();
  const toolsByKey = new Map<string, ToolActivity>();
  for (const entry of entries) if (entry.kind === 'assistant-turn') for (const part of entry.parts) {
    if (part.kind !== 'tool') continue;
    projectedTools.set(part.tool.id, part);
    toolsByKey.set(part.key, part.tool);
  }
  const sourceRows = new Map(conversationRows.map(row => [row.raw, row]));
  const renderTool = (tool: ToolActivity, key: string) => {
    const result = record(tool.result);
    const source = sourceRows.get(tool.result as NativeMessage);
    const deferred = result.historyResourceDeferred === true;
    const activity = tool.status === 'pending' && phase === 'running' && !historyMode ? { ...tool, status: 'running' as const } : tool;
    return <div key={key}><ToolCard tool={activity} {...body}>{deferred ? <DeferredContent reference={source?.resourceReference} onOpen={onOpenSessionResource} /> : undefined}</ToolCard>{!deferred && source?.resourceReference && <div className="message-actions"><ResourceButton reference={source.resourceReference} onOpen={onOpenSessionResource} /></div>}</div>;
  };
  const holdDisclosure = (element: HTMLElement | null) => {
    if (!element || !scrollRef.current) return;
    disclosureAnchor.current = { element, top: element.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top };
    userScrolling.current = false; reading.current.follow = false; captureReadingAnchors(); setShowJump(true);
  };
  const renderContent = (row: HistoryMessage) => { const message = row.raw; return <div className="prose-chat selectable">{typeof message.content === 'string' ? renderProse(message.content) : Array.isArray(message.content) ? message.content.map((raw: unknown, blockIndex: number) => {
    if (!raw || typeof raw !== 'object') return null;
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') return <div key={blockIndex}>{renderProse(block.text)}</div>;
    if (block.type === 'thinking' && typeof block.thinking === 'string') return <ThinkingRow key={blockIndex} value={block.thinking} {...body} />;
    if (block.type === 'toolCall' && text(block.id)) {
      const key = `${row.id}:block:${blockIndex}`;
      const tool = toolsByKey.get(key);
      return tool ? renderTool(tool, key) : null;
    }
    if (isVisibleImage(block)) return <MessageImage key={blockIndex} value={block} onOpenSessionResource={onOpenSessionResource} />;
    return <Disclosure key={blockIndex} className="tool-row" title={<span className="tool-row-name">{String(block.type || t('omp.workspace.nativeSubagent'))}</span>}><pre>{JSON.stringify(block, null, 2)}</pre></Disclosure>;
  }) : <pre>{JSON.stringify(message, null, 2)}</pre>}</div>; };
  return <div className="subagent-transcript-tab" data-testid="subagent-transcript-tab">
    <header ref={headerRef} className={`subagent-detail-header liuli${visible && headerInView ? '' : ' is-offscreen'}`} data-phase={phase} style={headerStyle}>
      <LiquidPool phase={phase} rippleKey={rippleKey} radius={20} />
      <GlassBead agent={subagent} size={40} />
      {subagent && <DetailAgentIdentity agent={subagent} />}
      <div className="subagent-detail-controls">
        <button type="button" className="icon-btn" title={t('omp.panel.back')} aria-label={t('omp.panel.back')} onClick={onBack}><IconChevronLeft size={16} /></button>
        <button type="button" className="icon-btn" disabled={(!runtimeId && !parentSessionPath) || loading || loadingEarlier} title={t('omp.workspace.refreshTranscript')} aria-label={t('omp.workspace.refreshTranscript')} onClick={() => setRevision(value => value + 1)}><IconRefresh size={16} /></button>
      </div>
      <h2 className="subagent-detail-title" title={subagent ? subagentTitle(subagent) : t('chat.subagentUnnamed')}>{subagent ? subagentTitle(subagent) : t('chat.subagentUnnamed')}</h2>
      {subagent?.agent && <span className="subagent-detail-role lg-static lg-thin lg-capsule" title={subagent.agent}>{subagent.agent}</span>}
      <div className="subagent-detail-meta">
        <span className="subagent-detail-status" data-phase={phase}>{t(`omp.panel.phase.${phase}`)}</span>
        {elapsed !== undefined && <span className="subagent-detail-elapsed" aria-label={t('omp.panel.elapsed', { value: elapsed })}>{elapsed}</span>}
        {metricItems.length > 0 && <span className="subagent-detail-metrics">{metricItems.join(' · ')}</span>}
      </div>
      {taskError || phase === 'failed' || phase === 'aborted' ? <div className="subagent-detail-error" data-phase={phase} role="alert">{taskError?.split('\n')[0] || t(`omp.subagent.stage.reason.${phase}`)}</div> : activity && <ActivityLine key={subagentId} className="subagent-detail-activity" text={activity} />}
    </header>
    <div ref={scrollRef} className="subagent-transcript-scroll" style={{ overflowAnchor: 'none' }} role="log" aria-live="off" aria-label={t('omp.workspace.subagentTranscript')} tabIndex={0} onWheel={beginReading} onTouchMove={beginReading} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && event.target === event.currentTarget) beginReading(); }} onPointerDown={event => { if (event.target === event.currentTarget) beginReading(); }} onScroll={() => {
      const node = scrollRef.current;
      if (!node || !visible || !node.clientHeight) return;
      if (userScrolling.current) {
        clearTimeout(scrollIdle.current);
        scrollIdle.current = window.setTimeout(() => { userScrolling.current = false; captureReadingAnchors(); }, 180);
        reading.current.follow = node.scrollHeight - node.scrollTop - node.clientHeight < 64; setShowJump(!reading.current.follow);
        if (reading.current.follow) reading.current.anchors = undefined; else captureReadingAnchors();
      }
      reading.current.top = node.scrollTop;
    }}><div ref={contentRef} className="subagent-transcript-list" onClickCapture={event => {
      const summary = event.target instanceof Element ? event.target.closest('summary') : null;
      if (summary instanceof HTMLElement && scrollRef.current) { disclosureAnchor.current = { element: summary, top: summary.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top }; userScrolling.current = false; reading.current.follow = false; captureReadingAnchors(); setShowJump(true); }
    }}>
      <DisclosureAnchor.Provider value={holdDisclosure}>
      <Disclosure className="tool-row subagent-detail-metadata" title={<span className="tool-row-name">{t('omp.subagent.metadata')}</span>}><code className="selectable">{subagentId}</code></Disclosure>
      {historyMode && <div className="subagent-detail-notice">{t('omp.subagent.savedConversation')}</div>}
      {visibleDiagnostics.map(diagnostic => <div key={diagnostic} className="subagent-detail-notice" role="status">{diagnostic}</div>)}
      {(sourceNotes.length > 0 || sourceReference) && <Disclosure className="tool-row subagent-detail-metadata" title={<span className="tool-row-name">{t('omp.subagent.recordDetails')}</span>}>{sourceNotes.map(diagnostic => <p key={diagnostic} className="subagent-detail-notice">{diagnostic}</p>)}{sourceReference && <div className="message-attachments"><ResourceButton reference={sourceReference} onOpen={onOpenSessionResource} /></div>}</Disclosure>}
      {before && <button type="button" className="btn" disabled={loadingEarlier || loading} onClick={() => void loadEarlier()}>{t(loadingEarlier ? 'omp.workspace.loadingTranscript' : 'omp.subagent.loadEarlier')}</button>}
      {assignment && !firstUserId && <div className="message-row user"><div className="message-col"><div className="message-bubble"><div className="message-user-text selectable">{assignment}</div></div></div></div>}
      {taskError && <div className="subagent-detail-notice" role="alert">{taskError}</div>}
      {error && <div className="subagent-detail-notice" role="alert">{t('omp.subagent.transcriptUnavailable')} {error}</div>}
      {!runtimeId && !parentSessionPath ? <div className="subagent-detail-notice">{t('omp.subagent.historyUnavailable')}</div> : loading ? <div className="subagent-detail-notice" role="status">{t('omp.workspace.loadingTranscript')}</div> : !error && !messages.length && <div className="subagent-detail-notice">{t('omp.workspace.noTranscriptEntries')}</div>}
      {instructionRows.length > 0 && <Disclosure className="tool-row subagent-detail-metadata" title={<span className="tool-row-name">{t('omp.subagent.nativeInstructions', { count: instructionRows.length })}</span>}>{instructionRows.map(row => <div key={row.id}>{row.raw.historyResourceDeferred === true ? <DeferredContent reference={row.resourceReference} onOpen={onOpenSessionResource} /> : <><pre className="selectable">{JSON.stringify(row.raw, null, 2)}</pre>{row.resourceReference && <ResourceButton reference={row.resourceReference} onOpen={onOpenSessionResource} />}</>}</div>)}</Disclosure>}
      {instructionRows.filter(row => typeof row.raw.errorMessage === 'string' && row.raw.errorMessage).map(row => <div key={row.id} data-message-id={row.id} className="subagent-detail-notice" role="alert">{String(row.raw.errorMessage)}</div>)}
      {conversationRows.map(row => {
        const message = row.raw;
        const deferred = message.historyResourceDeferred === true;
        if (message.role === 'toolResult') {
          const projected = projectedTools.get(text(message.toolCallId));
          // The shared projection places matched output at its call; retain the saved row anchor.
          if (projected && projected.row.id !== row.id) return <div key={row.id} data-message-id={row.id} />;
          const tool = projected?.tool ?? { id: text(message.toolCallId) || row.id, name: text(message.toolName) || t('omp.workspace.toolCall'), result: message, status: message.isError === true ? 'error' as const : 'complete' as const };
          return <div key={row.id} data-message-id={row.id}>{renderTool(tool, row.id)}</div>;
        }
        const content = deferred ? <DeferredContent reference={row.resourceReference} onOpen={onOpenSessionResource} /> : message.role === 'custom' && message.customType === 'async-result' ? <NativeTaskActivity raw={message} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} /> : row.id === firstUserId && message.attribution === 'agent' && assignment ? renderProse(assignment) : renderContent(row);
        const savedContent = !deferred && (row.resourceReference ? <div className="message-actions"><ResourceButton reference={row.resourceReference} onOpen={onOpenSessionResource} /></div> : row.id === firstUserId && message.attribution === 'agent' && assignment ? <Disclosure className="tool-row subagent-detail-metadata" title={<span className="tool-row-name">{t('omp.chat.nativeDetails')}</span>}><pre className="selectable">{JSON.stringify(message, null, 2)}</pre></Disclosure> : null);
        return <div key={row.id} data-message-id={row.id}><div className={`message-row ${message.role === 'user' ? 'user' : 'assistant'}`}><div className="message-col"><div className="message-bubble">{content}{typeof message.errorMessage === 'string' && <div className="subagent-detail-notice" role="alert">{message.errorMessage}</div>}</div>{savedContent}</div></div></div>;
      })}
      {!messages.length && typeof subagent?.output === 'string' && renderProse(subagent.output)}
      </DisclosureAnchor.Provider>
    </div></div>
    {showJump && <TooltipButton type="button" className="jump-latest-btn subagent-transcript-jump" tooltip={t('chat.scrollToBottom')} ariaLabel={t('chat.scrollToBottom')} onClick={() => { disclosureAnchor.current = null; reading.current.anchors = undefined; userScrolling.current = false; reading.current.follow = true; if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; setShowJump(false); }}><IconArrowDown size={14} /></TooltipButton>}
    <footer className="subagent-transcript-composer"><p className="file-tree-note">{t('panel.subagentReadOnly')}</p></footer>
  </div>;
}

function DetailAgentIdentity({ agent }: { agent: NativeSubagent }) {
  const { t } = useTranslation();
  const phase = subagentPhase(agent);
  const connector = useMemo(() => crackPath(crackPoints([{ x: 0, y: 4 }, { x: 28, y: 4 }], `${agent.id}:breadcrumb`, { amplitude: 1.2 })), [agent.id]);
  return <div className="subagent-detail-identity" data-phase={phase}>
    <LiquidSpring size={14} active={phase === 'running'} />
    <svg className="subagent-detail-channel" width="28" height="8" viewBox="0 0 28 8" aria-hidden="true"><LavaCrack d={connector} phase={phase} width={1.4} /></svg>
    <span className="subagent-detail-breadcrumb" title={`${t('omp.panel.mainAgent')} / ${subagentTitle(agent)}`}>{t('omp.panel.mainAgent')} / {subagentTitle(agent)}</span>
  </div>;
}

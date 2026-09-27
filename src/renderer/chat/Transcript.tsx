import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeMessage, NativeSubagent } from '../../shared/contracts';
import { parseNativeTaskDelivery } from '../../shared/native-task-results';
import { Markdown, HighlightedCode } from '../ui/Markdown';
import { IconArrowDown, IconBot, IconCheck, IconChevronRight, IconCircleAlert, IconCopy, IconFileText, IconGlobe, IconPencil, IconSearch, IconSparkles, IconTerminal, IconWrench } from '../ui/icons';
import { messageText, printable, record, text, type ChatMessage, type ChatState, type ToolActivity } from './model';
import { assistantTurnKey, buildTranscriptEntries, contentBlocks, nativeUsageSummary, projectTurnProcess, readableNativeData, type AssistantTurnEntry, type TurnPart } from './presentation';
import { ConversationMinimap } from './ConversationMinimap';
import { useSmoothText } from './useSmoothText';
import { createReadingAnchor, readingAnchorAdjustment, recallReadingPosition, rememberReadingPosition, type ReadingAnchor } from '../lib/transcript-reading-position';
import { SubagentStage } from '../workspace/SubagentStage';
import { groupSubagentsByToolCall, plannedSubagents, type SubagentNode } from '../workspace/subagent-model';
import { compactionBlocks, isVisibleImage, nativeTaskChild, sessionResourceReferences, visibleImage } from './message-details';

export const DisclosureAnchor = createContext<(element: HTMLElement | null) => void>(() => {});
type BodyProps = { cwd: string; onOpenFile: (path: string) => void; onOpenSessionResource?: (reference: string) => void };

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(0), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = error || t(copied ? 'omp.transcript.copied' : 'omp.transcript.copyAnswer');
  return <button type="button" className={`copy-btn icon lg-thin lg-capsule lg-pressable${copied ? ' copied' : ''}`} title={label} aria-label={label} onClick={() => { void window.ompDesktop.copyText(value).then(() => { setCopied(Date.now()); setError(''); }, cause => setError(String(cause))); }}>{copied ? <IconCheck size={14} /> : error ? <IconCircleAlert size={14} /> : <IconCopy size={14} />}</button>;
}

/** PI's independent process/item disclosures, with lazy bodies and collapse rails. */
export function Disclosure({ className, headerClass = 'tool-row-header', bodyClass = 'tool-row-body', title, label, collapseLabel, autoOpen = false, children }: { className: string; headerClass?: string; bodyClass?: string; title: ReactNode; label?: string; collapseLabel?: string; autoOpen?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const [manualOpen, setManualOpen] = useState<boolean>();
  const open = manualOpen ?? autoOpen;
  const header = useRef<HTMLButtonElement>(null);
  const notifyAnchor = useContext(DisclosureAnchor);
  const detailsId = useId();
  const toggle = () => { notifyAnchor(header.current); setManualOpen(!open); };
  return <section className={`${className}${open ? ' open' : ''}`}>
    <button type="button" ref={header} className={headerClass} aria-label={label} aria-expanded={open} aria-controls={detailsId} onClick={toggle}>
      {title}<span className={headerClass === 'tool-activity-header' ? 'tool-activity-caret' : 'tool-row-caret'} aria-hidden><IconChevronRight size={12} /></span>
    </button>
    {open && <div className={bodyClass} id={detailsId}>
      <button type="button" className="disclosure-collapse-rail" aria-label={collapseLabel || t('chat.collapseDetails')} title={collapseLabel || t('chat.collapseDetails')} onClick={() => { notifyAnchor(header.current); setManualOpen(false); header.current?.focus({ preventScroll: true }); }} />
      {children}
    </div>}
  </section>;
}

export function Prose({ source, cwd, onOpenFile, onOpenSessionResource, thinking = false, streaming = false }: BodyProps & { source: string; thinking?: boolean; streaming?: boolean }) {
  const displaySource = useSmoothText(source, streaming && !thinking);
  const references = useMemo(() => sessionResourceReferences(displaySource), [displaySource]);
  return <div className={`prose-chat${thinking ? ' thinking-prose' : ''}`}><Markdown source={displaySource} renderDiagrams={!thinking} baseDir={cwd} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} />{references.length > 0 && <div className="message-attachments">{references.map(reference => <ResourceButton key={reference} reference={reference} onOpen={onOpenSessionResource} label={reference} />)}</div>}</div>;
}

export function ResourceButton({ reference, onOpen, label }: { reference: string; onOpen?: (reference: string) => void; label?: string }) {
  const { t } = useTranslation();
  return <button type="button" className="composer-chip chat-file-chip" disabled={!onOpen} title={onOpen ? reference : t('omp.chat.sourceUnavailable', { defaultValue: 'Saved source is unavailable for this view' })} onClick={() => onOpen?.(reference)}>{label || t('omp.chat.openSavedSource', { defaultValue: 'Open saved source' })}</button>;
}

export function MessageImage({ value, onOpenSessionResource }: { value: unknown; onOpenSessionResource?: (reference: string) => void }) {
  const { t } = useTranslation();
  const image = useMemo(() => visibleImage(value), [value]);
  const [failed, setFailed] = useState<string>();
  const reference = text(record(value).resourceReference);
  if (image?.deferred) return <div className="message-attachments"><span>{t('omp.chat.savedImage')}</span><ResourceButton reference={reference} onOpen={onOpenSessionResource} label={t('omp.chat.viewSavedImage')} /></div>;
  return image?.dataUrl && failed !== image.dataUrl ? <img className="native-message-image" src={image.dataUrl} alt={t('chat.messageAttachments')} loading="lazy" onError={() => setFailed(image.dataUrl)} /> : <div className="native-content-unavailable" role="note"><strong>{t('omp.chat.imageUnavailable')}</strong><p>{image?.reason || t('omp.chat.imageDecodeFailed', { defaultValue: 'Image could not be decoded.' })}</p>{reference && <ResourceButton reference={reference} onOpen={onOpenSessionResource} />}</div>;
}

export function DeferredContent({ reference, onOpen }: { reference?: string; onOpen?: (reference: string) => void }) {
  const { t } = useTranslation();
  return <div className="message-attachments"><span>{t('omp.chat.savedContent')}</span>{reference ? <ResourceButton reference={reference} onOpen={onOpen} label={t('omp.chat.viewFullContent')} /> : <span>{t('omp.chat.sourceUnavailable')}</span>}</div>;
}

function NativeData({ value }: { value: unknown }) {
  return <HighlightedCode code={printable(readableNativeData(value))} lang="json" />;
}

export function ThinkingRow({ value, streaming = false, active = false, ...body }: BodyProps & { value: string; streaming?: boolean; active?: boolean }) {
  const { t } = useTranslation();
  const live = active && streaming;
  if (!value.trim() && !live) return null;
  return <Disclosure className={`tool-row thinking${live ? ' is-live' : ''}`} label={t('chat.thinkingShow')} collapseLabel={t('chat.thinkingHide')} title={<>
    <span className="tool-row-icon" aria-hidden><IconSparkles size={14} /></span>
    <span className={`thinking-label${live ? ' is-live' : ''}`}>{t(live ? 'omp.transcript.thinkingLive' : 'chat.thinking')}</span>
  </>}><Prose source={value} thinking {...body} /></Disclosure>;
}

export function ToolCard({ tool, children, ...body }: BodyProps & { tool: ToolActivity; children?: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLButtonElement>(null);
  const detailsId = useId();
  const notifyAnchor = useContext(DisclosureAnchor);
  const args = record(tool.args);
  const name = tool.name.toLowerCase().split(/[.:/]/).at(-1) || tool.name.toLowerCase();
  const family = /^(read|file|read_file)$/.test(name) ? 'read' : /^(edit|write|apply_patch|write_file|edit_file)$/.test(name) ? 'edit' : /^(bash|command|shell|exec|execute|python)$/.test(name) ? 'command' : /^(search|grep|glob|find)$/.test(name) ? 'search' : /^(web|fetch|web_search|web_fetch|browse|browser)$/.test(name) ? 'web' : /^(task|agent|subagent)$/.test(name) ? 'agent' : 'other';
  const Icon = { read: IconFileText, edit: IconPencil, command: IconTerminal, search: IconSearch, web: IconGlobe, agent: IconBot, other: IconWrench }[family];
  const path = text(args.path) || text(args.file_path) || text(args.file);
  const summary = family === 'command' ? text(args.command) || text(args.code) : family === 'search' ? text(args.pattern) || text(args.query) || path : family === 'web' ? text(args.url) || text(args.query) : path || text(args.command) || text(args.pattern) || text(args.url) || text(args.query) || text(args.description) || text(args.task);
  const fileSummary = !!path && summary === path && (family === 'read' || family === 'edit');
  const action = family === 'other' ? tool.name : t(`omp.transcript.tool.${family}`);
  const toggle = () => { notifyAnchor(header.current); setOpen(!open); };
  const status = tool.status === 'running' ? 'running' : tool.status === 'pending' ? 'pending' : tool.status === 'error' ? 'error' : tool.status === 'interrupted' ? 'interrupted' : undefined;
  return <section className={`tool-row status-${tool.status}${open ? ' open' : ''}`}>
    <div className="tool-row-header semantic-tool-header">
      <button type="button" className="tool-row-action" ref={header} aria-expanded={open} aria-controls={detailsId} title={tool.name} onClick={toggle}><span className="tool-row-icon" aria-hidden><Icon size={15} /></span><span className="tool-row-name">{action}</span></button>
      {fileSummary ? <button type="button" className="tool-row-summary tool-file-preview" title={path} aria-label={t('omp.transcript.openFile', { path })} onClick={() => body.onOpenFile(path)}>{path.split(/[\\/]/).filter(Boolean).at(-1) || path}</button> : <span className="tool-row-summary" title={summary}>{summary.replace(/\s+/g, ' ').trim()}</span>}
      {status && <span className={`tool-row-status${status === 'error' ? ' error' : ''}`} title={t(`omp.transcript.status.${status}`)}>{status === 'running' || status === 'pending' ? <span className="tool-spinner" aria-hidden /> : <IconCircleAlert size={13} aria-hidden />}<span>{t(`omp.transcript.status.${status}`)}</span></span>}
      <button type="button" className="tool-row-caret" aria-label={t(open ? 'chat.collapseToolOutput' : 'omp.transcript.expandTool', { name: tool.name })} aria-expanded={open} aria-controls={detailsId} onClick={toggle}><IconChevronRight size={12} /></button>
    </div>
    {open && <div id={detailsId} className="tool-row-body native-tool-details"><button type="button" className="disclosure-collapse-rail" title={t('chat.collapseToolOutput')} aria-label={t('chat.collapseToolOutput')} onClick={() => { notifyAnchor(header.current); setOpen(false); header.current?.focus({ preventScroll: true }); }} />{children ?? <ToolDetails tool={tool} {...body} />}</div>}
  </section>;
}

export function ToolDetails({ tool, ...body }: BodyProps & { tool: ToolActivity }) {
  const { t } = useTranslation();
  const result = record(tool.result);
  return <>
    {tool.args !== undefined && <NativeData value={tool.args} />}
    {tool.result !== undefined && (result.content !== undefined ? <MessageBody raw={{ ...result, role: 'toolResult' }} {...body} /> : typeof tool.result === 'string' ? <Prose source={tool.result} {...body} /> : <NativeData value={tool.result} />)}
    {result.content !== undefined && result.details !== undefined && <Disclosure className="tool-row" title={<span className="tool-row-name">{t('omp.chat.nativeDetails')}</span>}><NativeData value={result.details} /></Disclosure>}
    {tool.stream !== undefined && <Disclosure className="tool-row" title={<span className="tool-row-name">{t('omp.chat.liveActivity')}</span>}><NativeData value={tool.stream} /></Disclosure>}
  </>;
}

function ContentBlock({ value, ...body }: BodyProps & { value: unknown }) {
  const { t } = useTranslation();
  const block = record(value);
  if (block.type === 'text') return <Prose source={text(block.text)} {...body} />;
  if (block.type === 'thinking') return <ThinkingRow value={text(block.thinking)} {...body} />;
  if (block.role === 'toolResult') return <Disclosure className={`tool-row status-${block.isError ? 'error' : 'complete'}`} title={<><span className="tool-row-icon" aria-hidden><IconWrench size={15} /></span><span className="tool-row-name">{text(block.toolName) || t('chat.tool')}</span>{block.isError && <span className="tool-row-status error">{t('omp.transcript.status.error')}</span>}</>}><MessageBody raw={block as NativeMessage} {...body} /></Disclosure>;
  if (isVisibleImage(value)) return <MessageImage value={value} onOpenSessionResource={body.onOpenSessionResource} />;
  return <Disclosure className="tool-row" title={<span className="tool-row-name">{text(block.type) || text(block.role) || t('omp.chat.nativeContent')}</span>}><NativeData value={value} /></Disclosure>;
}

function MessageBody({ raw, ...body }: BodyProps & { raw: NativeMessage }) {
  const { t } = useTranslation();
  if (raw.historyResourceDeferred === true) return <span>{t('omp.chat.savedContent')}</span>;
  if (raw.role === 'bashExecution' || raw.role === 'pythonExecution') return <div className="tool-row open"><div className="tool-row-header">{raw.role === 'bashExecution' ? 'Shell' : 'Python'} · {raw.cancelled ? t('omp.chat.interrupted') : raw.exitCode !== undefined ? t('chat.toolChipExit', { count: Number(raw.exitCode) }) : t('omp.chat.recorded')}</div><HighlightedCode code={text(raw.command) || text(raw.code)} lang={raw.role === 'bashExecution' ? 'bash' : 'python'} /><HighlightedCode code={text(raw.output)} />{raw.truncated === true && <p>{t('omp.chat.outputTruncated')}</p>}{Array.isArray(raw.images) && <MessageBody raw={{ role: 'user', content: raw.images }} {...body} />}</div>;
  if (raw.role === 'fileMention') return <div className="message-attachments">{(Array.isArray(raw.files) ? raw.files : []).map((entry, index) => { const file = record(entry); return <Disclosure key={index} className="tool-row" title={<><span className="tool-row-name">{text(file.path)}</span><span className="tool-row-summary">{text(file.skippedReason)}</span></>}><button className="composer-chip chat-file-chip" onClick={() => body.onOpenFile(text(file.path))}>{text(file.path)}</button>{file.content !== undefined && <HighlightedCode code={text(file.content)} />}{file.image !== undefined && <ContentBlock value={file.image} {...body} />}</Disclosure>; })}</div>;
  if (raw.role === 'branchSummary' || raw.role === 'compactionSummary') return <><Disclosure className="transcript-compaction-row tool-row" title={<><span className="tool-row-name">{t(raw.role === 'branchSummary' ? 'omp.chat.branchSummary' : 'omp.chat.compactionSummary')}</span><span className="tool-row-summary">{text(raw.shortSummary) || text(raw.method)}</span></>}>
    <Prose source={text(raw.summary)} {...body} />
    {typeof raw.tokensBefore === 'number' && <p className="message-meta">{raw.tokensBefore.toLocaleString()} → {typeof raw.tokensAfter === 'number' ? raw.tokensAfter.toLocaleString() : '—'} tokens</p>}
    {compactionBlocks(raw).map((value, index) => <ContentBlock key={index} value={value} {...body} />)}
    {(raw.details !== undefined || raw.archive !== undefined) && <Disclosure className="tool-row" title={<span className="tool-row-name">{t('omp.chat.nativeDetails')}</span>}><NativeData value={{ details: raw.details, archive: raw.archive }} /></Disclosure>}
  </Disclosure>
    {text(raw.warning) && <div className="message-error" role="alert">{text(raw.warning)}</div>}
    {Number(record(raw.archive).truncatedChars) > 0 && <p className="message-error">{t('omp.chat.archiveOmitted', { defaultValue: '{{count}} archive characters are unavailable.', count: Number(record(raw.archive).truncatedChars) })}</p>}
  </>;
  const blocks = contentBlocks(raw);
  return <>{blocks.map((value, index) => <ContentBlock key={index} value={value} {...body} />)}{blocks.length === 0 && (messageText(raw) ? <Prose source={messageText(raw)} {...body} /> : <NativeData value={raw} />)}</>;
}

function Usage({ rows }: { rows: ChatMessage[] }) {
  const { t } = useTranslation();
  const requests = rows.filter(row => Object.keys(record(row.raw.usage)).length > 0);
  if (!requests.length) return null;
  const latest = requests[requests.length - 1];
  const summary = nativeUsageSummary(latest.raw);
  return <details className="message-action-details usage-details native-disclosure">
    <summary className="message-usage-chips lg-static lg-thin lg-capsule" title={t('omp.transcript.latestRequestUsage')} aria-label={t('omp.transcript.latestRequestUsage')}>
      {text(latest.raw.model) && <span className="message-meta-chip model">{text(latest.raw.model)}</span>}
      {summary.total && <span className="message-meta-chip">{t('omp.transcript.tokens', { value: summary.total })}</span>}
      {summary.cost && <span className="message-meta-chip">{summary.cost}</span>}
      {!text(latest.raw.model) && !summary.total && !summary.cost && <span className="message-meta-chip">{t('omp.transcript.usage')}</span>}
      <IconChevronRight size={12} className="native-disclosure-caret" aria-hidden />
    </summary>
    <div className="message-action-detail-body"><p className="message-meta">{t('omp.transcript.latestRequestUsage')}</p>{requests.map((row, index) => {
      const usage = nativeUsageSummary(row.raw);
      return <section key={row.id} data-message-id={row.id}><div className="message-meta">{t('omp.transcript.requestUsage', { number: index + 1 })} · {text(row.raw.model)}{usage.cost ? ` · ${usage.cost}` : ''}</div><NativeData value={usage.detail} /></section>;
    })}</div>
  </details>;
}

function SavedSources({ rows, onOpen }: { rows: ChatMessage[]; onOpen?: (reference: string) => void }) {
  const { t } = useTranslation();
  const sources = rows.filter(row => row.resourceReference);
  if (!sources.length) return null;
  const label = t('omp.transcript.openSavedSource');
  if (sources.length === 1) return <button type="button" className="copy-btn icon lg-thin lg-capsule lg-pressable" title={label} aria-label={label} disabled={!onOpen} onClick={() => onOpen?.(sources[0].resourceReference!)}><IconFileText size={14} /></button>;
  return <details className="message-action-details source-details native-disclosure"><summary className="copy-btn icon lg-thin lg-capsule lg-pressable" title={label} aria-label={label}><IconFileText size={14} /><IconChevronRight size={12} className="native-disclosure-caret" aria-hidden /></summary><div className="message-action-detail-body">{sources.map((row, index) => <button type="button" className="saved-source-action" key={row.id} disabled={!onOpen} title={row.resourceReference} onClick={() => onOpen?.(row.resourceReference!)}><IconFileText size={14} aria-hidden /><span>{t('omp.transcript.savedSource', { number: index + 1 })}</span></button>)}</div></details>;
}

/** Task deliveries are activity, never the native orchestration prompt. */
export function NativeTaskActivity({ raw, agents = [], onOpenSubagent, ...body }: BodyProps & { raw: NativeMessage; agents?: readonly NativeSubagent[]; onOpenSubagent?: (id: string) => void }) {
  const { t } = useTranslation();
  const delivery = parseNativeTaskDelivery(raw);
  return <div className="native-task-delivery">
    {delivery?.jobs.length ? delivery.jobs.map(job => {
      const child = nativeTaskChild(agents, job.id);
      const label = child?.description || job.label || job.id;
      const statusKey = job.status === 'unknown' ? 'omp.subagent.unknown' : `chat.subagentStatus.${job.status}`;
      return <div className="native-task-result" key={job.id}>
        <Disclosure className={`tool-row status-${job.status === 'failed' ? 'error' : job.status === 'completed' ? 'complete' : 'interrupted'}`} title={<>
          <span className="tool-row-icon" aria-hidden>{job.status === 'failed' || job.status === 'aborted' ? <IconCircleAlert size={15} /> : <IconChevronRight size={15} />}</span>
          <span className="tool-row-name">{label}</span>
          <span className={`tool-chip${job.status === 'failed' ? ' is-error' : ''}`}>{t(statusKey)}</span>
          {job.duration && <span className="tool-row-summary">{job.duration}</span>}
        </>}>
          {job.agent && <p className="message-meta">{job.agent}</p>}
          {job.error && <div className="message-error" role="alert">{job.error}</div>}
          {job.abortReason && <div className="message-error">{job.abortReason}</div>}
          {job.result && <Prose source={job.result} {...body} />}
          {job.status === 'unknown' && <p className="message-meta">{t('omp.chat.taskOutcomeUnknown')}</p>}
        </Disclosure>
        {child && onOpenSubagent && <button type="button" className="icon-btn native-task-open" onClick={() => onOpenSubagent(child.id)} title={t('omp.subagent.openDetails', { name: label })} aria-label={t('omp.subagent.openDetails', { name: label })}><IconChevronRight size={15} /></button>}
      </div>;
    }) : <p className="message-meta">{t('omp.chat.backgroundNotification')}</p>}
    <Disclosure className="tool-row native-task-source" title={<span className="tool-row-name">{t('omp.chat.nativeDetails')}</span>}>
      {delivery ? <NativeData value={{ jobs: delivery.jobs, diagnostics: delivery.diagnostics, source: raw }} /> : <><HighlightedCode code={messageText(raw) || printable(raw)} /><NativeData value={raw.details} /></>}
    </Disclosure>
  </div>;
}

function MessageRow({ row, agents, onOpenSubagent, ...body }: BodyProps & { row: ChatMessage; agents: readonly NativeSubagent[]; onOpenSubagent: (id: string) => void }) {
  const { t } = useTranslation();
  const raw = row.raw;
  const deferred = raw.historyResourceDeferred === true;
  const asyncResult = raw.role === 'custom' && raw.customType === 'async-result';
  if (raw.role === 'custom' && raw.customType === 'reset_boundary') return <div className="transcript-context-divider" data-message-id={row.id} role="separator" aria-label={t('omp.chat.contextReset', { defaultValue: 'Context reset' })}>{t('omp.chat.contextReset', { defaultValue: 'Context reset' })}{row.resourceReference && <ResourceButton reference={row.resourceReference} onOpen={body.onOpenSessionResource} />}</div>;
  return <div className={`message-row ${raw.role === 'user' ? 'user' : 'assistant'}${row.streaming ? ' streaming' : ''}`} data-minimap-id={row.id} data-message-id={row.id} data-row-role={raw.role} role="article" aria-label={t(raw.role === 'user' ? 'chat.userMessage' : 'chat.assistantMessage')}><div className="message-col">
    {deferred && raw.role === 'toolResult' && <div className="message-meta">{text(raw.toolName) || t('chat.tool')}</div>}
    {!deferred && !asyncResult && !['user', 'assistant', 'branchSummary', 'compactionSummary'].includes(raw.role) && <div className="message-meta">{raw.role}{raw.customType ? ` · ${raw.customType}` : ''}</div>}
    <div className="message-bubble">{deferred ? <DeferredContent reference={row.resourceReference} onOpen={body.onOpenSessionResource} /> : asyncResult ? <NativeTaskActivity raw={raw} agents={agents} onOpenSubagent={onOpenSubagent} {...body} /> : <MessageBody raw={raw} {...body} />}</div>
    {raw.errorMessage !== undefined && <div className="message-error" role="alert">{text(raw.errorMessage)}</div>}
    <div className="message-actions">{typeof raw.timestamp === 'number' && <span className="message-timestamp">{new Date(raw.timestamp).toLocaleTimeString()}</span>}<Usage rows={[row]} />{!deferred && <><CopyButton value={messageText(raw)} /><SavedSources rows={[row]} onOpen={body.onOpenSessionResource} /></>}</div>
  </div></div>;
}

function TurnPartView({ part, active = false, smoothText = false, ...body }: BodyProps & { part: TurnPart; active?: boolean; smoothText?: boolean }) {
  if (part.kind === 'boundary') return null;
  if (part.kind === 'tool') return <ToolCard tool={part.tool} {...body} />;
  if (part.kind === 'thinking') return <ThinkingRow value={part.value} active={active} streaming={part.row.streaming} {...body} />;
  if (part.kind === 'error') return <div className="message-error" role="alert" data-message-id={part.row.id} data-presentation-key={part.key}>{part.value}</div>;
  return <div className={`message-bubble assistant-turn-fragment${part.row.streaming ? ' streaming' : ''}`} data-message-id={part.row.id} data-presentation-key={part.key}>{part.kind === 'text' ? <Prose source={part.value} streaming={smoothText} {...body} /> : <ContentBlock value={part.block} {...body} />}</div>;
}

type StageProps = { byToolCall: Map<string, NativeSubagent[]>; resolvedTrees: SubagentNode[]; activeSubagentId?: string | null; modelName?: string; onOpenSubagent: (id: string) => void };
function TaskStage({ tool, byToolCall, resolvedTrees, activeSubagentId, modelName, onOpenSubagent, ...body }: BodyProps & StageProps & { tool: ToolActivity }) {
  const notifyAnchor = useContext(DisclosureAnchor);
  return <SubagentStage key={tool.id} toolCallId={tool.id} modelName={modelName} agents={byToolCall.get(tool.id) ?? []} resolvedTrees={resolvedTrees} planned={plannedSubagents(tool.args)} toolStatus={tool.status} toolError={tool.status === 'error' ? text(tool.result) || messageText(record(tool.result) as NativeMessage) || text(record(tool.result).error) : undefined} activeSubagentId={activeSubagentId} onOpen={onOpenSubagent} onBeforeToggle={notifyAnchor} rawDetails={<ToolDetails tool={tool} {...body} />} />;
}
function ProcessChunk({ parts, active, ...body }: BodyProps & { parts: TurnPart[]; active: boolean }) {
  const { t } = useTranslation();
  const tools = parts.filter(part => part.kind === 'tool');
  const issues = tools.filter(part => part.tool.status === 'error' || part.tool.status === 'interrupted').length;
  return <Disclosure className={`turn-process${active ? ' active' : ''}`} headerClass="tool-activity-header" bodyClass="turn-process-body" autoOpen={active && issues > 0} collapseLabel={t('chat.collapseProcess')} title={<>
    <span className="tool-activity-icon" aria-hidden><IconSparkles size={14} /></span>
    <span className={`tool-activity-label${active ? ' running' : ''}`}>{t('chat.processingSteps', { count: parts.length })}</span>
    {issues > 0 && <span className="turn-process-error"><IconCircleAlert size={14} aria-hidden />{t('chat.activityFailures', { count: issues })}</span>}
    {tools.length > 0 && <span className="tool-activity-count">{t('chat.processTools', { count: tools.length })}</span>}
    {active && <span className="tool-spinner" />}
  </>}>{parts.map(part => <TurnPartView key={part.key} part={part} active={active} {...body} />)}</Disclosure>;
}

function AssistantTurn({ entry, active, byToolCall, resolvedTrees, activeSubagentId, modelName, onOpenSubagent, ...body }: BodyProps & StageProps & { entry: AssistantTurnEntry; active: boolean }) {
  const { t } = useTranslation();
  const { process, responses } = projectTurnProcess(entry);
  const latest = entry.rows.at(-1);
  if (!process.length && !responses.length && !entry.rows.some(row => row.raw.usage || row.resourceReference)) return null;
  return <div className={`message-row assistant assistant-turn${active ? ' streaming' : ''}`} data-minimap-id={entry.id} data-message-id={latest?.id} data-row-role="assistant" role="article" aria-label={t('chat.assistantMessage')}><div className="message-col">
    {process.flatMap(chunk => {
      if (chunk.kind === 'stage') return <div key={chunk.tool.id} className="assistant-turn-stage" data-presentation-key={chunk.key}><TaskStage key={chunk.tool.id} modelName={text(entry.rows.find(row => row.raw.model)?.raw.model) || modelName} tool={chunk.tool} byToolCall={byToolCall} resolvedTrees={resolvedTrees} activeSubagentId={activeSubagentId} onOpenSubagent={onOpenSubagent} {...body} /></div>;
      const groups: TurnPart[][] = [];
      for (const part of chunk.parts) {
        const previous = groups.at(-1);
        if (part.kind === 'thinking' || !previous || previous[0].kind === 'thinking') groups.push([part]);
        else previous.push(part);
      }
      return groups.map(parts => parts[0].kind === 'thinking' ? <TurnPartView key={parts[0].key} part={parts[0]} active={active} {...body} /> : <ProcessChunk key={parts[0].key} parts={parts} active={active} {...body} />);
    })}
    {responses.map(part => <TurnPartView key={part.key} part={part} active={active} smoothText={active && part.row.streaming} {...body} />)}
    <div className="message-actions"><Usage rows={entry.rows} />{responses.some(part => part.kind === 'text') && <CopyButton value={responses.filter((part): part is Extract<TurnPart, { kind: 'text' }> => part.kind === 'text').map(part => part.value).join('\n\n')} />}<SavedSources rows={entry.rows} onOpen={body.onOpenSessionResource} />{typeof latest?.raw.timestamp === 'number' && <span className="message-timestamp">{new Date(latest.raw.timestamp).toLocaleTimeString()}</span>}</div>
  </div></div>;
}

export function Transcript({ chat, cwd, onOpenFile, onOpenSessionResource, onOpenSubagent, activeSubagentId, historyHeader }: BodyProps & { chat: ChatState; onOpenSubagent: (id: string) => void; activeSubagentId?: string | null; historyHeader?: ReactNode }) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const userScrolling = useRef(false);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const readingAnchors = useRef<ReadingAnchor[]>([]);
  const readingRestorePending = useRef(false);
  const readingKey = `${chat.runtimeId}:${chat.state.sessionId}`;
  const [atBottom, setAtBottom] = useState(true);
  const [overflow, setOverflow] = useState(false);
  const { entries, renderedTools } = useMemo(() => buildTranscriptEntries(chat.messages, chat.tools), [chat.messages, chat.tools]);
  const anchoredIds = useMemo(() => new Set([...renderedTools, ...Object.keys(chat.tools)]), [renderedTools, chat.tools]);
  const { byToolCall, orphans, resolvedTrees } = useMemo(() => groupSubagentsByToolCall(chat.subagents, anchoredIds), [chat.subagents, anchoredIds]);
  const measureReadingAnchors = (visibleOnly: boolean) => {
    const element = scroll.current;
    const candidates: ReadingAnchor[] = [];
    if (!element) return candidates;
    const viewport = element.getBoundingClientRect();
    for (const node of element.querySelectorAll<HTMLElement>('[data-presentation-key], [data-message-id], [data-minimap-id]')) {
      const rect = node.getBoundingClientRect();
      if (rect.height === 0 || (visibleOnly && (rect.bottom <= viewport.top || rect.top >= viewport.bottom))) continue;
      const candidate = createReadingAnchor({ presentationKey: node.dataset.presentationKey, messageId: node.dataset.messageId, minimapId: node.dataset.minimapId, turnId: node.closest<HTMLElement>('[data-minimap-id]')?.dataset.minimapId }, rect.top - viewport.top);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  };
  const captureReadingAnchors = () => {
    if (readingRestorePending.current) return;
    if (following.current) { readingAnchors.current = []; return; }
    // Prefer a specific stage/fragment over an enclosing turn, even when the
    // turn's top is closer. Each element contributes only its canonical ID.
    const specificity = { 'data-presentation-key': 0, 'data-message-id': 1, 'data-minimap-id': 2 };
    readingAnchors.current = measureReadingAnchors(true).sort((left, right) => specificity[left.attribute] - specificity[right.attribute] || Math.abs(left.top) - Math.abs(right.top));
  };
  const holdDisclosure = (element: HTMLElement | null) => {
    following.current = false;
    userScrolling.current = false;
    captureReadingAnchors();
    setAtBottom(false);
    if (element && scroll.current) {
      const viewportTop = scroll.current.getBoundingClientRect().top;
      anchor.current = { element, top: Math.max(0, element.getBoundingClientRect().top - viewportTop) };
    }
  };
  const sync = () => {
    const element = scroll.current;
    if (!element) return;
    const previousScrollTop = element.scrollTop;
    readingRestorePending.current = false;
    const viewportTop = element.getBoundingClientRect().top;
    if (anchor.current?.element.isConnected) {
      element.scrollTop += anchor.current.element.getBoundingClientRect().top - viewportTop - anchor.current.top;
    } else if (following.current) {
      element.scrollTop = element.scrollHeight;
      readingAnchors.current = [];
    } else {
      const adjustment = readingAnchorAdjustment(readingAnchors.current, measureReadingAnchors(false));
      const restored = adjustment !== undefined;
      if (restored) element.scrollTop += adjustment;
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
    if (element.scrollTop !== previousScrollTop) userScrolling.current = false;
    element.parentElement?.classList.toggle('is-scrolled', element.scrollTop > 2);
    setOverflow(element.scrollHeight > element.clientHeight + 10);
  };
  const latestSync = useRef(sync);
  latestSync.current = sync;
  useLayoutEffect(() => {
    const element = scroll.current;
    const saved = recallReadingPosition(readingKey);
    following.current = saved?.following ?? true;
    userScrolling.current = false;
    readingRestorePending.current = false;
    anchor.current = null;
    readingAnchors.current = saved?.anchors ?? [];
    setAtBottom(following.current);
    if (element && saved && !saved.following) element.scrollTop = saved.scrollTop;
    sync();
    // The content's padding is the live composer reserve: content-box misses it.
    const observer = new ResizeObserver(() => latestSync.current());
    if (content.current) observer.observe(content.current, { box: 'border-box' });
    if (element) observer.observe(element, { box: 'border-box' });
    // Saved child data hydrates after the history rows. Observe each stage as
    // well as the total height, including equal-and-opposite stage resizes.
    if (chat.runtimeId.startsWith('history:')) for (const stage of element?.querySelectorAll<HTMLElement>('.assistant-turn-stage') ?? []) observer.observe(stage, { box: 'border-box' });
    return () => {
      observer.disconnect();
      if (element && !readingRestorePending.current) rememberReadingPosition(readingKey, { scrollTop: element.scrollTop, following: following.current, anchors: readingAnchors.current });
    };
  }, [readingKey]);
  useLayoutEffect(sync);
  const beginReading = () => { anchor.current = null; userScrolling.current = true; };
  const jumpToMessage = (id: string) => {
    const viewport = scroll.current;
    const element = Array.from(viewport?.querySelectorAll<HTMLElement>('[data-minimap-id]') ?? []).find(node => node.dataset.minimapId === id);
    if (!viewport || !element) return;
    following.current = false;
    userScrolling.current = false;
    readingAnchors.current = [];
    anchor.current = { element, top: 0 };
    setAtBottom(false);
    // Offscreen intrinsic heights can change while a smooth scroll is running.
    // Navigate directly, then retain the actual row as layout settles.
    element.scrollIntoView({ behavior: 'auto', block: 'start' });
    sync();
    captureReadingAnchors();
  };
  return <DisclosureAnchor.Provider value={holdDisclosure}><div className="thread-wrap"><div ref={scroll} className="thread-scroll" onWheel={beginReading} onTouchMove={beginReading} onPointerDown={event => { if (event.target === event.currentTarget) beginReading(); }} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && !(event.target instanceof HTMLElement && event.target.closest('button, summary, input, textarea'))) beginReading(); }} onScroll={() => {
    const element = scroll.current!;
    element.parentElement?.classList.toggle('is-scrolled', element.scrollTop > 2);
    if (readingRestorePending.current) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
    // Resize/disclosure scroll events must not silently re-enable pinned follow.
    if (userScrolling.current) { following.current = nearBottom; setAtBottom(nearBottom); }
    // Programmatic scrolls during hydration may be clamped. Keep the original
    // element offsets so later layout/ResizeObserver passes can finish restoring.
    if (userScrolling.current && !following.current) captureReadingAnchors();
    rememberReadingPosition(readingKey, { scrollTop: element.scrollTop, following: following.current, anchors: readingAnchors.current });
  }}><div className="thread-content" ref={content} onClickCapture={event => { const summary = event.target instanceof Element ? event.target.closest('summary') : null; if (summary instanceof HTMLElement) holdDisclosure(summary); }}>
    {historyHeader && <div onClickCapture={() => { following.current = false; userScrolling.current = false; anchor.current = null; setAtBottom(false); captureReadingAnchors(); }}>{historyHeader}</div>}
    {entries.map((entry, index) => entry.kind === 'assistant-turn' ? <AssistantTurn modelName={chat.state.model?.name || chat.state.model?.id} key={assistantTurnKey(entry)} entry={entry} active={chat.isRunning && index === entries.length - 1} byToolCall={byToolCall} resolvedTrees={resolvedTrees} activeSubagentId={activeSubagentId} onOpenSubagent={onOpenSubagent} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} /> : <MessageRow key={entry.id} row={entry.row} agents={chat.subagents} onOpenSubagent={onOpenSubagent} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} />)}
    {Object.values(chat.tools).filter(tool => !renderedTools.has(tool.id)).map(tool => tool.name === 'task' ? <TaskStage modelName={chat.state.model?.name || chat.state.model?.id} key={tool.id} tool={tool} byToolCall={byToolCall} resolvedTrees={resolvedTrees} activeSubagentId={activeSubagentId} onOpenSubagent={onOpenSubagent} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} /> : <ToolCard key={tool.id} tool={tool} cwd={cwd} onOpenFile={onOpenFile} onOpenSessionResource={onOpenSessionResource} />)}
    {orphans.length > 0 && <SubagentStage modelName={chat.state.model?.name || chat.state.model?.id} agents={orphans} resolvedTrees={resolvedTrees} title={t('omp.subagent.stage.orphans')} activeSubagentId={activeSubagentId} onOpen={onOpenSubagent} onBeforeToggle={holdDisclosure} />}
    {chat.notices.map(item => <div className={`native-notice ${item.level}`} key={item.id}><div className="composer-status native-notice-summary" role={item.level === 'error' ? 'alert' : 'status'}>{item.text}</div>{item.diagnostic !== undefined && <Disclosure className="tool-row" title={<span className="tool-row-name">{t('omp.chat.nativeDetails')}</span>}><NativeData value={item.diagnostic} /></Disclosure>}</div>)}
    {chat.isRunning && <div className="transcript-running-status" role="status"><span className="tool-spinner" />{t(chat.state.isCompacting ? 'chat.compactingContext' : chat.state.hasPendingAsyncWork ? 'omp.chat.pendingAsync' : 'chat.running')}{Number(chat.state.queuedMessageCount) > 0 && <span> · {t('omp.chat.queuedCount', { defaultValue: '{{count}} queued', count: Number(chat.state.queuedMessageCount) })}</span>}</div>}
    {chat.outcome === 'aborted' && <div className="composer-status">{t('omp.chat.interrupted')}</div>}
  </div></div>
  <ConversationMinimap entries={entries} scrollRef={scroll} contentRef={content} overflows={overflow} atBottom={atBottom} onJump={jumpToMessage} />
  {!atBottom && <button className="jump-latest-btn lg-thick lg-refract lg-capsule lg-pressable" aria-label={t('chat.scrollToBottom')} title={t('chat.scrollToBottom')} onClick={() => { following.current = true; userScrolling.current = false; anchor.current = null; setAtBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }}><IconArrowDown size={16} /></button>}
  </div></DisclosureAnchor.Provider>;
}

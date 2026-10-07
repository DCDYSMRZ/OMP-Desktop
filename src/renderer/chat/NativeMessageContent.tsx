import { nativeError } from '../../shared/native-error';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeMessage, NativeSubagent } from '../../shared/contracts';
import { parseNativeAsyncDelivery, type NativeAsyncDelivery } from '../../shared/native-task-results';
import { HighlightedCode } from '../ui/Markdown';
import { record, text } from './model';
import { compactionBlocks, isVisibleImage, visibleImage, literalFileReferences, nativeTaskChild, sessionResourceReferences } from './message-details';
import { declaredNativeContent, messageSemantics, nativeMessageNotice, nativeTaskDeliveryLinkVerified } from './native-message-semantics';
import { nativeHarnessNotice } from '../../shared/native-harness-notice';
import { UserErrorNotice } from '../lib/UserErrorNotice';
import { AttachmentScope, UnavailableAttachment, DeferredContent, Disclosure, MessageImage } from './Transcript';
import { Prose, ResourceButton } from './Prose';
import { CompactionCard } from './CompactionCard';
import { formatElapsed } from '../lib/format-duration';
import { useDisplayPreferences } from '../lib/display-preferences';
import { ImagePreview, type PreviewOrigin } from './ImagePreview';
import { referencedImageIndices } from './inline-image-markers';
import { nativeActivityLabel } from './tools/tool-model';
import './native-semantic.css';

export interface NativeContentProps {
  cwd: string;
  onOpenFile: (path: string, originTurnId?: string) => void;
  onOpenSessionResource?: (reference: string, originTurnId?: string) => void;
  /** Stable within B's enclosing canonical row/part disclosure scope. */
  identity?: string;
}
export interface NativeMessageContentProps extends NativeContentProps {
  raw: NativeMessage;
  agents?: readonly NativeSubagent[];
  onOpenSubagent?: (id: string) => void;
}

/** Bounded technical preview, not a substitute for the authorized persisted source. */
function technicalPreview(value: unknown): string {
  const opaque = /^(?:data|signature|thinkingSignature|providerPayload|encrypted_content|encryptedContent|fallbackCreditHandle|blob|base64)$/i;
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') return item.length > 2000 ? `${item.slice(0, 2000)}…` : item;
    if (depth >= 5 && item && typeof item === 'object') return '[…]';
    if (Array.isArray(item)) return [...item.slice(0, 30).map(child => visit(child, depth + 1)), ...(item.length > 30 ? ['[…]'] : [])];
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 40).map(([key, child]) => [key, opaque.test(key) ? '[opaque]' : visit(child, depth + 1)]));
    return item;
  };
  return JSON.stringify(visit(value, 0), null, 2)?.slice(0, 16000) || '';
}
function NativeDetails({ value, identity }: { value: unknown; identity: string }) {
  const { t } = useTranslation();
  return <Disclosure identity={identity} className="tool-row native-semantic-details" title={<span className="tool-row-name">{t('omp.timeline.details')}</span>}>
    <HighlightedCode code={technicalPreview(value)} lang="json" />
  </Disclosure>;
}
function LiteralText({ source, ...body }: NativeContentProps & { source: string }) {
  const references = sessionResourceReferences(source);
  const links = [...new Set(source.match(/https?:\/\/[^\s<>"'`]+/g) || [])];
  const files = literalFileReferences(source);
  return <><div className="native-literal-text">{source}</div>{(references.length > 0 || links.length > 0 || files.length > 0) && <div className="message-attachments">
    {references.map(reference => <ResourceButton key={reference} reference={reference} onOpen={body.onOpenSessionResource} label={reference} />)}
    {links.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}
    {files.map(path => <button key={path} type="button" className="composer-chip chat-file-chip" onClick={() => body.onOpenFile(path)}>{path}</button>)}
  </div>}</>;
}
function DeclaredContent({ value, literal = false, identity = 'declared', ...body }: NativeContentProps & { value: unknown; literal?: boolean }) {
  return <AttachmentScope onOpenSessionResource={body.onOpenSessionResource}>{declaredNativeContent(value).map((block, index) => <NativeContentBlock key={index} identity={`${identity}:${index}`} value={block} literal={literal} {...body} />)}</AttachmentScope>;
}
export function NativeContentBlock({ value, literal = false, identity = 'block', ...body }: NativeContentProps & { value: unknown; literal?: boolean }) {
  const { t } = useTranslation();
  if (typeof value === 'string') return literal ? <LiteralText source={value} {...body} /> : <Prose source={value} {...body} />;
  const block = record(value);
  if (block.display === false || (typeof block.role === 'string' && !messageSemantics(block as NativeMessage).visible)) return null;
  if (text(block.unavailableReason) && !isVisibleImage(value)) return <UnavailableAttachment value={value} reason={text(block.unavailableReason)} onOpenSessionResource={body.onOpenSessionResource} />;
  if (block.type === 'yield-report') return <div className="yield-report">
    {text(block.prose) && <Prose source={text(block.prose)} {...body} />}
    {Array.isArray(block.fields) && block.fields.length > 0 && <dl className="yield-report-facts">{block.fields.map((field, index) => {
      const { name, value, label } = record(field);
      return <div key={index}><dt>{t(`omp.timeline.reportField.${text(name)}`, { defaultValue: text(label) || text(name) })}</dt>{value !== true && <dd>{text(value)}</dd>}</div>;
    })}</dl>}
  </div>;
  if (block.type === 'text') return literal ? <LiteralText source={text(block.text)} {...body} /> : <Prose source={text(block.text)} {...body} />;
  if (block.type === 'thinking') return text(block.thinking).trim() ? <Disclosure identity={`${identity}:thinking`} className="tool-row thinking" title={<span className="tool-row-name">{t('chat.thinking')}</span>}><Prose source={text(block.thinking)} thinking {...body} /></Disclosure> : null;
  if (block.type === 'redactedThinking') return <p className="message-meta">{t('omp.native.redactedReasoning')}</p>;
  if (block.type === 'fallback') return <p className="message-meta">{t('omp.native.providerFallback', { from: text(record(block.from).model) || t('omp.native.previousModel'), to: text(record(block.to).model) || t('omp.native.replacementModel') })}</p>;
  if (['providerPayload', 'signature', 'thinkingSignature'].includes(text(block.type))) return <p className="message-meta">{t('omp.native.opaqueReplay')}</p>;
  if (isVisibleImage(value)) return <MessageImage value={value} onOpenSessionResource={body.onOpenSessionResource} />;
  if (block.type === 'anthropicServerTool') {
    const server = record(block.block);
    return <section className="native-semantic-card"><p className="message-meta">{t('omp.native.providerTool', { name: text(server.name) || text(server.type) })}</p>
      {server.type === 'server_tool_use' ? <NativeDetails identity={`${identity}:input`} value={server.input} /> : <DeclaredContent identity={`${identity}:result`} value={server.content} literal {...body} />}
      <NativeDetails identity={`${identity}:server-details`} value={server} />
    </section>;
  }
  if (block.role === 'toolResult') {
    const skipped = !!nativeHarnessNotice(block);
    return <Disclosure identity={`${identity}:tool-result`} className={`tool-row${block.isError && !skipped ? ' status-error' : ''}`} autoOpen={block.isError === true && !skipped} title={<span className="tool-row-name">{text(block.toolName) || t('omp.native.toolResult')}{skipped ? ` · ${t('tools.status.skipped')}` : block.isError === true ? ` · ${t('omp.native.failed')}` : ''}</span>}>
      <NativeMessageContent identity={`${identity}:tool-content`} raw={block as NativeMessage} {...body} />{!skipped && <NativeMessageError raw={block as NativeMessage} />}
    </Disclosure>;
  }
  const declared = declaredNativeContent(block);
  return <section className="native-semantic-card"><p className="message-meta">{text(block.title) || text(block.type) || t('omp.timeline.other')}</p>
    {/^(?:https?):\/\//.test(text(block.url)) && <a href={text(block.url)} target="_blank" rel="noreferrer">{text(block.url)}</a>}
    {declared.map((content, index) => <NativeContentBlock key={index} identity={`${identity}:content:${index}`} value={content} literal={literal} {...body} />)}
    {!declared.length && !text(block.title) && <p className="message-meta">{t('omp.native.noDeclaredContent')}</p>}
    <NativeDetails identity={`${identity}:details`} value={block} />
  </section>;
}

export function NativeMessageError({ raw, onRetry, onOpenSettings }: { raw: NativeMessage; onRetry?: () => void; onOpenSettings?: () => void }) {
  const { t } = useTranslation();
  const notice = nativeHarnessNotice(raw) ?? nativeMessageNotice(raw);
  if (!notice) return null;
  if (notice.tone !== 'error') return <p className="message-meta" role="note">{t(`omp.native.notices.${notice.text}`, { defaultValue: notice.text })}</p>;
  return <section className="turn-error-block"><UserErrorNotice error={text(raw.errorMessage) ? nativeError(text(raw.errorMessage)) : notice.text} context="turn" onRetry={onRetry} onOpenSettings={onOpenSettings} /></section>;
}

function OutputMetadata({ value, identity = 'output-meta', ...body }: NativeContentProps & { value: unknown }) {
  const { t } = useTranslation();
  const meta = record(value);
  const truncation = record(meta.truncation);
  const source = record(meta.source);
  const artifact = text(truncation.artifactId);
  return <>{meta.artifactError !== undefined && <p className="message-error" role="alert">{t('omp.native.captureFailed', { operation: text(meta.artifactError) || t('omp.native.storageError') })}</p>}
    {meta.truncation !== undefined && <p className="message-meta">{t('omp.native.outputTruncated')}{typeof truncation.outputLines === 'number' && typeof truncation.totalLines === 'number' ? ` · ${t('omp.native.lineCoverage', { shown: truncation.outputLines, total: truncation.totalLines })}` : ''}{truncation.partialLine === true ? ` · ${t('omp.native.partialLine')}` : ''}</p>}
    {artifact && <ResourceButton reference={artifact.includes('://') ? artifact : `artifact://${artifact}`} onOpen={body.onOpenSessionResource} label={t('omp.native.fullOutput')} />}
    {text(source.value) && (source.type === 'path' ? <button type="button" className="composer-chip chat-file-chip" onClick={() => body.onOpenFile(text(source.value))}>{text(source.value)}</button> : source.type === 'internal' ? <ResourceButton reference={text(source.value)} onOpen={body.onOpenSessionResource} label={text(source.value)} /> : source.type === 'url' && /^https?:\/\//.test(text(source.value)) ? <a href={text(source.value)} target="_blank" rel="noreferrer">{text(source.value)}</a> : <span className="message-meta">{text(source.value)}</span>)}
    {meta.diagnostics !== undefined && <DeclaredContent identity={`${identity}:diagnostics`} value={record(meta.diagnostics).summary} literal {...body} />}
  </>;
}

export function NativeActivityContent({ raw, delivery: supplied, taskOwnershipVerified = false, agents = [], onOpenSubagent, identity = 'activity', ...body }: NativeMessageContentProps & { delivery?: NativeAsyncDelivery; taskOwnershipVerified?: boolean }) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  const delivery = supplied ?? parseNativeAsyncDelivery(raw);
  if (!delivery) return <NativeMessageContent identity={identity} raw={raw} agents={agents} onOpenSubagent={onOpenSubagent} {...body} />;
  return <div className="native-task-delivery">{delivery.jobs.map((job, index) => {
    const candidate = job.type === 'task' && job.agentId && !job.ambiguous ? nativeTaskChild(agents, job.agentId) : undefined;
    const child = nativeTaskDeliveryLinkVerified(job, taskOwnershipVerified, candidate) ? candidate : undefined;
    const label = job.label || child?.description || job.id;
    const jobIdentity = `${identity}:${job.type}:${job.id}:${index}`;
    const output = job.result || job.content || '';
    return <section className="native-task-result" key={jobIdentity}><div className="native-semantic-result">
      <p className="message-meta">{label}{job.status !== 'unknown' && ` · ${t(`omp.native.status.${job.status}`)}`}{typeof job.durationMs === 'number' ? ` · ${formatElapsed(job.durationMs, durationStyle, i18n.language)}` : job.duration ? ` · ${job.duration}` : ''}</p>
      {output && (job.type === 'task' ? <Prose source={output} {...body} /> : <LiteralText source={output} {...body} />)}
      <OutputMetadata identity={`${jobIdentity}:meta`} value={job.meta} {...body} />
      {child && onOpenSubagent && <button type="button" className="composer-chip chat-file-chip" onClick={() => onOpenSubagent(child.id)}>{t('omp.native.openChild', { name: child.nativeId || child.id })}</button>}
      <Disclosure identity={`${jobIdentity}:details`} className="tool-row" title={<span className="tool-row-name">{t('omp.timeline.details')}</span>}>
        {job.error && <LiteralText source={job.error} {...body} />}{job.abortReason && <LiteralText source={job.abortReason} {...body} />}
        {job.result && job.content && job.result !== job.content && <LiteralText source={job.content} {...body} />}
        <HighlightedCode code={technicalPreview({ job: job.raw, schema: job.schema, linkedAgent: child?.id })} lang="json" />
      </Disclosure>
    </div></section>;
  })}{delivery.residualContent.map((value, index) => <NativeContentBlock key={`residual:${index}`} identity={`${identity}:residual:${index}`} value={value} literal {...body} />)}{delivery.diagnostics.length > 0 && <NativeDetails identity={`${identity}:diagnostics`} value={delivery.diagnostics} />}</div>;
}

function InlineMessageImage({ value, index, literal }: { value: unknown; index: number; literal: string }) {
  const { t } = useTranslation();
  const image = useMemo(() => visibleImage(value), [value]);
  const [failed, setFailed] = useState(false);
  const [origin, setOrigin] = useState<PreviewOrigin>();
  const label = t('omp.timeline.inlineImage', { number: index + 1 });
  const source = failed ? undefined : image?.dataUrl;
  const reason = image?.reason || t(failed ? 'omp.chat.imageDecodeFailed' : 'omp.chat.imageUnavailable');
  return <><span className="inline-message-image"><span className="inline-message-image-literal" aria-hidden>{literal}</span>{source ? <button type="button" className="inline-message-image-chip" title={label} aria-label={label} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setOrigin({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); }}><img src={source} alt="" loading="lazy" onError={() => setFailed(true)} /><span>{label}</span></button> : <span className="inline-message-image-chip is-unavailable" title={reason} role="img" aria-label={`${label}: ${reason}`}>{t('omp.timeline.inlineImageUnavailable', { number: index + 1 })}</span>}</span>{origin && source && <ImagePreview source={source} name={label} origin={origin} onClose={() => setOrigin(undefined)} />}</>;
}

function UserMessageContent({ blocks, ...body }: NativeContentProps & { blocks: unknown[] }) {
  const images = useMemo(() => blocks.filter(isVisibleImage), [blocks]);
  const referenced = useMemo(() => referencedImageIndices(blocks.flatMap(block => typeof block === 'string' ? [block] : record(block).type === 'text' ? [text(record(block).text)] : []), images.length), [blocks, images.length]);
  const render = useCallback((index: number, literal: string) => <InlineMessageImage value={images[index]} index={index} literal={literal} />, [images]);
  const imageMarkers = useMemo(() => ({ count: images.length, render }), [images.length, render]);
  let imageIndex = 0;
  return <>{blocks.map((block, index) => {
    if (isVisibleImage(block) && referenced.has(imageIndex++)) return null;
    const source = typeof block === 'string' ? block : record(block).type === 'text' ? text(record(block).text) : undefined;
    return source === undefined ? <NativeContentBlock key={index} value={block} {...body} /> : <Prose key={index} source={source} imageMarkers={imageMarkers} {...body} />;
  })}</>;
}

export function NativeMessageContent({ raw, agents, onOpenSubagent, identity = 'message', ...body }: NativeMessageContentProps) {
  const { t } = useTranslation();
  const semantics = messageSemantics(raw);
  if (!semantics.visible) return null;
  if (raw.historyResourceDeferred === true) return <DeferredContent reference={text(raw.resourceReference) || undefined} onOpen={body.onOpenSessionResource} />;
  if ((raw.role === 'custom' || raw.role === 'hookMessage') && raw.customType === 'async-result') {
    const delivery = parseNativeAsyncDelivery(raw);
    if (delivery) return <NativeActivityContent identity={identity} delivery={delivery} raw={raw} agents={agents} onOpenSubagent={onOpenSubagent} {...body} />;
  }
  if (raw.role === 'bashExecution' || raw.role === 'pythonExecution') return <section className="native-semantic-card">
    <p className={typeof raw.exitCode === 'number' && raw.exitCode !== 0 ? 'message-error' : 'message-meta'}>{raw.cancelled ? t('omp.native.interrupted') : typeof raw.exitCode === 'number' ? t('omp.native.exitCode', { code: raw.exitCode }) : t('omp.native.executionRecorded')}{raw.excludeFromContext === true ? ` · ${t('omp.native.excludedContext')}` : ''}</p>
    <HighlightedCode code={text(raw.command) || text(raw.code)} lang={raw.role === 'bashExecution' ? 'bash' : 'python'} /><HighlightedCode code={text(raw.output)} />
    {raw.truncated === true && !record(raw.meta).truncation && <p className="message-meta">{t('omp.native.outputTruncated')}</p>}<OutputMetadata identity={`${identity}:meta`} value={raw.meta} {...body} />
    {Array.isArray(raw.images) && raw.images.map((image, index) => <NativeContentBlock key={index} identity={`${identity}:image:${index}`} value={image} {...body} />)}
  </section>;
  if (raw.role === 'fileMention') return <>{(Array.isArray(raw.files) ? raw.files : []).map((entry, index) => {
    const file = record(entry);
    return <section key={index} className="native-semantic-card"><button type="button" className="composer-chip chat-file-chip" onClick={() => body.onOpenFile(text(file.path))}>{text(file.path)}</button>
      {text(file.skippedReason) && <p className="message-meta">{file.skippedReason === 'binary' ? t('omp.native.binarySkipped') : file.skippedReason === 'tooLarge' ? t('omp.native.largeSkipped') : text(file.skippedReason)}</p>}
      {typeof file.lineCount === 'number' && <span className="message-meta">{t('omp.native.lineCount', { count: file.lineCount })}</span>}
      {text(file.content) && <Disclosure identity={`${identity}:file:${index}:content`} className="tool-row" title={<span className="tool-row-name">{t('omp.native.fileContents')}</span>}><HighlightedCode code={text(file.content)} /></Disclosure>}
      {file.image !== undefined && <NativeContentBlock identity={`${identity}:file:${index}:image`} value={file.image} {...body} />}
    </section>;
  })}</>;
  if (raw.role === 'branchSummary' || raw.role === 'compactionSummary') return <CompactionCard kind={raw.role === 'branchSummary' ? 'branch' : 'context'} identity={`${identity}:summary`} summary={text(raw.summary)} shortSummary={text(raw.shortSummary)} tokensBefore={typeof raw.tokensBefore === 'number' ? raw.tokensBefore : undefined} tokensAfter={typeof raw.tokensAfter === 'number' ? raw.tokensAfter : undefined} details={<>
    {text(raw.fromId) && <p className="message-meta">{t('omp.compaction.branchOrigin', { id: text(raw.fromId) })}</p>}
    {compactionBlocks(raw).length > 0 && <Disclosure identity={`${identity}:archive`} className="tool-row" title={<span className="tool-row-name">{t('omp.compaction.archive')}</span>}>{compactionBlocks(raw).map((value, index) => <NativeContentBlock key={index} identity={`${identity}:archive:${index}`} value={value} {...body} />)}</Disclosure>}
    {(raw.details !== undefined || raw.archive !== undefined) && <Disclosure identity={`${identity}:archive-details`} className="tool-row" title={<span className="tool-row-name">{t('omp.compaction.details')}</span>}><HighlightedCode code={technicalPreview({ details: raw.details, archive: raw.archive })} lang="json" /></Disclosure>}
    {text(raw.warning) && <p className="message-error" role="alert">{text(raw.warning)}</p>}{Number(record(raw.archive).truncatedChars) > 0 && <p className="message-meta">{t('omp.compaction.archiveOmitted', { count: Number(record(raw.archive).truncatedChars) })}</p>}
  </>}><Prose source={text(raw.summary)} {...body} /></CompactionCard>;
  if (raw.role === 'custom' || raw.role === 'hookMessage') return <CustomContent identity={identity} raw={raw} {...body} />;
  const blocks = declaredNativeContent(raw);
  if (raw.role === 'user') return <UserMessageContent blocks={blocks} {...body} />;
  return <>{blocks.map((value, index) => <NativeContentBlock key={index} identity={`${identity}:block:${index}`} value={value} literal={raw.role === 'toolResult' || raw.role === 'command_output' || semantics.actor === 'tool'} {...body} />)}{(!blocks.length || semantics.family === 'unknown') && <NativeDetails identity={`${identity}:raw-details`} value={raw} />}</>;
}

function CustomContent({ raw, identity = 'custom', ...body }: NativeMessageContentProps) {
  const { t } = useTranslation();
  const details = record(raw.details);
  const type = text(raw.customType);
  const literal = type === 'lsp-late-diagnostic';
  if (type === 'reset_boundary') return <p className="message-meta">{t('omp.native.resetHistory')}</p>;
  if (type === 'skill-prompt') return <>
    <p className="message-meta">{text(details.name) && t('omp.native.skillName', { name: text(details.name) })}</p>
    {text(details.path) && <p className="message-meta native-literal-text">{t('omp.native.recordedSkillPath', { path: text(details.path) })}</p>}
    {text(details.prompt) ? <Prose source={text(details.prompt)} {...body} /> : <DeclaredContent identity={`${identity}:skill`} value={raw} {...body} />}
    {text(details.prompt) && <Disclosure identity={`${identity}:expanded-skill`} className="tool-row" title={<span className="tool-row-name">{t('omp.native.expandedSkill')}</span>}><DeclaredContent identity={`${identity}:expanded-skill-content`} value={raw} {...body} /></Disclosure>}
  </>;
  if (type === 'collab-prompt') return <>{text(details.from) && <p className="message-meta">{t('omp.native.from', { name: text(details.from) })}</p>}<DeclaredContent identity={`${identity}:collab`} value={raw} literal={literal} {...body} /></>;
  if (type === 'background-tan-dispatch') return <><LiteralText source={text(details.work) || declaredNativeContent(raw).map(value => text(record(value).text)).join('\n')} {...body} />{text(details.jobId) && <p className="message-meta">{t('omp.native.backgroundJob', { id: text(details.jobId) })}</p>}<NativeDetails identity={`${identity}:dispatch-details`} value={details} /></>;
  if (type === 'lsp-late-diagnostic' && Array.isArray(details.files) && details.files.length > 0) return <>{details.files.map((value, index) => {
    const file = record(value);
    return <section className="native-semantic-card" key={index}>{text(file.path) && <button type="button" className="composer-chip chat-file-chip" onClick={() => body.onOpenFile(text(file.path))}>{text(file.path)}</button>}{text(file.summary) && <p className={file.errored === true ? 'message-error' : 'message-meta'}>{text(file.summary)}</p>}{Array.isArray(file.messages) && file.messages.map((message, i) => <div className="native-literal-text" key={i}>{text(message)}</div>)}</section>;
  })}</>;
  if (type === 'advisor' && Array.isArray(details.notes) && details.notes.length > 0) return <>{details.notes.map((value, index) => {
    const note = record(value);
    return <section className="native-semantic-card" key={index}><p className={note.severity === 'blocker' ? 'message-error' : 'message-meta'}>{text(note.advisor) || t('omp.native.advisor')}{text(note.severity) ? ` · ${t(`omp.native.severity.${text(note.severity)}`, { defaultValue: text(note.severity) })}` : ''}</p><Prose source={text(note.note)} {...body} /></section>;
  })}</>;
  if (type.startsWith('irc:')) return <><p className="message-meta">{nativeActivityLabel(raw, t)}</p><DeclaredContent identity={`${identity}:irc`} value={text(details.message) || text(details.body) || raw} {...body} />{raw.details !== undefined && <NativeDetails identity={`${identity}:irc-details`} value={details} />}</>;
  if (type === 'launch-completion' && Array.isArray(details.daemons) && details.daemons.length > 0) return <>{details.daemons.map((value, index) => {
    const daemon = record(value);
    return <section className="native-semantic-card" key={index}><p className={typeof daemon.exitCode === 'number' && daemon.exitCode !== 0 ? 'message-error' : 'message-meta'}>{nativeActivityLabel({ customType: 'launch-completion', details: { daemons: [daemon] } }, t)}</p><NativeDetails identity={`${identity}:daemon:${index}`} value={daemon} /></section>;
  })}</>;
  if (type === 'handoff') return <CompactionCard kind="handoff" identity={`${identity}:handoff`} summary={declaredNativeContent(raw).map(value => typeof value === 'string' ? value : text(record(value).text)).join('\n')} shortSummary={text(raw.shortSummary)} details={raw.details !== undefined && <Disclosure identity={`${identity}:handoff-details`} className="tool-row" title={<span className="tool-row-name">{t('omp.compaction.details')}</span>}><HighlightedCode code={technicalPreview(details)} lang="json" /></Disclosure>}><DeclaredContent identity={`${identity}:handoff-content`} value={raw} {...body} /></CompactionCard>;
  return <><DeclaredContent identity={`${identity}:content`} value={raw} literal={literal} {...body} />{raw.details !== undefined && <NativeDetails identity={`${identity}:details`} value={details} />}{declaredNativeContent(raw).length === 0 && <NativeDetails identity={`${identity}:raw`} value={raw} />}</>;
}

import { UserErrorNotice } from '../lib/UserErrorNotice';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Attachment, FileEntry, NativeCommand, PromptInput } from '../../shared/contracts';
import { record, type ChatState } from './model';
import { createFileReference, editorSelectionRange, insertClipboardText, nextChipToken, paintEditorValue, readEditorValue, setEditorCaret } from './composer/editor';
import { installComposerDeletionGuard } from './composer/native-deletion';
import { getComposerDraft, type Draft } from './composer/drafts';
import { IconPlus, IconArrowUp, IconStop, IconChevronDown, IconCheck, IconCircleAlert, IconClose, IconFolder, IconFileText, IconChevronRight } from '../ui/icons';
import { Button, Input } from '../ui/ui';
import { AnchoredMenu } from '../ui/AnchoredMenu';
import { errorText } from '../app/runtime-store';
import { ImagePreview, type PreviewOrigin } from './ImagePreview';
import { SubmissionReceipts } from './SubmissionReceipts';
import { CommandList } from './composer/CommandList';
import { AttachmentChip, type RejectedAttachment } from './composer/AttachmentChip';
import { commandSource, effectiveThinking, modelGroups, rankedCommands, visibleFileReference } from './composer/catalog';
import { useFileDrag } from './composer/useFileDrag';
import { Swap, useFlipList, useReducedMotion, motion, isMotionPaused } from '../ui/motion';
import type { DesktopQueue, QueuedPrompt } from './composer/queue';
import { QueueChips } from './composer/QueueChips';
import { presentUserError, UserFacingError, preserveUserError } from '../lib/user-errors';
import { ModelLabel } from './composer/ModelLabel';
import { useModelDisplayName } from '../lib/use-model-display-name';

export interface ComposerAccess {
  ready: boolean;
  category?: 'connecting' | 'checking' | 'ready' | 'unpersisted' | 'disconnected' | 'source-unavailable' | 'readonly' | 'historical' | 'external' | 'unknown';
  reason: string;
  canFork: boolean;
  onFork: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onReturn?: () => void;
  onLatest?: () => void;
}
export interface PickerConnection { onPickerOpen?: () => Promise<void>; pickerDisabled?: boolean; configuredModel?: string; setupRequired?: boolean }
interface Props extends PickerConnection { chat: ChatState | null; cwd: string; composerKey?: string; variant: 'home' | 'docked'; sessionMeter?: ReactNode; notice?: ReactNode; composerReadonly?: boolean; enterToSend?: boolean; sendDisabled?: boolean; mutationDisabled?: boolean; access?: ComposerAccess; desktopQueue: DesktopQueue; queuedPrompts: QueuedPrompt[]; onSend: (input: PromptInput) => Promise<void>; onAbort: () => Promise<void>; onModelChange: (provider: string, modelId: string) => Promise<void>; onThinkingChange: (level: string) => Promise<void>; }
export function Composer({ chat, cwd, composerKey, variant, sessionMeter, notice, composerReadonly, enterToSend: preferredEnterToSend, sendDisabled, mutationDisabled, access, desktopQueue, queuedPrompts, onSend, onAbort, onModelChange, onThinkingChange, onPickerOpen, pickerDisabled, configuredModel, setupRequired }: Props) {
  const { t } = useTranslation();
  const modelDisplayName = useModelDisplayName();
  const waitingForAnswer = !!chat?.prompts.length;
  sendDisabled = sendDisabled || waitingForAnswer;
  const observedActivity = chat?.state.observedSource === 'external' ? record(chat.state.observedActivity).state : undefined;
  const readonlyLabel = access?.category === 'historical' ? 'shell.historicalReadonly' : access?.category === 'readonly' ? 'shell.archiveReadonly' : observedActivity === 'running' ? 'shell.observingRunning' : observedActivity === 'stale' ? 'shell.observingStale' : 'shell.externalReadonly';
  const forkTooltip = `${t('omp.history.forkTooltip')}${access?.category === 'historical' ? ` ${t('omp.history.forkSavedTip')}` : ''}`;
  const key = composerKey ?? (chat ? `${chat.runtimeId}:${chat.state.sessionId}` : `draft:${cwd}`);
  const store = getComposerDraft(key);
  const { draft, busy, error, pending } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const input = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const autocomplete = useRef<HTMLDivElement>(null);
  const completionId = useId();
  const commandAnchor = useRef<HTMLButtonElement>(null);
  const [commandSearch, setCommandSearch] = useState('');
  const commandListId = useId();
  const [commandHighlight, setCommandHighlight] = useState(0);
  const dragCount = useFileDrag(!composerReadonly);
  const [rejected, setRejected] = useState<RejectedAttachment[]>([]);
  const attachmentsRef = useRef<HTMLDivElement>(null);
  useFlipList(attachmentsRef, [...draft.attachments, ...rejected].map(item => item.id));
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    const element = stack.current; if (!element) return;
    let previousHeight = element.offsetHeight, previousWidth = element.offsetWidth;
    let heightAnimation: Animation | undefined, homeAnimation: Animation | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.borderBoxSize[0];
      const height = box?.blockSize ?? element.offsetHeight, width = box?.inlineSize ?? element.offsetWidth;
      const delta = height - previousHeight, widthChanged = Math.abs(width - previousWidth) > .5;
      previousHeight = height; previousWidth = width;
      if (widthChanged || reducedMotion || isMotionPaused()) { heightAnimation?.cancel(); homeAnimation?.cancel(); return; }
      if (Math.abs(delta) <= .5) return;
      const transform = getComputedStyle(element).transform;
      const offset = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
      const home = element.closest('.chat-surface')?.querySelector<HTMLElement>('.home-layer[data-visible="true"] .home-panel');
      const homeTransform = home ? getComputedStyle(home).transform : 'none';
      const homeOffset = homeTransform === 'none' ? 0 : new DOMMatrixReadOnly(homeTransform).m42;
      heightAnimation?.cancel();
      heightAnimation = element.animate([{ transform: `translateY(${delta + offset}px)` }, { transform: 'translateY(0px)' }], { duration: motion.expand, easing: motion.spring, composite: 'add' });
      homeAnimation?.cancel();
      if (home) homeAnimation = home.animate([{ transform: `translateY(${delta + homeOffset}px)` }, { transform: 'translateY(0px)' }], { duration: motion.expand, easing: motion.spring, composite: 'add' });
    });
    const stopHeightMotion = () => { heightAnimation?.cancel(); homeAnimation?.cancel(); };
    window.addEventListener('scroll', stopHeightMotion, { capture: true, passive: true });
    observer.observe(element, { box: 'border-box' });
    return () => { observer.disconnect(); heightAnimation?.cancel(); homeAnimation?.cancel(); window.removeEventListener('scroll', stopHeightMotion, true); };
  }, [reducedMotion, composerReadonly]);
  useEffect(() => setRejected([]), [key]);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const accessAnchor = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const [cursor, setCursor] = useState(draft.text.length);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const previewOrigin = useRef<PreviewOrigin | undefined>(undefined);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<'model' | 'access' | 'commands' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connectingPicker,setConnectingPicker]=useState(false);
  async function togglePicker() {
    if(menu==='model'){setMenu(null);return;}
    setModelSearch('');setMenu('model');setConnectingPicker(true);
    try { await onPickerOpen?.(); }
    catch(cause) { store.setError(cause);setMenu(null); }
    finally { setConnectingPicker(false); }
  }
  const [modelSearch, setModelSearch] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [fileSearch, setFileSearch] = useState<{ loading: boolean; truncated: boolean; diagnostics: string[] }>({ loading: false, truncated: false, diagnostics: [] });
  const [highlight, setHighlight] = useState(0);
  const [acClosed, setAcClosed] = useState(false);
  const [enterToSend, setEnterToSend] = useState(true);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<Error | string>('');
  const [attachmentTime, setAttachmentTime] = useState(Date.now);
  useEffect(() => {
    const now=Date.now();
    const next=draft.attachments.reduce((soonest,item)=>item.expiresAt>attachmentTime?Math.min(soonest,item.expiresAt):soonest,Infinity);
    const refresh=()=>setAttachmentTime(Date.now());
    const timer=Number.isFinite(next)?window.setTimeout(refresh,Math.max(1,next-now)):undefined;
    window.addEventListener('focus',refresh);
    return()=>{window.clearTimeout(timer);window.removeEventListener('focus',refresh);};
  }, [draft.attachments, attachmentTime]);
  const expiredAttachments=draft.attachments.some(item=>item.expiresAt<=attachmentTime);
  const modelPreview = !chat?.state.model && access?.category === 'connecting' && !!configuredModel;
  const modelLabel = chat?.state.model ? modelDisplayName(chat.state.model.provider, chat.state.model.id) : modelPreview ? modelDisplayName(undefined, configuredModel!) : t(!cwd ? 'motion.modelWorkspace' : access?.category === 'connecting' ? 'motion.modelConnecting' : access?.category === 'disconnected' ? 'motion.modelFailed' : 'motion.modelUnselected');
  const thinking = chat?.state.model?.reasoning === false ? null : chat?.state.thinkingLevel ?? effectiveThinking(chat?.thinkingLevels ?? [], undefined, chat?.state.model?.reasoning);
  const supportsThinking = chat?.state.model?.reasoning !== false && !!chat?.thinkingLevels.some(level => level !== 'off');
  const thinkingLabel = thinking === 'off' ? t('composer.thinkingDisabled') : thinking ? t('composer.thinkingLevel', { level: t(`composer.thinking.${thinking}`, { defaultValue: thinking }) }) : t(chat?.state.model?.reasoning === false ? 'composer.thinkingUnsupported' : 'composer.thinkingUnknown');
  const selectionLabel = chat?.state.model ? t('omp.composer.selection', { model: modelLabel, provider: chat.state.model.provider, level: thinkingLabel }) : modelLabel;
  const hasDraft = !!draft.text.trim() || draft.attachments.length > 0;
  const accessCategory = access?.category ?? (access?.ready ? 'ready' : 'unknown');
  const accessLabel = t(`omp.composer.accessState.${accessCategory}`);
  async function refreshAccess() {
    if (!access || refreshing) return;
    setRefreshing(true);
    try { await access.onRefresh(); }
    catch (cause) { store.setError(cause); }
    finally { setRefreshing(false); }
  }
  function navigatePicker(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const target = event.target as HTMLElement;
    const inSearch = target.tagName === 'INPUT';
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    if (inSearch && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const scope = horizontal ? target.closest('[role="menu"]') : event.currentTarget;
    const options = Array.from((scope ?? event.currentTarget).querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'));
    if (!options.length) return;
    event.preventDefault();
    const current = options.indexOf(target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : current < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0) : (current + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + options.length) % options.length;
    options[next].focus();
    options[next].scrollIntoView({ block: 'nearest' });
  }
  async function fork() {
    if (!access?.canFork || busy || forking) return;
    setForking(true); setForkError('');
    await store.perform(async () => {
      try { await access.onFork(); setMenu(null); }
      catch (cause) { setForkError(preserveUserError(cause)); }
      finally { setForking(false); }
    });
  }
  function paint(next: Draft, caret = next.text.length, persist = true) {
    if (persist) store.setDraft(next);
    setCursor(caret);
    if (!input.current) return;
    paintEditorValue(input.current, next.text, new Map(next.references.filter(ref => ref.token).map(ref => [ref.token!, ref])), name => t('chat.removeFileReference', { name }), token => { const live = store.draft; paint({ ...live, text: live.text.replace(token, ''), references: live.references.filter(ref => ref.token !== token) }); }, token => {
      const reference = store.draft.references.find(ref => ref.token === token); if (!reference) return;
      void store.perform(async () => {
        const file = await window.ompDesktop.readFile(cwd, reference.path);
        if (file.kind !== 'text') throw new UserFacingError(t('omp.chat.textReferenceOnly'));
        const live = store.draft;
        store.setDraft({ ...live, text: live.text.replace(token, file.content ?? ''), references: live.references.filter(ref => ref.token !== token) });
      });
    });
    setEditorCaret(input.current, caret);
  }
  useLayoutEffect(() => { if (input.current && readEditorValue(input.current) !== draft.text) paint(draft, draft.text.length, false); }, [store, draft, composerReadonly]);
  useLayoutEffect(() => input.current ? installComposerDeletionGuard(input.current) : undefined, [composerReadonly]);
  useEffect(() => { if (preferredEnterToSend !== undefined) return; let active = true; void window.ompDesktop.bootstrap().then(data => { if (active) setEnterToSend(data.preferences.enterToSend); }, cause => { if (active) store.setError(String(cause)); }); return () => { active = false; }; }, [preferredEnterToSend, store]);
  useLayoutEffect(() => {
    const element = stack.current;
    const surface = element?.closest<HTMLElement>('.chat-surface');
    if (!element || !surface) return;
    const measure = () => surface.style.setProperty('--composer-block-size', `${element.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); surface.style.removeProperty('--composer-block-size'); };
  }, []);
  useEffect(() => { const editor = chat?.editorText; if (editor) store.applyEditor(editor.id, editor.text); }, [chat?.editorText, store]);
  const before = draft.text.slice(0, cursor);
  const fileMatch = before.match(/(?:^|\s)@(?:"([^"]*)"?|([^\s"]*))$/);
  const fileQuery = fileMatch ? fileMatch[1] ?? fileMatch[2] : undefined;
  const fileDirectory = fileQuery?.slice(0, fileQuery.lastIndexOf('/') + 1) ?? '';
  const slashMatch = before.match(/^\/([^\s]*)$/);
  useEffect(() => {
    let active = true; setFiles([]);
    if (fileQuery === undefined) { setFileSearch({ loading: false, truncated: false, diagnostics: [] }); return; }
    setFileSearch({ loading: true, truncated: false, diagnostics: [] });
    const timer = window.setTimeout(() => {
      const needle = fileQuery.slice(fileDirectory.length).toLowerCase();
      void Promise.all([window.ompDesktop.listFiles(cwd, fileDirectory), needle ? window.ompDesktop.searchFiles(cwd, fileQuery) : Promise.resolve({ entries: [], truncated: false, diagnostics: [] })]).then(([entries, result]) => {
        if (!active) return;
        const folders = entries.filter(entry => entry.kind === 'directory' && entry.name.toLowerCase().includes(needle));
        setFiles([...folders, ...(needle ? result.entries : entries.filter(entry => entry.kind === 'file'))].filter(entry => visibleFileReference(entry.path, fileQuery)));
        setFileSearch({ loading: false, truncated: result.truncated, diagnostics: result.diagnostics });
      }, cause => { if (active) setFileSearch({ loading: false, truncated: false, diagnostics: [errorText(cause)] }); });
    }, 120);
    return () => { active = false; clearTimeout(timer); };
  }, [cwd, fileQuery, fileDirectory]);
  const describeCommand = (command: NativeCommand) => commandSource(command) === 'builtin' ? t(`composer.command.${command.name}`, { defaultValue: command.description ?? '' }) : command.description ?? '';
  const slashCommands = slashMatch ? rankedCommands(chat?.commands ?? [], slashMatch[1], describeCommand).slice(0, 60) : [];
  const menuCommands = rankedCommands(chat?.commands ?? [], commandSearch, describeCommand);
  const completions = fileMatch ? files.slice(0, 60).map(file => ({ name: file.path, file })) : slashCommands.map(command => ({ name: `/${command.name}`, file: undefined }));
  const acOpen = focused && !acClosed && (!!fileMatch || !!slashMatch) && !composing.current;
  useEffect(() => { setHighlight(0); setAcClosed(false); }, [cursor, draft.text]);
  useEffect(() => { setHighlight(value => Math.min(value, Math.max(0, Math.min(completions.length, 60) - 1))); }, [completions.length]);
  useEffect(() => { if (acOpen) autocomplete.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [acOpen, highlight]);
  useEffect(() => { setCommandHighlight(0); }, [commandSearch, menu]);
  useEffect(() => { if (menu === 'commands') document.getElementById(`${commandListId}-${commandHighlight}`)?.scrollIntoView({ block: 'nearest' }); }, [menu, commandHighlight, commandListId]);
  function navigateCommands(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !menuCommands.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setCommandHighlight(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + menuCommands.length) % menuCommands.length); }
    else if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') { event.preventDefault(); const command = menuCommands[commandHighlight]; if (command) insertCommand(command.name); }
  }
  function browseFolder(path: string) {
    if (!fileMatch) return;
    const start = cursor - fileMatch[0].length + fileMatch[0].indexOf('@');
    const prefix = /\s/.test(path) ? `@"${path}` : `@${path}`;
    paint({ ...draft, text: draft.text.slice(0, start) + prefix + draft.text.slice(cursor) }, start + prefix.length);
    setAcClosed(false); input.current?.focus();
  }
  function accept(index: number) {
    const completion = completions[index]; if (!completion) return;
    const start = fileMatch ? cursor - fileMatch[0].length + fileMatch[0].indexOf('@') : 0;
    if (completion.file) {
      if (completion.file.kind === 'directory') { browseFolder(`${completion.file.path}/`); return; }
      const token = nextChipToken(); const reference = createFileReference(completion.file.path, completion.file.name, key, { token });
      paint({ ...draft, text: draft.text.slice(0, start) + token + ' ' + draft.text.slice(cursor), references: [...draft.references, reference] }, start + 2);
    } else { const next = completion.name + ' '; paint({ ...draft, text: next + draft.text.slice(cursor) }, next.length); }
    setAcClosed(true); input.current?.focus();
  }
  function insertCommand(name: string) {
    const live = store.draft;
    const prefix = live.text.match(/^\/[^\s]*\s?/);
    const command = `/${name} `;
    paint({ ...live, text: command + live.text.slice(prefix?.[0].length ?? 0) }, command.length);
    setMenu(null); setAcClosed(true);
    requestAnimationFrame(() => { input.current?.focus(); if (input.current) setEditorCaret(input.current, command.length); });
  }
  async function attach(files?: File[], clipboard = false) {
    await store.perform(async () => {
      const pending = new Set(files);
      try {
        if (clipboard && files) {
          for (const file of files) {
            if (!file.type.startsWith('image/')) throw new UserFacingError(t('omp.chat.clipboardImageOnly'));
            const attachment = await window.ompDesktop.addImageAttachment(cwd, { name: file.name, mimeType: file.type, data: new Uint8Array(await file.arrayBuffer()) });
            store.setDraft({ ...store.draft, attachments: [...store.draft.attachments, attachment] });
            pending.delete(file);
          }
        } else {
          const attachments = files ? await window.ompDesktop.addDroppedFiles(cwd, files) : await window.ompDesktop.chooseAttachments(cwd);
          store.setDraft({ ...store.draft, attachments: [...store.draft.attachments, ...attachments] });
        }
      } catch (cause) {
        setRejected(current => [...current, ...Array.from(pending, file => ({ id: crypto.randomUUID(), name: file.name, size: file.size, kind: file.type.startsWith('image/') ? 'image' as const : 'text' as const, reason: cause instanceof Error ? cause.message : errorText(cause) }))]);
        if (!pending.size) throw cause;
      }
    });
  }
  async function reattach(item: Attachment) {
    await store.perform(async () => {
      const replacements=await window.ompDesktop.chooseAttachments(cwd);
      if(!replacements.length)return;
      await window.ompDesktop.removeAttachment(item.id);
      store.setDraft({...store.draft,attachments:[...store.draft.attachments.filter(current=>current.id!==item.id),...replacements]});
    });
  }
  async function submit(steer = false) {
    if (sendDisabled || access && !access.ready || busy || forking || composing.current || (!store.draft.text.trim() && !store.draft.attachments.length)) return;
    if(store.draft.attachments.some(item=>item.expiresAt<=Date.now())){store.setError(new UserFacingError(t('omp.chat.expiredAttachments')));return;}
    await store.submit(async submitted => {
      let prompt = submitted.text;
      for (const reference of submitted.references) if (reference.token) prompt = prompt.replaceAll(reference.token, /\s/.test(reference.path) ? `@"${reference.path}"` : `@${reference.path}`);
      await onSend({ text: prompt, attachmentIds: submitted.attachments.map(item => item.id), mode: chat?.isRunning ? steer ? 'steer' : 'follow_up' : 'prompt' });
    });
  }
  async function change(action: () => Promise<void>) {
    if (mutationDisabled) return;
    setMenu(null);
    store.setError('');
    try { await action(); } catch (error) { store.setError(error); }
  }
  const widgets = Object.entries(chat?.widgets ?? {});
  const matchingModels = chat?.models.filter(model => `${model.provider} ${model.id} ${model.name ?? ''}`.toLowerCase().includes(modelSearch.toLowerCase())) ?? [];
  const groupedModels = modelGroups(matchingModels, chat?.state.model);
  return <div className={`composer-dock composer-dock-${variant}`} data-composer-dock={variant} ref={dock}><div className="composer-stack" ref={stack}>
    {notice}
    {widgets.filter(([, widget]) => widget.placement !== 'belowEditor').map(([id, widget]) => <pre className="composer-status native-widget" key={id}>{widget.lines.join('\n')}</pre>)}
    {Object.entries(chat?.statuses ?? {}).map(([id, status]) => <div className="composer-status" role="status" key={id}>{status}</div>)}
    <QueueChips items={queuedPrompts} queue={desktopQueue} draftStore={store} running={!!chat?.isRunning} onFocus={() => input.current?.focus()}/>
    {pending && (access?.category === 'connecting' || access?.category === 'checking') && <section className="composer-status native-notice" data-pending-start role="status"><strong>{t('omp.intent.status.submitting')}</strong><p style={{whiteSpace:'pre-wrap'}}>{pending.text}</p>{pending.attachments.map(item=><span key={item.id}>{item.name}</span>)}</section>}
    {chat && <SubmissionReceipts runtimeId={chat.runtimeId} />}
    {chat && chat.commandOutputs.some(output => !chat.messages.some(row => row.id === output.row.id)) && <details className="composer-status native-disclosure"><summary>{t('omp.intent.unplacedOutput')}</summary><p>{t('omp.intent.unplacedOutputExplanation')}</p><div style={{ maxHeight: 240, overflow: 'auto' }}>{chat.commandOutputs.filter(output => !chat.messages.some(row => row.id === output.row.id)).map(output => <pre key={output.row.id} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(output.row.raw.content ?? '')}</pre>)}</div></details>}
    {chat?.live.truncated ? <div className="composer-status" role="status">{t('omp.intent.liveCapacity', { count: chat.live.truncated })}</div> : null}
    {chat?.live.uncertain && <div className="composer-status" role="status">{t('omp.intent.liveUncertain')}</div>}
    {error && <div className="composer-status native-notice error"><UserErrorNotice error={error} /></div>}
    {preview?.previewUrl && <ImagePreview source={preview.previewUrl} name={preview.name} origin={previewOrigin.current} onClose={() => setPreview(null)} />}
    {forkError && <div className="composer-status native-notice error"><UserErrorNotice error={forkError} actions={<Button disabled={busy || forking || !access?.canFork} onClick={() => void fork()}>{t('omp.shell.retry')}</Button>}/></div>}
    <Swap swapKey={composerReadonly ? 'readonly' : 'editor'} animate={false} className="composer-mode-swap">{composerReadonly ? <div className="composer-readonly"><div className="composer-readonly-description"><span>{t(observedActivity === 'running' ? 'composer.externalRunningReadonly' : readonlyLabel)}</span><button ref={accessAnchor} type="button" className="icon-btn" aria-label={t('omp.composer.accessDetails', { reason: accessLabel })} aria-haspopup="dialog" aria-expanded={menu === 'access'} title={t('composer.externalReadonlyHint')} onClick={() => setMenu(menu === 'access' ? null : 'access')}><IconCircleAlert size="var(--icon-meta)" /></button></div><div className="composer-readonly-actions">
      {access?.onReturn && <Button onClick={access.onReturn}>{t('omp.shell.returnConnected')}</Button>}
      {access?.onLatest && <Button disabled={busy} onClick={access.onLatest}>{t('shell.returnLatest')}</Button>}
      {access && <Button variant="primary" title={access.canFork ? forkTooltip : t('omp.history.forkUnavailable')} disabled={busy || forking || !access.canFork} onClick={() => void fork()}>{t(forking ? 'omp.history.forking' : 'omp.composer.fork')}</Button>}
    </div></div> : <>
    <div ref={attachmentsRef} className="composer-image-attachments native-attachments" hidden={!draft.attachments.length && !rejected.length}>{draft.attachments.map(item => <AttachmentChip key={item.id} item={item} expired={item.expiresAt <= attachmentTime} busy={busy} onPreview={origin => { previewOrigin.current = origin; setPreview(item); }} onReattach={item.source === 'disk' ? () => void reattach(item) : undefined} onRemove={() => { void store.perform(async () => { await window.ompDesktop.removeAttachment(item.id); store.setDraft({ ...store.draft, attachments: store.draft.attachments.filter(file => file.id !== item.id) }); }); }} />)}{rejected.map(item => <AttachmentChip key={item.id} item={item} onRemove={() => setRejected(current => current.filter(file => file.id !== item.id))} />)}</div>
    {expiredAttachments && <div className="composer-status native-notice error" role="status">{t('omp.chat.expiredAttachments')}</div>}
    <div className={`composer-shell${dragCount ? ' is-drop-target' : ''}`} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void attach(Array.from(event.dataTransfer.files)); }}>
      <div className={`composer-drop-zone${dragCount ? ' is-visible' : ''}`} aria-hidden={!dragCount}><IconPlus size="var(--icon-heading)" /><span role="status">{dragCount ? t('composer.drop', { count: dragCount }) : ''}</span></div>
      {acOpen && <div ref={autocomplete} className={`composer-ac native-composer-menu${slashMatch ? ' composer-command-surface' : ' composer-file-surface'}`}>
        {fileMatch ? <>
          <nav className="composer-file-breadcrumb" aria-label={t('composer.breadcrumb')} onMouseDown={event => event.preventDefault()}><button onClick={() => browseFolder('')}>{t('composer.workspace')}</button>{fileDirectory.split('/').filter(Boolean).map((part, index, parts) => <span key={index}><IconChevronRight size="var(--icon-caption)" /><button onClick={() => browseFolder(`${parts.slice(0, index + 1).join('/')}/`)}>{part}</button></span>)}</nav>
          <div className="composer-ac-list" id={completionId} role="listbox" aria-label={t('chat.fileMenu')}>{completions.map((item, index) => <button type="button" tabIndex={-1} id={`${completionId}-${index}`} key={item.name} className={`composer-ac-item composer-file-row${highlight === index ? ' active' : ''}`} role="option" aria-selected={highlight === index} onMouseDown={event => event.preventDefault()} onClick={() => accept(index)}>{item.file?.kind === 'directory' ? <IconFolder size="var(--icon-ui)" /> : <IconFileText size="var(--icon-ui)" />}<span><strong>{item.file?.name}</strong><small>{item.name}</small></span>{item.file?.kind === 'directory' && <IconChevronRight size="var(--icon-meta)" />}</button>)}</div>
          {(fileSearch.loading || !files.length || fileSearch.truncated || !!fileSearch.diagnostics.length) && <div className="composer-ac-footer" role="status">{fileSearch.loading ? t('omp.chat.searchingFiles') : !files.length && !fileSearch.diagnostics.length ? t('omp.chat.noFileResults') : null}{fileSearch.truncated && <p>{t('omp.chat.partialFileResults')}</p>}{fileSearch.diagnostics.map((message, index) => <details key={index}><summary>{presentUserError(message).message}</summary>{message}</details>)}</div>}
        </> : <CommandList id={completionId} commands={slashCommands} active={highlight} onSelect={accept} filtered={!!slashMatch?.[1]} retainFocus />}
        {!fileMatch && !completions.length && <div className="composer-ac-footer" role="status">{!chat ? t('omp.composer.commandsDisconnected') : t('omp.composer.commandsNoMatch')}</div>}
        <div className="composer-ac-footer">{t(fileMatch ? 'composer.fileHint' : 'composer.keys')}</div>
      </div>}
      <div className="composer-input-wrap"><div className="composer-input-stage"><div ref={input} className="composer-input" role="textbox" aria-multiline="true" aria-autocomplete="list" aria-controls={acOpen ? completionId : undefined} aria-activedescendant={acOpen && completions[highlight] ? `${completionId}-${highlight}` : undefined} aria-label={t('chat.placeholder')} contentEditable suppressContentEditableWarning spellCheck={false} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onCompositionStart={() => { composing.current = true; setAcClosed(true); }} onCompositionEnd={event => { composing.current = false; store.setDraft({ ...store.draft, text: readEditorValue(event.currentTarget) }); setCursor(editorSelectionRange(event.currentTarget).start); }} onInput={event => { store.setDraft({ ...store.draft, text: readEditorValue(event.currentTarget) }); setCursor(editorSelectionRange(event.currentTarget).start); }} onKeyUp={() => { if (input.current) setCursor(editorSelectionRange(input.current).start); }} onClick={() => { if (input.current) setCursor(editorSelectionRange(input.current).start); }} onPaste={event => { event.preventDefault(); const files = Array.from(event.clipboardData.files); if (files.length) void attach(files, true); else if (input.current) { insertClipboardText(input.current, event.clipboardData.getData('text/plain')); store.setDraft({ ...store.draft, text: readEditorValue(input.current) }); setCursor(editorSelectionRange(input.current).start); } }} onBeforeInput={event => { const native = event.nativeEvent as InputEvent; if (!native.isComposing && (native.inputType === 'insertParagraph' || native.inputType === 'insertLineBreak')) { event.preventDefault(); if (input.current) insertClipboardText(input.current, '\n'); } }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
        if (acOpen && event.key === 'Escape') { event.preventDefault(); setAcClosed(true); return; }
        if (acOpen && completions.length > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); setHighlight((highlight + (event.key === 'ArrowDown' ? 1 : -1) + Math.min(completions.length, 60)) % Math.min(completions.length, 60)); return; }
        if (acOpen && completions.length > 0 && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); accept(highlight); return; }
        if (event.key === 'Enter' && !event.shiftKey && ((preferredEnterToSend ?? enterToSend) || event.metaKey || event.ctrlKey || event.altKey)) { event.preventDefault(); void submit(event.altKey); }
      }} />{!draft.text && <span className="composer-placeholder" aria-hidden="true">{t('shell.placeholder')}</span>}</div></div>
      <div className="composer-toolbar">
        <div className="composer-left"><div className="composer-plus"><button className="icon-btn icon-btn-square" title={t('chat.addFiles')} aria-label={t('chat.addFiles')} disabled={busy} onClick={() => void attach()}><IconPlus size="var(--icon-ui)" /></button></div><button ref={commandAnchor} type="button" className="icon-btn composer-command-button" title={t('omp.composer.commands')} aria-label={t('omp.composer.commands')} aria-haspopup="dialog" aria-expanded={menu === 'commands'} onClick={() => { setCommandSearch(''); setMenu(menu === 'commands' ? null : 'commands'); }}>/</button></div>
        {!setupRequired && <div className="composer-model-thinking">
          <button ref={pickerAnchor} className={`icon-btn composer-model-thinking-chip${menu === 'model' ? ' active' : ''}`} aria-haspopup="dialog" aria-expanded={menu === 'model'} aria-label={modelPreview ? t('composer.configuredModel', { model: configuredModel }) : selectionLabel} title={modelPreview ? t('composer.configuredModel', { model: configuredModel }) : pickerDisabled ? access?.reason || selectionLabel : selectionLabel} disabled={modelPreview || (pickerDisabled ?? mutationDisabled) || !cwd || busy || connectingPicker} onClick={() => void togglePicker()}>
            <ModelLabel label={modelLabel}/>{modelPreview && <span className="composer-model-connecting">{t('motion.modelConnecting')}</span>}{chat?.state.model && supportsThinking && <><span className="composer-model-thinking-dot" aria-hidden="true">·</span><span className="composer-model-thinking-level">{thinkingLabel}</span></>}<IconChevronDown size="var(--icon-caption)" aria-hidden="true" className="composer-model-thinking-chevron" />
          </button>
        </div>}
        <div className="composer-right">
          {!setupRequired && access && !['ready', 'connecting', 'unpersisted'].includes(accessCategory) && <button ref={accessAnchor} type="button" className="composer-access" data-state={accessCategory} aria-label={t('omp.composer.accessDetails', { reason: accessLabel })} aria-haspopup="dialog" aria-expanded={menu === 'access'} onClick={() => setMenu(menu === 'access' ? null : 'access')}><IconCircleAlert size="var(--icon-meta)" aria-hidden="true"/><span>{accessLabel}</span></button>}
          {sessionMeter && <div className="composer-meter-slot">{sessionMeter}</div>}
          {chat?.isRunning && hasDraft && <button className="send-btn is-queue" title={waitingForAnswer ? t('omp.live.waitingChoice') : undefined} aria-label={t('omp.chat.queueFollowUp')} disabled={sendDisabled || !!access && !access.ready || expiredAttachments || busy || forking} onClick={() => void submit()}><IconArrowUp size="var(--icon-heading)"/></button>}
          <button className={chat?.isRunning ? 'stop-btn composer-primary-action' : 'send-btn composer-primary-action'} title={!chat?.isRunning ? expiredAttachments ? t('omp.chat.expiredAttachments') : access && !access.ready ? access.reason : undefined : undefined} aria-label={t(chat?.isRunning ? 'chat.stopGenerating' : 'chat.send')} disabled={chat?.isRunning ? mutationDisabled : sendDisabled || !!access && !access.ready || expiredAttachments || busy || forking || !hasDraft} onClick={() => { if (chat?.isRunning) void change(onAbort); else void submit(); }}><Swap swapKey={chat?.isRunning ? 'stop' : 'send'} variant="scale">{chat?.isRunning ? <IconStop size="var(--icon-ui)"/> : <IconArrowUp size="var(--icon-heading)"/>}</Swap></button>
        </div>
      </div>
      <AnchoredMenu open={menu === 'commands'} onClose={() => { setMenu(null); commandAnchor.current?.focus(); }} trigger={() => null} anchorRef={commandAnchor} menuClassName="composer-model-menu composer-command-menu composer-command-surface" role="dialog" label={t('omp.composer.commands')} side="top" align="start" initialFocus="input" onMenuKeyDown={navigateCommands} restoreFocus={false}>
        <div className="native-menu-heading">{t('omp.composer.commands')}<button className="icon-btn icon-btn-square" aria-label={t('common.close')} onClick={() => { setMenu(null); commandAnchor.current?.focus(); }}><IconClose size="var(--icon-meta)" /></button></div>
        <p className="composer-ac-footer">{t('composer.commandHint')}</p>
        <Input className="composer-model-search" role="combobox" aria-autocomplete="list" aria-expanded aria-controls={commandListId} aria-activedescendant={menuCommands[commandHighlight] ? `${commandListId}-${commandHighlight}` : undefined} aria-label={t('composer.searchCommands')} placeholder={t('composer.searchCommands')} value={commandSearch} onChange={event => setCommandSearch(event.target.value)} />
        <CommandList id={commandListId} commands={menuCommands} active={commandHighlight} onSelect={index => insertCommand(menuCommands[index].name)} filtered={!!commandSearch.trim()} retainFocus />
        {!menuCommands.length && <p className="composer-ac-footer" role="status">{t(!chat ? 'omp.composer.commandsDisconnected' : chat.commands.length ? 'omp.composer.commandsNoMatch' : 'omp.composer.commandsEmpty')}</p>}
        <div className="composer-ac-footer">{t('composer.keys')}</div>
      </AnchoredMenu>
      <AnchoredMenu open={menu === 'model'} onClose={() => setMenu(null)} trigger={() => null} anchorRef={pickerAnchor} menuClassName="composer-model-menu composer-model-thinking-menu native-model-picker" role="dialog" label={t('omp.composer.pickerTitle')} side="top" align="end" initialFocus="input" onMenuKeyDown={navigatePicker}>
        <div className="native-menu-heading">{t('omp.composer.pickerTitle')}<button className="icon-btn icon-btn-square" onClick={() => setMenu(null)} aria-label={t('common.close')}><IconClose size="var(--icon-meta)" /></button></div>
        {connectingPicker && <p role="status">{t('motion.modelConnecting')}</p>}
        <Input className="composer-model-search" aria-label={t('chat.searchModels')} placeholder={t('chat.searchModels')} value={modelSearch} onChange={event => setModelSearch(event.target.value)} />
        <div className="composer-ac-list" role="menu" aria-label={t('chat.model')}>{groupedModels.map(([provider, models]) => <div key={provider}><div className="composer-catalog-group">{provider}</div>{models.map(model => {
          const selected = chat?.state.model?.provider === model.provider && chat.state.model.id === model.id;
          return <button className="composer-ac-item composer-picker-option" role="menuitemradio" aria-checked={selected} key={`${model.provider}:${model.id}`} disabled={busy || mutationDisabled} onClick={() => void change(() => onModelChange(model.provider, model.id))}><span className="composer-picker-model"><span>{model.name || model.id}</span><small>{model.provider}{model.contextWindow ? ` · ${t('composer.context', { size: model.contextWindow >= 1000 ? `${Number((model.contextWindow / 1000).toFixed(1))}K` : String(model.contextWindow) })}` : ''}</small></span><span className="composer-picker-check">{selected && <IconCheck size="var(--icon-ui)" aria-hidden="true" />}</span></button>;
        })}</div>)}</div>
        {!matchingModels.length && <p role="status" className="native-menu-heading">{t('chat.noModelResults')}</p>}
        {supportsThinking && chat ? <div className="composer-thinking-section"><div className="native-menu-heading">{t('chat.reasoningLevel')}</div><ThinkingOptions levels={chat.thinkingLevels} selectedLevel={thinking} disabled={busy || mutationDisabled} label={t('chat.reasoningLevel')} onChange={level => void change(() => onThinkingChange(level))} /></div> : <p className="composer-thinking-unavailable">{t('composer.thinkingUnavailable')}</p>}
      </AnchoredMenu>
    </div>{widgets.filter(([, widget]) => widget.placement === 'belowEditor').map(([id, widget]) => <pre className="composer-status native-widget" key={id}>{widget.lines.join('\n')}</pre>)}
    </>}</Swap>
      <AnchoredMenu open={menu === 'access' && !!access} onClose={() => setMenu(null)} trigger={() => null} anchorRef={accessAnchor} menuClassName="composer-model-menu composer-access-menu" role="dialog" label={t('omp.composer.accessDetails', { reason: accessLabel })} side="top" align="end">
        <div className="native-menu-heading">{t('omp.composer.accessTitle')}<button className="icon-btn icon-btn-square" onClick={() => setMenu(null)} aria-label={t('common.close')}><IconClose size="var(--icon-meta)" /></button></div>
        <p className="composer-access-reason">{access?.reason}</p>
        <div className="composer-access-actions">
          <Button disabled={refreshing} onClick={() => void refreshAccess()}>{t(refreshing ? 'omp.composer.refreshing' : 'omp.composer.refresh')}</Button>
          {access?.onReturn && <Button onClick={() => { setMenu(null); access.onReturn?.(); }}>{t('omp.shell.returnConnected')}</Button>}
          {access?.canFork && <Button variant="primary" title={forkTooltip} disabled={busy || forking} onClick={() => void fork()}>{t(forking ? 'omp.history.forking' : 'omp.composer.fork')}</Button>}
        </div>
      </AnchoredMenu>
  </div></div>;
}

function ThinkingOptions({ levels, selectedLevel, disabled, label, onChange }: { levels: string[]; selectedLevel: string | null; disabled?: boolean; label: string; onChange: (level: string) => void }) {
  const { t } = useTranslation();
  return <div className="composer-thinking-options" role="menu" aria-label={label}>
    {levels.map(level => <button key={level} className="composer-thinking-option" role="menuitemradio" aria-checked={selectedLevel === level} disabled={disabled} onClick={() => onChange(level)}>{t(`composer.thinking.${level}`, { defaultValue: level })}{selectedLevel === level && <IconCheck size="var(--icon-caption)" aria-hidden="true" />}</button>)}
  </div>;
}

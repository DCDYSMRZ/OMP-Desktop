import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Attachment, FileEntry, PromptInput } from '../../shared/contracts';
import type { ChatState } from './model';
import { createFileReference, editorSelectionRange, insertClipboardText, nextChipToken, paintEditorValue, readEditorValue, setEditorCaret } from './composer/editor';
import { installComposerDeletionGuard } from './composer/native-deletion';
import { getComposerDraft, type Draft } from './composer/drafts';
import { IconPlus, IconArrowUp, IconStop, IconChevronDown, IconCheck, IconCircleAlert, IconClose } from '../ui/icons';
import { Button } from '../ui/ui';
import { AnchoredMenu } from '../ui/AnchoredMenu';
import { Modal } from '../app/Dialogs';
import { errorText } from '../app/runtime-store';
import { ImagePreview } from './ImagePreview';
import { useLiquidIndicator } from '../lib/glass/useLiquidIndicator';
import { useGlassExit } from '../lib/portal-visibility';

export interface ComposerAccess { ready: boolean; reason: string; canFork: boolean; onFork: () => Promise<void>; onRefresh: () => Promise<void>; }
interface Props { chat: ChatState | null; cwd: string; composerKey?: string; variant: 'home' | 'docked'; enterToSend?: boolean; sendDisabled?: boolean; mutationDisabled?: boolean; access?: ComposerAccess; onSend: (input: PromptInput) => Promise<void>; onAbort: () => Promise<void>; onModelChange: (provider: string, modelId: string) => Promise<void>; onThinkingChange: (level: string) => Promise<void>; }
export function Composer({ chat, cwd, composerKey, variant, enterToSend: preferredEnterToSend, sendDisabled, mutationDisabled, access, onSend, onAbort, onModelChange, onThinkingChange }: Props) {
  const { t } = useTranslation();
  const key = composerKey ?? (chat ? `${chat.runtimeId}:${chat.state.sessionId}` : `draft:${cwd}`);
  const store = getComposerDraft(key);
  const { draft, busy, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const input = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const autocomplete = useRef<HTMLDivElement>(null);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const accessAnchor = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const [cursor, setCursor] = useState(draft.text.length);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<'model' | 'access' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [fileSearch, setFileSearch] = useState<{ loading: boolean; truncated: boolean; diagnostics: string[] }>({ loading: false, truncated: false, diagnostics: [] });
  const [highlight, setHighlight] = useState(0);
  const [acClosed, setAcClosed] = useState(false);
  const [enterToSend, setEnterToSend] = useState(true);
  const [mode, setMode] = useState<'steer' | 'follow_up'>('follow_up');
  const [confirmFork, setConfirmFork] = useState(false);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState('');
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
  const modelLabel = chat?.state.model?.name || chat?.state.model?.id || t('chat.model');
  const thinkingLabel = chat?.state.thinkingLevel || t('chat.thinking');
  const selectionLabel = t('omp.composer.selection', { model: modelLabel, provider: chat?.state.model?.provider || '', level: thinkingLabel });
  const hasDraft = !!draft.text.trim() || draft.attachments.length > 0;
  async function refreshAccess() {
    if (!access || refreshing) return;
    setRefreshing(true);
    try { await access.onRefresh(); }
    catch (cause) { store.setError(errorText(cause)); }
    finally { setRefreshing(false); }
  }
  function navigatePicker(event: KeyboardEvent<HTMLDivElement>) {
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
      try { await access.onFork(); setConfirmFork(false); }
      catch (cause) { setForkError(errorText(cause)); }
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
        if (file.kind !== 'text') throw new Error(t('omp.chat.textReferenceOnly'));
        const live = store.draft;
        store.setDraft({ ...live, text: live.text.replace(token, file.content ?? ''), references: live.references.filter(ref => ref.token !== token) });
      });
    });
    setEditorCaret(input.current, caret);
  }
  useLayoutEffect(() => { if (input.current && readEditorValue(input.current) !== draft.text) paint(draft, draft.text.length, false); }, [store, draft]);
  useLayoutEffect(() => input.current ? installComposerDeletionGuard(input.current) : undefined, []);
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
  useLayoutEffect(() => {
    const editor = input.current;
    if (!editor) return;
    const measure = () => {
      const range = document.createRange();
      range.selectNodeContents(editor);
      const lineHeight = parseFloat(getComputedStyle(editor).lineHeight);
      editor.closest('.composer-shell')?.classList.toggle('is-single-line', range.getBoundingClientRect().height <= lineHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [draft.text]);
  useEffect(() => { const editor = chat?.editorText; if (editor) store.applyEditor(editor.id, editor.text); }, [chat?.editorText, store]);
  const before = draft.text.slice(0, cursor);
  const fileMatch = before.match(/(?:^|\s)@([^\s]*)$/);
  const slashMatch = before.match(/^\/([^\s]*)$/);
  useEffect(() => {
    let active = true; setFiles([]);
    if (!fileMatch) { setFileSearch({ loading: false, truncated: false, diagnostics: [] }); return; }
    setFileSearch({ loading: true, truncated: false, diagnostics: [] });
    const timer = window.setTimeout(() => { void window.ompDesktop.searchFiles(cwd, fileMatch[1]).then(result => { if (active) { setFiles(result.entries); setFileSearch({ loading: false, truncated: result.truncated, diagnostics: result.diagnostics }); } }, cause => { if (active) setFileSearch({ loading: false, truncated: false, diagnostics: [errorText(cause)] }); }); }, 120);
    return () => { active = false; clearTimeout(timer); };
  }, [cwd, fileMatch?.[1]]);
  const completions = fileMatch ? files.map(file => ({ name: file.path, description: file.kind, file })) : slashMatch ? (chat?.commands ?? []).filter(command => command.name.startsWith(slashMatch[1]) || command.aliases?.some(alias => alias.startsWith(slashMatch[1]))).map(command => ({ name: `/${command.name}`, description: command.description ?? command.source ?? '', file: undefined })) : [];
  const acOpen = focused && !acClosed && (!!fileMatch || completions.length > 0) && !composing.current;
  useGlassExit(autocomplete, acOpen);
  useEffect(() => { setHighlight(0); setAcClosed(false); }, [cursor, draft.text]);
  useEffect(() => { setHighlight(value => Math.min(value, Math.max(0, Math.min(completions.length, 60) - 1))); }, [completions.length]);
  useEffect(() => { if (acOpen) dock.current?.querySelector('.composer-ac-item.active')?.scrollIntoView({ block: 'nearest' }); }, [acOpen, highlight]);
  function accept(index: number) {
    const completion = completions[index]; if (!completion) return;
    const start = fileMatch ? cursor - fileMatch[1].length - 1 : 0;
    if (completion.file) {
      const token = nextChipToken(); const reference = createFileReference(completion.file.path, completion.file.name, key, { token });
      paint({ ...draft, text: draft.text.slice(0, start) + token + ' ' + draft.text.slice(cursor), references: [...draft.references, reference] }, start + 2);
    } else { const next = completion.name + ' '; paint({ ...draft, text: next + draft.text.slice(cursor) }, next.length); }
    setAcClosed(true); input.current?.focus();
  }
  async function attach(files?: File[], clipboard = false) {
    await store.perform(async () => {
      if (clipboard && files) {
        for (const file of files) {
          if (!file.type.startsWith('image/')) throw new Error(t('omp.chat.clipboardImageOnly'));
          const attachment = await window.ompDesktop.addImageAttachment(cwd, { name: file.name, mimeType: file.type, data: new Uint8Array(await file.arrayBuffer()) });
          store.setDraft({ ...store.draft, attachments: [...store.draft.attachments, attachment] });
        }
      } else {
        const attachments = files ? await window.ompDesktop.addDroppedFiles(cwd, files) : await window.ompDesktop.chooseAttachments(cwd);
        store.setDraft({ ...store.draft, attachments: [...store.draft.attachments, ...attachments] });
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
    if(store.draft.attachments.some(item=>item.expiresAt<=Date.now())){store.setError(t('omp.chat.expiredAttachments'));return;}
    await store.submit(async submitted => {
      let prompt = submitted.text;
      for (const reference of submitted.references) if (reference.token) prompt = prompt.replaceAll(reference.token, /\s/.test(reference.path) ? `@"${reference.path}"` : `@${reference.path}`);
      await onSend({ text: prompt, attachmentIds: submitted.attachments.map(item => item.id), mode: chat?.isRunning ? steer ? 'steer' : mode : 'prompt' });
    });
  }
  async function change(action: () => Promise<void>) { if (mutationDisabled) return; await store.perform(async () => { await action(); setMenu(null); }); }
  const widgets = Object.entries(chat?.widgets ?? {});
  const matchingModels = chat?.models.filter(model => `${model.provider} ${model.id} ${model.name ?? ''}`.toLowerCase().includes(modelSearch.toLowerCase())) ?? [];
  return <div className={`composer-dock composer-dock-${variant}`} data-composer-dock={variant} ref={dock}><div className="composer-stack" ref={stack}>
    {widgets.filter(([, widget]) => widget.placement !== 'belowEditor').map(([id, widget]) => <pre className="composer-status native-widget" key={id}>{widget.lines.join('\n')}</pre>)}
    {Object.entries(chat?.statuses ?? {}).map(([id, status]) => <div className="composer-status" role="status" key={id}>{status}</div>)}
    {(chat?.state.queuedMessageCount ?? 0) > 0 && <div className="composer-status">{t('omp.chat.queuedCount', { count: chat?.state.queuedMessageCount })}</div>}
    {error && <div className="composer-status native-notice error" role="alert">{error}</div>}
    {preview?.previewUrl && <ImagePreview source={preview.previewUrl} name={preview.name} onClose={() => setPreview(null)} />}
    {confirmFork && access && <Modal title={t('omp.history.forkTitle')} onClose={() => { if (!forking) setConfirmFork(false); }}>
      <p className="session-rename-dialog-description">{access.reason}</p>
      <p className="session-rename-dialog-description">{t('omp.history.forkDescription')}</p>
      <p className="session-rename-dialog-description">{t('omp.history.forkDraftDescription')}</p>
      {forkError && <p role="alert" className="omp-inline-error">{forkError}</p>}
      <div className="session-rename-dialog-actions composer-fork-actions">
        <Button variant="ghost" disabled={forking} onClick={() => setConfirmFork(false)}>{t('common.cancel')}</Button>
        <Button disabled={forking} onClick={() => { void access.onRefresh().catch(cause => setForkError(errorText(cause))); }}>{t('omp.history.refreshAccess')}</Button>
        <Button variant="primary" disabled={forking || busy || !access.canFork} onClick={() => void fork()}>{t(forking ? 'omp.history.forking' : 'omp.history.forkConfirm')}</Button>
      </div>
    </Modal>}
    {draft.attachments.length > 0 && <div className="composer-image-attachments native-attachments">{draft.attachments.map(item => <div className={`composer-chip${item.expiresAt<=attachmentTime?' is-expired':''}`} key={item.id}>{item.previewUrl && <button aria-label={`${t('chat.imagePreview.title')}: ${item.name}`} onClick={() => setPreview(item)}><img src={item.previewUrl} alt={item.name} /></button>}<span>{item.name}</span>{item.expiresAt<=attachmentTime && <><span>{t('omp.chat.attachmentExpired')}</span>{item.source==='disk' && <button disabled={busy} onClick={()=>void reattach(item)}>{t('omp.chat.reattach')}</button>}</>}<button className="composer-chip-remove" aria-label={t('chat.removeFileReference', { name: item.name })} disabled={busy} onClick={() => { void store.perform(async () => { await window.ompDesktop.removeAttachment(item.id); store.setDraft({ ...store.draft, attachments: store.draft.attachments.filter(file => file.id !== item.id) }); }); }}>×</button></div>)}</div>}
    {expiredAttachments && <div className="composer-status native-notice error" role="status">{t('omp.chat.expiredAttachments')}</div>}
    <div className="composer-shell lg-thick lg-refract" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void attach(Array.from(event.dataTransfer.files)); }}>
      {acOpen && <div ref={autocomplete} className="composer-ac native-composer-menu lg-regular lg-morph-in" role="listbox" aria-label={t(fileMatch ? 'chat.fileMenu' : 'chat.slashMenu')}><div className="composer-ac-list">{completions.slice(0, 60).map((item, index) => <button key={item.name} className={`composer-ac-item${highlight === index ? ' active' : ''}`} role="option" aria-selected={highlight === index} onMouseDown={event => event.preventDefault()} onClick={() => accept(index)}><span className="composer-ac-name">{item.name}</span><span className="composer-ac-desc">{item.description}</span></button>)}</div>{fileMatch && <div className="composer-ac-footer" role="status">{fileSearch.loading ? t('omp.chat.searchingFiles') : !files.length && !fileSearch.diagnostics.length ? t('omp.chat.noFileResults') : null}{fileSearch.truncated && <p>{t('omp.chat.partialFileResults')}</p>}{fileSearch.diagnostics.map((message, index) => <p key={index}>{message}</p>)}</div>}<div className="composer-ac-footer">{t('chat.acHint')}</div></div>}
      <div className="composer-input-wrap"><div className="composer-input-stage"><div ref={input} className="composer-input" role="textbox" aria-multiline="true" aria-label={t('chat.placeholder')} contentEditable suppressContentEditableWarning spellCheck={false} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; store.setDraft({ ...store.draft, text: readEditorValue(event.currentTarget) }); setCursor(editorSelectionRange(event.currentTarget).start); }} onInput={event => { store.setDraft({ ...store.draft, text: readEditorValue(event.currentTarget) }); setCursor(editorSelectionRange(event.currentTarget).start); }} onKeyUp={() => { if (input.current) setCursor(editorSelectionRange(input.current).start); }} onClick={() => { if (input.current) setCursor(editorSelectionRange(input.current).start); }} onPaste={event => { event.preventDefault(); const files = Array.from(event.clipboardData.files); if (files.length) void attach(files, true); else if (input.current) { insertClipboardText(input.current, event.clipboardData.getData('text/plain')); store.setDraft({ ...store.draft, text: readEditorValue(input.current) }); setCursor(editorSelectionRange(input.current).start); } }} onBeforeInput={event => { const native = event.nativeEvent as InputEvent; if (!native.isComposing && (native.inputType === 'insertParagraph' || native.inputType === 'insertLineBreak')) { event.preventDefault(); if (input.current) insertClipboardText(input.current, '\n'); } }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
        if (acOpen && event.key === 'Escape') { event.preventDefault(); setAcClosed(true); return; }
        if (acOpen && completions.length > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); setHighlight((highlight + (event.key === 'ArrowDown' ? 1 : -1) + Math.min(completions.length, 60)) % Math.min(completions.length, 60)); return; }
        if (acOpen && (event.key === 'Enter' || event.key === 'Tab' && completions.length > 0) && !event.shiftKey) { event.preventDefault(); accept(highlight); return; }
        if (event.key === 'Enter' && !event.shiftKey && ((preferredEnterToSend ?? enterToSend) || event.metaKey || event.ctrlKey || event.altKey)) { event.preventDefault(); void submit(event.altKey); }
      }} />{!draft.text && <span className="composer-placeholder" aria-hidden="true">{t(variant === 'home' ? 'chat.placeholderHome' : 'chat.placeholder')} · {t('chat.placeholderHint')}</span>}</div></div>
      <div className="composer-toolbar">
        <div className="composer-left"><div className="composer-plus"><button className="icon-btn icon-btn-square lg-thin lg-capsule lg-pressable" title={t('chat.addFiles')} aria-label={t('chat.addFiles')} disabled={busy} onClick={() => void attach()}><IconPlus size={18} /></button></div></div>
        <div className="composer-model-thinking">
          <button ref={pickerAnchor} className={`icon-btn composer-model-thinking-chip lg-thin lg-capsule lg-pressable${menu === 'model' ? ' active' : ''}`} aria-haspopup="dialog" aria-expanded={menu === 'model'} aria-label={selectionLabel} title={selectionLabel} disabled={mutationDisabled || !chat || busy} onClick={() => { setModelSearch(''); setMenu(menu === 'model' ? null : 'model'); }}>
            <span className="composer-model-thinking-model">{modelLabel}</span><span className="composer-model-thinking-dot" aria-hidden="true">·</span><span className="composer-model-thinking-level">{thinkingLabel}</span><IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
          </button>
        </div>
        <div className="composer-right">
          {access && !access.ready && <button ref={accessAnchor} className="composer-access lg-thin lg-capsule lg-pressable" aria-label={t('omp.composer.accessDetails', { reason: access.reason })} aria-haspopup="dialog" aria-expanded={menu === 'access'} onClick={() => setMenu(menu === 'access' ? null : 'access')}><IconCircleAlert size={14} aria-hidden="true" /><span>{access.reason}</span></button>}
          {chat?.isRunning && hasDraft && <select aria-label={t('omp.chat.sendMode')} className="icon-btn mode-chip" value={mode} onChange={event => setMode(event.target.value as 'steer' | 'follow_up')}><option value="follow_up">{t('omp.chat.followUp')}</option><option value="steer">{t('omp.chat.steer')}</option></select>}
          {(!chat?.isRunning || hasDraft) && <button className={`send-btn lg-thin lg-pressable${chat?.isRunning ? ' is-queue' : ''}`} title={expiredAttachments ? t('omp.chat.expiredAttachments') : access && !access.ready ? access.reason : undefined} aria-label={t(chat?.isRunning ? mode === 'steer' ? 'omp.chat.steerNow' : 'omp.chat.queueFollowUp' : 'chat.send')} disabled={sendDisabled || !!access && !access.ready || expiredAttachments || busy || forking || !hasDraft} onClick={() => void submit()}><IconArrowUp size={18} /></button>}
          {chat?.isRunning && <button className="send-btn is-stop lg-thin lg-pressable" disabled={mutationDisabled} aria-label={t('chat.stopGenerating')} onClick={() => void change(onAbort)}><IconStop size={16} /></button>}
        </div>
      </div>
      <AnchoredMenu open={menu === 'model'} onClose={() => setMenu(null)} trigger={() => null} anchorRef={pickerAnchor} menuClassName="composer-model-menu composer-model-thinking-menu native-model-picker" role="dialog" label={t('omp.composer.pickerTitle')} side="top" align="end" initialFocus="input" onMenuKeyDown={navigatePicker}>
        <div className="native-menu-heading">{t('omp.composer.pickerTitle')}<button className="icon-btn icon-btn-square" onClick={() => setMenu(null)} aria-label={t('common.close')}><IconClose size={14} /></button></div>
        <input className="input composer-model-search" aria-label={t('chat.searchModels')} placeholder={t('chat.searchModels')} value={modelSearch} onChange={event => setModelSearch(event.target.value)} />
        <div className="composer-ac-list" role="menu" aria-label={t('chat.model')}>{matchingModels.map(model => {
          const selected = chat?.state.model?.provider === model.provider && chat.state.model.id === model.id;
          return <button className="composer-ac-item composer-picker-option" role="menuitemradio" aria-checked={selected} key={`${model.provider}:${model.id}`} disabled={busy || mutationDisabled} onClick={() => void change(() => onModelChange(model.provider, model.id))}><span className="composer-picker-model"><span>{model.name || model.id}</span><small>{model.provider}</small></span><span className="composer-picker-check">{selected && <IconCheck size={15} aria-hidden="true" />}</span></button>;
        })}</div>
        {!matchingModels.length && <p role="status" className="native-menu-heading">{t('chat.noModelResults')}</p>}
        {!!chat?.thinkingLevels.length && <div className="composer-thinking-section"><div className="native-menu-heading">{t('chat.reasoningLevel')}</div><ThinkingOptions levels={chat.thinkingLevels} selectedLevel={chat.state.thinkingLevel ?? null} disabled={busy || mutationDisabled} label={t('chat.reasoningLevel')} onChange={level => void change(() => onThinkingChange(level))} /></div>}
      </AnchoredMenu>
      <AnchoredMenu open={menu === 'access' && !!access && !access.ready} onClose={() => setMenu(null)} trigger={() => null} anchorRef={accessAnchor} menuClassName="composer-model-menu composer-access-menu" role="dialog" label={t('omp.composer.accessTitle')} side="top" align="end" restoreFocus={!confirmFork}>
        <div className="native-menu-heading">{t('omp.composer.accessTitle')}<button className="icon-btn icon-btn-square" onClick={() => setMenu(null)} aria-label={t('common.close')}><IconClose size={14} /></button></div>
        <p className="composer-access-reason">{access?.reason}</p>
        <div className="composer-access-actions">
          <Button disabled={refreshing} onClick={() => void refreshAccess()}>{t(refreshing ? 'omp.composer.refreshing' : 'omp.composer.refresh')}</Button>
          {access?.canFork && <Button variant="primary" disabled={busy || forking} onClick={() => { accessAnchor.current?.focus(); setMenu(null); setForkError(''); setConfirmFork(true); }}>{t('omp.composer.fork')}</Button>}
        </div>
      </AnchoredMenu>
    </div>{widgets.filter(([, widget]) => widget.placement === 'belowEditor').map(([id, widget]) => <pre className="composer-status native-widget" key={id}>{widget.lines.join('\n')}</pre>)}
  </div></div>;
}

function ThinkingOptions({ levels, selectedLevel, disabled, label, onChange }: { levels: string[]; selectedLevel: string | null; disabled?: boolean; label: string; onChange: (level: string) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const indicator = useLiquidIndicator(track, selectedLevel, 'x');
  return <div ref={track} className="composer-thinking-options lg-thin" role="menu" aria-label={label}>
    <div ref={indicator} className="lg-liquid-indicator" aria-hidden="true" />
    {levels.map(level => <button key={level} data-liquid-key={level} className="composer-thinking-option" role="menuitemradio" aria-checked={selectedLevel === level} disabled={disabled} onClick={() => onChange(level)}>{level}{selectedLevel === level && <IconCheck size={12} aria-hidden="true" />}</button>)}
  </div>;
}

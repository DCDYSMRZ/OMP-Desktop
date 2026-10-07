import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileContent, MessageSearchHit, MessageSearchCoverage, NativeCommand } from '../../shared/contracts';
import type { SidebarSession } from './sidebar-session';
import { errorText } from './runtime-store';
import { CodeView, languageFromPath } from '../ui/CodeView';
import { IconSearch, IconMessages, IconFileText, IconSettings, IconTerminal, IconHistory, IconArrowRight } from '../ui/icons';
import { portalOverlay, useModalFocus, useOverlayLeaving, SegmentedControl } from '../ui/ui';
import { Swap, useFlipList, useSurfaceMotion } from '../ui/motion';
import { cleanPaletteMessage, groupPaletteMessages, paletteMessageTimestamp, paletteScopes, parsePaletteQuery, rankPaletteItems, type MatchRange, type PaletteScope, type RankablePaletteItem } from './palette-model';
import { paletteActionIds, shortcutKeycaps, shortcutLabelKey, type PaletteActionId } from './shortcuts';
import { formatSessionRelativeTime } from './session-relative-time';
import { messageText } from '../chat/model';
import { plainMarkdownLine } from '../lib/markdown-plain';
import { sessionProseExcerpt } from '../chat/home-model';
import { commandSource } from '../chat/composer/catalog';
import { displaySessionTitle } from '../lib/session-title';
import { presentUserError } from '../lib/user-errors';
import '../styles/command-palette.css';

export type PaletteTarget = { kind: 'session'; session: SidebarSession } | { kind: 'message'; hit: MessageSearchHit } | { kind: 'file'; path: string } | { kind: 'command'; name: string } | { kind: 'settings'; query: string } | { kind: 'action'; id: PaletteActionId };
interface PaletteItem extends RankablePaletteItem { target?: PaletteTarget; openSessionFile?: boolean; snippetRanges?: MatchRange[]; preview?: string; keycaps?: string[]; messageMeta?: string; occurrences?: number }
export interface CommandPaletteProps { liveSessions: SidebarSession[]; sourceGeneration: number; cwd: string; commands: NativeCommand[]; platform: string; initialScope?: PaletteScope; initialQuery?: string; messagePath?: string; onClose: () => void; onSelect: (target: PaletteTarget) => void; onOpenSessionFile: () => void; onSearchCurrent?: (query: string) => void }
export function Highlight({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  let offset = 0;
  const parts = ranges.flatMap(([start, end], index) => { const before = text.slice(offset, start); offset = end; return [before, <mark key={index}>{text.slice(start, end)}</mark>]; });
  return <>{parts}{text.slice(offset)}</>;
}
export function CommandPalette({ liveSessions, sourceGeneration, cwd, commands, platform, initialScope = 'all', initialQuery = '', messagePath, onClose, onSelect, onOpenSessionFile, onSearchCurrent }: CommandPaletteProps) {
  const { t, i18n } = useTranslation();
  const leaving = useOverlayLeaving();
  const [input, setInput] = useState(initialQuery), [scope, setScope] = useState(initialScope), [activeId, setActiveId] = useState<string | null>(null);
  const parsed = parsePaletteQuery(input, scope), { query } = parsed;
  const key = JSON.stringify([query, parsed.scope, cwd, messagePath, sourceGeneration]);
  const [loaded, setLoaded] = useState<{ key: string; items: PaletteItem[]; diagnostics: string[]; coverage?: MessageSearchCoverage } | null>(null);
  const [filePreview, setFilePreview] = useState<{ path: string; file?: FileContent; error?: string } | null>(null);
  const [sessionPreview, setSessionPreview] = useState<{ path: string; text?: string; error?: string } | null>(null);
  const [messagePreview, setMessagePreview] = useState<{ key: string; text: string; ranges: MatchRange[]; error?: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLInputElement>(null), composing = useRef(false), compositionTimer = useRef<number | undefined>(undefined);
  const backdrop = useRef<HTMLDivElement>(null);
  useSurfaceMotion(ref, !leaving, 'scale');
  useSurfaceMotion(backdrop, !leaving);
  useModalFocus(ref, { onClose, initialFocus: inputRef });
  useEffect(() => () => window.clearTimeout(compositionTimer.current), []);
  const sessionItem = (session: SidebarSession): PaletteItem => {
    const relative = formatSessionRelativeTime(session.updatedAt, i18n.resolvedLanguage || i18n.language, Date.now()) ?? t('sidebar.timeUnknown');
    return { id: `session:${session.path}`, group: 'sessions', title: displaySessionTitle(session.title, t), detail: `${session.cwd.split(/[/\\]/).filter(Boolean).at(-1) ?? session.cwd} · ${relative}`, currentProject: session.cwd === cwd, updatedAt: session.updatedAt, keywords: `${session.cwd} ${session.preview}`, preview: [session.preview, session.lastAssistantExcerpt].filter(Boolean).join('\n\n'), target: { kind: 'session', session } };
  };
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const diagnostics: string[] = [], items: PaletteItem[] = [];
      let coverage: MessageSearchCoverage | undefined;
      const enabled = (group: PaletteScope) => parsed.scope === 'all' || parsed.scope === group;
      await Promise.all([
        enabled('sessions') ? window.ompDesktop.listHistory().then(result => { items.push(...result.sessions.map(sessionItem)); diagnostics.push(...result.diagnostics.map(item => item.message)); }).catch(cause => diagnostics.push(errorText(cause))) : undefined,
        enabled('messages') && query ? window.ompDesktop.searchMessages({ query, path: messagePath, limit: 50 }).then(result => {
          coverage = result.coverage;
          items.push(...groupPaletteMessages(result.results, query).map(({ hit, count, text, ranges }) => {
            const role = hit.role === 'toolResult' && hit.toolName ? t(hit.toolName === 'bash' ? 'shell.searchToolOutput' : 'shell.searchToolResult', { tool: hit.toolName }) : t(`omp.palette.role.${hit.role}`);
            const messageMeta = paletteMessageTimestamp(hit.timestamp) ?? (hit.position ? t('shell.searchPosition', { count: hit.position }) : undefined);
            return { id: `message:${hit.path}:${hit.entryId}`, group: 'messages' as const, title: `${role} · ${plainMarkdownLine(displaySessionTitle(hit.title, t))}`, detail: text, snippetRanges: ranges, messageMeta, occurrences: count, matched: true, target: { kind: 'message' as const, hit } };
          }));
          diagnostics.push(...result.diagnostics);
        }).catch(cause => diagnostics.push(errorText(cause))) : undefined,
        enabled('files') && cwd ? window.ompDesktop.searchFiles(cwd, query).then(result => { items.push(...result.entries.filter(file => file.kind === 'file').map(file => ({ id: `file:${file.path}`, group: 'files' as const, title: file.name, detail: file.path === file.name ? '' : file.path, keywords: file.path, target: { kind: 'file' as const, path: file.path } }))); diagnostics.push(...result.diagnostics); if (result.truncated) diagnostics.push(t('omp.palette.truncated')); }).catch(cause => diagnostics.push(errorText(cause))) : undefined,
      ]);
      if (!cancelled) setLoaded({ key, items, diagnostics, coverage });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [key, i18n.language]);
  const loading = loaded?.key !== key;
  const localItems = useMemo<PaletteItem[]>(() => [
    ...liveSessions.map(sessionItem),
    { id: 'action:open-session-file', group: 'actions', title: t('shell.openSessionFile'), detail: '', openSessionFile: true },
    ...commands.map(command => ({ id: `command:${command.name}`, group: 'commands' as const, title: `/${command.name}`, detail: commandSource(command) === 'builtin' && i18n.exists(`composer.command.${command.name}`) ? t(`composer.command.${command.name}`) : command.description ? `${t('shell.nativeDescription')}：${command.description}` : '', keywords: command.aliases?.join(' '), target: { kind: 'command' as const, name: command.name } })),
    ...['font', 'language', 'model', 'thinking', 'credentials', 'profile'].map(name => ({ id: `settings:${name}`, group: 'settings' as const, title: t(name === 'profile' ? 'shell.profile' : `omp.palette.setting.${name}`), detail: t('omp.palette.settingsHint'), keywords: name, target: { kind: 'settings' as const, query: t(name === 'profile' ? 'shell.profile' : `omp.palette.setting.${name}`) } })),
    ...paletteActionIds.map(id => ({ id: `action:${id}`, group: 'actions' as const, title: t(shortcutLabelKey(id)), detail: t(`omp.palette.description.${id}`), keycaps: shortcutKeycaps(id, platform), target: { kind: 'action' as const, id } })),
  ], [liveSessions, commands, platform, i18n.language, cwd]);
  const ranked = useMemo(() => rankPaletteItems([...(loaded?.items ?? []), ...localItems], query, parsed.scope), [loaded, localItems, query, parsed.scope]);
  // Keep the last settled ordering while remote sources catch up; selection is identity-based.
  const settled = useRef(ranked);
  if (!loading) settled.current = ranked;
  const rows = loading && loaded ? settled.current : ranked;
  const resultsRef = useRef<HTMLDivElement>(null);
  useFlipList(resultsRef, rows.map(row => row.item.id));
  const active = rows.find(row => row.item.id === activeId) ?? rows[0];
  const selected = active?.item;
  const messagePreviewKey = JSON.stringify([selected?.id, query]);
  const contextPreview = selected?.target?.kind === 'message' && messagePreview?.key === messagePreviewKey ? messagePreview : null;
  useEffect(() => {
    if (selected?.target?.kind !== 'message') return;
    const hit = selected.target.hit; let cancelled = false;
    void window.ompDesktop.readHistory({ path: hit.path, leafId: hit.entryId, anchorId: hit.entryId }).then(snapshot => {
      if (cancelled) return;
      const message = snapshot.messages.find(row => row.id === hit.entryId || row.entryId === hit.entryId);
      setMessagePreview({ key: messagePreviewKey, ...cleanPaletteMessage(message && messageText(message.raw) || hit.snippet, query) });
    }, cause => { if (!cancelled) setMessagePreview({ key: messagePreviewKey, ...cleanPaletteMessage(hit.snippet, query), error: errorText(cause) }); });
    return () => { cancelled = true; };
  }, [messagePreviewKey]);
  useEffect(() => { if (contextPreview) ref.current?.querySelector('.palette-preview mark')?.scrollIntoView({ block: 'nearest' }); }, [contextPreview]);
  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selected?.id]);
  useEffect(() => {
    if (selected?.target?.kind !== 'session') return;
    const session = selected.target.session;
    if (session.lastAssistantExcerpt || session.source?.status === 'unpersisted' || session.path.startsWith('runtime:')) return;
    let cancelled = false;
    void window.ompDesktop.readHistory({ path: session.path }).then(snapshot => {
      if (cancelled) return;
      const last = snapshot.messages.findLast(message => message.raw.role === 'assistant');
      setSessionPreview({ path: session.path, text: last ? sessionProseExcerpt(messageText(last.raw)) : '' });
    }, cause => { if (!cancelled) setSessionPreview({ path: session.path, error: errorText(cause) }); });
    return () => { cancelled = true; };
  }, [selected?.id]);
  useEffect(() => {
    if (selected?.target?.kind !== 'file') return;
    const path = selected.target.path; let cancelled = false;
    setFilePreview(null);
    void window.ompDesktop.readFile(cwd, path).then(file => { if (!cancelled) setFilePreview({ path, file }); }, cause => { if (!cancelled) setFilePreview({ path, error: errorText(cause) }); });
    return () => { cancelled = true; };
  }, [selected?.id, cwd]);
  const activate = (item: PaletteItem | undefined) => { if (!item || leaving || composing.current || loading) return; onClose(); if (item.openSessionFile) onOpenSessionFile(); else if (item.target) onSelect(item.target); };
  const icons = { sessions: IconHistory, messages: IconMessages, files: IconFileText, commands: IconTerminal, settings: IconSettings, actions: IconArrowRight };
  return portalOverlay(<div className={`palette-overlay motion-managed${leaving ? ' is-leaving' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget && !leaving) onClose(); }}>
    <div ref={backdrop} className="palette-backdrop" aria-hidden />
    <div className="command-palette motion-managed" role="dialog" aria-modal="true" aria-label={t('omp.palette.title')} ref={ref} onCompositionStart={() => { window.clearTimeout(compositionTimer.current); composing.current = true; }} onCompositionEnd={() => { compositionTimer.current = window.setTimeout(() => { composing.current = false; }, 0); }} onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const index = rows.indexOf(active!); const next = rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]; if (next) setActiveId(next.item.id); inputRef.current?.focus(); }
      if (event.key === 'Enter' && event.target === inputRef.current) { event.preventDefault(); activate(selected); }
    }}>
      <div className="palette-input-row"><IconSearch size="var(--icon-heading)"/><input ref={inputRef} value={input} maxLength={500} onChange={event => setInput(event.target.value)} role="combobox" aria-expanded aria-controls="palette-results" aria-activedescendant={selected ? `palette-option-${rows.indexOf(active!)}` : undefined} aria-label={t('omp.palette.title')} placeholder={t('omp.palette.placeholder')}/><kbd>Esc</kbd></div>
      <SegmentedControl className="palette-scopes" role="group" label={t('omp.palette.scopes')} value={parsed.scope} options={paletteScopes.map(value => ({ value, label: t(`omp.palette.scope.${value}`) }))} onChange={value => { setInput(query); setScope(value); inputRef.current?.focus(); }}/>
      {loaded?.key === key && loaded.coverage && <section className="palette-coverage" role="status">{!loaded.coverage.complete && <><strong>{t('shell.searchPartial')}</strong><button disabled={!onSearchCurrent} onClick={()=>{onClose();onSearchCurrent?.(query);}}>{t('shell.searchCurrent')}</button></>}<span>{t('shell.searchExclusions')}</span></section>}
      <div className="palette-body"><div ref={resultsRef} className={`palette-results${loading ? ' is-loading' : ''}`} id="palette-results" role="listbox" aria-label={t('omp.palette.title')} aria-busy={loading}>
        {rows.map((row, index) => { const item = row.item, Icon = icons[item.group]; return <Fragment key={item.id}>{(index === 0 || rows[index - 1].item.group !== item.group) && <div className="palette-group">{t(`omp.palette.scope.${item.group}`)}</div>}<button data-flip-key={item.id} id={`palette-option-${index}`} role="option" aria-selected={selected?.id === item.id} className="palette-result" type="button" tabIndex={-1} onMouseMove={() => setActiveId(item.id)} onFocus={() => setActiveId(item.id)} onClick={() => activate(item)}><Icon size="var(--icon-ui)"/><span className="palette-result-copy"><strong title={item.title}><Highlight text={item.title} ranges={row.titleRanges}/></strong><span><Highlight text={item.detail} ranges={item.snippetRanges ?? row.detailRanges}/></span></span>{(item.messageMeta || (item.occurrences ?? 0) > 1) && <span className="palette-message-meta">{item.messageMeta && <time>{item.messageMeta}</time>}{(item.occurrences ?? 0) > 1 && <span title={t('shell.searchOpenFirst')}>{t('shell.searchOccurrences', { count: item.occurrences })}</span>}</span>}{item.keycaps && <span className="palette-keycaps">{item.keycaps.map((key, index) => <kbd key={index}>{key}</kbd>)}</span>}</button></Fragment>; })}
        {!rows.length && <p className="palette-empty">{t(loading ? 'omp.palette.loading' : parsed.scope === 'messages' && !query ? 'omp.palette.messageHint' : 'omp.palette.empty')}</p>}
      </div><aside className="palette-preview" aria-label={t('omp.palette.preview')}>
        <Swap swapKey={selected?.id ?? ''} className="palette-preview-swap">
        {selected?.messageMeta && <div className="palette-preview-meta">{selected.messageMeta}{(selected.occurrences ?? 0) > 1 && ` · ${t('shell.searchOccurrences', { count: selected.occurrences })} · ${t('shell.searchOpenFirst')}`}</div>}
        {selected && <><div className="palette-preview-kind">{t(`omp.palette.scope.${selected.group}`)}</div><h2>{selected.title}</h2>{selected.target?.kind === 'file' ? filePreview?.path === selected.target.path ? filePreview.error ? <div role="alert">{presentUserError(filePreview.error).message}<details><summary>{t('omp.errors.details')}</summary>{filePreview.error}</details></div> : filePreview.file?.kind === 'text' ? <CodeView code={(filePreview.file.content ?? '').split('\n').slice(0, 40).join('\n')} lang={languageFromPath(selected.target.path)} gutter maxHeight={380}/> : <p>{t('omp.palette.filePreviewUnavailable')}</p> : <p>{t('omp.palette.loading')}</p> : <><p className="palette-preview-text"><Highlight text={contextPreview?.text || selected.preview || selected.detail} ranges={contextPreview?.ranges ?? selected.snippetRanges ?? []}/></p>{selected.target?.kind === 'session' && <p className="palette-preview-meta">{selected.target.session.cwd}</p>}{contextPreview?.error && <details><summary>{t('omp.palette.diagnostics', { count: 1 })}</summary><p>{contextPreview.error}</p></details>}</>}</>}
        {selected?.target?.kind === 'session' && !selected.target.session.lastAssistantExcerpt && sessionPreview?.path === selected.target.session.path && <>{sessionPreview.text && <p>{sessionPreview.text}</p>}{sessionPreview.error && <div role="alert">{presentUserError(sessionPreview.error).message}<details><summary>{t('omp.errors.details')}</summary>{sessionPreview.error}</details></div>}</>}
        </Swap>
      </aside></div>
      <footer className="palette-footer"><span>{loading ? t('omp.palette.loading') : t('omp.palette.navigation')}</span>{loaded?.diagnostics.length ? <details><summary>{t('omp.palette.diagnostics', { count: loaded.diagnostics.length })}</summary><div>{[...new Set(loaded.diagnostics)].map(message => <p key={message}>{message}</p>)}</div></details> : null}</footer>
    </div>
  </div>);
}

// Adapted from PI-Desktop-main FilesTab (LGPL-3.0); native OMP desktop data boundary.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileContent, FileEntry, FileSearchResult } from '../../shared/contracts';
import { Markdown } from '../ui/Markdown';
import { CodeView, languageFromPath } from '../ui/CodeView';
import { IconChevronLeft, IconChevronRight, IconExternal, IconFileText, IconFolder } from '../ui/icons';
import { Input, TooltipButton, cx } from '../ui/ui';
import { useFileObject } from '../lib/file-object';

const fileStatusLabels: Record<string, string> = { A: 'omp.review.added', M: 'omp.review.modified', D: 'omp.review.deleted', R: 'omp.review.renamed', '?': 'omp.review.untracked', U: 'tools.fileConflict', C: 'tools.fileCopied', T: 'tools.fileTypeChanged' };
function fileStatusLabel(status: string) {
  const code = status.trim().split(/\s+/).at(-1) ?? '';
  return fileStatusLabels[code] ?? (code.includes('?') ? fileStatusLabels['?'] : code.includes('U') ? fileStatusLabels.U : 'tools.fileChanged');
}
interface DirState { entries: FileEntry[]; error?: string }
export function FilesTab({ cwd, initialPath, line, endLine, originTurnId, initialPathRevision, visible = true, maximized = false, changedFiles, referencedPaths, onOpenFile, onPinFile, onBack }: { cwd: string; initialPath?: string; line?: number; endLine?: number; originTurnId?: string; initialPathRevision?: number; visible?: boolean; maximized?: boolean; changedFiles?: ReadonlyMap<string, string>; referencedPaths?: ReadonlySet<string>; onOpenFile: (path: string) => void; onPinFile?: (path: string) => void; onBack?: () => void }) {
  const { t } = useTranslation();
  const objects = useFileObject(cwd);
  const [showHidden, setShowHidden] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState<string | null>(initialPath ?? null);
  const [treeSelection, setTreeSelection] = useState<string | null>(null);
  const selectedRow = useRef<HTMLButtonElement | null>(null);
  const revealPending = useRef(false);
  const [file, setFile] = useState<FileContent | null>(null);
  const fileRequest = useRef('');
  const [error, setError] = useState('');
  const [source, setSource] = useState(line !== undefined);
  useEffect(() => { setSource(line !== undefined); }, [initialPath, initialPathRevision, line, endLine]);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<FileSearchResult | null>(null);
  const [searchError, setSearchError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const loadDir = useCallback(async (relative: string) => {
    try { const entries = await window.ompDesktop.listFiles(cwd, relative); setDirs(old => ({ ...old, [relative]: { entries } })); }
    catch (cause) { setDirs(old => ({ ...old, [relative]: { entries: [], error: String(cause) } })); }
  }, [cwd]);
  useEffect(() => { if (cwd) void loadDir(''); }, [cwd, loadDir, refresh]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const target = JSON.stringify([cwd, selected, initialPathRevision]);
    if (fileRequest.current !== target) { setFile(null); fileRequest.current = target; }
    setError('');
    const root = cwd.replace(/\/$/, '');
    const relative = selected.startsWith(`${root}/`) ? selected.slice(root.length + 1) : selected.replace(/^\.\//, '');
    if (relative.startsWith('/') || relative.split('/').includes('..')) { setError(t('shell.fileOutside')); return; }
    window.ompDesktop.readFile(cwd, relative).then(value => { if (active) setFile(value); }, () => { if (active) setError(t('shell.fileMissing')); });
    return () => { active = false; };
  }, [cwd, selected, refresh, initialPathRevision, t]);
  useEffect(() => {
    if (!initialPath || !cwd) return;
    setSelected(initialPath);
    // listFiles uses workspace-relative paths, even for absolute chat links.
    const root = cwd.replace(/\/$/, '');
    const relative = initialPath.startsWith(`${root}/`) ? initialPath.slice(root.length + 1) : initialPath.replace(/^\.\//, '');
    if (relative.startsWith('/') || relative.split('/').includes('..')) return;
    setTreeSelection(relative);
    const parts = relative.split('/').slice(0, -1);
    const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    setExpanded(old => new Set([...old, ...ancestors]));
    for (const ancestor of ancestors) void loadDir(ancestor);
  }, [cwd, initialPath, initialPathRevision, loadDir]);
  useEffect(() => {
    if (visible && selected === null && revealPending.current && selectedRow.current) {
      selectedRow.current.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      selectedRow.current.focus({ preventScroll: true });
      revealPending.current = false;
    }
  }, [visible, selected, dirs, query]);
  useEffect(() => {
    let active = true;
    setMatches(null); setSearchError('');
    if (!query.trim() || !cwd) return;
    const timer = setTimeout(() => { window.ompDesktop.searchFiles(cwd, query).then(value => { if (active) setMatches(value); }, cause => { if (active) setSearchError(String(cause)); }); }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [cwd, query, refresh]);
  const openFile = (path: string) => { revealPending.current = true; setTreeSelection(path); onOpenFile(path); };
  const toggleDir = (path: string) => {
    setExpanded(old => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next; });
    if (!dirs[path]) void loadDir(path);
  };
  const renderEntries = (entries: FileEntry[], depth: number): ReactNode => entries.filter(entry => showHidden || !entry.path.split('/').some(part => part.startsWith('.') || part === 'node_modules')).map(entry => entry.kind === 'directory' ? (
    <div key={entry.path}><button type="button" className="file-tree-row" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => toggleDir(entry.path)} aria-expanded={expanded.has(entry.path)}>
      <span className={cx('file-tree-caret', expanded.has(entry.path) && 'open')} aria-hidden><IconChevronRight size="var(--icon-caption)" /></span><IconFolder size="var(--icon-meta)" /><span className="file-tree-name">{entry.name}</span>
    </button>{expanded.has(entry.path) && renderDir(entry.path, depth + 1)}</div>
  ) : <button key={entry.path} ref={treeSelection === entry.path ? selectedRow : undefined} type="button" className={cx('file-tree-row', treeSelection === entry.path && 'active')} aria-current={treeSelection === entry.path ? 'true' : undefined} style={{ paddingLeft: 28 + depth * 14 }} onClick={event => { clearTimeout(previewTimer.current); if (event.detail === 0) openFile(entry.path); else previewTimer.current = setTimeout(() => openFile(entry.path), 220); }} onDoubleClick={() => { clearTimeout(previewTimer.current); onPinFile?.(entry.path); }} onContextMenu={event => objects.contextMenu(entry.path, event)} {...objects.dragProps(entry.path)} onKeyDown={event => { if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); objects.quickLook(entry.path); } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); onPinFile?.(entry.path); objects.openInEditor(entry.path); } }} title={entry.path}><IconFileText size="var(--icon-meta)" /><span className="file-tree-name">{query ? entry.path : entry.name}</span>{referencedPaths?.has(entry.path) && <span className="file-reference-dot" title={t('shell.referenced')} aria-label={t('shell.referenced')} />}{changedFiles?.get(entry.path) && <span className="file-change-badge" data-status={changedFiles.get(entry.path)} title={t(fileStatusLabel(changedFiles.get(entry.path)!))}>{t(fileStatusLabel(changedFiles.get(entry.path)!))}</span>}</button>);
  const renderDir = (path: string, depth: number): ReactNode => {
    const state = dirs[path];
    if (!state || state.error || !state.entries.length) return <div className="file-tree-note" style={{ paddingLeft: 12 + depth * 14 }}>{!state ? t('panel.files.loading') : state.error || t('panel.files.empty')}</div>;
    return renderEntries(state.entries, depth);
  };
  if (!cwd) return <div className="work-tab-empty"><IconFolder size="var(--icon-heading)" /><p className="work-tab-empty-title">{t('panel.files.noWorkspace')}</p></div>;
  const viewer = selected !== null ? <div className="file-viewer"><div className="file-viewer-header">
    <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t('panel.files.back')} ariaLabel={t('panel.files.back')} onClick={() => { if (onBack) onBack(); else { revealPending.current = true; setSelected(null); setFile(null); } }}><IconChevronLeft size="var(--icon-meta)" /></TooltipButton>
    <span className="file-viewer-path" title={selected} onContextMenu={event => objects.contextMenu(selected, event)} {...objects.dragProps(selected)}>{selected}</span>
    <button type="button" className="file-viewer-mode" onClick={() => onPinFile?.(selected)}>{t('shell.pinFile')}</button>
    <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t('shell.editFile')} ariaLabel={t('shell.editFile')} onClick={() => { onPinFile?.(selected); objects.openInEditor(`${selected}${line ? `:${line}` : ''}`); }}><IconExternal size="var(--icon-meta)" /></TooltipButton>
    {(line !== undefined || originTurnId) && <span className="file-viewer-range" title={originTurnId ? t('shell.currentVersionHint') : undefined}>{[line !== undefined ? t(endLine && endLine !== line ? 'shell.lineRange' : 'shell.line', { start: line, end: endLine }) : '', originTurnId ? t('shell.currentVersion') : ''].filter(Boolean).join(' · ')}</span>}
    {file?.kind === 'text' && /\.(md|markdown)$/i.test(selected) && <button type="button" className="file-viewer-mode" aria-pressed={source} onClick={() => setSource(value => !value)}>{t(source ? 'shell.preview' : 'shell.source')}</button>}
    <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t('tools.refresh')} ariaLabel={t('tools.refresh')} onClick={() => setRefresh(value => value + 1)}><span aria-hidden>↻</span></TooltipButton>
    <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t('omp.workspace.revealFile')} ariaLabel={t('omp.workspace.revealFile')} onClick={() => objects.reveal(selected)}><IconFolder size="var(--icon-meta)" /></TooltipButton>
  </div><div className="file-viewer-body">{error ? <div className="file-tree-note" role="alert">{error}</div> : !file ? <div className="file-tree-note">{t('panel.files.loading')}</div> : file.kind === 'text' ? /\.(md|markdown)$/i.test(selected) && !source ? <div className="file-viewer-markdown prose-chat"><Markdown source={file.content ?? ''} cwd={cwd} baseDir={file.path.split('/').slice(0, -1).join('/')} onOpenFile={onOpenFile} /></div> : <div className="file-viewer-code"><CodeView key={`${selected}:${initialPathRevision ?? 0}`} code={(file.content ?? '').split('\n').slice(0, 5000).join('\n')} lang={file.language || languageFromPath(selected)} highlight={line !== undefined ? { start: line, end: endLine } : undefined} revealHighlight={visible} className={line !== undefined ? 'ui-flash' : undefined} />{(file.content ?? '').split('\n').length > 5000 && <div className="file-viewer-cap">{t('omp.workspace.previewLineLimit')}</div>}</div> : file.kind === 'image' ? <div className="file-viewer-image"><img src={file.dataUrl} alt={file.name} /></div> : <div className="work-tab-empty"><p className="work-tab-empty-title">{file.kind === 'tooLarge' ? t('omp.workspace.previewSizeLimit') : t('omp.workspace.binaryPreview')}</p></div>}</div></div> : null;
  const tree = <div className="file-tree"><div className="file-viewer-header"><Input aria-label={t('omp.workspace.searchFiles')} placeholder={t('omp.workspace.searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} /><TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t('tools.refresh')} ariaLabel={t('tools.refresh')} onClick={() => { setDirs({}); setExpanded(new Set()); setRefresh(value => value + 1); }}><span aria-hidden>↻</span></TooltipButton></div><label className="file-hidden-toggle"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />{t('shell.showHidden')}</label>{query.trim() ? searchError ? <div className="file-tree-note" role="alert">{searchError}</div> : matches === null ? <div className="file-tree-note">{t('omp.workspace.searching')}</div> : <>{matches.truncated && <div className="file-tree-note" role="status">{t('omp.workspace.partialSearch')}</div>}{matches.diagnostics.map((diagnostic, index) => <div className="file-tree-note" key={index}>{diagnostic}</div>)}{matches.entries.length ? renderEntries(matches.entries, 0) : <div className="file-tree-note">{t('omp.workspace.noMatches')}</div>}</> : renderDir('', 0)}</div>;
  return maximized ? <div className="files-split">{tree}{viewer ?? <div className="work-tab-empty"><IconFileText size="var(--icon-heading)" /><p>{t('shell.openFile')}</p></div>}</div> : viewer ?? tree;
}

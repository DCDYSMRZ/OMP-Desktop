// Adapted from PI-Desktop-main FilesTab (LGPL-3.0); native OMP desktop data boundary.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileContent, FileEntry, FileSearchResult } from '../../shared/contracts';
import { Markdown, HighlightedCode } from '../ui/Markdown';
import { IconChevronLeft, IconChevronRight, IconExternal, IconFileText, IconFolder } from '../ui/icons';
import { TooltipButton, cx } from '../ui/ui';

interface DirState { entries: FileEntry[]; error?: string }
export function FilesTab({ cwd, initialPath, initialPathRevision, onOpenFile }: { cwd: string; initialPath?: string; initialPathRevision?: number; onOpenFile: (path: string) => void }) {
  const { t } = useTranslation();
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState(new Set<string>());
  const [selected, setSelected] = useState<string | null>(initialPath ?? null);
  const [treeSelection, setTreeSelection] = useState<string | null>(null);
  const selectedRow = useRef<HTMLButtonElement | null>(null);
  const revealPending = useRef(false);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState('');
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
    setFile(null); setError('');
    window.ompDesktop.readFile(cwd, selected).then(value => { if (active) setFile(value); }, cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [cwd, selected, refresh, initialPathRevision]);
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
    if (selected === null && revealPending.current && selectedRow.current) {
      selectedRow.current.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      selectedRow.current.focus({ preventScroll: true });
      revealPending.current = false;
    }
  }, [selected, dirs, query]);
  useEffect(() => {
    let active = true;
    setMatches(null); setSearchError('');
    if (!query.trim() || !cwd) return;
    const timer = setTimeout(() => { window.ompDesktop.searchFiles(cwd, query).then(value => { if (active) setMatches(value); }, cause => { if (active) setSearchError(String(cause)); }); }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [cwd, query, refresh]);
  const openFile = (path: string) => { setTreeSelection(path); setSelected(path); };
  const toggleDir = (path: string) => {
    setExpanded(old => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next; });
    if (!dirs[path]) void loadDir(path);
  };
  const renderEntries = (entries: FileEntry[], depth: number): ReactNode => entries.map(entry => entry.kind === 'directory' ? (
    <div key={entry.path}><button type="button" className="file-tree-row" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => toggleDir(entry.path)} aria-expanded={expanded.has(entry.path)}>
      <span className={cx('file-tree-caret', expanded.has(entry.path) && 'open')} aria-hidden><IconChevronRight size={12} /></span><IconFolder size={14} /><span className="file-tree-name">{entry.name}</span>
    </button>{expanded.has(entry.path) && renderDir(entry.path, depth + 1)}</div>
  ) : <button key={entry.path} ref={treeSelection === entry.path ? selectedRow : undefined} type="button" className={cx('file-tree-row', treeSelection === entry.path && 'active')} aria-current={treeSelection === entry.path ? 'true' : undefined} style={{ paddingLeft: 28 + depth * 14 }} onClick={() => openFile(entry.path)} title={entry.path}><IconFileText size={14} /><span className="file-tree-name">{query ? entry.path : entry.name}</span></button>);
  const renderDir = (path: string, depth: number): ReactNode => {
    const state = dirs[path];
    if (!state || state.error || !state.entries.length) return <div className="file-tree-note" style={{ paddingLeft: 12 + depth * 14 }}>{!state ? t('panel.files.loading') : state.error || t('panel.files.empty')}</div>;
    return renderEntries(state.entries, depth);
  };
  if (!cwd) return <div className="work-tab-empty"><IconFolder size={18} /><p className="work-tab-empty-title">{t('panel.files.noWorkspace')}</p></div>;
  if (selected !== null) return <div className="file-viewer"><div className="file-viewer-header">
    <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t('panel.files.back')} ariaLabel={t('panel.files.back')} onClick={() => { revealPending.current = true; setSelected(null); setFile(null); }}><IconChevronLeft size={14} /></TooltipButton>
    <span className="file-viewer-path" title={selected}>{selected}</span>{file && <span className="file-viewer-size">{(file.size / 1024).toFixed(1)} KB</span>}
    <button className="icon-btn" title={t('omp.workspace.refreshFile')} onClick={() => setRefresh(value => value + 1)}>↻</button>
    <TooltipButton type="button" className="icon-btn icon-btn-square" tooltip={t('omp.workspace.revealFile')} ariaLabel={t('omp.workspace.revealFile')} onClick={() => { void window.ompDesktop.revealFile(cwd, selected).catch(cause => setError(String(cause))); }}><IconExternal size={14} /></TooltipButton>
  </div><div className="file-viewer-body">{error ? <div className="file-tree-note" role="alert">{error}</div> : !file ? <div className="file-tree-note">{t('panel.files.loading')}</div> : file.kind === 'text' ? /\.(md|markdown)$/i.test(selected) ? <div className="file-viewer-markdown prose-chat"><Markdown source={file.content ?? ''} cwd={cwd} baseDir={file.path.split('/').slice(0, -1).join('/')} onOpenFile={onOpenFile} /></div> : <div className="file-viewer-code"><HighlightedCode code={(file.content ?? '').split('\n').slice(0, 5000).join('\n')} lang={file.language} />{(file.content ?? '').split('\n').length > 5000 && <div className="file-viewer-cap">{t('omp.workspace.previewLineLimit')}</div>}</div> : file.kind === 'image' ? <div className="file-viewer-image"><img src={file.dataUrl} alt={file.name} /></div> : <div className="work-tab-empty"><p className="work-tab-empty-title">{file.kind === 'tooLarge' ? t('omp.workspace.previewSizeLimit') : t('omp.workspace.binaryPreview')}</p></div>}</div></div>;
  return <div className="file-tree"><div className="file-viewer-header"><input className="input" aria-label={t('omp.workspace.searchFiles')} placeholder={t('omp.workspace.searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} /><button className="icon-btn" title={t('omp.workspace.refreshFiles')} onClick={() => { setDirs({}); setExpanded(new Set()); setRefresh(value => value + 1); }}>↻</button></div>{query.trim() ? searchError ? <div className="file-tree-note" role="alert">{searchError}</div> : matches === null ? <div className="file-tree-note">{t('omp.workspace.searching')}</div> : <>{matches.truncated && <div className="file-tree-note" role="status">{t('omp.workspace.partialSearch')}</div>}{matches.diagnostics.map((diagnostic, index) => <div className="file-tree-note" key={index}>{diagnostic}</div>)}{matches.entries.length ? renderEntries(matches.entries, 0) : <div className="file-tree-note">{t('omp.workspace.noMatches')}</div>}</> : renderDir('', 0)}</div>;
}

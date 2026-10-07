import { UserFacingError, preserveUserError } from '../lib/user-errors';
import { UserErrorNotice } from '../lib/UserErrorNotice';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryTreeNode, HistoryTreeSnapshot, SessionSummary } from '../../shared/contracts';
import { Button } from '../ui/ui';
import { Markdown } from '../ui/Markdown';
import { IconChevronRight, IconSearch } from '../ui/icons';
import { Modal } from './Dialogs';
import { errorText } from './runtime-store';
import { historyExplorerRows, historyNodeDate, HistoryTreeWindowError, isTechnicalHistoryNode, readHistoryTreeWindow, shapeHistoryTree } from './history-explorer-model';
import { displaySessionTitle } from '../lib/session-title';
import '../styles/history-explorer.css';
import { HistoryPaging, PrependAnchor } from '../chat/HistoryPaging';
import { useFlipList } from '../ui/motion';
import { noteProgrammaticScroll } from '../ui/motion/programmatic-scroll';

export function HistoryTreeDialog({ session, selectedLeafId, runtimeLeafId, onClose, onView, onFork, onOwnedBranch }: { session: SessionSummary; selectedLeafId?: string | null; runtimeLeafId?: string | null; onClose: () => void; onView: (leafId?: string | null) => Promise<void>; onFork: () => Promise<void>; onOwnedBranch?: () => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const [tree, setTree] = useState<HistoryTreeSnapshot | null>(null), [error, setError] = useState<Error | string>(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true), [paging, setPaging] = useState(false);
  const [forkCapability, setForkCapability] = useState<{ canFork: boolean; diagnostics: string[] } | null>(null);
  const [query, setQuery] = useState(''), [technical, setTechnical] = useState(false), [selected, setSelected] = useState<string | null>(selectedLeafId ?? null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const generation = useRef(0), list = useRef<HTMLDivElement>(null), filter = useRef<HTMLInputElement>(null);
  const prependAnchor = useRef<PrependAnchor>(null);
  const revealSelection = useRef(true);
  const selectionSource = useRef<string | undefined>(undefined);
  const loadedWindow = useRef<{ path: string; tree: HistoryTreeSnapshot | null }>({ path: session.path, tree });
  useLayoutEffect(() => { if (loadedWindow.current.path === session.path) loadedWindow.current.tree = tree; }, [session.path, tree]);
  useEffect(() => {
    const ticket = ++generation.current; setLoading(true); setPaging(false); setError(''); setForkCapability(null);
    void window.ompDesktop.readHistory({ path: session.path }).then(snapshot => { if (ticket === generation.current) setForkCapability({ canFork: snapshot.session.canFork, diagnostics: snapshot.diagnostics }); }, cause => { if (ticket === generation.current) setForkCapability({ canFork: false, diagnostics: [errorText(cause)] }); });
    const oldestId = loadedWindow.current.path === session.path ? loadedWindow.current.tree?.nodes[0]?.id : undefined;
    void readHistoryTreeWindow(before => window.ompDesktop.readHistoryTree(session.path, before), oldestId, () => ticket === generation.current).then(value => { if (value && ticket === generation.current) { loadedWindow.current = { path: session.path, tree: value }; setTree(value); } }, cause => { if (ticket === generation.current) setError(cause instanceof HistoryTreeWindowError ? new UserFacingError(t(cause.reason === 'revision' ? 'omp.history.treeChanged' : 'omp.history.treeCursorInvalid')) : preserveUserError(cause)); }).finally(() => { if (ticket === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [session.path, attempt]);
  const model = useMemo(() => shapeHistoryTree(tree?.nodes ?? [], technical), [tree, technical]);
  useLayoutEffect(() => {
    selectionSource.current = undefined; revealSelection.current = true;
    setSelected(selectedLeafId ?? null);
  }, [session.path, selectedLeafId]);
  useLayoutEffect(() => {
    const source = JSON.stringify([session.path, selectedLeafId]);
    if (selectionSource.current === source || selected !== (selectedLeafId ?? null)) return;
    const turnId = selectedLeafId ? model.entryTurn.get(selectedLeafId) : undefined;
    if (selectedLeafId && !turnId) return;
    selectionSource.current = source;
    if (turnId && turnId !== selectedLeafId) setExpanded(previous => new Set(previous).add(turnId));
  }, [model, selectedLeafId, session.path, selected]);
  const rows = useMemo(() => historyExplorerRows(model, expanded, query), [model, expanded, query]);
  const motionTree = useRef(tree);
  useFlipList(list, rows.map(row => row.id), { animate: !loading && !paging && motionTree.current === tree });
  useEffect(() => { motionTree.current = tree; }, [tree]);
  const active = rows.find(row => row.id === selected) ?? rows.find(row => row.id === model.entryTurn.get(selected ?? selectedLeafId ?? runtimeLeafId ?? tree?.leafId ?? '')) ?? rows[0];
  const selectedNode = active?.node;
  const selectedDate = selectedNode && historyNodeDate(selectedNode.timestamp, i18n.language);
  const rowIndexes = new Map(rows.map((row, index) => [row.id, index]));
  const graphWidth = 24 + model.laneCount * 16;
  useLayoutEffect(() => {
    const viewport = list.current;
    if (!active || !viewport || !revealSelection.current) return;
    const row = document.getElementById(`history-row-${active.id}`);
    if (!row) return;
    revealSelection.current = false; prependAnchor.current?.cancel();
    const bounds = viewport.getBoundingClientRect(), rect = row.getBoundingClientRect();
    const delta = rect.top < bounds.top ? rect.top - bounds.top : rect.bottom > bounds.bottom ? rect.bottom - bounds.bottom : 0;
    if (delta) { viewport.scrollTop += delta; noteProgrammaticScroll(viewport); }
  });
  async function older() {
    if (!tree?.hasMore || !tree.nextBefore || paging || loading || busy) return;
    const source = tree, ticket = generation.current; setPaging(true); setError('');
    try {
      const page = await window.ompDesktop.readHistoryTree(session.path, source.nextBefore);
      if (ticket !== generation.current) return;
      if (page.revision !== source.revision) throw new UserFacingError(t('omp.history.treeChanged'));
      if (page.hasMore && (!page.nextBefore || page.nextBefore === source.nextBefore)) throw new UserFacingError(t('omp.history.treeCursorInvalid'));
      const ids = new Set(source.nodes.map(node => node.id));
      setTree({ ...page, leafId: source.leafId, nodes: [...page.nodes.filter(node => !ids.has(node.id)), ...source.nodes], diagnostics: [...new Set([...source.diagnostics, ...page.diagnostics])] });
    } catch (cause) { if (ticket === generation.current) setError(preserveUserError(cause)); throw cause; }
    finally { if (ticket === generation.current) setPaging(false); }
  }
  async function act(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await action(); onClose(); } catch (cause) { setError(preserveUserError(cause)); } finally { setBusy(false); } }
  function toggle(id: string) { setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function keydown(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey || busy) return;
    revealSelection.current = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(event.key); prependAnchor.current?.cancel();
    const index = active ? rows.indexOf(active) : 0;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      if (rows[next]) setSelected(rows[next].id);
    } else if (event.key === 'Enter' && active) { event.preventDefault(); void act(() => onView(active.id)); }
    else if (event.target === filter.current) return;
    else if (event.key === 'ArrowRight' && active) { event.preventDefault(); if (!expanded.has(active.turn.id) && active.turn.entries.length) toggle(active.turn.id); else if (rows[index + 1]) setSelected(rows[index + 1].id); }
    else if (event.key === 'ArrowLeft' && active) { event.preventDefault(); if (active.detail) setSelected(active.turn.id); else if (expanded.has(active.id)) toggle(active.id); else if (active.parentRowId) setSelected(active.parentRowId); }
    else if (event.key.length === 1 && event.key !== ' ') { event.preventDefault(); setQuery(value => value + event.key); filter.current?.focus(); }
  }
  const canFork = !loading && !error && !!tree && !!forkCapability?.canFork;
  const roleLabel = (node: HistoryTreeNode) => t(`omp.explorer.${isTechnicalHistoryNode(node) ? 'event' : node.role === 'user' ? 'user' : node.role === 'assistant' ? 'assistant' : 'tool'}`);
  const diagnostics = [...new Set([...(tree?.diagnostics ?? []), ...(!forkCapability?.canFork ? forkCapability?.diagnostics ?? [] : [])])];
  return <Modal className="history-explorer" title={t('omp.explorer.title')} initialFocus={filter} busy={busy} onClose={() => { if (!busy) onClose(); }}>
    <div className="history-explorer-toolbar">
      <label className="history-explorer-filter field-surface"><IconSearch size="var(--icon-ui)"/><input className="field-editor" ref={filter} value={query} disabled={busy} placeholder={t('omp.explorer.filter')} aria-label={t('omp.explorer.filter')} onChange={event => { revealSelection.current = true; prependAnchor.current?.cancel(); setQuery(event.target.value); }} onKeyDown={keydown}/></label>
      <label className="history-explorer-technical"><input type="checkbox" checked={technical} disabled={busy} onChange={event => { revealSelection.current = true; prependAnchor.current?.cancel(); setTechnical(event.target.checked); }}/>{t('omp.explorer.technical')}</label>
      <Button disabled={busy || loading || paging} onClick={() => setAttempt(value => value + 1)}>{t('omp.history.refreshTree')}</Button>
    </div>
    <div className="history-explorer-heading"><strong>{displaySessionTitle(session.title,t)}</strong><span>{session.cwd}</span></div>
    <div className="history-explorer-body">
      <section className="history-explorer-navigation" aria-label={t('omp.explorer.tree')}>
        <div className="history-explorer-legend"><span className="history-tip-saved">● {t('omp.explorer.saved')}</span>{runtimeLeafId && <span className="history-tip-runtime">◆ {t('omp.explorer.runtime')}</span>}<span>◉ {t('omp.explorer.selected')}</span></div>
        <div ref={list} className="history-explorer-tree" role="tree" aria-label={t('omp.explorer.tree')} aria-activedescendant={active ? `history-row-${active.id}` : undefined} tabIndex={0} onKeyDown={keydown} onWheel={() => { revealSelection.current = false; }} onTouchStart={() => { revealSelection.current = false; }} onPointerDown={() => { revealSelection.current = false; }} aria-busy={loading || paging}>
          <HistoryPaging key={session.path} scrollRef={list} cursor={tree?.hasMore ? tree.nextBefore : undefined} busy={busy || loading || paging} error={error} load={older} enabled={!loading} />
          <PrependAnchor ref={prependAnchor} scrollRef={list} first={tree?.nodes[0]?.id}>
          <div className="history-explorer-rows" style={{ minWidth: graphWidth + 230 }}>
            <svg className="history-explorer-lanes" width={graphWidth} height={rows.length * 64} aria-hidden="true">
              {rows.map((row, index) => { const parentIndex = row.parentRowId ? rowIndexes.get(row.parentRowId) : undefined; const x = 16 + row.lane * 16, y = index * 64 + 24; const parent = parentIndex === undefined ? undefined : rows[parentIndex]; const px = parent ? 16 + parent.lane * 16 : x; const py = parentIndex === undefined ? y : parentIndex * 64 + 24; const saved = row.id === tree?.leafId || !row.detail && model.entryTurn.get(tree?.leafId ?? '') === row.id; const runtime = row.id === runtimeLeafId || !row.detail && model.entryTurn.get(runtimeLeafId ?? '') === row.id; return <g key={row.id}>
                {parent && <path d={`M ${px} ${py} Q ${x} ${py} ${x} ${py + 12} L ${x} ${y}`} className={row.detail ? 'history-lane-detail' : ''}/>}
                {active?.id === row.id && <circle cx={x} cy={y} r={8} className="history-node-selected"/>}
                <circle cx={x} cy={y} r={row.detail ? 2 : 4} className={saved ? 'history-node-saved' : ''}/>
                {runtime && <path d={`M ${x} ${y - 6} l 6 6 l -6 6 l -6 -6 Z`} className="history-node-runtime"/>}
              </g>; })}
            </svg>
            {rows.map(row => { const date = historyNodeDate(row.node.timestamp, i18n.language); const open = expanded.has(row.turn.id) || !!query.trim(); const saved = row.id === tree?.leafId || !row.detail && model.entryTurn.get(tree?.leafId ?? '') === row.id; const runtime = row.id === runtimeLeafId || !row.detail && model.entryTurn.get(runtimeLeafId ?? '') === row.id; return <div data-flip-key={row.id} key={row.id} id={`history-row-${row.id}`} role="treeitem" aria-level={row.depth + 1} aria-selected={active?.id === row.id} aria-expanded={!row.detail && row.turn.entries.length ? open : undefined} aria-current={row.id === selectedLeafId ? 'location' : undefined} className={`history-explorer-row${row.detail ? ' is-detail' : ''}${row.matched ? ' is-match' : ''}`} style={{ paddingInlineStart: graphWidth }} onClick={() => { if (!busy) { revealSelection.current = true; prependAnchor.current?.cancel(); setSelected(row.id); list.current?.focus({ preventScroll: true }); } }}>
              {!row.detail && row.turn.entries.length > 0 ? <button tabIndex={-1} disabled={busy} className="history-explorer-fold" aria-label={t(open ? 'omp.explorer.collapse' : 'omp.explorer.expand')} onClick={event => { event.stopPropagation(); revealSelection.current = true; prependAnchor.current?.cancel(); setSelected(row.id); toggle(row.id); list.current?.focus({ preventScroll: true }); }}><IconChevronRight size="var(--icon-meta)" style={{ transform: open ? 'rotate(90deg)' : undefined }}/></button> : <span className="history-explorer-fold"/>}
              <div className="history-explorer-row-copy"><span className="history-explorer-row-title">{row.node.label || row.node.preview || roleLabel(row.node)}</span><span className="history-explorer-row-meta">{roleLabel(row.node)}{!row.detail && row.turn.entries.length > 0 && ` · ${t('omp.explorer.entries', { count: row.turn.entries.length })}`} · <time dateTime={date ? row.node.timestamp : undefined} title={date?.exact}>{date?.relative ?? t('omp.explorer.unknownDate')}</time>{saved && <span className="history-tip-saved"> · {t('omp.explorer.saved')}</span>}{runtime && <span className="history-tip-runtime"> · {t('omp.explorer.runtime')}</span>}{row.id === selectedLeafId && ` · ${t('omp.explorer.viewing')}`}</span></div>
            </div>; })}
          </div>
          </PrependAnchor>
          {loading && <p role="status">{t('omp.shell.readingHistory')}</p>}
          {!loading && !rows.length && <p role="status">{t(query ? 'omp.explorer.noMatches' : 'omp.history.noBranchEntries')}</p>}
        </div>
        <p className="history-explorer-keys">{t('omp.explorer.keyboard')}</p>
      </section>
      <section className="history-explorer-preview" aria-label={t('omp.explorer.preview')}>
        <div className="history-explorer-preview-heading"><span>{selectedNode ? roleLabel(selectedNode) : t('omp.explorer.preview')}</span><time title={selectedDate?.exact}>{selectedDate?.relative}</time></div>
        <div className="history-explorer-preview-content" key={selectedNode?.id}>{selectedNode?.preview ? selectedNode.role === 'assistant' ? <div className="prose-chat"><Markdown source={selectedNode.preview} cwd={session.cwd}/></div> : <div className="history-explorer-literal">{selectedNode.preview}</div> : <p>{t('omp.explorer.noPreview')}</p>}{selectedNode && isTechnicalHistoryNode(selectedNode) && <details><summary>{t('omp.explorer.details')}</summary><code>{selectedNode.type}</code><p>{selectedNode.label}</p></details>}</div>
        <p className="history-explorer-excerpt">{t('omp.explorer.excerpt')}</p>
        <div className="history-explorer-view-actions"><Button variant="primary" disabled={busy || loading || !selectedNode} onClick={() => selectedNode && void act(() => onView(selectedNode.id))}>{t('omp.explorer.view')}</Button><Button disabled={busy || loading} onClick={() => void act(() => onView())}>{t('omp.history.followLatest')}</Button></div>
      </section>
    </div>
    <div className="history-explorer-footer"><p>{t('omp.explorer.explanation')}</p><div className="history-explorer-footer-actions"><Button disabled={busy || !canFork} onClick={() => void act(onFork)}>{t('shell.forkLatest')}</Button>{onOwnedBranch && <Button disabled={busy} onClick={() => void act(onOwnedBranch)}>{t('shell.branchBefore')}</Button>}</div>{!forkCapability && <span role="status">{t('omp.history.checkingFork')}</span>}{forkCapability && !canFork && <span role="status">{t('omp.history.forkUnavailable')}</span>}</div>
    {diagnostics.length > 0 && <details className="history-explorer-diagnostics"><summary>{t('omp.explorer.details')} ({diagnostics.length})</summary>{diagnostics.map(message => <p key={message}>{message}</p>)}</details>}
    {error && <UserErrorNotice error={error} />}
  </Modal>;
}

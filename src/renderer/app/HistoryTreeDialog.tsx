import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryTreeSnapshot, SessionSummary } from '../../shared/contracts';
import { Button } from '../ui/ui';
import { Modal } from './Dialogs';
import { errorText } from './runtime-store';

export function HistoryTreeDialog({ session, onClose, onView, onFork, onOwnedBranch }: { session: SessionSummary; onClose: () => void; onView: (leafId?: string | null) => Promise<void>; onFork: () => Promise<void>; onOwnedBranch?: () => Promise<void> }) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<HistoryTreeSnapshot | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true), [paging, setPaging] = useState(false);
  const generation = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const readingAnchor = useRef<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const ticket = ++generation.current; setLoading(true); setPaging(false); setError('');
    void window.ompDesktop.readHistoryTree(session.path).then(value => { if (ticket === generation.current) { readingAnchor.current = null; setTree(value); } }, cause => { if (ticket === generation.current) setError(errorText(cause)); }).finally(() => { if (ticket === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [session.path, attempt]);
  useLayoutEffect(() => { const anchor = readingAnchor.current; if (anchor && list.current) list.current.scrollTop = anchor.top + list.current.scrollHeight - anchor.height; readingAnchor.current = null; }, [tree]);
  async function older() {
    if (!tree?.hasMore || !tree.nextBefore || paging || loading || busy) return;
    const source = tree, ticket = generation.current; setPaging(true); setError('');
    try {
      const page = await window.ompDesktop.readHistoryTree(session.path, source.nextBefore);
      if (ticket !== generation.current) return;
      if (page.revision !== source.revision) throw new Error(t('omp.history.treeChanged'));
      if (page.hasMore && (!page.nextBefore || page.nextBefore === source.nextBefore)) throw new Error(t('omp.history.treeCursorInvalid'));
      const ids = new Set(source.nodes.map(node => node.id));
      if (list.current) readingAnchor.current = { height: list.current.scrollHeight, top: list.current.scrollTop };
      setTree({ ...page, nodes: [...page.nodes.filter(node => !ids.has(node.id)), ...source.nodes], diagnostics: [...new Set([...source.diagnostics, ...page.diagnostics])] });
    } catch (cause) { if (ticket === generation.current) setError(errorText(cause)); }
    finally { if (ticket === generation.current) setPaging(false); }
  }
  async function act(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); onClose(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  const depths = new Map<string, number>();
  const childCounts = new Map<string, number>();
  for (const node of tree?.nodes ?? []) if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  const canFork = !loading && !error && !!tree && session.canFork;
  return <Modal title={t('omp.history.tree')} onClose={() => { if (!busy) onClose(); }}>
    <p className="session-rename-dialog-description">{t('omp.history.treeDescription')}</p>
    <div className="omp-history-actions"><Button disabled={busy} onClick={() => void act(() => onView())}>{t('omp.history.followLatest')}</Button><Button disabled={busy || loading || paging} onClick={() => setAttempt(value => value + 1)}>{t('omp.history.refreshTree')}</Button></div>
    {loading && <p role="status">{t('omp.shell.readingHistory')}</p>}
    {tree?.hasMore && <Button disabled={busy || loading || paging} onClick={() => void older()}>{t(paging ? 'omp.history.loadingEarlierTree' : 'omp.history.loadEarlierTree')}</Button>}
    <div ref={list} className="omp-branch-messages omp-history-tree">{tree?.nodes.map(node => { const depth = node.parentId ? (depths.get(node.parentId) ?? 0) + ((childCounts.get(node.parentId) ?? 0) > 1 ? 1 : 0) : 0; depths.set(node.id, depth); return <button className="search-item" key={node.id} disabled={busy} style={{ paddingInlineStart: `${12 + Math.min(depth, 4) * 12}px` }} onClick={() => void act(() => onView(node.id))}><span className="search-item-title">{node.label || node.preview || node.role || node.type}</span><span className="search-item-meta">{node.timestamp}{node.id === tree.leafId ? ` · ${t('omp.history.persistedLeaf')}` : ''}</span></button>; })}</div>
    {tree?.diagnostics.map((message, index) => <p key={index} role="status">{message}</p>)}
    <p className="session-rename-dialog-description">{t('omp.history.forkDescription')}</p>
    <div className="omp-history-actions"><Button disabled={busy || !canFork} onClick={() => void act(onFork)}>{t('omp.history.forkLatest')}</Button>{!canFork && <p role="status">{t('omp.history.forkUnavailable')}</p>}{onOwnedBranch && <Button disabled={busy} onClick={() => void act(onOwnedBranch)}>{t('omp.history.ownedBranch')}</Button>}</div>
    {error && <p role="alert" className="omp-inline-error">{error}</p>}
  </Modal>;
}

// Adapted from PI-Desktop-main ReviewChangeCard (LGPL-3.0). No snapshot or rollback semantics.
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceDiff } from '../../shared/contracts';
import { IconChevronRight } from '../ui/icons';
import { cx } from '../ui/ui';
import { parseUnifiedDiff } from './unified-diff';

export function ReviewChangeCard({ change, onOpenFile }: { change: WorkspaceDiff['files'][number]; onOpenFile: (path: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const diff = useMemo(() => parseUnifiedDiff(change.patch), [change.patch]);
  const rawMark = change.status.split(' ').at(-1) ?? 'M';
  const mark = diff.renamedFrom ? 'R' : rawMark.startsWith('R') ? 'R' : rawMark;
  const untracked = mark === '?' || change.status.startsWith('untracked');
  const status = mark === 'A' || untracked ? 'added' : mark === 'D' ? 'deleted' : mark === 'R' ? 'renamed' : 'modified';
  const statusLabel = t(untracked ? 'omp.review.untracked' : `omp.review.${status}`);
  const stage = t(change.status.startsWith('staged ') ? 'omp.review.staged' : 'omp.review.unstaged');
  const slash = change.path.lastIndexOf('/');
  const directory = change.path.slice(0, slash + 1);
  const basename = change.path.slice(slash + 1);
  return <section className={cx('review-change-card', open && 'open')} data-status={status}>
    <button type="button" className="review-change-card-header lg-regular" aria-expanded={open} aria-controls={detailsId} aria-label={`${change.path}: ${statusLabel}${untracked ? '' : `, ${stage}`}`} onClick={() => setOpen(value => !value)}>
      <span className="review-change-card-caret" aria-hidden><IconChevronRight size={11} /></span>
      <span className="review-change-card-path" title={change.path}><strong>{basename}</strong>{directory && <span className="review-change-directory">{directory}</span>}</span>
      <span className="review-change-card-mark" title={statusLabel}>{untracked ? statusLabel : mark}</span>
      {!untracked && <span className="review-change-stage">{stage}</span>}
      {(diff.additions > 0 || diff.deletions > 0) && <span className="review-change-card-counts diff-counts"><span className="diff-count-add">+{diff.additions}</span><span className="diff-count-del">−{diff.deletions}</span></span>}
    </button>
    {open && <div className="review-change-card-body" id={detailsId}><div className="review-change-card-body-content">
      {diff.renamedFrom && <div className="review-change-note review-change-rename">{t('omp.review.renamedFrom', { path: diff.renamedFrom })}</div>}
      {diff.state !== 'text' ? <div className="review-change-note">{t(`omp.review.${diff.state}`)}</div> : <div className="review-change-diff">{diff.hunks.map((hunk, hunkIndex) => <div className="diff-hunk" key={hunkIndex}>
        <div className="diff-line hunk lg-thin lg-static lg-capsule"><span className="diff-line-text">{hunk.header}</span></div>
        {hunk.lines.map((line, lineIndex) => <div className={cx('diff-line', line.type)} key={lineIndex}>
          <span className="diff-line-number" aria-label={line.oldLine === undefined ? undefined : t('omp.review.oldLine', { line: line.oldLine })}>{line.oldLine ?? ''}</span>
          <span className="diff-line-number" aria-label={line.newLine === undefined ? undefined : t('omp.review.newLine', { line: line.newLine })}>{line.newLine ?? ''}</span>
          <span className="diff-line-sign" aria-hidden>{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
          <span className="diff-line-text">{line.text}{line.noNewline && <span className="diff-no-newline">{t('omp.review.noNewline')}</span>}</span>
        </div>)}
      </div>)}</div>}
      {status !== 'deleted' && <div className="review-change-card-actions"><button type="button" className="review-open-file" onClick={() => onOpenFile(change.path)}>{t('omp.workspace.openFile')}</button></div>}
    </div></div>}
  </section>;
}

export function ReviewTab({ cwd, path, onOpenFile }: { cwd: string; path?: string; onOpenFile: (path: string) => void }) {
  const { t } = useTranslation();
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState(path ?? '');
  const [appliedFilter, setAppliedFilter] = useState(path ?? '');
  useEffect(() => {
    let active = true; setDiff(null); setError('');
    if (!cwd) return;
    window.ompDesktop.gitDiff(cwd, appliedFilter || undefined).then(value => { if (active) setDiff(value); }, cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [cwd, appliedFilter, revision]);
  return <div className="review-tab"><div className="file-viewer-header"><span className="file-viewer-path">{t('omp.workspace.gitHeading')}</span><button className="icon-btn" title={t('omp.workspace.refreshDiff')} onClick={() => setRevision(value => value + 1)}>↻</button></div><form className="file-viewer-header" onSubmit={event => { event.preventDefault(); setAppliedFilter(filter); }}><input className="input" aria-label={t('omp.workspace.gitPathFilter')} placeholder={t('omp.workspace.gitPathPlaceholder')} value={filter} onChange={event => setFilter(event.target.value)} /><button type="submit" className="icon-btn">{t('omp.workspace.filter')}</button></form><p className="review-read-only">{t('omp.workspace.readOnlyDiff')}</p>{!cwd ? <div className="work-tab-empty">{t('omp.shell.chooseWorkspace')}</div> : error ? <div className="work-tab-empty" role="alert">{error}</div> : !diff ? <div className="file-tree-note">{t('omp.workspace.loadingDiff')}</div> : !diff.available ? <div className="work-tab-empty">{diff.reason}</div> : !diff.files.length ? <div className="work-tab-empty">{appliedFilter ? t('omp.workspace.noPathChanges') : t('omp.workspace.cleanGit')}</div> : <div className="review-change-list">{diff.files.map(change => <ReviewChangeCard key={`${change.status}:${change.path}`} change={change} onOpenFile={onOpenFile} />)}</div>}</div>;
}

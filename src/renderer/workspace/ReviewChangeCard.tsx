import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceDiff, RecordedFileChange } from '../../shared/contracts';
import type { TurnChangeQuery, TurnChangeResult, ChangeOrigin } from '../../shared/turn-change-types';
import { useTurnChanges } from '../chat/use-turn-changes';
import { fuzzyMatch } from '../app/palette-model';
import { FileObjectProvider, useFileObject } from '../lib/file-object';
import { formatFileTarget } from '../lib/file-target';
import { IconFilePen, IconFilePlus, IconFileText, IconExternal, IconSearch } from '../ui/icons';
import { cx } from '../ui/ui';
import { parseUnifiedDiff, reviewDiffRows, type DiffHunk, type ReviewDiffLine, type ReviewDiffRow } from './unified-diff';
import { recordedChangeLabel, reviewRelativePath } from './review-path';
import { AnimatedNumber, Swap, useFlipList } from '../ui/motion';
import { captureReviewReading, restoreReviewReading, retainReviewHunk, type ReviewReading, type ReviewReadingLine } from './review-reading';
import { noteProgrammaticScroll } from '../ui/motion/programmatic-scroll';
import '../styles/review.css';

interface ReviewTabProps { cwd: string; path?: string; turnChanges?: TurnChangeResult; turnChangeQuery?: TurnChangeQuery; referencedPaths?: ReadonlySet<string>; onRevealTool?: (toolId: string) => void; onRevealOrigin?: (origin: ChangeOrigin) => void; onOpenFile: (path: string) => void }
const groups = ['recorded', 'staged', 'unstaged', 'untracked'] as const;
type ReviewGroup = typeof groups[number];

export function ReviewTab(props: ReviewTabProps) {
  return <FileObjectProvider cwd={props.cwd} onOpenFile={props.onOpenFile}><ReviewWorkspace {...props} /></FileObjectProvider>;
}

function ReviewWorkspace({ cwd, path, turnChanges, turnChangeQuery, referencedPaths, onRevealTool, onRevealOrigin }: ReviewTabProps) {
  const { t } = useTranslation();
  const objects = useFileObject(cwd);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [patches, setPatches] = useState<Record<string, string>>({});
  const [patchError, setPatchError] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState('');
  const turnOnly = !!turnChangeQuery;
  const { result, error: turnError } = useTurnChanges(turnChangeQuery, turnChanges, revision);
  const changes = result?.files ?? [];
  const turnIncomplete = !!turnError || result?.state !== 'complete';
  const coverageReasons = [...new Set([...(result?.coverage.reasons ?? []), ...(turnError ? [turnError] : [])])];
  const coverageDetails = coverageReasons.length > 0 && <ul className="review-coverage-reasons">{coverageReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>;
  const [selected, setSelected] = useState(path ? `recorded:${reviewRelativePath(cwd, path)}` : '');
  const [wide, setWide] = useState(false);
  const [mode, setMode] = useState<'unified' | 'split'>('split');
  const [wrap, setWrap] = useState(true);
  const [hunkIndex, setHunkIndex] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const referenceKey = JSON.stringify([...referencedPaths ?? []]);
  const sourceKey = JSON.stringify([cwd, turnChangeQuery?.context, turnChangeQuery?.anchorId]);
  const loadedSource = useRef(sourceKey);
  const reading = useRef<ReviewReading | undefined>(undefined);
  const previousHunks = useRef<DiffHunk[]>([]);
  useEffect(() => {
    const element = root.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 900));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true; setError('');
    if (loadedSource.current !== sourceKey) { setDiff(null); setPatches({}); loadedSource.current = sourceKey; }
    if (!turnOnly && cwd) window.ompDesktop.gitDiff(cwd, undefined, JSON.parse(referenceKey) as string[]).then(async value => {
      if (!active) return;
      // Keep the current canvas mounted until its deferred replacement is ready.
      const current = latestFocused.current;
      const replacement = current && value.files.find(file => file.path === current.path && file.status === current.status);
      let patch: string | undefined;
      if (replacement?.patchDeferred) {
        try { patch = (await window.ompDesktop.gitDiff(cwd, replacement.path, [replacement.path])).files.find(file => file.status === replacement.status)?.patch ?? ''; }
        catch (cause) { if (active) setError(String(cause)); return; }
      }
      if (active) { setPatches(current && patch !== undefined ? { [current.id]: patch } : {}); setDiff(value); }
    }, cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [cwd, revision, referenceKey, turnOnly, sourceKey]);
  const entries = useMemo(() => {
    const git = (diff?.files ?? []).map(change => {
      const group = change.status.startsWith('untracked') ? 'untracked' : change.status.startsWith('staged ') ? 'staged' : 'unstaged';
      const id = `${group}:${change.path}`, patch = patches[id] ?? change.patch, parsed = parseUnifiedDiff(patch);
      return { ...change, patch, id, scratch: false, reasonLabel: undefined as string | undefined, reasonTitle: '', patchDeferred: !!change.patchDeferred && patches[id] === undefined, countsKnown: patches[id] !== undefined || change.added !== undefined, group: group as ReviewGroup, diff: { ...parsed, additions: change.added ?? parsed.additions, deletions: change.removed ?? parsed.deletions }, steps: [] as RecordedFileChange['steps'], processTruncated: false };
    });
    const recorded = changes.map(file => {
      const relative = reviewRelativePath(cwd, file.path);
      const patch = file.patch;
      return { path: relative, status: `recorded ${file.op === 'delete' ? 'D' : file.op === 'create' ? 'A' : file.op === 'move' ? 'R' : 'M'}`, patch, repo: undefined as string | undefined, id: `recorded:${relative}`, group: 'recorded' as ReviewGroup, diff: { ...parseUnifiedDiff(patch), additions: file.added, deletions: file.removed }, steps: file.steps, processTruncated: !!file.processTruncated, patchDeferred: false, countsKnown: file.countsKnown, reasonLabel: file.content === 'binary' ? 'review.binary' : file.content !== 'complete' ? 'review.contentGap' : undefined, reasonTitle: file.reason ?? '', scratch: false };
    });
    return turnOnly ? recorded : git;
  }, [diff, changes, turnOnly, cwd, patches]);
  const scoped = entries;
  const visible = useMemo(() => scoped.flatMap(entry => {
    const match = fuzzyMatch(entry.path, filter); return match ? [{ ...entry, score: match.score }] : [];
  }).sort((a, b) => Number(a.scratch) - Number(b.scratch) || groups.indexOf(a.group) - groups.indexOf(b.group) || b.score - a.score || a.path.localeCompare(b.path)), [scoped, filter]);
  const focused = visible.find(entry => entry.id === selected) ?? visible[0];
  useFlipList(list, visible.map(entry => entry.id));
  const repositories = [...new Set(visible.map(entry => entry.repo ?? ''))];
  const focusedId = focused?.id;
  const latestFocused = useRef(focused);
  latestFocused.current = focused;
  useEffect(() => {
    setPatchError('');
    if (!focused?.patchDeferred) return;
    let active = true;
    window.ompDesktop.gitDiff(cwd, focused.path, [focused.path]).then(result => {
      if (!active) return;
      setPatches(current => ({ ...current, [focused.id]: result.files.find(file => file.status === focused.status)?.patch ?? '' }));
    }, cause => { if (active) setPatchError(String(cause)); });
    return () => { active = false; };
  }, [cwd, focusedId, focused?.patchDeferred, focused?.status, revision]);
  const hunks = useMemo(() => focused?.diff.hunks.map(hunk => ({ ...hunk, rows: reviewDiffRows(hunk.lines) })) ?? [], [focused?.diff]);
  const split = wide && mode === 'split';
  const readingTarget = JSON.stringify([sourceKey, focusedId]);
  const readingRows = useRef<{ element: HTMLElement; line: ReviewDiffLine; hunk: number }[]>([]);
  const measureReading = () => {
    const node = canvas.current;
    if (!node) return;
    const edge = node.getBoundingClientRect().top + (node.querySelector<HTMLElement>('.review-file-header')?.offsetHeight ?? 0);
    readingRows.current = Array.from(node.querySelectorAll<HTMLElement>('[data-review-line]'), element => ({
      element, line: JSON.parse(element.dataset.reviewLine!) as ReviewDiffLine, hunk: Number(element.closest<HTMLElement>('[data-hunk]')?.dataset.hunk ?? 0),
    }));
    const lines: ReviewReadingLine[] = readingRows.current.map(({ element, line, hunk }) => {
      const bounds = element.getBoundingClientRect();
      return { ...line, top: bounds.top, height: bounds.height, hunk };
    });
    return { node, edge, lines };
  };
  const captureReading = () => {
    const node = canvas.current;
    if (!node) return;
    const edge = node.getBoundingClientRect().top + (node.querySelector<HTMLElement>('.review-file-header')?.offsetHeight ?? 0);
    // DOM order is vertical order, with equal-bottom pairs in split mode.
    // Only logarithmically many live rects are read; metadata is cached at commit.
    const rows = readingRows.current;
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle].element.getBoundingClientRect().bottom <= edge) low = middle + 1;
      else high = middle;
    }
    const row = rows[low];
    const bounds = row?.element.getBoundingClientRect();
    const line = row && bounds ? { ...row.line, top: bounds.top, height: bounds.height, hunk: row.hunk } : undefined;
    reading.current = captureReviewReading(readingTarget, node.scrollTop, edge, line ? [line] : [], hunkIndex);
  };
  useLayoutEffect(() => {
    const measured = measureReading();
    if (!measured) return;
    const next = restoreReviewReading(reading.current, readingTarget, measured.node.scrollTop, measured.edge, measured.lines);
    if (measured.node.scrollTop !== next.top) { measured.node.scrollTop = next.top; noteProgrammaticScroll(measured.node); }
    setHunkIndex(next.navigated ? 0 : retainReviewHunk(previousHunks.current[hunkIndex], hunkIndex, hunks));
    previousHunks.current = hunks;
    if (next.navigated) {
      const row = list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]');
      row?.scrollIntoView({ block: 'nearest' });
      if (list.current) noteProgrammaticScroll(list.current);
      if (list.current?.contains(document.activeElement)) row?.focus({ preventScroll: true });
    }
    captureReading();
  }, [readingTarget, hunks, split, wrap, expanded]);
  const totals = scoped.filter(entry => entry.countsKnown).reduce((sum, entry) => ({ added: sum.added + entry.diff.additions, removed: sum.removed + entry.diff.deletions }), { added: 0, removed: 0 });
  const fileCount = new Set(scoped.map(entry => entry.path)).size;
  useEffect(() => { if (path) setSelected(`${turnOnly ? 'recorded' : focused?.group ?? 'unstaged'}:${reviewRelativePath(cwd, path)}`); }, [cwd, path, sourceKey]);
  const moveHunk = (step: number) => {
    const next = Math.max(0, Math.min(hunks.length - 1, hunkIndex + step));
    setHunkIndex(next);
    const element = canvas.current?.querySelector<HTMLElement>(`[data-hunk="${next}"]`);
    if (element && canvas.current) {
      canvas.current.scrollTop = element.offsetTop - (canvas.current.querySelector<HTMLElement>('.review-file-header')?.offsetHeight ?? 0);
      noteProgrammaticScroll(canvas.current);
      captureReading();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLElement && (event.target.closest('input, textarea, select, [contenteditable=true]') || event.altKey || event.nativeEvent.isComposing)) return;
    if (!focused) return;
    const target = formatFileTarget({ path: focused.path, line: hunks[hunkIndex]?.lines.find(line => line.type === 'add')?.newLine ?? hunks[hunkIndex]?.lines.find(line => line.newLine !== undefined)?.newLine });
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!focused.status.endsWith(' D')) objects.openInEditor(target); return; }
    if (event.metaKey || event.ctrlKey) return;
    const key = event.key.toLowerCase();
    if (key === ' ' && event.target instanceof HTMLElement && event.target.closest('button') && !event.target.closest('.review-file-row')) return;
    if (!['j', 'k', 'n', 'p', 'w', 'u', 's', ' '].includes(key)) return;
    event.preventDefault();
    if (key === 'j' || key === 'k') {
      const index = visible.findIndex(entry => entry.id === focused.id);
      setSelected(visible[Math.max(0, Math.min(visible.length - 1, index + (key === 'j' ? 1 : -1)))].id);
    } else if (key === 'n' || key === 'p') moveHunk(key === 'n' ? 1 : -1);
    else if (key === 'w') setWrap(value => !value);
    else if (key === 'u') setMode('unified');
    else if (key === 's' && wide) setMode('split');
    else if (key === ' ' && !focused.status.endsWith(' D')) objects.quickLook(focused.path);
  };
  const refresh = () => setRevision(value => value + 1);
  const counts = (added: number, removed: number) => <span className="review-counts"><span className="review-added">+<AnimatedNumber value={added} /></span><span className="review-removed">−<AnimatedNumber value={removed} /></span></span>;
  const lineView = (line: ReviewDiffLine | undefined, side?: 'before' | 'after') => <div className={cx('review-code-line', line?.type, !line && 'blank')} data-review-line={line ? JSON.stringify({ type: line.type, text: line.text, oldLine: line.oldLine, newLine: line.newLine }) : undefined}>
    {(!side || side === 'before') && <span className="review-line-number" aria-label={line?.oldLine === undefined ? undefined : t('omp.review.oldLine', { line: line.oldLine })}>{line?.oldLine}</span>}
    {(!side || side === 'after') && <span className="review-line-number" aria-label={line?.newLine === undefined ? undefined : t('omp.review.newLine', { line: line.newLine })}>{line?.newLine}</span>}
    <span className="review-line-sign" aria-hidden>{line?.type === 'add' ? '+' : line?.type === 'del' ? '−' : ' '}</span>
    <span className="review-line-text">{line?.words ? line.words.map((word, index) => word.changed ? <mark key={index}>{word.text}</mark> : <Fragment key={index}>{word.text}</Fragment>) : line?.text}{line?.noNewline && <span className="review-no-newline">{t('omp.review.noNewline')}</span>}</span>
  </div>;
  const rowView = (row: Extract<ReviewDiffRow, { kind: 'line' }>, key: string) => split
    ? <div className="review-split-row" key={key}>{lineView(row.before, 'before')}{lineView(row.after, 'after')}</div>
    : <Fragment key={key}>{row.before && lineView(row.before)}{row.after && row.after !== row.before && lineView(row.after)}</Fragment>;
  const empty = (title: string, detail: string, action: string, run: () => void) => <div className="review-empty"><IconFileText size="var(--icon-heading)" /><strong>{title}</strong>{detail && <p>{detail}</p>}<button type="button" onClick={run}>{action}</button></div>;
  const deleted = focused?.status.split(' ').at(-1) === 'D';
  const target = focused && formatFileTarget({ path: focused.path, line: hunks[hunkIndex]?.lines.find(line => line.type === 'add')?.newLine ?? hunks[hunkIndex]?.lines.find(line => line.newLine !== undefined)?.newLine });
  const note = focused?.patch.startsWith('Diff unavailable:')
    ? focused.patch.includes('4 MiB') ? 'review.patchTooLarge' : 'omp.review.tooLarge'
    : focused?.group === 'untracked' && focused.diff.state === 'noLineDetails' && focused.patch.includes('new file mode ') ? 'review.emptyFile' : `omp.review.${focused?.diff.state}`;
  return <div ref={root} className={cx('review-tab', wide && 'review-wide')} tabIndex={0} onKeyDown={onKeyDown} aria-label={t('review.workspace')}>
    <header className="review-summary-header"><div><strong>{t(turnOnly && !fileCount && turnIncomplete ? 'omp.changes.title' : turnOnly && turnIncomplete ? 'review.knownFiles' : 'review.files', { count: fileCount })}</strong>{scoped.some(entry => entry.countsKnown) && counts(totals.added, totals.removed)}{scoped.some(entry => !entry.countsKnown) && <span className="review-total-note">{t('review.partialTotal')}</span>}</div><button type="button" onClick={refresh} title={t('review.refresh')} aria-label={t('review.refresh')}>↻</button></header>
    <div className="review-group-counts"><span>{t(turnOnly ? 'review.turnOnly' : 'review.all')}</span>{!turnOnly && groups.filter(group => group !== 'recorded').map(group => <span key={group}>{t(`review.${group}`)} <b>{scoped.filter(entry => entry.group === group).length}</b></span>)}</div>
    {turnOnly && entries.length > 0 && turnIncomplete && <div className="review-note" role="status">{t(turnError ? 'review.loadFailed' : result?.state === 'collecting' ? 'review.collecting' : 'review.partialCoverage')}{coverageDetails}</div>}
    {entries.length > 0 && <div className="review-filter-toolbar"><label className="review-filter field-surface"><IconSearch size="var(--icon-meta)" /><input className="field-editor" aria-label={t('review.filter')} placeholder={t('review.filter')} value={filter} onChange={event => setFilter(event.target.value)} /></label></div>}
    {turnOnly && !entries.length ? <div className="review-empty" role="status"><strong>{t(turnError ? 'review.undetermined' : !result || result.state === 'collecting' ? 'review.collecting' : result.state === 'complete' ? 'review.noTurnChanges' : 'review.undetermined')}</strong>{(turnError || result?.state === 'partial') && <p>{t('review.undeterminedDetail')}</p>}{coverageDetails}<button type="button" onClick={refresh}>{t('review.refresh')}</button></div>
      : !turnOnly && error && !entries.length ? empty(t('review.loadFailed'), error, t('review.refresh'), refresh)
      : !cwd ? empty(t('omp.shell.chooseWorkspace'), t('review.workspaceNeeded'), t('review.refresh'), refresh)
      : !turnOnly && !diff ? <div className="review-empty" role="status">{t('omp.workspace.loadingDiff')}</div>
      : !turnOnly && diff && !diff.available && !entries.length ? empty(t('review.noGit'), t('review.noGitDetail'), t('review.checkAgain'), refresh)
      : !entries.length ? empty(t('review.clean'), t('review.cleanDetail'), t('review.refresh'), refresh)
      : !visible.length ? empty(t('review.noMatch'), t('review.noMatchDetail'), t('review.resetFilter'), () => setFilter(''))
      : <div className="review-workspace"><div ref={list} className="review-file-list" aria-label={t('review.fileList')}>{repositories.map(repo => <section key={repo} className="review-repository">{!turnOnly && <h2>{repo ? reviewRelativePath(cwd, repo) || repo : t('review.unversioned')}</h2>}{groups.map(group => {
        const rows = visible.filter(entry => entry.group === group && (entry.repo ?? '') === repo);
        return rows.length > 0 && <section key={group}><h3>{t(`review.${group}`)} <span>{rows.length}</span></h3>{rows.map(entry => {
          const slash = entry.path.lastIndexOf('/'), directory = entry.path.slice(0, slash + 1), middle = Math.ceil(directory.length / 2);
          const mark = entry.group === 'untracked' ? 'A' : entry.status.split(' ').at(-1) ?? 'M';
          const StatusIcon = mark === 'A' ? IconFilePlus : mark === 'D' ? IconFileText : IconFilePen;
          return <button type="button" key={entry.id} data-flip-key={entry.id} className={cx('review-file-row', entry.scratch && 'review-scratch')} aria-current={entry.id === focusedId ? 'true' : undefined} title={entry.path} onFocus={() => setSelected(entry.id)} onClick={() => setSelected(entry.id)} onDoubleClick={() => { if (mark !== 'D') objects.open(entry.path); }} onContextMenu={event => { if (mark !== 'D') objects.contextMenu(formatFileTarget({ path: entry.path, line: entry.diff.hunks[0]?.lines.find(line => line.type === 'add')?.newLine }), event); }} {...(mark === 'D' ? {} : objects.dragProps(entry.path))}>
            <span role="img" className={cx('review-status', mark === 'A' && 'review-added', mark === 'D' && 'review-removed')} aria-label={t(`omp.review.${mark === 'A' ? 'added' : mark === 'D' ? 'deleted' : mark === 'R' ? 'renamed' : 'modified'}`)} title={t(`omp.review.${mark === 'A' ? 'added' : mark === 'D' ? 'deleted' : mark === 'R' ? 'renamed' : 'modified'}`)}><StatusIcon size="var(--icon-ui)" aria-hidden /><span aria-hidden>{mark}</span></span>
            <span className="review-file-path change-file-identity"><span className="change-file-name">{entry.path.slice(slash + 1)}</span>{directory && <span className="change-file-directory"><span>{directory.slice(0, middle)}</span><span><bdi>{directory.slice(middle)}</bdi></span></span>}</span><span className="review-row-meta">{entry.reasonLabel && <span className="review-counts" title={entry.reasonTitle}>{t(entry.reasonLabel)}</span>}{entry.countsKnown ? counts(entry.diff.additions, entry.diff.deletions) : entry.patchDeferred ? <span className="review-counts">{t('review.onSelection')}</span> : null}</span>
          </button>;
        })}</section>;
      })}</section>)}</div><div ref={canvas} onScroll={captureReading} className={cx('review-canvas', wrap && 'review-wrap', split && 'review-split')} aria-label={t('review.diffCanvas')}><Swap swapKey={focused.id + ':' + (split ? 'split' : 'unified')} variant="fade" className="review-file-swap">
        <header className="review-file-header"><div className="review-file-heading"><strong title={focused.path}>{focused.path}</strong><span>{t(`review.${focused.group}`)}</span></div><div className="review-file-actions">
          <button type="button" disabled={deleted} onClick={() => objects.open(target!)}>{t('review.open')}</button><button type="button" disabled={deleted} onClick={() => objects.openInEditor(target!)} title={t('review.editorHint')}><IconExternal size="var(--icon-meta)" />{t('review.editor')}</button>
          <button type="button" disabled={deleted} onClick={() => objects.quickLook(focused.path)} title={t('review.quickLookHint')}>{t('review.quickLook')}</button><button type="button" disabled={deleted} onClick={() => objects.reveal(focused.path)}>{t('review.reveal')}</button>
        </div><div className="review-diff-toolbar"><div className="review-segments"><button type="button" aria-pressed={!split} onClick={() => setMode('unified')} title="U">{t('review.unified')}</button><button type="button" disabled={!wide} aria-pressed={split} onClick={() => setMode('split')} title={wide ? 'S' : t('review.wideRequired')}>{t('review.split')}</button></div><button type="button" aria-pressed={wrap} onClick={() => setWrap(value => !value)} title="W">{t('review.wrap')}</button><span className="review-hunk-navigation"><button type="button" disabled={hunkIndex <= 0} aria-label={t('review.previousHunk')} title="P" onClick={() => moveHunk(-1)}>↑</button><span>{hunks.length ? hunkIndex + 1 : 0}/{hunks.length}</span><button type="button" disabled={hunkIndex >= hunks.length - 1} aria-label={t('review.nextHunk')} title="N" onClick={() => moveHunk(1)}>↓</button></span></div></header>
        {focused.diff.renamedFrom && <p className="review-note">{t('omp.review.renamedFrom', { path: focused.diff.renamedFrom })}</p>}
        {focused.patchDeferred && <p className="review-note" role="status">{patchError || t('omp.workspace.loadingDiff')}</p>}
        {(focused.steps.length > 0 || focused.processTruncated) && <details className="review-recorded-steps"><summary>{t('review.process')}</summary>{focused.processTruncated && <p className="review-note">{t('review.processTruncated')}</p>}{focused.steps.map((step, index) => {
          const ownSource = !step.origin || JSON.stringify(step.origin.context) === JSON.stringify(turnChangeQuery?.context);
          const revealTool = ownSource && !!onRevealTool;
          return <section key={`${step.origin?.sessionId ?? ''}:${step.origin?.entryId ?? ''}:${step.toolId}:${index}`}><header><strong>{step.origin?.label ?? step.origin?.sessionId ?? t('review.step', { count: index + 1 })}</strong>{recordedChangeLabel(step) && <span>{t(recordedChangeLabel(step)!)}</span>}{(revealTool || step.origin?.context && (step.origin.resultEntryId ?? step.origin.entryId) && onRevealOrigin) && <button type="button" onClick={() => revealTool ? onRevealTool?.(step.toolId) : step.origin && onRevealOrigin?.(step.origin)}>{t(revealTool ? 'review.revealStep' : 'omp.resource.title')} ↗</button>}</header>{step.command && <pre>{step.command}</pre>}{step.patch && <pre className="selectable">{step.patch}</pre>}</section>;
        })}</details>}
        {focused.reasonLabel && <p className="review-note" title={focused.reasonTitle}>{t(focused.reasonLabel)}</p>}
        {!focused.patchDeferred && (focused.diff.state !== 'text' ? !focused.reasonLabel && <p className="review-note">{t(note)}</p> : <div className="review-diff-content">{split && <div className="review-side-labels"><span>{t('review.before')}</span><span>{t('review.after')}</span></div>}{hunks.map((hunk, index) => <section key={index} className="review-hunk" data-hunk={index} aria-label={hunk.header}>
          <button type="button" className="review-hunk-header" aria-current={hunkIndex === index ? 'true' : undefined} onClick={() => setHunkIndex(index)}>{hunk.header}</button>
          {hunk.rows.map((row, rowIndex) => {
            const key = `${index}:${rowIndex}`;
            if (row.kind === 'line') return rowView(row, key);
            const id = `${focusedId}:${index}:${row.id}`;
            return <Fragment key={key}><button type="button" className="review-context-toggle" aria-expanded={expanded.has(id)} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}>{t(expanded.has(id) ? 'review.collapseContext' : 'review.expandContext', { count: row.lines.length })}</button>{expanded.has(id) && row.lines.map((line, contextIndex) => rowView({ kind: 'line', before: line, after: line }, `${key}:${contextIndex}`))}</Fragment>;
          })}</section>)}</div>)}
      </Swap></div></div>}
    <footer className="review-shortcuts">{t('review.shortcuts')}</footer>
  </div>;
}

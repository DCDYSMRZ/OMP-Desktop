import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconArrowRight, IconChevronRight, IconFilePen, IconFilePlus, IconMore, IconTrash } from '../ui/icons';
import { Collapse } from '../ui/Collapse';
import { DisclosureScope, useAutomaticDisclosure } from './disclosure';
import { useFileObject } from '../lib/file-object';
import { formatFileTarget } from '../lib/file-target';
import { reviewRelativePath } from '../workspace/review-path';
import type { PanelRequest, SessionResourceContext } from '../../shared/contracts';
import type { TurnChangeQuery } from '../../shared/turn-change-types';
import { AnimatedNumber, useFlipList } from '../ui/motion';
import { useTurnChanges } from './use-turn-changes';
import '../styles/review.css';

export type TurnReviewRequest = PanelRequest & { onRevealTool?: (toolId: string) => void };
export interface TurnChangesProps { sourceContext?: SessionResourceContext; onOpenChanges?: (request: TurnReviewRequest) => void }

export function TurnChanges({ query, enabled, active, cwd, onOpenChanges, onRevealTool }: TurnChangesProps & { query?: TurnChangeQuery; enabled: boolean; active: boolean; cwd: string; onRevealTool: (toolId: string) => void }) {
  const { t } = useTranslation();
  const disclosure = useAutomaticDisclosure(false, 'changes');
  const id = useId(), objects = useFileObject(cwd);
  const { result, error } = useTurnChanges(query, undefined, active, enabled);
  const files = result?.files ?? [];
  const fileList = useRef<HTMLUListElement>(null);
  useFlipList(fileList, files.map(file => file.path));
  if (!query || active || (!files.length && !error && (!result || result.state === 'collecting' || result.state === 'complete'))) return null;
  const exact = files.filter(file => file.countsKnown);
  const added = exact.reduce((sum, file) => sum + file.added, 0), removed = exact.reduce((sum, file) => sum + file.removed, 0);
  const open = (path?: string) => onOpenChanges?.({ kind: 'changes', path, turnChanges: result, turnChangeQuery: query, context: query.context, onRevealTool });
  if (!files.length) return onOpenChanges ? <div className="turn-changes turn-changes-undetermined"><button type="button" className="turn-changes-review" onClick={() => open()}>{t('review.undetermined')}<IconArrowRight size="var(--icon-meta)" aria-hidden /></button></div> : null;
  const incomplete = !!error || result?.state !== 'complete';
  return <section className={`turn-changes${disclosure.open ? ' open' : ''}`} aria-label={t('omp.changes.title')}>
    <div className="turn-changes-header">
      <button type="button" ref={disclosure.titleRef} className="turn-changes-toggle" aria-expanded={disclosure.open} aria-controls={id} onClick={disclosure.toggle}>
        <IconFilePen size="var(--icon-meta)" aria-hidden /><span>{t('omp.changes.title')}</span><span className="turn-changes-count">· {t(incomplete ? 'review.knownFiles' : 'omp.changes.files', { count: files.length })}</span><span className="turn-changes-stats">{exact.length > 0 && <><span className="turn-changes-added">+{added}</span><span className="turn-changes-removed">−{removed}</span></>}{exact.length !== files.length && <span>{t('review.partialTotal')}</span>}</span><IconChevronRight size="var(--icon-caption)" className="timeline-caret" aria-hidden />
      </button>
      {onOpenChanges && result && <button type="button" className="turn-changes-review" onClick={() => open()}>{t('omp.changes.review')}<IconArrowRight size="var(--icon-meta)" aria-hidden /></button>}
    </div>
    {incomplete && <p className="turn-changes-note" role="status">{t(error ? 'review.loadFailed' : result?.state === 'collecting' ? 'review.collecting' : 'review.partialCoverage')}</p>}
    <Collapse open={disclosure.open} bodyRef={disclosure.bodyRef} id={id} {...disclosure.bodyEvents}><DisclosureScope disclosure={disclosure}>
      <ul ref={fileList} className="turn-changes-files">{files.map(file => {
        const Icon = file.op === 'create' ? IconFilePlus : file.op === 'delete' ? IconTrash : file.op === 'move' ? IconArrowRight : IconFilePen;
        const target = formatFileTarget({ path: file.path, line: file.firstChangedLine });
        const relative = reviewRelativePath(cwd, file.path);
        const slash = relative.lastIndexOf('/'), directory = relative.slice(0, slash + 1), middle = Math.ceil(directory.length / 2);
        return <li key={file.path} data-flip-key={file.path} className="turn-changes-file" {...objects.dragProps(file.path)} onContextMenu={event => objects.contextMenu(target, event)} onKeyDown={event => {
          if (file.op === 'delete') return;
          if (event.key === ' ' && event.target === event.currentTarget.querySelector('.turn-changes-path')) { event.preventDefault(); objects.quickLook(file.path); }
          else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); objects.openInEditor(target); }
        }}>
          <button type="button" className="turn-changes-path" title={file.sourcePath ? `${file.sourcePath} → ${file.path}` : file.path} onClick={() => open(file.path)}><Icon size="var(--icon-meta)" aria-label={t(`omp.changes.${file.op}`)} /><span className="change-file-identity"><span className="change-file-name">{relative.slice(slash + 1)}</span>{directory && <span className="change-file-directory"><span>{directory.slice(0, middle)}</span><span><bdi>{directory.slice(middle)}</bdi></span></span>}{file.sourcePath && <span className="turn-changes-source">← {reviewRelativePath(cwd, file.sourcePath)}</span>}</span></button>
          <span className="turn-changes-stats">{file.countsKnown ? <><span className="turn-changes-added">+<AnimatedNumber value={file.added} /></span><span className="turn-changes-removed">−<AnimatedNumber value={file.removed} /></span></> : <span>{t(file.content === 'binary' ? 'review.binary' : 'review.contentGap')}</span>}</span>
          <button type="button" disabled={file.op === 'delete'} className="turn-changes-actions" aria-label={t('omp.changes.actions', { path: file.path })} onClick={event => objects.contextMenu(target, event)}><IconMore size="var(--icon-ui)" /></button>
        </li>;
      })}</ul>
    </DisclosureScope></Collapse>
  </section>;
}

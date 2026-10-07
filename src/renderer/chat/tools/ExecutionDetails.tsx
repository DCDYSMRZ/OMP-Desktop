import { useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeView } from '../../ui/CodeView';
import { object, string, list, resultText, stripAnsi, splitOutputTail, stripExecutionNotices, describeTool } from './tool-model';
import { formatElapsed } from '../../lib/format-duration';
import { useDisplayPreferences } from '../../lib/display-preferences';
import { BoundedCode, DetailFold, Literal, ResultImages, StatusIcon, ErrorBlock } from './detail-primitives';
import type { DetailProps } from './FileDetails';
import { DisclosureAnchor, DisclosureScope, useAutomaticDisclosure } from '../disclosure';

function CommandSource({ command, identity }: { command: string; identity: string }) {
  const { t } = useTranslation(), disclosure = useAutomaticDisclosure(false, identity);
  const anchor = useContext(DisclosureAnchor), id = useId(), preview = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const lines = preview.current?.querySelector<HTMLElement>('.code-view-lines');
    if (!lines) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(lines).lineHeight);
      if (lineHeight && lines.getClientRects().length) setClipped(lines.scrollHeight > lineHeight * 3 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(lines);
    return () => observer.disconnect();
  }, [command]);
  return <DisclosureScope disclosure={disclosure}><div className="tool-command-source" ref={disclosure.bodyRef} {...disclosure.bodyEvents}><div id={id} ref={preview} className={`tool-command-preview${disclosure.open ? '' : ' is-clamped'}`}><CodeView code={`$ ${command}`} lang="bash" gutter={false} wrap /></div>{clipped && <button type="button" className="tool-detail-toggle" ref={disclosure.titleRef} aria-expanded={disclosure.open} aria-controls={id} onClick={() => { anchor(disclosure.titleRef.current); disclosure.toggle(); }}>{t(disclosure.open ? 'tools.collapseCommand' : 'tools.expandCommand')}</button>}</div></DisclosureScope>;
}

export function CommandDetails({ tool }: DetailProps) {
  const { t, i18n } = useTranslation(), args = object(tool.args), details = object(object(tool.result).details);
  const { durationStyle } = useDisplayPreferences();
  const output = stripExecutionNotices(resultText(tool.result) || resultText(tool.stream), { durationMs: details.wallTimeMs, exitCode: details.exitCode });
  const tail = splitOutputTail(output);
  return <div className="tool-terminal"><CommandSource command={string(args.command)} identity={`command-source:${tool.id}`} />{string(args.cwd) && <p className="tool-note">{string(args.cwd)}</p>}<Literal>{tail.text}</Literal>{tail.hiddenLines > 0 && <DetailFold identity={`command-output:${tool.id}`} title={t('tools.showAllLines', { count: tail.totalLines })}><Literal>{output}</Literal></DetailFold>}<div className="tool-execution-meta">{details.exitCode === 0 && <span>{t('tools.chip.exit', { value: 0 })}</span>}{details.timedOut === true && <span>{t('tools.timedOut')}</span>}{string(object(details.async).state) && <span>{t(`tools.status.${string(object(details.async).state)}`, { defaultValue: string(object(details.async).state) })}</span>}{typeof details.wallTimeMs === 'number' && details.wallTimeMs < 1000 && <span>{formatElapsed(details.wallTimeMs, durationStyle, i18n.language)}</span>}</div></div>;
}
export function EvalDetails({ tool, onOpenSessionResource }: DetailProps) {
  const { t, i18n } = useTranslation(), args = object(tool.args), details = object(object(tool.result).details);
  const { durationStyle } = useDisplayPreferences();
  const cells = list(details.cells), summary = describeTool(tool), multiple = cells.length > 1;
  return <>{(cells.length ? cells : [{ ...args, output: resultText(tool.result) || resultText(tool.stream), status: tool.status }]).map((value, index) => {
    const cell = object(value), output = stripExecutionNotices(string(cell.output) || resultText(cell.output), { durationMs: cell.durationMs, exitCode: cell.exitCode });
    const showTitle = multiple || (!!string(cell.title) && string(cell.title) !== summary.target);
    const showDuration = typeof cell.durationMs === 'number' && (multiple || !summary.chips.some(chip => chip.kind === 'duration' && chip.value === cell.durationMs));
    const showExit = typeof cell.exitCode === 'number' && cell.exitCode !== 0 && (multiple || !summary.chips.some(chip => chip.kind === 'exit' && chip.value === cell.exitCode));
    return <section className="tool-file-section" key={index}>{(showTitle || showDuration || showExit || multiple) && <div className="tool-detail-heading">{multiple && <StatusIcon status={string(cell.status)} />}{showTitle && <strong>{string(cell.title) || t('tools.cell', { index: index + 1 })}</strong>}{multiple && <span>{t(`tools.status.${string(cell.status)}`, { defaultValue: string(cell.status) })}</span>}{showDuration && <span>{formatElapsed(cell.durationMs as number, durationStyle, i18n.language)}</span>}{showExit && <span className="tool-removed">{t('tools.chip.exit', { value: cell.exitCode })}</span>}</div>}<BoundedCode code={string(cell.code)} lang={string(cell.language) === 'py' ? 'python' : string(cell.language)} limit={10} identity={`eval-code:${tool.id}:${index}`} /><Literal>{output}</Literal><ResultImages result={cell} onOpenSessionResource={onOpenSessionResource} /></section>;
  })}</>;
}
export function WaitDetails({ tool }: DetailProps) {
  const { t, i18n } = useTranslation(), details = object(object(tool.result).details), jobs = list(details.jobs);
  const { durationStyle } = useDisplayPreferences();
  return <>{jobs.length ? jobs.map((value, index) => {
    const job = object(value), status = string(job.status);
    const output = stripAnsi(string(job.resultText)).replace(/<\/?task-result\b[^>]*>/g, '').trim();
    return <section className="tool-job" key={string(job.id) || index}><div className={`tool-detail-heading status-${status}`}><StatusIcon status={status} /><strong>{string(job.label) || string(job.id)}</strong><span>{string(job.type)}</span><span>{t(`tools.status.${status}`, { defaultValue: status })}</span>{typeof job.durationMs === 'number' && <span>{formatElapsed(job.durationMs, durationStyle, i18n.language)}</span>}</div>{string(job.errorText) && <ErrorBlock text={string(job.errorText)} />}{output && <DetailFold identity={`job:${tool.id}:${string(job.id) || index}`} title={t('tools.result')}><Literal>{output}</Literal></DetailFold>}</section>;
  }) : <Literal>{resultText(tool.result)}</Literal>}</>;
}

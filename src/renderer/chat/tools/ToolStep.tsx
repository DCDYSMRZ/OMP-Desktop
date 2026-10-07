import { Fragment, useContext, useId, useRef, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapse } from '../../ui/Collapse';
import { HighlightedCode, useCopy } from '../../ui/Markdown';
import { IconFileText, IconFilePen, IconFilePlus, IconSquareTerminal, IconCode, IconSearch, IconFolderSearch, IconGlobe, IconUsers, IconHourglass, IconListTodo, IconCircleAlert, IconSend, IconWrench, IconBraces, IconCopy, IconCheck, IconChevronRight, IconCircleX, IconCircleSlash, IconExternal } from '../../ui/icons';
import { DisclosureAnchor, DisclosureScope, useAutomaticDisclosure } from '../disclosure';
import type { ToolActivity, ChatMessage } from '../model';
import type { BodyProps } from '../body-props';
import { describeTool, semanticToolLabel, object, string, resultText, readDisplay, stripAnsi, splitOutputTail, type ToolChip, type ToolFamily } from './tool-model';
import { nativeHarnessNotice } from '../../../shared/native-harness-notice';
import { formatElapsed } from '../../lib/format-duration';
import { useDisplayPreferences } from '../../lib/display-preferences';
import { Swap } from '../../ui/motion';
import { ReadDetails, EditDetails, WriteDetails, SearchDetails, FindDetails } from './FileDetails';
import { CommandDetails, EvalDetails, WaitDetails } from './ExecutionDetails';
import { MessageDetails, WebDetails, TodoDetails, AskDetails } from './StructuredDetails';
import { FileLink, Literal, ErrorBlock, ResultImages } from './detail-primitives';
import '../../styles/tools.css';

const familyIcons = { read: IconFileText, edit: IconFilePen, write: IconFilePlus, command: IconSquareTerminal, eval: IconCode, search: IconSearch, find: IconFolderSearch, web: IconGlobe, task: IconUsers, wait: IconHourglass, todo: IconListTodo, ask: IconCircleAlert, message: IconSend, lsp: IconCode, browser: IconGlobe, computer: IconSquareTerminal, other: IconWrench };
const detailViews = { read: ReadDetails, edit: EditDetails, write: WriteDetails, command: CommandDetails, eval: EvalDetails, search: SearchDetails, find: FindDetails, web: WebDetails, wait: WaitDetails, todo: TodoDetails, ask: AskDetails, message: MessageDetails };
type Props = BodyProps & { tool: ToolActivity; resultRow?: ChatMessage };

function Chips({ chips }: { chips: ToolChip[] }) {
  const { t, i18n } = useTranslation();
  const { durationStyle } = useDisplayPreferences();
  return <span className="tool-chips">{chips.map((chip, index) => <Fragment key={`${chip.kind}:${index}`}>{index > 0 && <span className="tool-chip-separator" aria-hidden>·</span>}<span className={`tool-chip${chip.tone ? ` tone-${chip.tone}` : ''}`}>{chip.kind === 'duration' ? formatElapsed(Number(chip.value), durationStyle, i18n.language) : chip.kind === 'outcome' ? t(`tools.outcome.${chip.value}`, { defaultValue: String(chip.value) }) : chip.kind === 'jobs' ? t(chip.tone === 'error' ? 'tools.jobsFailed' : 'tools.jobsCompleted', { value: chip.value, count: Number(chip.value) }) : t(`tools.chip.${chip.kind}`, { value: chip.value, count: Number.isFinite(Number(chip.value)) ? Number(chip.value) : undefined })}</span></Fragment>)}</span>;
}
export function ToolRawDetails({ tool, resultRow, onOpenSessionResource }: Props): JSX.Element {
  const { t } = useTranslation(), result = object(tool.result);
  return <div className="tool-raw-details">{tool.args !== undefined && <section><h4>{t('tools.arguments')}</h4><pre className="tool-literal"><HighlightedCode code={JSON.stringify(tool.args, null, 2)} lang="json" /></pre></section>}<section><h4>{t('tools.result')}</h4><Literal>{resultText(tool.result)}</Literal></section>{result.details !== undefined && <section><h4>{t('tools.details')}</h4><pre className="tool-literal"><HighlightedCode code={JSON.stringify(result.details, null, 2)} lang="json" /></pre></section>}{tool.stream !== undefined && <section><h4>{t('tools.stream')}</h4><pre className="tool-literal"><HighlightedCode code={JSON.stringify(tool.stream, null, 2)} lang="json" /></pre></section>}{resultRow?.resourceReference && onOpenSessionResource && <button type="button" className="tool-detail-toggle" onClick={() => onOpenSessionResource(resultRow.resourceReference!)}><IconExternal size="var(--icon-meta)" />{t('tools.fullOutput')}</button>}</div>;
}
function TypedDetail({ family, ...props }: Props & { family: ToolFamily }) {
  const { t } = useTranslation(), result = object(props.tool.result), details = object(result.details);
  const deferred = result.historyResourceDeferred === true;
  const View = family in detailViews ? detailViews[family as keyof typeof detailViews] : undefined;
  const literal = stripAnsi(resultText(props.tool.result) || resultText(object(details.xdev).inner) || resultText(props.tool.stream));
  const notice = nativeHarnessNotice(props.tool.result);
  if (notice) return <Literal>{notice.text}</Literal>;
  const visual = family === 'browser' || family === 'computer', args = object(props.tool.args);
  if (props.tool.name.split(/[/.]/).at(-1) === 'goal') {
    const goal = object(details.goal), state = string(goal.status) || string(details.status);
    const title = string(goal.objective) || string(args.objective) || string(args.goal);
    const progress = goal.progress ?? details.progress;
    return <section className="tool-goal"><p>{title}</p>{state && <p className="tool-note">{t(`omp.timeline.goal.${state}`, { defaultValue: t('omp.timeline.goalRecorded') })}</p>}{typeof progress === 'number' && <p className="tool-note">{t('omp.timeline.goalProgress', { value: progress })}</p>}</section>;
  }
  return <>{deferred ? <div className="tool-deferred"><span>{t('tools.deferred')}</span>{props.resultRow?.resourceReference && props.onOpenSessionResource && <button type="button" onClick={() => props.onOpenSessionResource!(props.resultRow!.resourceReference!)}>{t('tools.fullOutput')}</button>}</div> : <>
    {visual && <div className="tool-detail-heading"><strong>{string(args.action)}</strong><span>{string(args.name) || string(details.name)}</span><span>{string(details.url) || string(args.url)}</span></div>}
    {visual && <ResultImages result={props.tool.result} onOpenSessionResource={props.onOpenSessionResource} />}
    {View ? <View {...props} /> : <>{!visual && <p className="tool-note">{string(args.action) || string(object(object(details.xdev).args).action)}</p>}<Literal>{literal}</Literal></>}
    {!visual && <ResultImages result={props.tool.result} onOpenSessionResource={props.onOpenSessionResource} />}
  </>}
  {props.tool.status === 'error' && !literal.trim() && <ErrorBlock text={t('tools.status.error')} />}</>;
}
export function ToolStep({ tool, resultRow, autoOpen = false, live = false, ...body }: Props & { autoOpen?: boolean; live?: boolean }): JSX.Element {
  const { t } = useTranslation(), summary = describeTool(tool), Icon = familyIcons[summary.family];
  const skipped = !!nativeHarnessNotice(tool.result);
  const status = skipped ? 'skipped' : tool.status;
  const semantic = semanticToolLabel(tool, t);
  const verb = t(summary.verbKey);
  const target = summary.target || `· ${t(tool.status === 'pending' ? 'tools.argumentsPending' : tool.args === undefined ? 'tools.argumentsUnloaded' : 'tools.argumentsMissing')}`;
  const chips = semantic ? summary.chips.filter(chip => !['outcome', 'jobs', 'todo', 'lines'].includes(chip.kind)) : summary.chips;
  const observedLive = useRef(live);
  if (live) observedLive.current = true;
  const disclosure = useAutomaticDisclosure(autoOpen || (!skipped && (tool.status === 'error' || tool.status === 'interrupted')), `tool:${tool.id}`);
  const raw = useAutomaticDisclosure(false, `tool-raw:${tool.id}`), anchor = useContext(DisclosureAnchor), id = useId(), rawId = useId(), copy = useCopy();
  const running = tool.status === 'running' || tool.status === 'pending';
  const weak = !semantic && !summary.target;
  const stream = object(tool.stream);
  const liveText = live && running && (summary.family === 'command' || summary.family === 'eval') ? splitOutputTail(resultText(tool.stream) || string(stream.delta) || resultText(tool.result), 4).text : '';
  const output = summary.family === 'read' ? readDisplay(tool.result).text : stripAnsi(resultText(tool.result) || resultText(tool.stream));
  return <div className={`tool-step family-${summary.family} status-${status}${disclosure.open ? ' is-open' : ''}`}><div className="tool-step-row">
    <button type="button" ref={disclosure.titleRef} className="tool-step-hit" title={semantic || summary.targetTitle || summary.intent} aria-label={semantic || `${verb} ${target || summary.intent || ''}`} aria-expanded={disclosure.open} aria-controls={id} onClick={() => { anchor(disclosure.titleRef.current); disclosure.toggle(); }} />
    <Icon size="var(--icon-meta)" className="tool-step-icon" />{semantic ? <span className={`tool-step-summary${live && running ? ' ui-shimmer' : ''}`} title={semantic}>{semantic}</span> : <><span className={`tool-step-verb${live && running ? ' ui-shimmer' : ''}`}>{verb}</span>
    {target && (summary.file ? <FileLink file={summary.file} onOpenFile={body.onOpenFile}>{target}</FileLink> : <span className="tool-step-target" title={summary.targetTitle || target}>{target}</span>)}
    {weak && summary.intent && <span className="tool-step-intent" title={summary.intent}>{summary.intent}</span>}</>}
    <Chips chips={skipped ? chips.filter(chip => !chip.tone) : chips} />{skipped && <span className="tool-step-skipped">{t('tools.status.skipped')}</span>}<span className="tool-step-status" title={t(`tools.status.${status}`)}><Swap swapKey={status} animate={observedLive.current}>{skipped ? <IconCircleSlash size="var(--icon-meta)" aria-label={t('tools.status.skipped')} /> : running ? <span className="ui-spinner" aria-label={t(`tools.status.${tool.status}`)} /> : tool.status === 'error' ? <IconCircleX size="var(--icon-meta)" aria-label={t('tools.status.error')} /> : tool.status === 'interrupted' ? <IconCircleSlash size="var(--icon-meta)" aria-label={t('tools.status.interrupted')} /> : <IconCheck size="var(--icon-meta)" aria-label={t('tools.status.complete')} />}</Swap></span><IconChevronRight size="var(--icon-meta)" className="tool-step-caret" />
  </div>{liveText && <pre className="tool-live-tail">{liveText}</pre>}
  <DisclosureScope disclosure={disclosure}><Collapse id={id} open={disclosure.open} bodyRef={disclosure.bodyRef} {...disclosure.bodyEvents}><div className="tool-detail"><div className="tool-detail-toolbar"><button type="button" className="tool-icon-button" title={t(copy.copied ? 'tools.copied' : 'tools.copy')} aria-label={t(copy.copied ? 'tools.copied' : 'tools.copy')} onClick={() => copy.copy(output)}>{copy.copied ? <IconCheck size="var(--icon-meta)" /> : <IconCopy size="var(--icon-meta)" />}</button><button type="button" ref={raw.titleRef} className="tool-toolbar-button" aria-expanded={raw.open} aria-controls={rawId} onClick={() => { anchor(raw.titleRef.current); raw.toggle(); }}><IconBraces size="var(--icon-meta)" />{t('tools.raw')}</button>{resultRow?.resourceReference && body.onOpenSessionResource && <button type="button" className="tool-toolbar-button" onClick={() => body.onOpenSessionResource!(resultRow.resourceReference!)}><IconExternal size="var(--icon-meta)" />{t('tools.fullOutput')}</button>}</div>
    <TypedDetail family={summary.family} tool={tool} resultRow={resultRow} {...body} />{copy.error && <ErrorBlock text={copy.error} />}<DisclosureScope disclosure={raw}><Collapse id={rawId} open={raw.open} bodyRef={raw.bodyRef} {...raw.bodyEvents}><ToolRawDetails tool={tool} resultRow={resultRow} {...body} /></Collapse></DisclosureScope>
  </div></Collapse></DisclosureScope></div>;
}

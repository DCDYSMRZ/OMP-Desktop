import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeState } from '../../shared/contracts';
import { nativeExecutionActive } from '../chat/model';
import { DisclosureScope, useAutomaticDisclosure } from '../chat/disclosure';
import { Collapse } from '../ui/Collapse';
import { useCopy } from '../ui/Markdown';
import { IconChevronRight, IconCopy, IconInfo } from '../ui/icons';
import { Button, Select, TooltipButton } from '../ui/ui';
import { deriveInspectorSummary, type InspectorSummary } from './inspector-model';
import './session-inspector.css';
import { UserFacingError, preserveUserError } from '../lib/user-errors';
import { UserErrorNotice } from '../lib/UserErrorNotice';
import { formatCurrency } from '../lib/format-cost';

/** Exact admitted native operations; no prompt synthesis or renderer-selected export path. */
export type SessionInspectorCommand =
  | { type: 'get_state' | 'get_session_stats' | 'abort_retry' | 'export_html' }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'set_fast_mode' | 'set_auto_compaction' | 'set_auto_retry'; enabled: boolean }
  | { type: 'set_steering_mode' | 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_interrupt_mode'; mode: 'immediate' | 'wait' };

export interface SessionInspectorProps {
  runtimeId: string | null;
  state: NativeState | null;
  connected: boolean;
  canMutate: boolean;
  accessReason?: string;
  /** Capture the selected runtime and use RuntimeStore.command, including its native refresh. */
  onCommand: (command: SessionInspectorCommand) => Promise<unknown>;
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;

export function SessionInspector(props: SessionInspectorProps) {
  return <Inspector key={JSON.stringify([props.runtimeId, props.state?.sessionId])} {...props} />;
}

function Inspector({ runtimeId, state, connected, canMutate, accessReason, onCommand }: SessionInspectorProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const unknown = t('omp.inspector.notReported');
  const format = (value: unknown, digits = 0) => {
    const valid = number(value);
    return valid === undefined ? unknown : valid.toLocaleString(locale, { maximumFractionDigits: digits });
  };
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<Error | string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [stats, setStats] = useState<{ data: RecordValue; at: Date } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const live = Boolean(runtimeId && state && connected);
  const editable = live && canMutate && !pending;
  useEffect(() => { if (live) void run({ type: 'get_session_stats' }); }, [live, state?.isSettled]);

  async function run(command: SessionInspectorCommand) {
    const readOnly = command.type === 'get_state' || command.type === 'get_session_stats';
    if (!live || busy.current || (!readOnly && !canMutate)) return;
    busy.current = true;
    setPending(command.type); setError(null); setReceipt(null);
    if (command.type === 'export_html') setExportPath(null);
    try {
      const result = object(await onCommand(command));
      if (!mounted.current) return;
      if (command.type === 'get_session_stats') {
        if (result.sessionId !== state?.sessionId) throw new UserFacingError(t('omp.inspector.statisticsDoNotBelongToThisSession'));
        setStats({ data: result, at: new Date() });
      } else if (command.type === 'export_html') {
        if (result.cancelled === true) setReceipt(t('omp.inspector.exportCancelledNoExportWasRequested'));
        else {
          const path = string(result.path);
          if (!path) throw new UserFacingError(t('omp.inspector.nativeExportReturnedNoOutputPath'));
          setExportPath(path);
          setReceipt(t('omp.inspector.hTMLExportedToThePathBelow'));
        }
      } else if (command.type === 'set_auto_retry') {
        setReceipt(command.enabled ? t('omp.inspector.nativeAcceptedEnableAutomaticRetryCurrentRetryStateIs') : t('omp.inspector.nativeAcceptedDisableAutomaticRetryCurrentRetryStateIs'));
      } else if (command.type === 'abort_retry') {
        setReceipt(t('omp.inspector.nativeRetryCancellationRequestedThisDoesNotDisconnectThe'));
      } else if (command.type === 'compact') {
        setReceipt(t('omp.inspector.nativeCompactionCompletedContextIsRefreshedDurableHistoryRemains'));
      } else setReceipt(t('omp.inspector.nativeStateRefreshed'));
    } catch (cause) {
      if (mounted.current) setError(preserveUserError(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const summary = deriveInspectorSummary(state, live);
  if (state?.model?.reasoning === false) summary.generation.thinking = t('omp.inspector.thinkingUnsupported');
  else if (summary.generation.thinking) summary.generation.thinking = t(`composer.thinking.${summary.generation.thinking}`, { defaultValue: summary.generation.thinking });
  if (!summary.context.window) { summary.context.percent = undefined; summary.context.ringPercent = undefined; }
  const phases = Array.isArray(state?.todoPhases) ? state.todoPhases : null;
  const statsData = stats?.data;
  const tokens = object(statsData?.tokens);
  const autoCompaction = summary.context.autoCompaction === undefined ? unknown : summary.context.autoCompaction ? t('omp.inspector.enabled') : t('omp.inspector.disabled');
  if (!state || !runtimeId) return <div className="session-inspector session-inspector-empty"><h2>{t('omp.inspector.session')}</h2><SummaryTiles summary={summary} /><p>{t('omp.inspector.savedHistoryIsAvailableInTheConversationLiveContext')}</p></div>;
  const canCompact = editable && !nativeExecutionActive(state) && state.isCompacting === false;
  const numericRow = (label: string, value: unknown, digits = 0) => <Row label={label}>{format(value, digits)}</Row>;
  const policy = (label: string, value: unknown, type: 'set_steering_mode' | 'set_follow_up_mode' | 'set_interrupt_mode') => {
    const interrupt = type === 'set_interrupt_mode';
    const valid = interrupt ? value === 'immediate' || value === 'wait' : value === 'all' || value === 'one-at-a-time';
    return <label className="session-inspector-control"><span>{label}</span><Select aria-label={label} value={valid ? String(value) : ''} disabled={!editable} onChange={event => {
      const mode = event.currentTarget.value;
      if (type === 'set_interrupt_mode' && (mode === 'immediate' || mode === 'wait')) void run({ type, mode });
      else if (type !== 'set_interrupt_mode' && (mode === 'all' || mode === 'one-at-a-time')) void run({ type, mode });
    }}><option value="" disabled>{unknown}</option>{interrupt ? <><option value="immediate">{t('omp.inspector.immediate')}</option><option value="wait">{t('omp.inspector.wait')}</option></> : <><option value="one-at-a-time">{t('omp.inspector.oneAtATime')}</option><option value="all">{t('omp.inspector.allQueued')}</option></>}</Select></label>;
  };
  const toggle = (label: string, value: unknown, type: 'set_fast_mode' | 'set_auto_compaction') => <label className="session-inspector-control"><span>{label}</span><Select aria-label={label} value={typeof value === 'boolean' ? String(value) : ''} disabled={!editable} onChange={event => void run({ type, enabled: event.currentTarget.value === 'true' })}><option value="" disabled>{unknown}</option><option value="true">{t('omp.inspector.enabled')}</option><option value="false">{t('omp.inspector.disabled')}</option></Select></label>;

  return <div className="session-inspector">
    <header className="session-inspector-heading"><h2>{t('omp.inspector.session')}</h2><Button size="sm" variant="ghost" disabled={!live || !!pending} onClick={() => void run({ type: 'get_state' })}>{t('omp.inspector.refresh')}</Button></header>
    <Section title={t('omp.inspector.identity')} identity="identity" defaultOpen>
      <dl><Row label={t('omp.inspector.model')}>{state.model ? `${state.model.name || state.model.id} · ${state.model.provider}` : unknown}</Row></dl>
      <details><summary>{t('omp.inspector.details')}</summary><CopyValue label={t('omp.inspector.nativeSession')} value={state.sessionId} /><CopyValue label={t('omp.inspector.runtime')} value={runtimeId} />{state.sessionFile && <CopyValue label={t('omp.inspector.journal')} value={state.sessionFile} />}<dl><Row label={t('omp.inspector.thinking')}>{summary.generation.thinking || unknown}</Row>{numericRow(t('omp.inspector.estimatedTokens'), summary.context.tokens)}{numericRow(t('omp.inspector.contextWindow'), summary.context.window)}<Row label={t('omp.inspector.automaticCompaction')}>{autoCompaction}</Row></dl></details>
    </Section>
    <SummaryTiles summary={summary} />
    <section className="session-inspector-spend"><span>{t('omp.inspector.spend')}</span><strong>{number(statsData?.cost) === undefined ? unknown : formatCurrency(number(statsData?.cost)!, locale)}</strong></section>
    {!live && <p className="session-inspector-note">{t('omp.inspector.lastObserved')}</p>}
    {!canMutate && <p className="session-inspector-note">{accessReason || t('omp.inspector.readOnlyNativeChangesRequireCurrentOwnershipPermission')}</p>}
    <div className="session-inspector-feedback" role="status">{pending ? t('omp.inspector.waitingForNativeOperation') : receipt}{exportPath && <code>{exportPath}</code>}</div>
    {error && <UserErrorNotice error={error} />}

    <Section title={t('omp.inspector.statistics')} identity="statistics" help={t('omp.inspector.statisticsHelp')}>
      <div className="session-inspector-actions"><Button size="sm" disabled={!live || !!pending} onClick={() => void run({ type: 'get_session_stats' })}>{stats ? t('omp.inspector.refreshStatistics') : t('omp.inspector.readStatistics')}</Button></div>
      {stats ? <><p className="session-inspector-note">{t('omp.inspector.snapshotReadAt')}{stats.at.toLocaleTimeString(locale)}{t('omp.inspector.refreshToUpdate')}</p><dl>{numericRow(t('omp.inspector.contextMessages'), statsData?.totalMessages)}{numericRow(t('omp.inspector.userMessages'), statsData?.userMessages)}{numericRow(t('omp.inspector.assistantMessages'), statsData?.assistantMessages)}{numericRow(t('omp.inspector.toolCalls'), statsData?.toolCalls)}{numericRow(t('omp.inspector.toolResults'), statsData?.toolResults)}{numericRow(t('omp.inspector.reportedInputTokens'), tokens.input)}{numericRow(t('omp.inspector.reportedOutputTokens'), tokens.output)}{numericRow(t('omp.inspector.reasoningTokens'), tokens.reasoning)}{numericRow(t('omp.inspector.cacheReadTokens'), tokens.cacheRead)}{numericRow(t('omp.inspector.cacheWriteTokens'), tokens.cacheWrite)}{numericRow(t('omp.inspector.reportedTokenTotal'), tokens.total)}{numericRow(t('omp.inspector.reportedCostUSD'), statsData?.cost, 6)}{numericRow(t('omp.inspector.premiumRequests'), statsData?.premiumRequests)}{statsData?.credits !== undefined && <>{numericRow(t('omp.inspector.creditCost'), object(statsData.credits).cost, 4)}{numericRow(t('omp.inspector.committedCreditCost'), object(statsData.credits).committedCost, 4)}{numericRow(t('omp.inspector.aCUCost'), object(statsData.credits).acuCost, 4)}</>}</dl>{statsData?.routedModels !== undefined && <details><summary>{t('omp.inspector.providerRoutedModels')}</summary><dl>{Object.entries(object(statsData.routedModels)).map(([model, count]) => <Row key={model} label={model}>{format(count)}</Row>)}</dl></details>}</> : <p className="session-inspector-note">{t('omp.inspector.statisticsHaveNotBeenRequested')}</p>}
    </Section>
    <Section title={t('omp.inspector.queueInterruption')} identity="controls" help={t('omp.inspector.theseArePoliciesForThisNativeSessionNotThe')}>
      <dl>{numericRow(t('omp.inspector.queuedMessages'), state.queuedMessageCount)}<Row label={t('omp.inspector.backgroundWork')}>{typeof state.hasPendingAsyncWork === 'boolean' ? state.hasPendingAsyncWork ? t('omp.inspector.pending2') : t('omp.inspector.nonePending') : unknown}</Row></dl>
      {policy(t('omp.inspector.steeringDelivery'), state.steeringMode, 'set_steering_mode')}
      {policy(t('omp.inspector.followUpDelivery'), state.followUpMode, 'set_follow_up_mode')}
      {policy(t('omp.inspector.interruption'), state.interruptMode, 'set_interrupt_mode')}
      {toggle(t('omp.inspector.automaticCompaction'), state.autoCompactionEnabled, 'set_auto_compaction')}
      {toggle(t('omp.inspector.fastModeEnabled'), state.fastModeEnabled, 'set_fast_mode')}
      <dl><Row label={t('omp.inspector.fastModeActive')}>{typeof state.fastModeActive === 'boolean' ? state.fastModeActive ? t('omp.inspector.active') : t('omp.inspector.notActive') : unknown}</Row></dl>
      <div className="session-inspector-actions"><Button size="sm" disabled={!canCompact} onClick={() => void run({ type: 'compact' })}>{t('omp.inspector.compactContext')}</Button><Help label={`${t('omp.inspector.manualCompactionIsAvailableWhenTheNativeSessionIs')} ${t('omp.inspector.retryAndAutomaticCompactionChangesApplyToThisSession')}`} /></div>
    </Section>

    <Section title={t('omp.inspector.recovery')} identity="recovery" help={`${t('omp.inspector.theNativeProtocolDoesNotReportWhetherARetry')} ${t('omp.inspector.retryAndAutomaticCompactionChangesApplyToThisSession')}`}>
      <p className="session-inspector-note">{t('omp.inspector.retryNotReported')}</p>
      <div className="session-inspector-actions"><Button size="sm" disabled={!editable} onClick={() => void run({ type: 'set_auto_retry', enabled: true })}>{t('omp.inspector.enableRetry')}</Button><Button size="sm" disabled={!editable} onClick={() => void run({ type: 'set_auto_retry', enabled: false })}>{t('omp.inspector.disableRetry')}</Button><Button size="sm" variant="ghost" disabled={!editable} onClick={() => void run({ type: 'abort_retry' })}>{t('omp.inspector.cancelWaitingRetry')}</Button></div>
    </Section>

    <Section title={t('omp.inspector.nativeTodoPhases')} identity="tasks">
      {phases === null ? <p className="session-inspector-note">{unknown}</p> : phases.length === 0 ? <p className="session-inspector-note">{t('omp.inspector.noNativeTodoPhases')}</p> : phases.map((item, phaseIndex) => {
        const phase = object(item);
        const tasks = Array.isArray(phase.tasks) ? phase.tasks : null;
        return <div className="session-inspector-phase" key={phaseIndex}><h4>{string(phase.name) || unknown}</h4>{tasks === null ? <p>{unknown}</p> : tasks.length === 0 ? <p className="session-inspector-note">{t('omp.inspector.noTasksInThisPhase')}</p> : <ul>{tasks.map((item, taskIndex) => {
          const task = object(item);
          const status = string(task.status);
          const statusLabel = status === 'pending' ? t('omp.inspector.pending') : status === 'in_progress' ? t('omp.inspector.inProgress') : status === 'completed' ? t('omp.inspector.completed') : status === 'abandoned' ? t('omp.inspector.abandoned') : status === 'blocked' ? t('omp.inspector.blocked') : status || unknown;
          const notes = Array.isArray(task.notes) ? task.notes.filter((note): note is string => typeof note === 'string') : [];
          return <li key={taskIndex}><span className="session-inspector-task-status" data-status={status}>{statusLabel}</span><div>{string(task.content) || unknown}{string(task.blocker) && <p className="session-inspector-blocker">{t('omp.inspector.waitingFor')}{string(task.blocker)}</p>}{(string(task.details) || notes.length > 0) && <details><summary>{t('omp.inspector.details')}</summary>{string(task.details) && <p>{string(task.details)}</p>}{notes.map((note, index) => <p key={index}>{note}</p>)}</details>}</div></li>;
        })}</ul>}</div>;
      })}
    </Section>

    <Section title={t('omp.inspector.export')} identity="export" help={t('omp.inspector.exportHelp')}>
      <Button size="sm" disabled={!editable} onClick={() => void run({ type: 'export_html' })}>{t('omp.inspector.exportHTML')}</Button>
      {exportPath && <CopyValue label={t('omp.inspector.exportPath')} value={exportPath} />}
    </Section>
  </div>;
}

function Section({ title, identity, children, defaultOpen = false, help }: { title: string; identity: string; children: ReactNode; defaultOpen?: boolean; help?: string }) {
  const disclosure = useAutomaticDisclosure(defaultOpen, `inspector:${identity}`);
  const id = useId();
  return <section className="session-inspector-section"><div className="session-inspector-section-heading"><h3><button type="button" ref={disclosure.titleRef} aria-expanded={disclosure.open} aria-controls={id} onClick={disclosure.toggle}><IconChevronRight size="var(--icon-meta)" /><span>{title}</span></button></h3>{help && <Help label={help} />}</div><DisclosureScope disclosure={disclosure}><Collapse id={id} open={disclosure.open} bodyRef={disclosure.bodyRef} {...disclosure.bodyEvents}><div className="session-inspector-section-body">{children}</div></Collapse></DisclosureScope></section>;
}

function Help({ label }: { label: string }) {
  const { t } = useTranslation();
  return <TooltipButton type="button" className="session-inspector-help" tooltipClassName="ui-tooltip-help" tooltip={label} ariaLabel={`${t('omp.inspector.help')}: ${label}`}><IconInfo size="var(--icon-meta)" /></TooltipButton>;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const { copy, copied, error } = useCopy();
  return <div className="session-inspector-copy"><span>{label}</span><div><code>{value}</code><TooltipButton type="button" className="session-inspector-help" tooltip={copied ? t('omp.inspector.copied') : t('omp.inspector.copy')} ariaLabel={t('omp.inspector.copyValue', { label })} onClick={() => copy(value)}><IconCopy size="var(--icon-meta)" /></TooltipButton></div>{copied && <span role="status">{t('omp.inspector.copied')}</span>}{error && <p className="session-inspector-error" role="alert">{error}</p>}</div>;
}

function SummaryTiles({ summary }: { summary: InspectorSummary }) {
  const { t, i18n } = useTranslation();
  const unknown = t('omp.inspector.notReported');
  const format = (value: number | undefined, digits = 0) => value === undefined ? unknown : value.toLocaleString(i18n.resolvedLanguage ?? i18n.language, { maximumFractionDigits: digits });
  const { context, generation } = summary;
  return <div className="session-inspector-tiles">
    <section className="session-inspector-tile" data-activity={summary.activity}><h3>{t('omp.inspector.activity')}</h3><strong className="session-inspector-activity"><span aria-hidden="true" className={summary.animated ? 'ui-live-dot' : 'session-inspector-dot'} />{t(`omp.inspector.activity.${summary.activity}`)}</strong><span className="session-inspector-tile-meta">{summary.live ? t('omp.inspector.connected') : t('omp.inspector.notLive')}</span></section>
    <section className="session-inspector-tile session-inspector-context"><div className="session-inspector-tile-heading"><h3>{t('omp.inspector.context')}</h3><Help label={t('omp.inspector.thisIsTheModelSWorkingContextNotThe')} /></div><div className="session-inspector-context-value"><span className="session-inspector-ring" role={context.percent === undefined ? 'img' : 'meter'} aria-label={t('omp.inspector.modelContextPressure')} aria-valuemin={context.percent === undefined ? undefined : 0} aria-valuemax={context.percent === undefined ? undefined : 100} aria-valuenow={context.ringPercent} aria-valuetext={context.percent === undefined ? unknown : `${format(context.percent, 1)}%`}><svg viewBox="0 0 40 40" aria-hidden="true"><circle className="session-inspector-ring-track" cx="20" cy="20" r="17" /><circle cx="20" cy="20" r="17" pathLength="100" strokeDasharray={`${context.ringPercent ?? 0} 100`} /></svg><strong>{context.percent === undefined ? unknown : `${format(context.percent)}%`}</strong></span><span>{t('omp.inspector.autoCompactShort')}<br /><b>{context.autoCompaction === undefined ? unknown : context.autoCompaction ? t('omp.inspector.enabled') : t('omp.inspector.disabled')}</b></span></div><span className="session-inspector-tile-meta">{format(context.tokens)} / {format(context.window)}</span></section>
    <section className="session-inspector-tile session-inspector-generation"><div className="session-inspector-tile-heading"><h3>{t('omp.inspector.generation')}</h3><Help label={t('omp.inspector.fastModeIsNativePriorityServiceNotAGuarantee')} /></div><strong className="session-inspector-model" title={[generation.model, generation.provider].filter(Boolean).join(' · ')}>{generation.model || unknown}</strong><span className="session-inspector-tile-meta">{t('omp.inspector.thinking')}: {generation.thinking || unknown}</span><div className="session-inspector-generation-metrics"><span>{generation.speed === undefined ? t('omp.inspector.noLiveGenerationMeasurement') : `${format(generation.speed, 1)} ${t('omp.inspector.tokensS')}`}</span><span>{t('omp.inspector.queueCount', { value: format(generation.queued) })}</span></div></section>
  </div>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="session-inspector-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

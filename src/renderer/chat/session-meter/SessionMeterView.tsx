import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeTodoPhase } from '../../../shared/contracts';
import { formatContextPercent, formatCost, formatTokensCompact, type ContextMeter, type SessionMeterModel, type SpendMeter, type WorkMeter } from '../../app/session-meter-model';
import { AnchoredMenu } from '../../ui/AnchoredMenu';
import { IconCheck, IconLayers, IconListTodo, IconUsers } from '../../ui/icons';
import { AnimatedNumber } from '../../ui/motion';
import { PlanContent, type PlanProvenance } from '../TodoDock';
import { todoDockPlan } from '../todo-dock-model';
import './session-meter.css';

export interface SessionMeterViewProps {
  model: SessionMeterModel; phases: NativeTodoPhase[] | undefined; provenance: PlanProvenance; animate: boolean;
  variant: 'toolbar' | 'readonly'; onOpenInspector: () => void; onOpenSubagent: (id: string) => void;
}
type Menu = 'context' | 'spend' | 'plan' | 'overflow';

/** Pure rendering surface also used by the isolated component harness. */
export function SessionMeterView({ model, phases, provenance, animate, variant, onOpenInspector }: SessionMeterViewProps) {
  const { t, i18n } = useTranslation();
  const [menu, setMenu] = useState<Menu | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const contextAnchor = useRef<HTMLButtonElement | null>(null);
  const navigating = useRef(false);
  const [toolbarWidth, setToolbarWidth] = useState(Infinity);
  const compact = toolbarWidth < 600;
  useLayoutEffect(() => {
    const element = root.current?.closest('.composer-stack') ?? root.current?.parentElement;
    if (!element) return;
    const update = () => setToolbarWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const plan = useMemo(() => todoDockPlan(phases), [phases]);
  const tasks = plan.phases.flatMap(phase => phase.tasks);
  const abandoned = tasks.filter(({ task }) => task.status === 'abandoned').length;
  const blocked = tasks.filter(({ task }) => task.status === 'blocked').length;
  const finished = plan.total > 0 && plan.completed + abandoned === plan.total;
  const currentTask = provenance === 'live' ? tasks.find(({ task }) => task.status === 'in_progress')?.task.content : undefined;
  const { context, spend } = model;
  const contextValue = context.state === 'known' && context.percent !== undefined ? formatContextPercent(context.percent) : context.state === 'windowUnknown' && context.tokens !== undefined ? formatTokensCompact(context.tokens) : t(`meter.context.${context.state}`);
  const contextTitle = context.state === 'known' ? t('meter.context.tooltip', { used: formatTokensCompact(context.tokens ?? 0), window: formatTokensCompact(context.window ?? 0), percent: `${(context.percent ?? 0).toFixed(1)}%` }) : context.state === 'windowUnknown' ? t('meter.context.unknownTooltip', { used: formatTokensCompact(context.tokens ?? 0) }) : `${t('meter.context')} · ${contextValue}`;
  const spendValue = spend.total === undefined ? '' : formatCost(spend.total, i18n.resolvedLanguage ?? i18n.language);
  const spendNote = spend.unavailable ? t('meter.spend.unavailable') : spend.stale ? t(spend.source === 'live' ? 'meter.spend.updating' : 'meter.spend.settling') : '';
  const planLabel = [t(`meter.plan.${provenance}`), t('meter.plan.completed', { completed: plan.completed, total: plan.total }), currentTask, abandoned ? t('meter.plan.abandoned', { count: abandoned }) : '', blocked ? t('meter.plan.blocked', { count: blocked }) : ''].filter(Boolean).join(' · ');
  if (compact) return <div ref={root} className={`session-meter session-meter-${variant}`}><AnchoredMenu open={menu === 'overflow'} onClose={() => setMenu(null)} side="top" align="end" role="dialog" label={t('composer.meters')} menuClassName="session-meter-popover" trigger={ref => <button ref={ref} className="session-meter-chip" aria-label={t('composer.meters')} title={t('composer.meters')} aria-expanded={menu === 'overflow'} onClick={() => setMenu(menu === 'overflow' ? null : 'overflow')}>…</button>}><button className="session-meter-close" aria-label={t('meter.close')} onClick={() => setMenu(null)}>×</button>{plan.total > 0 && <details><summary>{planLabel}</summary><PlanContent phases={phases} provenance={provenance}/></details>}<ContextDetails context={context} onManage={() => { setMenu(null); onOpenInspector(); }}/>{spend.total !== undefined && <SpendDetails spend={spend}/>}</AnchoredMenu></div>;
  const chip = (kind: Menu, label: string, children: ReactNode, content: ReactNode, extra = '') => <AnchoredMenu open={menu === kind} onClose={() => setMenu(null)} restoreFocus={menu === null && !navigating.current} anchorRef={kind === 'spend' && compact ? contextAnchor : undefined} side="top" align="end" role="dialog" label={t(`meter.${kind}`)} className={`session-meter-item session-meter-${kind}`} menuClassName={`session-meter-popover session-meter-popover-${kind}`} trigger={ref => <button ref={element => { ref.current = element; if (kind === 'context') contextAnchor.current = element; }} type="button" className={`session-meter-chip ${extra}`} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={menu === kind} onClick={() => { navigating.current = false; setMenu(menu === kind ? null : kind); }}>{children}</button>}><button type="button" className="session-meter-close" aria-label={t('meter.close')} onClick={() => setMenu(null)}>×</button>{content}</AnchoredMenu>;
  return <div ref={root} className={`session-meter session-meter-${variant}`} role="group" aria-label={t('meter.label')} data-animate={animate}>
    <div className="session-meter-row">
      {plan.total > 0 && chip('plan', planLabel, <>{finished ? <IconCheck aria-hidden="true"/> : <IconListTodo aria-hidden="true"/>}{currentTask && <span className="session-meter-task">{currentTask}<span aria-hidden="true"> · </span></span>}<span>{plan.completed}/{plan.total}</span>{blocked > 0 && <span className="session-meter-warning-dot"/>}</>, <PlanContent phases={phases} provenance={provenance}/>, finished ? 'is-finished' : '')}
      {chip('context', contextTitle, <><ContextRing context={context}/><span className="session-meter-context-value">{context.state === 'known' && context.percent !== undefined ? <AnimatedNumber value={context.percent} format={formatContextPercent} animate={animate}/> : contextValue}</span></>, <><ContextDetails context={context} onManage={() => { navigating.current = true; setMenu(null); onOpenInspector(); }}/>{toolbarWidth <= 680 && spend.total !== undefined && <footer className="session-meter-spend-footer"><button type="button" onClick={() => setMenu('spend')}><span>{t('meter.spend')}</span><strong>{spendValue}</strong><span aria-hidden="true">›</span></button>{spendNote && <p>{spendNote}</p>}</footer>}</>, `session-meter-context-${context.state} session-meter-level-${context.level}`)}
      {spend.total !== undefined && chip('spend', `${t('meter.spend')} ${spendValue}${spendNote ? ` · ${spendNote}` : ''}`, <AnimatedNumber value={spend.total} format={value => formatCost(value, i18n.resolvedLanguage ?? i18n.language)} animate={animate}/>, <SpendDetails spend={spend}/>, spend.stale || spend.unavailable ? 'is-stale' : '')}
    </div>
  </div>;
}

/** The same live-work popover is available beside the composer and live status. */
export function WorkChip({ work, onOpenSubagent, expandedLabel = false }: { work: WorkMeter | null; onOpenSubagent: (id: string) => void; expandedLabel?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const navigating = useRef(false);
  if (!work || (!work.runningAgents.length && !work.backgroundWork)) return null;
  const label = [work.runningAgents.length ? t('omp.timeline.chapterAgentsRunning', { count: work.runningAgents.length }) : '', work.backgroundWork ? t('meter.work.background') : ''].filter(Boolean).join(' · ');
  return <AnchoredMenu open={open} onClose={() => setOpen(false)} restoreFocus={!open && !navigating.current} side="top" align="end" role="dialog" label={t('meter.work')} className="session-meter-item session-meter-work" menuClassName="session-meter-popover session-meter-popover-work" trigger={ref => <button ref={ref} type="button" className="session-meter-chip" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => { navigating.current = false; setOpen(!open); }}><IconUsers aria-hidden="true"/><span>{expandedLabel ? label : work.runningAgents.length || t('meter.work.short')}</span></button>}>
    <button type="button" className="session-meter-close" aria-label={t('meter.close')} onClick={() => setOpen(false)}>×</button><h3>{t('meter.work')}</h3><ul className="session-meter-agents">{work.runningAgents.map(agent => <li key={agent.id}><button type="button" aria-label={t('meter.work.open', { title: agent.title })} onClick={() => { navigating.current = true; setOpen(false); onOpenSubagent(agent.id); }}><IconUsers aria-hidden="true"/><span><strong>{agent.title}</strong>{agent.activity && <small>{agent.activity}</small>}</span></button></li>)}</ul>{work.backgroundWork && <p>{t('meter.work.background')}</p>}
  </AnchoredMenu>;
}

function ContextRing({ context }: { context: ContextMeter }) {
  const known = context.state === 'known';
  return <span className="session-meter-ring" aria-hidden="true">{context.state === 'compacting' ? <span className="ui-spinner"/> : <><svg viewBox="0 0 16 16"><circle className="session-meter-ring-track" cx="8" cy="8" r="6" strokeDasharray={known ? undefined : '2 2'}/>{known && <circle className="session-meter-ring-fill" cx="8" cy="8" r="6" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - Math.max(0, Math.min(100, context.percent ?? 0))}/>}</svg>{context.state === 'compacted' && <IconLayers className="session-meter-compact-glyph"/>}</>}</span>;
}

function ContextDetails({ context, onManage }: { context: ContextMeter; onManage: () => void }) {
  const { t, i18n } = useTranslation();
  const known = context.state === 'known' && context.percent !== undefined;
  const thresholdTokens = context.level === 'error' ? 500000 : context.level === 'purple' ? 270000 : 150000;
  const thresholdPercent = context.level === 'error' ? 90 : context.level === 'purple' ? 70 : 50;
  const tokenThresholdFirst = !!context.window && thresholdTokens / context.window * 100 <= thresholdPercent;
  const reachedPercent = tokenThresholdFirst ? thresholdTokens / context.window! * 100 : thresholdPercent;
  const threshold = t(`meter.context.threshold.${(context.percent ?? 0) > reachedPercent ? 'above' : 'at'}`, { value: tokenThresholdFirst ? `${formatTokensCompact(thresholdTokens)} tokens` : `${thresholdPercent}%` });
  const categories = context.composition?.categories;
  const free = Math.max(0, (context.window ?? 0) - (context.tokens ?? 0));
  const percent = (tokens: number) => `${Number((tokens / context.window! * 100).toFixed(1))}%`;
  const policy = context.policy;
  const markers = policy?.enabled && context.window ? [
    ...(policy.speculationStart !== undefined ? [{ id: 'prepare', tokens: policy.speculationStart }] : []),
    ...(policy.threshold !== undefined ? [{ id: 'compact', tokens: policy.threshold }] : []),
  ] : [];
  const observed = context.composition?.source === 'request' ? context.observedAt : context.composition?.basis === 'request' ? context.requestObservedAt : undefined;
  const provenance = [context.model?.name ?? context.model?.id, context.window ? t('meter.context.windowSummary', { window: formatTokensCompact(context.window), source: context.windowSource ? t(`meter.context.windowShort.${context.windowSource}`) : t('meter.notRecorded') }) : undefined, observed !== undefined ? t('meter.context.requestAt', { time: new Date(observed).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }) }) : undefined].filter(Boolean).join(' · ');
  return <div className={`session-meter-context-details session-meter-level-${context.level}`}><h3>{t('meter.context')}</h3>
    {known ? <>
      <div className="session-meter-context-heading"><div className="session-meter-large">{formatContextPercent(context.percent!)}</div><span>{formatTokensCompact(context.tokens ?? 0)} / {formatTokensCompact(context.window ?? 0)} tokens</span></div>
      <div className="session-meter-composition" role="meter" aria-label={t('meter.context.composition')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, context.percent!))} aria-valuetext={formatContextPercent(context.percent!)}>
        {(categories ?? [{ id: 'messages', tokens: context.tokens ?? 0 }]).map(category => <span key={category.id} className={`meter-category-${category.id}`} style={{ flexBasis: `${category.tokens / Math.max(context.window!, context.tokens ?? 0) * 100}%` }} title={`${t(`meter.context.category.${category.id}`)} · ${formatTokensCompact(category.tokens)} tokens`}/>)}
        {markers.map(marker => <i key={marker.id} className="session-meter-bar-marker" style={{ left: `${marker.tokens / context.window! * 100}%` }} aria-hidden="true"/>)}
      </div>
      {markers.length > 0 && <div className="session-meter-policy-markers">{markers.map(marker => <div className="session-meter-policy-marker" key={marker.id} title={policy?.eligibilityUnknown ? t('meter.context.policy.unknown') : undefined}><span className="session-meter-policy-track" aria-hidden="true"><i style={{ left: `${marker.tokens / context.window! * 100}%` }}/></span><span>{t(`meter.context.policy.${marker.id}`)} <strong>{percent(marker.tokens)}</strong> · {formatTokensCompact(marker.tokens)}</span></div>)}</div>}
      {categories ? <dl className="session-meter-legend">{[...categories, { id: 'free', tokens: free }].map(category => <div key={category.id}><dt><i className={`meter-category-${category.id}`} aria-hidden="true"/>{t(`meter.context.category.${category.id}`)}</dt><dd>{formatTokensCompact(category.tokens)} <span>{percent(category.tokens)}</span></dd></div>)}</dl> : <p className="session-meter-muted">{t('meter.context.compositionUnavailable')}</p>}
      <p className="session-meter-severity">{t(`meter.context.level.${context.level}`, { threshold })}</p>
    </> : <><div className="session-meter-state-title">{context.state === 'windowUnknown' ? `${formatTokensCompact(context.tokens ?? 0)} tokens` : t(`meter.context.${context.state}`)}</div><p>{t(`meter.context.${context.state === 'windowUnknown' ? 'windowUnknown' : `${context.state}Detail`}`)}</p>{context.state === 'compacted' && context.compactedTokens !== undefined && <p>{t('meter.context.afterCompaction')} · {formatTokensCompact(context.compactedTokens)} tokens</p>}</>}
    {context.composition?.estimated && <p className="session-meter-muted">{t(`meter.context.estimate.${context.composition.basis}`)}</p>}
    {provenance && <p className="session-meter-muted session-meter-provenance">{provenance}</p>}
    <div className="session-meter-auto"><span>{t('meter.context.auto')} · {t(`meter.context.auto.${context.autoCompaction === undefined ? 'unknown' : context.autoCompaction ? 'on' : 'off'}`)}</span>{context.source === 'live' && <button type="button" onClick={onManage}>{t('meter.context.manage')}</button>}</div>
    {policy?.enabled && policy.threshold !== undefined && context.window && <p className="session-meter-muted">{t(`meter.context.policy.${policy.source}`)}{t('meter.context.policy.explain', { percent: percent(policy.threshold), tokens: formatTokensCompact(policy.threshold) })}</p>}
  </div>;
}

function SpendDetails({ spend }: { spend: SpendMeter }) {
  const { t, i18n } = useTranslation();
  const number = (value: number | undefined) => value === undefined ? t('meter.notRecorded') : value.toLocaleString(i18n.language, { maximumFractionDigits: 1 });
  const cost = (value: number | undefined) => value === undefined ? t('meter.notRecorded') : formatCost(value, i18n.resolvedLanguage ?? i18n.language);
  const row = (key: string, value: ReactNode) => <div className="session-meter-detail-row" key={key}><dt>{t(`meter.spend.${key}`)}</dt><dd>{value}</dd></div>;
  return <>
    <h3>{t('meter.spend')}</h3>
    <div className="session-meter-large">{spend.total === undefined ? t(`meter.spend.${spend.state === 'pending' ? 'pending' : 'none'}`) : formatCost(spend.total, i18n.resolvedLanguage ?? i18n.language)}</div>
    <p className="session-meter-muted">{t('meter.spend.scope')}</p>
    <dl>
      {row('main', cost(spend.main))}{row('subagents', cost(spend.subagents))}
      {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map(key => row(key, number(spend.tokens?.[key])))}
      {row('totalTokens', number(spend.tokens?.total))}
      {row('cacheRate', spend.cacheHitRate === undefined ? t('meter.notRecorded') : `${number(spend.cacheHitRate)}%`)}
      {spend.latest && row('latest', <>{cost(spend.latest.cost)}{spend.latest.tokens !== undefined && <> · {number(spend.latest.tokens)} tokens</>}</>)}
      {spend.premiumRequests !== undefined && row('premium', number(spend.premiumRequests))}
    </dl>
    {!!spend.unrecordedSubagents && <p className="session-meter-note">{t('meter.spend.unrecordedSubagents', { count: spend.unrecordedSubagents })}</p>}
    {(spend.stale || spend.unavailable) && <p className="session-meter-note">{t(spend.unavailable ? 'meter.spend.unavailable' : spend.source === 'live' ? 'meter.spend.updating' : 'meter.spend.settling')}</p>}
  </>;
}

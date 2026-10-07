import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NativeTodoItem, NativeTodoPhase } from '../../shared/contracts';
import { Collapse } from '../ui/Collapse';
import { IconCheck, IconChevronRight, IconCircleAlert, IconCircleDashed, IconCircleDot, IconCircleSlash } from '../ui/icons';
import { DisclosureScope, useAutomaticDisclosure } from './disclosure';
import { diffTodoDockPlans, todoDockPlan, type TodoDockChanges, type TodoDockPhase, type TodoDockPlan } from './todo-dock-model';
import '../styles/todo-dock.css';

const NO_CHANGES: TodoDockChanges = { completed: new Set(), added: new Set(), phaseAdvanced: false };

export type PlanProvenance = 'live' | 'connected' | 'saved' | 'stopped';

/** The plan has one home: the composer's anchored popover. */
export function PlanContent({ phases, provenance }: { phases: NativeTodoPhase[] | undefined; provenance: PlanProvenance }) {
  const { t } = useTranslation();
  const live = provenance === 'live';
  const paused = provenance === 'stopped';
  const plan = useMemo(() => todoDockPlan(phases), [phases]);
  const previous = useRef<{ plan: TodoDockPlan; live: boolean } | null>(null);
  const [changes, setChanges] = useState(NO_CHANGES);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { plan, live };
    if (!live || !before?.live) { setChanges(NO_CHANGES); return; }
    const next = diffTodoDockPlans(before.plan, plan);
    if (!next.completed.size && !next.added.size && !next.phaseAdvanced) { setChanges(NO_CHANGES); return; }
    setChanges(next);
    const timer = window.setTimeout(() => setChanges(NO_CHANGES), 260);
    return () => window.clearTimeout(timer);
  }, [plan, live]);
  if (!plan.phases.length) return null;
  const abandoned = plan.phases.reduce((count, phase) => count + phase.tasks.filter(({ task }) => task.status === 'abandoned').length, 0);
  return <section className="todo-dock" aria-label={t('meter.plan')} data-live={live}>
    <header className="todo-dock-popover-heading"><strong>{t('meter.plan')}</strong><span>{t(`meter.plan.${provenance}`)}</span></header>
    <p className="todo-dock-popover-summary">{t('meter.plan.completed', { completed: plan.completed, total: plan.total })}{abandoned > 0 && <> · {t('meter.plan.abandoned', { count: abandoned })}</>}</p>
    <div className="todo-dock-scroll">{plan.phases.map((phase, index) => <TodoPhase key={phase.key} phase={phase} current={index === plan.current} live={live} paused={paused} changes={changes} />)}</div>
  </section>;
}

function TodoPhase({ phase, current, live, paused, changes }: { phase: TodoDockPhase; current: boolean; live: boolean; paused: boolean; changes: TodoDockChanges }) {
  const { t } = useTranslation();
  const id = useId();
  const disclosure = useAutomaticDisclosure(current, phase.key);
  const blockers = phase.tasks.filter(({ task }) => task.status === 'blocked');
  return <DisclosureScope disclosure={disclosure}><div className={`todo-dock-phase${current && live ? ' is-current' : ''}${current && live && changes.phaseAdvanced ? ' todo-dock-phase-advance' : ''}`}>
    <button type="button" ref={disclosure.titleRef} className="todo-dock-phase-heading" aria-expanded={disclosure.open} aria-controls={id} onClick={disclosure.toggle}>
      <IconChevronRight className="todo-dock-caret" aria-hidden="true" />
      <span className="todo-dock-phase-name">{phase.name}</span>
      {current && live && <span className="todo-dock-phase-current">{t('todo.currentPhase')}</span>}
      <span className="todo-dock-count">{phase.completed}/{phase.tasks.length}</span>
    </button>
    <Collapse id={id} open={disclosure.open} bodyRef={disclosure.bodyRef} {...disclosure.bodyEvents}>
      <ul className="todo-dock-tasks">{phase.tasks.map(({ key, task }) => <TodoTask key={key} task={task} live={live} paused={paused} completed={changes.completed.has(key)} added={changes.added.has(key)} />)}</ul>
    </Collapse>
    {!disclosure.open && blockers.length > 0 && <ul className="todo-dock-blockers">{blockers.map(({ key, task }) => <li key={key}><IconCircleAlert aria-hidden="true" /><span>{task.content}{task.blocker && <span className="todo-dock-blocker-reason">{task.blocker}</span>}</span></li>)}</ul>}
  </div></DisclosureScope>;
}

function TodoTask({ task, live, paused, completed, added }: { task: NativeTodoItem; live: boolean; paused: boolean; completed: boolean; added: boolean }) {
  const { t } = useTranslation();
  const status = paused && task.status === 'in_progress' ? 'paused' : task.status;
  const Icon = task.status === 'completed' ? IconCheck : task.status === 'blocked' ? IconCircleAlert : task.status === 'abandoned' ? IconCircleSlash : task.status === 'in_progress' ? IconCircleDot : IconCircleDashed;
  return <li className={`todo-dock-task${completed ? ' todo-dock-task-completed' : ''}${added ? ' ui-enter' : ''}`} data-status={status}>
    <span className="todo-dock-task-status" role="img" aria-label={t(`todo.status.${status}`)} title={t(`todo.status.${status}`)}>{live && status === 'in_progress' ? <span className="ui-live-dot" /> : <Icon aria-hidden="true" />}</span>
    <span className="todo-dock-task-body"><span className="todo-dock-task-content">{task.content}</span>{task.status === 'blocked' && task.blocker && <span className="todo-dock-blocker-reason">{task.blocker}</span>}{task.details && <span className="todo-dock-task-detail">{task.details}</span>}{task.notes?.map((note, index) => <span key={index} className="todo-dock-task-detail">{note}</span>)}</span>
  </li>;
}

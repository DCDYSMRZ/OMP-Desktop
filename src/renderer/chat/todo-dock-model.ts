import type { NativeTodoItem, NativeTodoPhase } from '../../shared/contracts';
import { record, type ChatState } from './model';

/** Live observations outrank older state snapshots. Hydrated plans use transcript
 * order; a settled live state is authoritative when no receipt order is known. */
export function latestTodoPhases(chat: ChatState, live: boolean): NativeTodoPhase[] | undefined {
  let latest: NativeTodoPhase[] | undefined;
  let revision: number | undefined;
  const represented = new Set<string>();
  for (const row of chat.messages) {
    if (row.raw.role !== 'toolResult') continue;
    const id = typeof row.raw.toolCallId === 'string' ? row.raw.toolCallId : '';
    represented.add(id);
    const tool = chat.tools[id];
    if (row.streaming && tool?.todoRevision === undefined || row.raw.isError || tool && tool.status !== 'complete' || (row.raw.toolName ?? tool?.name) !== 'todo') continue;
    const phases = row.streaming ? record(record(tool?.result).details).phases : record(row.raw.details).phases ?? record(record(tool?.result).details).phases;
    if (!Array.isArray(phases)) continue;
    if (live && (tool?.todoRevision ?? 0) < (revision ?? 0)) continue;
    latest = phases as NativeTodoPhase[];
    revision = tool?.todoRevision;
  }
  // A completed execution event can precede its transcript result row.
  for (const tool of Object.values(chat.tools)) {
    if (represented.has(tool.id) || tool.name !== 'todo' || tool.status !== 'complete' || record(tool.result).isError) continue;
    const phases = record(record(tool.result).details).phases;
    if (!Array.isArray(phases)) continue;
    if (live && (tool.todoRevision ?? 0) < (revision ?? 0)) continue;
    latest = phases as NativeTodoPhase[];
    revision = tool.todoRevision;
  }
  const state = chat.state.todoPhases;
  if (!live || state === undefined) return latest ?? state;
  if (latest === undefined) return state;
  if (revision !== undefined || chat.todoStateRevision !== undefined) return (revision ?? 0) > (chat.todoStateRevision ?? 0) ? latest : state;
  return chat.state.isStreaming || chat.state.isCompacting ? latest : state;
}

export interface TodoDockTask { key: string; task: NativeTodoItem }
export interface TodoDockPhase { key: string; name: string; tasks: TodoDockTask[]; completed: number }
export interface TodoDockPlan { phases: TodoDockPhase[]; current: number; completed: number; total: number }
export interface TodoDockChanges { completed: Set<string>; added: Set<string>; phaseAdvanced: boolean }

/** Native todos have no IDs. Match content within named phases, with occurrence
 * ordinals for duplicates; insertion/reordering must not complete a different task. */
export function todoDockPlan(phases: NativeTodoPhase[] | undefined): TodoDockPlan {
  const names = new Map<string, number>();
  const rows = (phases ?? []).map(phase => {
    const occurrence = names.get(phase.name) ?? 0;
    names.set(phase.name, occurrence + 1);
    const key = JSON.stringify([phase.name, occurrence]);
    const contents = new Map<string, number>();
    const tasks = phase.tasks.map(task => {
      const ordinal = contents.get(task.content) ?? 0;
      contents.set(task.content, ordinal + 1);
      return { key: JSON.stringify([key, task.content, ordinal]), task };
    });
    return { key, name: phase.name, tasks, completed: tasks.filter(({ task }) => task.status === 'completed').length };
  });
  let current = rows.findIndex(phase => phase.tasks.some(({ task }) => task.status === 'in_progress'));
  if (current < 0) current = rows.findIndex(phase => phase.tasks.some(({ task }) => task.status === 'pending' || task.status === 'blocked'));
  if (current < 0) current = rows.length - 1;
  return { phases: rows, current, completed: rows.reduce((sum, phase) => sum + phase.completed, 0), total: rows.reduce((sum, phase) => sum + phase.tasks.length, 0) };
}

/** Initial/hydrated plans are not live transitions, including already-done tasks. */
export function diffTodoDockPlans(previous: TodoDockPlan | null, next: TodoDockPlan): TodoDockChanges {
  const completed = new Set<string>();
  const added = new Set<string>();
  if (!previous) return { completed, added, phaseAdvanced: false };
  const statuses = new Map(previous.phases.flatMap(phase => phase.tasks.map(({ key, task }) => [key, task.status] as const)));
  for (const phase of next.phases) for (const { key, task } of phase.tasks) {
    const before = statuses.get(key);
    if (before === undefined) added.add(key);
    else if (before !== 'completed' && task.status === 'completed') completed.add(key);
  }
  const before = previous.phases[previous.current]?.key;
  const after = next.phases[next.current]?.key;
  return { completed, added, phaseAdvanced: before !== undefined && after !== undefined && before !== after };
}

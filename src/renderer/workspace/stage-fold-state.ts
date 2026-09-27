export interface StageFoldState { expanded: boolean; manual: boolean; wasActive: boolean; foldDueAt?: number }
export type StageFoldEvent =
  | { type: 'mount'; active: boolean; defaultExpanded: boolean }
  | { type: 'active' }
  | { type: 'settle'; canFold: boolean }
  | { type: 'absorb-done' | 'hover-out'; now: number; protected: boolean; returnsPending: boolean }
  | { type: 'hover-in' | 'returns-pending' }
  | { type: 'manual'; expanded: boolean }
  | { type: 'deadline'; now: number; protected: boolean; returnsPending: boolean };

/** The deadline is wall-clock time so an unavoidable remount resumes, not restarts, the wait. */
export function nextStageFoldState(previous: StageFoldState | undefined, event: StageFoldEvent): StageFoldState {
  if (event.type === 'mount') {
    if (!previous) return { expanded: event.defaultExpanded, manual: false, wasActive: event.active };
    if (event.active) return { expanded: previous.manual ? previous.expanded : true, manual: previous.manual, wasActive: true };
    return previous;
  }
  if (!previous) throw new Error('Stage fold state must be mounted before receiving events');
  if (event.type === 'manual') return { expanded: event.expanded, manual: true, wasActive: previous.wasActive };
  if (event.type === 'active') return { expanded: previous.manual ? previous.expanded : true, manual: previous.manual, wasActive: true };
  if (previous.manual) return previous;
  if (event.type === 'settle') return previous.wasActive ? { expanded: true, manual: false, wasActive: event.canFold } : previous;
  if (event.type === 'hover-in' || event.type === 'returns-pending') return previous.foldDueAt === undefined ? previous : { expanded: previous.expanded, manual: false, wasActive: previous.wasActive };
  if (!previous.wasActive || !previous.expanded) return previous;
  if (event.type === 'absorb-done' || event.type === 'hover-out' || event.type === 'deadline') {
    if (event.protected || event.returnsPending) return previous;
    if (event.type !== 'deadline') return previous.foldDueAt === undefined ? { ...previous, foldDueAt: event.now + 1400 } : previous;
    if (previous.foldDueAt !== undefined && event.now >= previous.foldDueAt) return { expanded: false, manual: false, wasActive: false };
  }
  return previous;
}

const stageStates = new Map<string, StageFoldState>();
export function recallStageFoldState(toolId: string | undefined): StageFoldState | undefined {
  const state = toolId ? stageStates.get(toolId) : undefined;
  if (toolId && state) { stageStates.delete(toolId); stageStates.set(toolId, state); }
  return state;
}
export function rememberStageFoldState(toolId: string | undefined, state: StageFoldState): void {
  if (!toolId) return;
  stageStates.delete(toolId); stageStates.set(toolId, state);
  if (stageStates.size > 128) stageStates.delete(stageStates.keys().next().value!);
}

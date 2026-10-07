import type { SessionResourceContext } from '../../shared/contracts';
import type { SourceReadScope } from './source-read-scope';

export interface PanelRemoval { runtimeIds: readonly string[]; sourcePath?: string }
export function belongsToRemoval(context: SessionResourceContext | undefined, removal: PanelRemoval): boolean {
  return !!context && (context.kind === 'runtime' ? removal.runtimeIds.includes(context.runtimeId) : context.parentPath === removal.sourcePath);
}

/** Invalidate existing tab lifetimes, not source names: restored sources get fresh tabs. */
export function retainPanelSourceTabs<T extends { id: string; scope: SourceReadScope; context?: SessionResourceContext }>(tabs: readonly T[], removal: PanelRemoval, removeAll = false, resolvedContexts?: Readonly<Record<string, SessionResourceContext>>): T[] {
  return tabs.filter(tab => {
    if (!removeAll && !belongsToRemoval(tab.context ?? resolvedContexts?.[tab.id], removal)) return true;
    tab.scope.invalidate();
    return false;
  });
}

import type { RuntimeShutdownOutcome, SessionRemovalTarget } from '../../shared/contracts';
import { SessionAdmissions } from './admission';

export interface RemovalRuntimeBinding { runtimeId: string; sessionId: string; path?: string }
export interface RemovalRuntimeCatalog {
  identities(): RemovalRuntimeBinding[];
  close(runtimeId: string): Promise<RuntimeShutdownOutcome>;
}
export interface RemovalLifecycleAdmission {
  runtimeIds: string[];
  revalidate(): void;
  close?: () => Promise<RuntimeShutdownOutcome>;
}

/** Caller syntax never removes lifecycle obligations remembered for the exact backend source. */
export async function withRemovalRuntimeAdmission<T>(admissions: SessionAdmissions, target: SessionRemovalTarget, source: { sessionId: string; path?: string }, catalog: RemovalRuntimeCatalog, operation: (lifecycle: RemovalLifecycleAdmission) => Promise<T>): Promise<T> {
  const matching = (): string[] => {
    const identities = catalog.identities();
    if (target.kind === 'runtime') {
      const owner = identities.find(identity => identity.runtimeId === target.runtimeId);
      if (!owner || owner.sessionId !== source.sessionId || owner.path !== source.path) throw new Error('Owned source binding changed during removal admission');
    }
    return identities.filter(identity => target.kind === 'runtime' && identity.runtimeId === target.runtimeId || source.path !== undefined && identity.path === source.path && identity.sessionId === source.sessionId).map(identity => identity.runtimeId).sort();
  };
  const runtimeIds = matching();
  const revalidate = () => {
    const current = matching();
    if (current.length !== runtimeIds.length || current.some((id, index) => id !== runtimeIds[index])) throw new Error('Owned source bindings changed during removal admission');
  };
  const perform = async (): Promise<T> => {
    revalidate();
    return operation({ runtimeIds, revalidate, close: runtimeIds.length ? async () => {
      for (const id of runtimeIds) {
        revalidate();
        const outcome = await catalog.close(id);
        revalidate();
        if (!outcome.clean || outcome.forced || outcome.exitCode !== 0 || outcome.signal || outcome.error) return outcome;
      }
      return { clean: true, forced: false, exitCode: 0 };
    } : undefined });
  };
  const enter = (index: number): Promise<T> => index < runtimeIds.length
    ? admissions.run(`runtime:${runtimeIds[index]}`, () => enter(index + 1))
    : source.path ? admissions.run(source.path, perform) : perform();
  return enter(0);
}

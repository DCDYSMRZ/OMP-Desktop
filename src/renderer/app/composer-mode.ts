import type { HistoryView } from './history-store';
import type { RuntimeAccess } from '../../shared/contracts';

/** The renderer accepts intent during checks; sendPrompt awaits authoritative admission. */
export function runtimeComposerReady(active: { closed: boolean } | undefined, access: Pick<RuntimeAccess, 'canSend'> | undefined, connecting: boolean, error: string): boolean {
  if (error || active?.closed) return false;
  if (active) return !access || access.canSend;
  return connecting;
}

export function savedComposerMode(view: Pick<HistoryView, 'options' | 'snapshot' | 'access' | 'loading' | 'error'>) {
  const canFork = !!view.snapshot?.session.canFork && !view.loading && !view.error;
  const historical = view.options.leafId !== undefined;
  const readonlySource = !!view.snapshot && (!view.snapshot.session.writable || view.snapshot.session.sourceKind === 'archive');
  const pending = !!view.access?.pending;
  const readonly = historical || readonlySource || !pending && view.access?.status === 'external';
  const ready = !pending && !readonly && !view.loading && !view.error && !!view.snapshot && view.access?.status === 'idle';
  const category = pending ? 'checking' : historical ? 'historical' : readonlySource ? 'readonly' : view.access?.status === 'external' ? 'external' : view.error ? 'source-unavailable' : view.loading || !view.access || !view.snapshot ? 'checking' : ready ? 'ready' : 'unknown';
  return { readonly, ready, canFork, category } as const;
}

/** Header and editor consume the same read-only decision, including transient checks. */
export function savedSessionHeader(mode: { readonly: boolean }): 'omp.history.readonly' | null {
  return mode.readonly ? 'omp.history.readonly' : null;
}

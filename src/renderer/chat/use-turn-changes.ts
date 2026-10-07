import { useEffect, useState } from 'react';
import type { DesktopApi } from '../../shared/contracts';
import type { TurnChangeQuery, TurnChangeResult } from '../../shared/turn-change-types';

/** Follow evidence invalidations only while admitted, without changing the authorized query. */
export function observeTurnChanges(api: Pick<DesktopApi, 'getTurnChanges' | 'onTurnChanges' | 'onHistoryEvent'>, query: TurnChangeQuery, receive: (result: TurnChangeResult) => void, fail: (cause: unknown) => void, enabled = true) {
  if (!enabled) return () => {};
  let active = true, loading = false, dirty = false;
  let historyRevision: string | undefined;
  const load = () => {
    if (!active) return;
    // The main process deduplicates identical pending queries. Wait before asking
    // again so an invalidation cannot merely reuse the pre-revision promise.
    if (loading) { dirty = true; return; }
    loading = true;
    api.getTurnChanges(query).then(result => {
      if (active && !dirty) receive(result);
    }, cause => { if (active && !dirty) fail(cause); }).finally(() => {
      loading = false;
      if (active && dirty) { dirty = false; load(); }
    });
  };
  const context = query.context;
  const offChanges = api.onTurnChanges(event => {
    if (context.kind === 'runtime' ? event.runtimeId === context.runtimeId : event.sourcePath === context.parentPath || (!event.sourcePath && !event.runtimeId)) load();
  });
  const offHistory = context.kind === 'saved' ? api.onHistoryEvent(event => {
    if (event.kind !== 'snapshot' || event.path !== context.parentPath) return;
    const revision = JSON.stringify([event.snapshot.revision, event.snapshot.selectedLeafId, event.snapshot.activity?.childrenRevision]);
    if (revision === historyRevision) return;
    historyRevision = revision;
    load();
  }) : undefined;
  load();
  return () => { active = false; offChanges(); offHistory?.(); };
}

/** Query identity gates render as well as completion: an old source never flashes during an effect handoff. */
export function useTurnChanges(query: TurnChangeQuery | undefined, initial?: TurnChangeResult, refreshKey?: unknown, enabled = true) {
  const key = query ? JSON.stringify(query) : '';
  const [value, setValue] = useState<{ key: string; result?: TurnChangeResult; error?: string }>({ key, result: initial });
  useEffect(() => {
    if (!key) return;
    return observeTurnChanges(window.ompDesktop, JSON.parse(key) as TurnChangeQuery,
      result => setValue({ key, result }),
      cause => setValue(previous => ({ key, result: previous.key === key ? previous.result : undefined, error: String(cause) })), enabled);
  // Admission pauses observation, not result identity. Re-entry always reads current
  // evidence because offscreen invalidations deliberately have no subscription.
  }, [key, refreshKey, enabled]);
  return value.key === key ? value : { key };
}

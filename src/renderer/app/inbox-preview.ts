import type { InboxItem } from './runtime-store';
import { presentUserError } from '../lib/user-errors';

/** Failure rows summarize the problem; native diagnostics stay in the turn. */
export function inboxPreview(item: Pick<InboxItem, 'kind' | 'snippet'>): string | undefined {
  if (!item.snippet) return;
  // Child inbox entries are emitted only for failed subagents.
  return item.kind === 'failed' || item.kind === 'child' ? presentUserError(item.snippet).message : item.snippet;
}

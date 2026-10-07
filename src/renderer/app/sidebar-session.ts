import type { RuntimeSourceState, SessionSummary } from '../../shared/contracts';
import type { SubmissionReceipt } from '../chat/submissions';
import { messageText, type ChatMessage } from '../chat/model';

/** A sidebar row: a saved session summary merged with any live runtime record. */
export type SidebarSession = SessionSummary & { source?: RuntimeSourceState; runtimeId?: string; running?: boolean; failed?: boolean; unreadCompletion?: boolean; pendingCount?: number; closed?: boolean; lastAssistantExcerpt?: string; modelId?: string; modelProvider?: string };

/** Only accepted prompts create rows; allocations and local commands remain drafts. */
export function sidebarSubmission(receipts: readonly SubmissionReceipt[], runtimeId: string, sessionId: string): SubmissionReceipt | undefined {
  return receipts.findLast(receipt => receipt.runtimeId === runtimeId && receipt.sessionId === sessionId && (receipt.status === 'accepted' || receipt.status === 'queue-accepted' || receipt.status === 'completed' || receipt.status === 'aborted'));
}

export function isSidebarConversation(source: RuntimeSourceState, messages: readonly { raw: { role?: unknown } }[], accepted?: SubmissionReceipt): boolean {
  return !!accepted || source.status !== 'unpersisted' || messages.some(message => message.raw.role === 'user' || message.raw.role === 'assistant');
}

/** Forking copies the saved source; ownership and send admission do not gate it. */
export function sidebarForkReason(session: SidebarSession): 'unsaved' | 'unavailable' | undefined {
  if (session.source?.status === 'unavailable') return 'unavailable';
  if (session.source?.status === 'unpersisted' || !session.path || session.path.startsWith('runtime:')) return 'unsaved';
  return undefined;
}

/** Recency follows the user's request, not background writes or completion. */
export function sidebarConversationDetails(messages: readonly ChatMessage[], accepted?: SubmissionReceipt, saved?: SessionSummary): { title: string; updatedAt: string } {
  const firstUser = messages.find(message => message.raw.role === 'user');
  const lastUser = messages.findLast(message => message.raw.role === 'user');
  const timestamp = lastUser?.raw.timestamp;
  const sentAt = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
  const recent = accepted ? Math.max(accepted.submittedAt, sentAt ?? 0) : sentAt;
  return {
    title: (firstUser ? messageText(firstUser.raw) : accepted?.input.text ?? '').trim().split(/\r?\n/, 1)[0],
    updatedAt: recent !== undefined ? new Date(recent).toISOString() : saved?.updatedAt ?? '',
  };
}

export function projectSidebarSessions(sessions: readonly SidebarSession[], cwd: string, pinned: readonly string[] = []): SidebarSession[] {
  return sessions.filter(session => session.cwd === cwd).sort((a, b) => Number(pinned.includes(b.path)) - Number(pinned.includes(a.path)) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

export function sidebarProjects(workspaces: readonly string[], sessions: readonly SidebarSession[]): string[] {
  const activity = new Map<string, number>();
  for (const session of sessions) activity.set(session.cwd, Math.max(activity.get(session.cwd) ?? 0, Date.parse(session.updatedAt) || 0));
  return [...new Set([...workspaces, ...sessions.map(session => session.cwd)].filter(Boolean))].sort((a, b) => (activity.get(b) ?? 0) - (activity.get(a) ?? 0));
}

export function sidebarProjectRows(sessions: readonly SidebarSession[], current: boolean, expanded: boolean, active: string | null): readonly SidebarSession[] {
  const important = (session: SidebarSession) => session.path === active || session.runtimeId === active || session.running || session.activity === 'running' || !!session.pendingCount || session.failed || session.unreadCompletion;
  if (expanded) return sessions;
  const limit = current ? 8 : 5;
  return sessions.filter((session, index) => index < limit || important(session));
}

export function sidebarProjectNeedsAttention(sessions: readonly SidebarSession[], active: string | null): boolean {
  return sessions.some(session => session.path === active || session.runtimeId === active || session.running || session.activity === 'running' || !!session.pendingCount || session.failed || session.unreadCompletion);
}

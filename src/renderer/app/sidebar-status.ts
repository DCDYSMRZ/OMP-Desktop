import type { SidebarSession } from './sidebar-session';

/** Access/occupancy is not activity: saved and ready rows need no visual mark. */
export function sidebarStatus(session: SidebarSession): 'waiting' | 'failed' | 'running' | 'unread' | undefined {
  if (session.pendingCount) return 'waiting';
  if (session.failed) return 'failed';
  if ((!session.closed && session.running) || session.activity === 'running') return 'running';
  if (session.unreadCompletion) return 'unread';
  return undefined;
}

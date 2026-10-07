export interface SidebarRevealTarget { active: string | null; project?: string; visible: boolean; rowVisible: boolean }

/** Metadata/reordering is not navigation; reveal on selection or actual re-entry only. */
export function shouldRevealSidebar(previous: SidebarRevealTarget | undefined, next: SidebarRevealTarget): boolean {
  return !!next.active && next.visible && next.rowVisible && (!previous || previous.active !== next.active || previous.project !== next.project || !previous.visible || !previous.rowVisible);
}

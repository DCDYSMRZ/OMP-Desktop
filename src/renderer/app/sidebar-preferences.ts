import type { DesktopPreferences } from '../../shared/contracts';

export type SidebarPreferences = Pick<DesktopPreferences, 'hiddenProjects' | 'collapsedProjects' | 'sidebarStateMigrated'>;
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && /^(?:\/|[A-Za-z]:[\\/])/.test(value) && !/[\0\r\n]/.test(value);
const parse = (value: string | null): unknown => { try { return JSON.parse(value ?? 'null'); } catch { return null; } };

export function mergeSidebarPreferences(current: SidebarPreferences, hidden: string | null, collapsed: string | null): SidebarPreferences {
  const legacyHidden = parse(hidden), legacyCollapsed = parse(collapsed);
  const hiddenProjects = [...new Set([...current.hiddenProjects, ...(Array.isArray(legacyHidden) ? legacyHidden.filter(validPath) : [])])].slice(0, 200);
  const entries = legacyCollapsed && typeof legacyCollapsed === 'object' && !Array.isArray(legacyCollapsed) ? Object.entries(legacyCollapsed).filter(([path, value]) => validPath(path) && typeof value === 'boolean') as [string, boolean][] : [];
  const collapsedProjects = Object.fromEntries([...Object.entries(current.collapsedProjects), ...entries.filter(([path]) => !Object.hasOwn(current.collapsedProjects, path))].slice(0, 200));
  return { hiddenProjects, collapsedProjects, sidebarStateMigrated: true };
}

export async function migrateSidebarPreferences(current: () => SidebarPreferences, save: (patch: SidebarPreferences) => Promise<void>, storage: () => Pick<Storage, 'getItem' | 'removeItem'>): Promise<SidebarPreferences | undefined> {
  if (current().sidebarStateMigrated) return;
  const legacy = storage();
  const patch = mergeSidebarPreferences(current(), legacy.getItem('omp.sidebar.hiddenProjects'), legacy.getItem('omp.sidebar.collapsed'));
  await save(patch);
  legacy.removeItem('omp.sidebar.hiddenProjects');
  legacy.removeItem('omp.sidebar.collapsed');
  return patch;
}

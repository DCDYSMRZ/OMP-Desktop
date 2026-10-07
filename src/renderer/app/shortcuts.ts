/** Shared by renderer navigation and the native application menu. No DOM dependencies. */
export const shortcutDefinitions = [
  { id: 'new-session', binding: 'CommandOrControl+N', global: true },
  { id: 'open-workspace', binding: 'CommandOrControl+O', global: true },
  { id: 'palette', binding: 'CommandOrControl+K', global: true },
  { id: 'quick-open', binding: 'CommandOrControl+P', global: true },
  { id: 'search-messages', binding: 'CommandOrControl+Shift+F', global: true },
  { id: 'find', binding: 'CommandOrControl+F', global: true },
  { id: 'toggle-sidebar', binding: 'CommandOrControl+B', global: true },
  { id: 'toggle-panel', binding: 'CommandOrControl+Shift+B', global: true },
  { id: 'settings', binding: 'CommandOrControl+,', global: true },
  { id: 'shortcuts', binding: 'CommandOrControl+/', global: true },
  { id: 'close-tab', binding: 'CommandOrControl+W', global: true },
  { id: 'next-tab', binding: 'Control+Tab', global: true },
  { id: 'prev-tab', binding: 'Control+Shift+Tab', global: true },
  { id: 'jump-latest', binding: 'CommandOrControl+End', global: true },
  { id: 'stop', binding: 'CommandOrControl+Shift+Escape', global: true },
] as const;
export type ShortcutId = typeof shortcutDefinitions[number]['id'];
export type PaletteActionId = ShortcutId | 'open-files' | 'open-changes' | 'open-tasks' | 'open-session';
export const paletteActionIds: readonly PaletteActionId[] = [...shortcutDefinitions.map(item => item.id), 'open-files', 'open-changes', 'open-tasks', 'open-session'];
export function shortcutLabelKey(id: PaletteActionId): string { return `omp.palette.action.${id}`; }
export function shortcutKeycaps(id: PaletteActionId, platform: string): string[] {
  const binding = shortcutDefinitions.find(item => item.id === id)?.binding;
  if (!binding) return [];
  const mac = platform === 'darwin';
  return binding.split('+').map(key => key === 'CommandOrControl' ? mac ? '⌘' : 'Ctrl' : key === 'Control' ? mac ? '⌃' : 'Ctrl' : key === 'Shift' ? mac ? '⇧' : 'Shift' : key === 'Escape' ? 'Esc' : key);
}
export interface ShortcutEvent { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented?: boolean; isComposing?: boolean; keyCode?: number }
export function resolveShortcut(event: ShortcutEvent, platform: string, editable = false): ShortcutId | undefined {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey) return;
  if (event.key === '?' && !editable && !event.metaKey && !event.ctrlKey) return 'shortcuts';
  const mac = platform === 'darwin';
  return shortcutDefinitions.find(item => {
    if (editable && !item.global) return false;
    const parts = item.binding.split('+');
    const primary = parts.includes('CommandOrControl');
    return event.key.toLowerCase() === parts.at(-1)!.toLowerCase() && event.shiftKey === parts.includes('Shift') && event.metaKey === (primary && mac) && event.ctrlKey === (parts.includes('Control') || primary && !mac);
  })?.id;
}

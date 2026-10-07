/** Display-only history fallback. Never persist this translated label as a session name. */
export function displaySessionTitle(title: string | undefined, t: (key: string) => string): string {
  return !title || title === 'Untitled session' ? t('shell.untitledSession') : title;
}

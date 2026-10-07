import type { DesktopPreferences } from '../shared/contracts';

/** Closing a busy macOS window preserves its renderer and owned sessions. */
export function lifecycleDecision(action: 'close' | 'quit', platform: string, runningCount: number): 'hide' | 'confirm' | 'quit' {
  if (runningCount <= 0) return 'quit';
  return action === 'close' && platform === 'darwin' ? 'hide' : 'confirm';
}

export function quitDialogOptions(language: DesktopPreferences['language'], count: number) {
  return {
    type: 'warning' as const,
    title: 'OMP-Desktop',
    message: language === 'zh-CN' ? `有 ${count} 个会话正在运行，确定退出吗？` : `${count} ${count === 1 ? 'session is' : 'sessions are'} running. Quit anyway?`,
    detail: language === 'zh-CN' ? '退出会停止这些会话及其后台任务。' : 'Quitting will stop these sessions and their background tasks.',
    buttons: language === 'zh-CN' ? ['停止并退出', '取消'] : ['Stop and Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/** Strict IPC payload validation, independent of Electron for boundary tests. */
export function validateAttention(value: unknown): { badge: string; bounce?: 'informational' | 'critical' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid attention');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['badge', 'bounce'].includes(key)) || typeof input.badge !== 'string' || !/^(?:[1-9][0-9]{0,5})?$/.test(input.badge) || input.bounce !== undefined && input.bounce !== 'informational' && input.bounce !== 'critical') throw new TypeError('Invalid attention');
  return { badge: input.badge, bounce: input.bounce as 'informational' | 'critical' | undefined };
}

export function validateWindowTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid window title');
  return value;
}

export function validateNotification(value: unknown): { title: string; body: string; runtimeId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid notification');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['title', 'body', 'runtimeId'].includes(key))) throw new TypeError('Invalid notification');
  for (const [key, max] of [['title', 160], ['body', 320], ['runtimeId', 256]] as const) {
    const text = input[key];
    if (typeof text !== 'string' || !text.trim() || text.length > max || /[\x00-\x1f\x7f]/.test(text)) throw new TypeError(`Invalid notification ${key}`);
  }
  return input as { title: string; body: string; runtimeId: string };
}

export function shouldNotify(enabled: boolean, visible: boolean, focused: boolean): boolean {
  return enabled && (!visible || !focused);
}

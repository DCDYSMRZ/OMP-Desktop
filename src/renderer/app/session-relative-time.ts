import { useSyncExternalStore } from 'react';

let minute = Date.now();
let timer: number | undefined;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    minute = Date.now();
    timer = window.setInterval(() => { minute = Date.now(); for (const notify of listeners) notify(); }, 60_000);
  }
  return () => { listeners.delete(listener); if (!listeners.size) { window.clearInterval(timer); timer = undefined; } };
}
export function useSessionMinute(): number { return useSyncExternalStore(subscribe, () => minute); }

/** Compact historical time; calendar days follow the user's local timezone. */
export function formatSessionRelativeTime(timestamp: string, language: string, now: number): string | null {
  const updated = Date.parse(timestamp);
  if (!Number.isFinite(updated) || !Number.isFinite(now)) return null;
  const age = Math.max(0, now - updated);
  const zh = language.startsWith('zh');
  if (age < 60_000) return zh ? '刚刚' : 'now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}${zh ? '分' : 'm'}`;
  const date = new Date(updated), today = new Date(now);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return zh ? '昨天' : 'yesterday';
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}${zh ? '时' : 'h'}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

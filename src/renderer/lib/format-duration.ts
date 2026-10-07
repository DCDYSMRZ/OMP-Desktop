/** Elapsed-duration display shared by timelines, subagents, status and inbox. */
export type DurationStyle = 'units' | 'clock';

const SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR, WEEK = 7 * DAY, MONTH = 30 * DAY;
const UNITS = [['months', MONTH], ['weeks', WEEK], ['days', DAY], ['hours', HOUR], ['minutes', MINUTE], ['seconds', SECOND]] as const;
type Unit = typeof UNITS[number][0];
interface DurationFormatter { format(duration: Partial<Record<Unit, number>>): string }
type DurationFormatConstructor = new (locale: string, options: { style: 'narrow'; secondsDisplay?: 'always' }) => DurationFormatter;
// TypeScript 5.9 libs lack Intl.DurationFormat; Chromium 129+ and Node 23+ ship it.
const DurationFormat: DurationFormatConstructor = (Intl as unknown as { DurationFormat: DurationFormatConstructor }).DurationFormat;
const durationFormats = new Map<string, DurationFormatter>();
function durationFormat(locale: string, zero: boolean): DurationFormatter {
  const key = `${locale}:${zero}`;
  let formatter = durationFormats.get(key);
  if (!formatter) {
    formatter = new DurationFormat(locale, zero ? { style: 'narrow', secondsDisplay: 'always' } : { style: 'narrow' });
    durationFormats.set(key, formatter);
  }
  return formatter;
}

/**
 * `clock`: unbounded minutes and seconds (`147:39`).
 * `units`: promotes to the two most significant non-zero units, month → second (`2小时27分钟`, `2h 27m`, `3天4小时`).
 * Seconds appear only below one hour, so a running timer ticks visibly without becoming noisy.
 */
export function formatElapsed(ms: number, style: DurationStyle, locale: string): string {
  const total = Math.max(0, Math.floor(ms / SECOND)) * SECOND;
  if (style === 'clock') {
    const minutes = Math.floor(total / MINUTE), seconds = Math.floor((total % MINUTE) / SECOND);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  const parts: Partial<Record<Unit, number>> = {};
  let rest = total, count = 0;
  for (const [unit, size] of UNITS) {
    const value = Math.floor(rest / size);
    rest -= value * size;
    if (count === 0 && value === 0) continue;
    if (unit === 'seconds' && total >= HOUR) break;
    if (value > 0) parts[unit] = value;
    if (++count === 2) break;
  }
  const zero = !Object.keys(parts).length;
  if (zero) parts.seconds = 0;
  const english = !locale.toLowerCase().startsWith('zh');
  // Narrow English renders months as "m", indistinguishable from minutes.
  if (english && parts.months !== undefined) return [`${parts.months}mo`, parts.weeks !== undefined ? `${parts.weeks}w` : ''].filter(Boolean).join(' ');
  return durationFormat(english ? 'en' : 'zh-CN', zero).format(parts);
}

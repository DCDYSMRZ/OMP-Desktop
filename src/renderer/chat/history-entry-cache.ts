import type { TranscriptEntry } from './presentation';

/** Projection objects are immutable; unchanged raw rows/tools stop traversal immediately. */
function sameProjection(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameProjection(value, right[index]));
  if (Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameProjection(a[key], b[key]));
}

export function unchangedHistoryEntry(previous: TranscriptEntry, next: TranscriptEntry): boolean {
  if (previous.kind !== next.kind || previous.id !== next.id) return false;
  if (previous.kind === 'message' && next.kind === 'message') return previous.row === next.row;
  if (previous.kind !== 'assistant-turn' || next.kind !== 'assistant-turn') return false;
  return previous.nextPromptId === next.nextPromptId && previous.rows.length === next.rows.length && previous.rows.every((row, index) => row === next.rows[index]) && sameProjection(previous.parts, next.parts) && sameProjection(previous.presentation, next.presentation);
}

import type { HistoryMessage, ObservedTail } from './contracts';

/** Native IDs win; an unkeyed stream must match a newly persisted assistant fragment. */
export function presenceTailMatches(tail: ObservedTail, message: HistoryMessage): boolean {
  if (message.raw.role !== 'assistant') return false;
  if (tail.messageId && [message.id, message.entryId, message.raw.id].includes(tail.messageId)) return true;
  if (!Array.isArray(message.raw.content)) return false;
  const content = message.raw.content as Record<string, unknown>[];
  return tail.content.length > 0 && tail.content.every(part => content.some(row => row?.type === part.type && (part.type === 'text' ? typeof row.text === 'string' && row.text.includes(part.text) : typeof row.thinking === 'string' && row.thinking.includes(part.thinking))));
}

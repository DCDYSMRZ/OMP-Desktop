/** Renderer-only shape; callers project final answers before tool output. */
export type MinimapMessage = { id: string; role: string; content?: string; hasContent?: boolean };

export type ConversationMinimapMarker = {
  id: string;
  role: 'user' | 'assistant';
  preview: string;
};

export const CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS = 280;

/** Plain reading snippets, not a second Markdown surface. Keep fenced content. */
export function minimapPreview(source: string): string {
  return source
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s*\[[^\]]+\]:.*$/gm, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, '')
    .replace(/(`+)(.*?)\1/g, '$2')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=$|[\s).,!?:;])/g, '$1$2')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_{}[\]()#+.!>~-])/g, '$1')
    .split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).slice(0, 4).join('\n')
    .slice(0, CONVERSATION_MINIMAP_PREVIEW_MAX_CHARS);
}

/** Each projected entry owns its jump anchor; never merge across boundaries. */
export function buildConversationMinimapMarkers(messages: readonly MinimapMessage[]): ConversationMinimapMarker[] {
  return messages.flatMap(message => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const preview = minimapPreview(message.content || '');
    return preview || message.hasContent ? [{ id: message.id, role: message.role, preview }] : [];
  });
}

/** Ordered anchors: the entry at the reading line wins; equal tops prefer the later entry. */
export function activeMinimapIndex(count: number, atBottom: boolean, scrollTop: number, readingLine: number, topAt: (index: number) => number): number {
  if (!count) return -1;
  if (atBottom) return count - 1;
  if (scrollTop <= 1) return 0;
  let low = 0, high = count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (topAt(middle) <= readingLine) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

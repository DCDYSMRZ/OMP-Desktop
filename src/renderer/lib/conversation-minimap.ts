/** Renderer-only shape; callers project final answers before tool output. */
export type MinimapMessage = { id: string; role: string; content?: string };

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
    return preview ? [{ id: message.id, role: message.role, preview }] : [];
  });
}

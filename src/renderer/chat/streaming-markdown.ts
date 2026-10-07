import { revealPieces, type StreamingReveal } from './streaming-reveal';
import type { StreamingTailRange } from './streaming-tail';

type TextNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: TextNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };

/** Run after sanitization. Never rewrite code, math, or attribute values. */
export function rehypeStreamingText({ offset, raw, reveal }: { offset: number; raw: string; reveal?: StreamingReveal }) {
  return (tree: TextNode, file: { data: Record<string, unknown> }) => {
    const hidden = ((file.data.streamingTailRanges as StreamingTailRange[] | undefined) ?? []).map(range => ({ start: offset + range.start, end: offset + range.end }));
    if (!reveal?.glyphs.size && !hidden.length) return;
    const now = performance.now();
    const first = reveal?.glyphs.keys().next().value ?? Infinity;
    let last = first;
    if (reveal) for (const glyph of reveal.glyphs.values()) last = glyph.end;
    const visit = (node: TextNode) => {
      if (!node.children || node.tagName === 'code' || node.tagName === 'pre' || node.tagName === 'math' || node.tagName === 'table' || String(node.properties?.className ?? '').includes('katex')) return;
      node.children = node.children.flatMap(child => {
        const elementStart = child.position?.start.offset, elementEnd = child.position?.end.offset;
        if (child.tagName === 'a' && elementStart !== undefined && elementEnd !== undefined && hidden.some(range => range.start <= offset + elementStart && range.end >= offset + elementEnd)) return [];
        if (child.type !== 'text' || child.position?.start.offset === undefined || !child.value) { visit(child); return [child]; }
        const start = child.position.start.offset;
        const end = child.position.end.offset ?? start + child.value.length;
        // Entire settled blocks and the large settled prefix stay untouched.
        if ((offset + end <= first || offset + start >= last) && !hidden.some(range => range.start < offset + end && range.end > offset + start)) return [child];
        return revealPieces(child.value, raw.slice(start, end), offset + start, reveal, now, hidden).map(piece => piece.at === undefined
          ? { type: 'text', value: piece.text }
          : { type: 'element', tagName: 'span', properties: { 'data-reveal-offset': piece.offset, 'data-reveal-at': piece.at }, children: [{ type: 'text', value: piece.text }] });
      });
    };
    visit(tree);
  };
}

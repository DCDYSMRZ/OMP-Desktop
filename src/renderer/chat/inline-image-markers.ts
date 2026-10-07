import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { markdownRemarkPlugins } from '../lib/markdown-blocks';

type Node = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] };
const parser = unified().use(remarkParse).use(markdownRemarkPlugins);
const markerPattern = /\[Image #([1-9]\d*),\s*\d+[x×]\d+\]/g;
export function imageMarkers(value: string, count: number) {
  return Array.from(value.matchAll(markerPattern)).flatMap(match => {
    const index = Number(match[1]) - 1;
    return Number.isSafeInteger(index) && index < count ? [{ index, literal: match[0], start: match.index!, end: match.index! + match[0].length }] : [];
  });
}

/** Share Markdown's grammar; code, links and raw HTML are never image references. */
export function referencedImageIndices(sources: readonly string[], count: number): Set<number> {
  const indices = new Set<number>();
  if (!count) return indices;
  const visit = (node: Node) => {
    if (['code', 'inlineCode', 'link', 'linkReference', 'html', 'math', 'inlineMath'].includes(node.type)) return;
    if (node.type === 'text' && node.value) for (const marker of imageMarkers(node.value, count)) indices.add(marker.index);
    node.children?.forEach(visit);
  };
  for (const source of sources) if (source.includes('[Image #')) visit(parser.parse(source) as Node);
  return indices;
}

/** Run after sanitization and only with a user message's attachment count. */
export function rehypeInlineImageMarkers({ count }: { count: number }) {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children || ['pre', 'code', 'a', 'math', 'svg'].includes(node.tagName ?? '') || String(node.properties?.className ?? '').includes('katex')) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child]; }
        const matches = imageMarkers(child.value, count);
        if (!matches.length) return [child];
        const pieces: Node[] = [];
        let offset = 0;
        for (const marker of matches) {
          if (marker.start > offset) pieces.push({ type: 'text', value: child.value.slice(offset, marker.start) });
          pieces.push({ type: 'element', tagName: 'span', properties: { 'data-image-marker': marker.index, 'data-image-literal': marker.literal }, children: [{ type: 'text', value: marker.literal }] });
          offset = marker.end;
        }
        if (offset < child.value.length) pieces.push({ type: 'text', value: child.value.slice(offset) });
        return pieces;
      });
    };
    if (count) visit(tree);
  };
}

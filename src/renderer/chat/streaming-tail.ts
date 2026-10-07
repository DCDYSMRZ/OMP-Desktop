export type StreamingTailRange = { start: number; end: number };
type Node = { type: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
const whitespace = /\s/u;
const punctuation = /[\p{P}\p{S}]/u;

/** Record presentation-only omissions; parser input and source offsets never change. */
export function remarkStreamingTail({ raw, streaming }: { raw: string; streaming: boolean }) {
  return (tree: Node, file: { data: Record<string, unknown> }) => {
    if (!streaming) return;
    let tail = tree;
    while (tail.children?.length && !['paragraph', 'heading', 'tableCell'].includes(tail.type)) tail = tail.children[tail.children.length - 1];
    if (!['paragraph', 'heading', 'tableCell'].includes(tail.type)) return;
    const spans: StreamingTailRange[] = [];
    const collect = (node: Node) => {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (node.type === 'text' && start !== undefined && end !== undefined) spans.push({ start, end });
      else if (['paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete'].includes(node.type)) node.children?.forEach(collect);
    };
    collect(tail);
    const hidden: StreamingTailRange[] = [];
    let end = tail.position?.end.offset ?? raw.length;
    for (const span of spans) {
      for (let i = span.start; i < Math.min(span.end, end);) {
        const char = raw[i];
        if (char === '\\') { i += 2; continue; }
        // Unclosed math is not prose merely because its closing delimiter has
        // not arrived. Closed math/code/link nodes were excluded above.
        if (char === '$') {
          const marker = raw[i + 1] === '$' ? '$$' : '$';
          let close = raw.indexOf(marker, i + marker.length);
          while (close !== -1 && raw[close - 1] === '\\') close = raw.indexOf(marker, close + marker.length);
          if (close === -1 || close >= end) { end = i; break; }
          i = close + marker.length; continue;
        }
        if (char === '[') {
          let depth = 1, labelEnd = i + 1;
          for (; labelEnd < end; labelEnd++) {
            if (raw[labelEnd] === '\\') { labelEnd++; continue; }
            if (raw[labelEnd] === '[') depth++;
            if (raw[labelEnd] === ']' && --depth === 0) break;
          }
          if (raw[labelEnd + 1] === '(') {
            depth = 1;
            let cursor = labelEnd + 2;
            for (; cursor < end && depth; cursor++) {
              if (raw[cursor] === '\\') { cursor++; continue; }
              if (raw[cursor] === '(') depth++;
              if (raw[cursor] === ')') depth--;
            }
            if (depth) { hidden.push({ start: i, end: i + 1 }, { start: labelEnd, end }); end = labelEnd; }
          }
        }
        if (char === '`') {
          let next = i + 1;
          while (raw[next] === '`') next++;
          hidden.push({ start: i, end: next });
          end = i; break;
        }
        if (char !== '*' && char !== '_') { i++; continue; }
        let next = i + 1;
        while (raw[next] === char) next++;
        const before = raw[i - 1] ?? '', after = raw[next] ?? '';
        const beforeSpace = !before || whitespace.test(before), afterSpace = !after || whitespace.test(after);
        const beforePunctuation = punctuation.test(before), afterPunctuation = punctuation.test(after);
        const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
        const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
        if ((left && (char === '*' || !right || beforePunctuation)) || (next === end && (beforeSpace || beforePunctuation))) hidden.push({ start: i, end: next });
        i = next;
      }
    }
    if (hidden.length) file.data.streamingTailRanges = hidden.sort((a, b) => a.start - b.start);
  };
}

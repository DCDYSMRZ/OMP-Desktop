export interface DiffLine {
  type: 'add' | 'del' | 'context';
  text: string;
  oldLine?: number;
  newLine?: number;
  noNewline?: boolean;
}

export interface DiffHunk { header: string; lines: DiffLine[] }
export interface ParsedDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  state: 'text' | 'binary' | 'tooLarge' | 'noLineDetails';
  renamedFrom?: string;
  renamedTo?: string;
}

// Bound DOM work independently of the workspace service's byte limit. Counts
// still describe the entire patch, even when line details are withheld.
const MAX_PREVIEW_LINES = 5000;

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const result: ParsedDiff = { hunks: [], additions: 0, deletions: 0, state: 'noLineDetails' };
  let hunk: DiffHunk | undefined;
  let previous: DiffLine | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let lineCount = 0;
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '\\ No newline at end of file') {
      if (previous) previous.noNewline = true;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      hunk = { header: line, lines: [] };
      previous = undefined;
      if (result.state !== 'tooLarge') {
        result.hunks.push(hunk);
        result.state = 'text';
      }
      continue;
    }
    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      let parsed: DiffLine;
      if (line.startsWith('+') && newRemaining > 0) {
        parsed = { type: 'add', text: line.slice(1), newLine: newLine++ };
        newRemaining--;
        result.additions++;
      } else if (line.startsWith('-') && oldRemaining > 0) {
        parsed = { type: 'del', text: line.slice(1), oldLine: oldLine++ };
        oldRemaining--;
        result.deletions++;
      } else if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
        parsed = { type: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ };
        oldRemaining--;
        newRemaining--;
      } else {
        previous = undefined;
        continue;
      }
      previous = parsed;
      if (++lineCount <= MAX_PREVIEW_LINES) hunk.lines.push(parsed);
      else if (result.state !== 'tooLarge') {
        result.state = 'tooLarge';
        result.hunks = [];
      }
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') result.state = 'binary';
    else if (line.startsWith('rename from ')) result.renamedFrom = line.slice(12);
    else if (line.startsWith('rename to ')) result.renamedTo = line.slice(10);
    // File/index/mode metadata is intentionally not rendered as source lines.
  }
  if (result.state === 'text' && !lineCount) result.state = 'noLineDetails';
  return result;
}

export interface DiffWord { text: string; changed: boolean }

/** Word LCS preserves punctuation and whitespace; very long lines use bounded edge matching. */
export function diffWords(before: string, after: string): { before: DiffWord[]; after: DiffWord[] } {
  const a = before.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
  const b = after.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
  const left = a.map(text => ({ text, changed: true }));
  const right = b.map(text => ({ text, changed: true }));
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) {
    left[start].changed = right[start].changed = false; start++;
  }
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    left[--endA].changed = right[--endB].changed = false;
  }
  const rows = endA - start, columns = endB - start, stride = columns + 1;
  if (rows * columns <= 65536 && rows && columns) {
    const lengths = new Uint32Array((rows + 1) * stride);
    for (let i = rows - 1; i >= 0; i--) for (let j = columns - 1; j >= 0; j--) {
      lengths[i * stride + j] = a[start + i] === b[start + j]
        ? lengths[(i + 1) * stride + j + 1] + 1
        : Math.max(lengths[(i + 1) * stride + j], lengths[i * stride + j + 1]);
    }
    let i = 0, j = 0;
    while (i < rows && j < columns) {
      if (a[start + i] === b[start + j]) { left[start + i++].changed = right[start + j++].changed = false; }
      else if (lengths[(i + 1) * stride + j] >= lengths[i * stride + j + 1]) i++;
      else j++;
    }
  }
  return { before: left, after: right };
}

export interface ReviewDiffLine extends DiffLine { words?: DiffWord[] }
export type ReviewDiffRow = { kind: 'line'; before?: ReviewDiffLine; after?: ReviewDiffLine }
  | { kind: 'context'; id: number; lines: DiffLine[] };

/** Pair only adjacent replacement blocks, never across unchanged context. */
export function reviewDiffRows(lines: DiffLine[]): ReviewDiffRow[] {
  const rows: ReviewDiffRow[] = [];
  for (let index = 0; index < lines.length;) {
    const start = index;
    if (lines[index].type === 'context') {
      while (index < lines.length && lines[index].type === 'context') index++;
      const context = lines.slice(start, index);
      const visible = (line: DiffLine) => rows.push({ kind: 'line', before: line, after: line });
      if (context.length > 4) {
        context.slice(0, 2).forEach(visible);
        rows.push({ kind: 'context', id: start, lines: context.slice(2, -2) });
        context.slice(-2).forEach(visible);
      } else context.forEach(visible);
      continue;
    }
    const removed: DiffLine[] = [], added: DiffLine[] = [];
    while (index < lines.length && lines[index].type === 'del') removed.push(lines[index++]);
    while (index < lines.length && lines[index].type === 'add') added.push(lines[index++]);
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
      const before = removed[offset], after = added[offset];
      const words = before && after ? diffWords(before.text, after.text) : undefined;
      rows.push({ kind: 'line', before: before && { ...before, words: words?.before }, after: after && { ...after, words: words?.after } });
    }
  }
  return rows;
}

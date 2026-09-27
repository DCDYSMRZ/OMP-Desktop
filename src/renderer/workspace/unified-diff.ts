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

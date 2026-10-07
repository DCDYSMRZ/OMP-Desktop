import type { DiffLine, DiffHunk } from './unified-diff';

export interface ReviewReadingLine extends DiffLine { top: number; height: number; hunk: number }
export interface ReviewReading { target: string; top: number; line?: ReviewReadingLine; offset: number; hunk: number }

/** Capture the line at the reading edge, below the sticky file toolbar. */
export function captureReviewReading(target: string, top: number, edge: number, lines: readonly ReviewReadingLine[], hunk: number): ReviewReading {
  const line = lines.find(line => line.top + line.height > edge);
  return { target, top, line, offset: line ? line.top - edge : 0, hunk };
}

function distance(a: DiffLine, b: DiffLine): number {
  return a.newLine !== undefined && b.newLine !== undefined ? Math.abs(a.newLine - b.newLine) : a.oldLine !== undefined && b.oldLine !== undefined ? Math.abs(a.oldLine - b.oldLine) : Infinity;
}

/** Prefer surviving content, then its source coordinate when that content was edited. */
export function findReviewLine<T extends DiffLine>(line: DiffLine, lines: readonly T[]): T | undefined {
  let content: T | undefined, coordinate: T | undefined;
  for (const candidate of lines) {
    if (candidate.type !== line.type) continue;
    if (candidate.text === line.text && (!content || distance(line, candidate) < distance(line, content))) content = candidate;
    if (distance(line, candidate) === 0) coordinate = candidate;
  }
  return content ?? coordinate;
}

/** Only target navigation resets; a refreshed patch compensates the surviving line. */
export function restoreReviewReading(previous: ReviewReading | undefined, target: string, top: number, edge: number, lines: readonly ReviewReadingLine[]): { top: number; navigated: boolean } {
  if (!previous || previous.target !== target) return { top: 0, navigated: true };
  const line = previous.line && findReviewLine(previous.line, lines);
  return { top: line ? top + line.top - edge - previous.offset : previous.top, navigated: false };
}

export function retainReviewHunk(previous: DiffHunk | undefined, index: number, hunks: readonly DiffHunk[]): number {
  if (previous) {
    const line = previous.lines.find(line => line.type !== 'context') ?? previous.lines[0];
    const match = line && findReviewLine(line, hunks.flatMap(hunk => hunk.lines));
    const found = match ? hunks.findIndex(hunk => hunk.lines.includes(match)) : hunks.findIndex(hunk => hunk.header === previous.header);
    if (found >= 0) return found;
  }
  return Math.max(0, Math.min(index, hunks.length - 1));
}

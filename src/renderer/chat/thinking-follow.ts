/** C3: only downward user movement can resume, against the input's original bottom. */
export function resumeThinkingFollow(direction: number, bottomGap: number, contentGrowth: number): boolean {
  return direction > 0 && bottomGap - contentGrowth <= 8;
}

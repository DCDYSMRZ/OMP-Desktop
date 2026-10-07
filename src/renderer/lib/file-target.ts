export interface FileTarget { path: string; line?: number; endLine?: number }

/**
 * Split a trailing line selector off a file reference. Accepted suffixes:
 * `:N`, `:N-M`, `:N+K` (K lines from N) and GitHub-style `#LN` / `#LN-LM`.
 * Hashline anchors (`#AB12`) and Windows drive letters are left untouched.
 */
export function parseFileTarget(value: string): FileTarget {
  const hash = /^(.*)#L(\d+)(?:-L?(\d+))?$/.exec(value);
  const colon = hash ? null : /^(.+?):(\d+)(?:([-+])(\d+))?$/.exec(value);
  if (hash) {
    const line = Number(hash[2]);
    const end = hash[3] ? Number(hash[3]) : undefined;
    return { path: hash[1], line, endLine: end !== undefined && end >= line ? end : undefined };
  }
  if (!colon || /^[A-Za-z]$/.test(colon[1])) return { path: value };
  const line = Number(colon[2]);
  if (line < 1) return { path: value };
  const amount = colon[4] ? Number(colon[4]) : undefined;
  const endLine = amount === undefined ? undefined : colon[3] === '+' ? line + Math.max(0, amount - 1) : amount;
  return { path: colon[1], line, endLine: endLine !== undefined && endLine >= line ? endLine : undefined };
}

export function formatFileTarget({ path, line, endLine }: FileTarget): string {
  if (!line) return path;
  return endLine && endLine > line ? `${path}:${line}-${endLine}` : `${path}:${line}`;
}

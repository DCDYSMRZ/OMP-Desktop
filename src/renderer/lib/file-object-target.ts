import { parseFileTarget } from './file-target';

export function parseEditorTarget(value: string): { path: string; line?: number; column?: number } {
  const position = /^(.+):(\d+):(\d+)$/.exec(value);
  if (position) return Number.isSafeInteger(Number(position[2])) && Number(position[2]) > 0 && Number.isSafeInteger(Number(position[3])) && Number(position[3]) > 0 ? { path: position[1], line: Number(position[2]), column: Number(position[3]) } : { path: value };
  const { path, line } = parseFileTarget(value);
  return line !== undefined && (!Number.isSafeInteger(line) || line < 1) ? { path: value } : { path, ...(line ? { line } : {}) };
}

/** Copy a location, not the transcript's line selector; never grants filesystem access. */
export function fileObjectPath(cwd: string, path: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path)) return path;
  const separator = /^[A-Za-z]:|^\\\\/.test(cwd) ? '\\' : '/';
  return `${cwd.replace(/[\\/]$/, '')}${separator}${path}`;
}

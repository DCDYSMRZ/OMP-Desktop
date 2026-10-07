import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesktopPreferences } from '../shared/contracts';

export interface DesktopFileRequest { cwd: string; path: string; line?: number; column?: number }
export interface EditorCommand { executable: string; args: string[] }
const executeFile = promisify(execFile);

export function validateDesktopFileRequest(value: unknown, position = false): DesktopFileRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('File request must be an object');
  const request = value as Record<string, unknown>;
  for (const key of Object.keys(request)) if (!(position ? ['cwd', 'path', 'line', 'column'] : ['cwd', 'path']).includes(key)) throw new TypeError(`Unsupported field: ${key}`);
  for (const key of ['cwd', 'path']) if (typeof request[key] !== 'string' || !request[key].trim() || request[key].length > 4096 || /[\0\r\n]/.test(request[key])) throw new TypeError(`Invalid file ${key}`);
  for (const key of ['line', 'column']) if (request[key] !== undefined && (typeof request[key] !== 'number' || !Number.isSafeInteger(request[key]) || request[key] < 1)) throw new TypeError(`Invalid file ${key}`);
  if (request.column !== undefined && request.line === undefined) throw new TypeError('A column requires a line');
  return request as unknown as DesktopFileRequest;
}

/** Arguments remain distinct even for spaces, quotes, and shell metacharacters. */
export function editorCommand(editor: Exclude<DesktopPreferences['preferredEditor'], 'system'>, target: Pick<DesktopFileRequest, 'path' | 'line' | 'column'>, executable?: string, platform: NodeJS.Platform = process.platform): EditorCommand {
  const location = target.line ? `${target.path}:${target.line}${editor === 'zed' ? '' : `:${target.column ?? 1}`}` : target.path;
  const args = editor === 'zed' ? [location] : ['-g', location];
  if (executable) return { executable, args };
  if (platform !== 'darwin') throw new Error(`Install the ${editor === 'vscode' ? 'code' : editor} editor command on PATH`);
  return { executable: '/usr/bin/open', args: ['-a', editor === 'vscode' ? 'Visual Studio Code' : editor === 'cursor' ? 'Cursor' : 'Zed', '--args', ...args] };
}

export async function openInPreferredEditor(editor: DesktopPreferences['preferredEditor'], target: DesktopFileRequest, env: NodeJS.ProcessEnv, openPath: (path: string) => Promise<string>): Promise<void> {
  if (editor === 'system') {
    const error = await openPath(target.path);
    if (error) throw new Error(error);
    return;
  }
  const binary = editor === 'vscode' ? 'code' : editor;
  let executable: string | undefined;
  for (const directory of (env.PATH || '').split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, process.platform === 'win32' ? `${binary}.exe` : binary);
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) { executable = candidate; break; } } catch { /* Try the next PATH entry. */ }
  }
  const command = editorCommand(editor, target, executable);
  await executeFile(command.executable, command.args, { cwd: target.cwd, env, windowsHide: true, maxBuffer: 256 * 1024 });
}

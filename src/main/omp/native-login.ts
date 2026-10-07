import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionContext } from './cli';

const loginEnvironment = ['HOME', 'USERPROFILE', 'CFFIXED_USER_HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'PATH', 'TMPDIR', 'LANG', 'SHELL'] as const;
const quote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

/** No renderer arguments: every value comes from the resolved desktop execution context. */
export function nativeLoginScript(context: ExecutionContext): string {
  const environment = loginEnvironment.flatMap(key => context.env[key] === undefined ? [] : [`${key}=${context.env[key]}`]);
  const args = [context.executable, ...(context.profile ? ['--profile', context.profile] : []), 'login'];
  return `#!/bin/sh\ncd ${quote(context.cwd)} || exit 1\nexec /usr/bin/env -i ${[...environment, 'TERM=xterm-256color', ...args].map(quote).join(' ')}\n`;
}

export async function clearNativeLoginScripts(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export async function openNativeLogin(directory: string, context: ExecutionContext, openPath: (path: string) => Promise<string>): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, 'omp-login.command');
  await writeFile(path, nativeLoginScript(context), { mode: 0o700 });
  await chmod(path, 0o700);
  const error = await openPath(path);
  if (error) throw new Error(error);
}

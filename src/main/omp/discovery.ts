// GUI PATH/candidate strategy adapted from pi-desktop-master (Apache-2.0).
// Copyright 2026 HighlandJewls, PikkonMG, FaqFirebase. Modified for OMP-only discovery.
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import type { RuntimeInfo } from '../../shared/contracts';
import { capture } from './process';

/** Require OMP identity in the version output, not an arbitrary executable's semver. */
export function parseInstalledVersion(stdout: string): string {
  const match = /^(?:omp|oh-my-pi)(?:\/|[ \t]+)v?(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?$/.exec(stdout.trim());
  if (!match) throw new Error('Executable did not report a supported omp version');
  const version = `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ''}`;
  if (Number(match[1]) < 18 || (Number(match[1]) === 18 && Number(match[2]) < 3)) throw new Error(`omp ${version} is unsupported; install omp 18.3 or newer with rpc-ui protocol v2`);
  return version;
}

export async function resolveInstallation(override?: string): Promise<{ info: RuntimeInfo; env: NodeJS.ProcessEnv }> {
  const env = { ...process.env };
  const home = env.HOME || env.USERPROFILE || homedir();
  let shellWarning: string | undefined;
  if (process.platform !== 'win32') {
    const shell = env.SHELL || '/bin/zsh';
    const marker = '__OMP_DESKTOP_PATH__';
    const expression = basename(shell) === 'fish' ? '(string join : $PATH)' : '"$PATH"';
    try {
      const { stdout } = await capture(shell, ['-i', '-l', '-c', `printf '%s%s%s' '${marker}' ${expression} '${marker}'`], { cwd: home, env, maxBytes: 256 * 1024, timeoutMs: 5000 });
      const start = stdout.indexOf(marker);
      const end = stdout.indexOf(marker, start + marker.length);
      if (start < 0 || end < 0) throw new Error('Login shell did not report PATH');
      const shellPath = stdout.slice(start + marker.length, end);
      env.PATH = [...new Set([...(env.PATH || '').split(delimiter), ...shellPath.split(delimiter)].filter(Boolean))].join(delimiter);
    } catch (error) { shellWarning = error instanceof Error ? error.message : 'Login shell PATH discovery failed'; }
  }
  let explicit = override?.trim();
  if (explicit && ((explicit.startsWith('"') && explicit.endsWith('"')) || (explicit.startsWith("'") && explicit.endsWith("'")))) explicit = explicit.slice(1, -1);
  if (explicit?.startsWith('~/')) explicit = join(home, explicit.slice(2));
  if (explicit && !isAbsolute(explicit)) return { info: { available: false, error: 'The omp executable override must be an absolute file path, not a command or arguments' }, env };
  const binary = process.platform === 'win32' ? 'omp.exe' : 'omp';
  const known = [join(home, '.bun', 'bin'), join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.npm-packages', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  const candidates = explicit ? [explicit] : [...new Set([...(env.PATH || '').split(delimiter).filter(isAbsolute), ...known].map(directory => join(directory, binary)))];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) throw new Error('Executable path is not a file');
    } catch {
      if (explicit) return { info: { available: false, path: explicit, error: 'The configured omp executable does not exist or is not executable' }, env };
      continue;
    }
    const childEnv = { ...env, PATH: [...new Set([...(env.PATH || '').split(delimiter).filter(Boolean), dirname(candidate)])].join(delimiter) };
    try {
      const { stdout } = await capture(candidate, ['--version'], { cwd: home, env: childEnv, maxBytes: 64 * 1024, timeoutMs: 10000 });
      const version = parseInstalledVersion(stdout);
      return { info: { available: true, path: candidate, version }, env: childEnv };
    } catch (error) { failures.push(error instanceof Error ? error.message : 'Executable version verification failed'); }
  }
  return { info: { available: false, ...(explicit ? { path: explicit } : {}), error: failures.length ? failures.join('; ') : `No installed omp executable was found in PATH or known installation locations${shellWarning ? `; ${shellWarning}` : ''}` }, env };
}

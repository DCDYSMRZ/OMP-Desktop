import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { ExecutionContext } from './omp/cli';
import { resolveAgentRoots } from './data/roots';
import { isMissing } from './data/io';

const MARKER = /^\/\/ omp-desktop-presence v(\d+\.\d+\.\d+) \(managed by OMP-Desktop\)\r?\n/;
export interface PresenceInstallation { path: string; installedVersion: string | null; error?: string }
/** Packaged: extraResources beside app.asar. Unpacked: `<repo>/resources`, located from the main bundle (`<repo>/out/main`), independent of how Electron was launched. */
export function presenceResourcePath(packaged: boolean, resourcesPath: string, mainOutputDirectory: string): string {
  return packaged ? join(resourcesPath, 'omp-desktop-presence.ts') : join(mainOutputDirectory, '..', '..', 'resources', 'omp-desktop-presence.ts');
}
async function managedFile(path: string): Promise<{ text: string; version: string; dev: number; ino: number } | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 256 * 1024) throw new Error('Presence extension path is not a managed regular file');
    const text = await file.readFile('utf8'), version = MARKER.exec(text)?.[1];
    if (!version) throw new Error('Presence extension path contains an unmanaged file; it was left unchanged');
    return { text, version, dev: info.dev, ino: info.ino };
  } finally { await file.close(); }
}
export async function getPresenceInstallation(context: ExecutionContext): Promise<PresenceInstallation> {
  const path = join((await resolveAgentRoots(context)).agent, 'extensions', 'omp-desktop-presence.ts');
  try { return { path, installedVersion: (await managedFile(path))?.version ?? null }; }
  catch (error) { return { path, installedVersion: null, error: String(error) }; }
}
export async function syncPresenceInstallation(context: ExecutionContext, enabled: boolean, source: string): Promise<PresenceInstallation> {
  const path = join((await resolveAgentRoots(context)).agent, 'extensions', 'omp-desktop-presence.ts');
  const current = await managedFile(path);
  if (!enabled) { if (current) await unlink(path); return { path, installedVersion: null }; }
  const shipped = await managedFile(source);
  if (!shipped) throw new Error('Bundled presence extension is missing');
  if (current?.text === shipped.text) return { path, installedVersion: current.version };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(shipped.text); await file.sync(); } finally { await file.close(); }
    const latest = await managedFile(path);
    if (current && latest?.ino === current.ino && latest.dev === current.dev && latest.text === current.text) await rename(temporary, path);
    else if (!current && !latest) await link(temporary, path); // Atomic no-clobber first install.
    else throw new Error('Presence extension changed during installation; it was left unchanged');
  } finally { await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
  return { path, installedVersion: shipped.version };
}

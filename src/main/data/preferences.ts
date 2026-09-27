import { mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { DesktopPreferences } from '../../shared/contracts';
import { isMissing, readSmallFile, record } from './io';

const MAX_BYTES = 128 * 1024;
export const DEFAULT_PREFERENCES: DesktopPreferences = {
  theme: 'system', language: 'zh-CN', fontSize: 14, fontFamily: '', sidebarWidth: 260,
  panelWidth: 480, chatContentWidth: 760, executablePath: '', profile: '', lastWorkspace: '', recentWorkspaces: [],
  pinnedSessions: [], enterToSend: true,
};

export function normalizeProfile(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name || name === 'default') return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || name.endsWith('.') || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\..*)?$/i.test(name)) {
    throw new Error('Invalid OMP profile name');
  }
  return name;
}

function validPath(value: unknown, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= 4096 && !/[\0\r\n]/.test(value) && ((allowEmpty && value === '') || isAbsolute(value));
}

export function validatePreferences(value: unknown): Partial<DesktopPreferences> {
  if (!record(value)) throw new Error('Desktop preferences must be an object');
  for (const [key, item] of Object.entries(value)) {
    let valid = false;
    switch (key) {
      case 'theme': valid = item === 'system' || item === 'light' || item === 'dark'; break;
      case 'language': valid = item === 'zh-CN' || item === 'en'; break;
      case 'enterToSend': valid = typeof item === 'boolean'; break;
      case 'fontSize': valid = typeof item === 'number' && Number.isInteger(item) && item >= 10 && item <= 32; break;
      case 'sidebarWidth': valid = typeof item === 'number' && Number.isFinite(item) && item >= 180 && item <= 600; break;
      case 'panelWidth': valid = typeof item === 'number' && Number.isFinite(item) && item >= 1 && item <= Number.MAX_SAFE_INTEGER; break;
      case 'chatContentWidth': valid = typeof item === 'number' && Number.isFinite(item) && item >= 360 && item <= 1600; break;
      case 'fontFamily': valid = typeof item === 'string' && item.length <= 200 && !/[\x00-\x1f{};]/.test(item); break;
      case 'profile':
        valid = typeof item === 'string' && item.length <= 64;
        if (valid) normalizeProfile(item as string);
        break;
      case 'executablePath': case 'lastWorkspace': valid = validPath(item); break;
      case 'recentWorkspaces': valid = Array.isArray(item) && item.length <= 40 && item.every(path => validPath(path, false)) && new Set(item).size === item.length; break;
      case 'pinnedSessions': valid = Array.isArray(item) && item.length <= 200 && item.every(id => typeof id === 'string' && id.length > 0 && id.length <= 4096 && !/[\0\r\n]/.test(id)) && new Set(item).size === item.length; break;
      default: throw new Error(`Unknown desktop preference: ${key}`);
    }
    if (!valid) throw new Error(`Invalid desktop preference: ${key}`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error('Desktop preferences exceed size limit');
  return value as Partial<DesktopPreferences>;
}

async function canonicalWorkspaces(preferences: DesktopPreferences): Promise<DesktopPreferences> {
  const identities = new Map<string, string>();
  for (const path of [preferences.lastWorkspace, ...preferences.recentWorkspaces]) {
    if (!path || identities.has(path)) continue;
    let identity = path;
    try {
      const canonical = await realpath(path);
      if ((await stat(canonical)).isDirectory()) {
        identity = canonical;
        identities.set(canonical, canonical);
      }
    } catch (error) {
      // Keep labels for unavailable workspaces; a preference is not an access grant.
      const code = (error as NodeJS.ErrnoException).code;
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(code ?? '')) throw error;
    }
    identities.set(path, identity);
  }
  return { ...preferences, lastWorkspace: identities.get(preferences.lastWorkspace) ?? preferences.lastWorkspace, recentWorkspaces: [...new Set(preferences.recentWorkspaces.map(path => identities.get(path) ?? path))] };
}

export class PreferenceStore {
  private readonly path: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) { this.path = join(directory, 'desktop-preferences.json'); }

  private async read(): Promise<DesktopPreferences> {
    const text = await readSmallFile(this.path, MAX_BYTES);
    let parsed: unknown = {};
    if (text !== undefined) {
      try { parsed = JSON.parse(text); } catch { throw new Error(`Invalid desktop preferences JSON: ${this.path}`); }
    }
    return { ...DEFAULT_PREFERENCES, recentWorkspaces: [], pinnedSessions: [], ...validatePreferences(parsed) };
  }

  async get(): Promise<DesktopPreferences> {
    return canonicalWorkspaces(await this.read());
  }

  set(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences> {
    const validated = structuredClone(validatePreferences(patch));
    const next = this.pending.then(async () => {
      const preferences = await canonicalWorkspaces({ ...await this.read(), ...validated });
      validatePreferences(preferences);
      const serialized = `${JSON.stringify(preferences, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Desktop preferences exceed size limit');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(serialized); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
      } finally {
        try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw error; }
      }
      return preferences;
    });
    this.pending = next.catch(() => undefined); // A rejected caller must not poison later independent saves.
    return next;
  }
}

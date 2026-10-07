import { readFile, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { ExecutionContext } from './cli';
import { resolveAgentRoots } from '../data/roots';

/** A preview of the configured role, not an assertion of credentials or runtime readiness.
 * Native Settings own-layer order: global → project → config overlays;
 * main.ts uses getModelRole('default') when the desktop supplies no model flags.
 * Unhandled foreign project settings deliberately leave the preview unknown. */
export async function readConfiguredModel(context: ExecutionContext): Promise<string | undefined> {
  try {
    const { agent, env } = await resolveAgentRoots(context);
    const read = async (path: string): Promise<Record<string, unknown> | undefined> => {
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Config cannot be read safely');
        const document = parseDocument(await readFile(path, 'utf8'));
        if (document.errors.length) throw document.errors[0];
        const value: unknown = document.toJS();
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    const role = (value: Record<string, unknown> | undefined): unknown => { const roles = value?.modelRoles; return roles && typeof roles === 'object' && !Array.isArray(roles) ? (roles as Record<string, unknown>).default : undefined; };
    const global = await read(join(agent, 'config.yml')) ?? await read(join(agent, 'config.yaml'));
    let selected = role(global);
    const legacyProject = await read(join(context.cwd, '.omp', 'settings.json'));
    const nativeProject = await read(join(context.cwd, '.omp', 'config.yml'));
    const nativeRoles = nativeProject?.modelRoles;
    const projectRole = nativeRoles && typeof nativeRoles === 'object' && Object.hasOwn(nativeRoles, 'default') ? role(nativeProject) : role(legacyProject);
    if (typeof projectRole === 'string' && projectRole.trim()) selected = projectRole;
    else {
      for (const directory of ['.claude', '.cursor', '.gemini', '.pi']) if (await read(join(context.cwd, directory, 'settings.json'))) return undefined;
    }
    for (const file of (env.PI_CONFIG_FILES ?? '').split(delimiter).filter(Boolean)) {
      const path = file.startsWith('~/') ? join(env.HOME!, file.slice(2)) : resolve(context.cwd, file);
      const overlay = await read(path);
      if (!overlay) return undefined;
      const value = role(overlay);
      if (value !== undefined) selected = value;
    }
    return typeof selected === 'string' && /^[^\s/:,*@]+\/[^\s:,*@]+$/.test(selected) ? selected : undefined;
  } catch { return undefined; }
}

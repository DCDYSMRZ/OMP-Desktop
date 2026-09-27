import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { ExecutionContext } from '../omp/cli';
import { isMissing, readSmallFile } from './io';
import { normalizeProfile } from './preferences';

const DIRECTORY_KEYS = ['PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;

/** Native 18.3.2 utils/dirs.ts and utils/env.ts semantics, without migration helpers. */
export async function resolveHistoryRoots(context: ExecutionContext): Promise<{ sessions: string; archives: string; registry: string; blobs: string; terminals: string }> {
  const env = { ...context.env };
  const home = env.HOME || homedir();
  const profile = normalizeProfile(context.profile || (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE));
  const initialRoot = profile ? join(home, env.PI_CONFIG_DIR || '.omp', 'profiles', profile) : join(home, env.PI_CONFIG_DIR || '.omp');
  let inheritedProfile: string | undefined;
  // Native treats an invalid, shadowed legacy profile as absent for stale-override detection.
  try { inheritedProfile = normalizeProfile(env.PI_PROFILE); } catch { inheritedProfile = undefined; }
  let override = env.PI_CODING_AGENT_DIR;
  if (!profile && inheritedProfile && override === join(home, env.PI_CONFIG_DIR || '.omp', 'profiles', inheritedProfile, 'agent')) override = undefined;
  env.PI_CODING_AGENT_DIR = override;
  const initialAgent = !profile && override ? resolve(context.cwd, override) : join(initialRoot, 'agent');
  // Only directory values survive this read. Auth keys are neither retained nor exported.
  for (const file of [join(context.cwd, '.env'), join(initialAgent, '.env'), join(initialRoot, '.env'), join(home, '.env')]) {
    const text = await readSmallFile(file, 1024 * 1024);
    if (text === undefined) continue;
    const parsed = parseEnv(text);
    for (const key of DIRECTORY_KEYS) {
      const alias = key.startsWith('PI_') ? `OMP_${key.slice(3)}` : key;
      const value = parsed[alias] ?? parsed[key];
      if (!env[key] && value !== undefined) {
        if (value.includes('\0')) throw new Error(`Invalid native directory environment in ${file}`);
        env[key] = value;
      }
    }
  }
  const root = profile ? join(home, env.PI_CONFIG_DIR || '.omp', 'profiles', profile) : join(home, env.PI_CONFIG_DIR || '.omp');
  const defaultAgent = join(root, 'agent');
  const agent = !profile && env.PI_CODING_AGENT_DIR ? resolve(context.cwd, env.PI_CODING_AGENT_DIR) : defaultAgent;
  async function category(key: 'XDG_DATA_HOME' | 'XDG_STATE_HOME'): Promise<string> {
    if (agent !== defaultAgent || !['darwin', 'linux'].includes(process.platform) || !env[key]) return agent;
    const root = resolve(context.cwd, env[key]!);
    const candidate = profile ? join(root, 'omp', 'profiles', profile) : join(root, 'omp');
    try {
      if (!(await stat(candidate)).isDirectory()) throw new Error(`Native XDG root is not a directory: ${candidate}`);
      return candidate;
    } catch (error) { if (isMissing(error)) return agent; throw error; }
  }
  const data = await category('XDG_DATA_HOME');
  const state = await category('XDG_STATE_HOME');
  return { sessions: join(data, 'sessions'), archives: join(data, 'archive', 'sessions'), blobs: join(data, 'blobs'), registry: join(state, 'custom-session-files'), terminals: join(state, 'terminal-sessions') };
}

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { record } from './io';
import type { ModelName } from '../../shared/model-display-name';

export interface ModelCapacity { provider: string; id: string; name?: string; contextWindow: number; windowSource: 'runtime' | 'catalog' | 'config'; input?: string[]; remoteCompaction?: boolean; remoteCompactionV2?: boolean }
type CatalogModel = Omit<ModelCapacity, 'windowSource' | 'contextWindow'> & { contextWindow?: number; observedAt: number };
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Mirrors native route gates while persisting only booleans, never endpoint URLs or credentials. */
export function remoteCompactionCapabilities(model: Record<string, unknown>): { remoteCompaction?: boolean; remoteCompactionV2?: boolean } {
  if (typeof model.remoteCompaction === 'boolean') return { remoteCompaction: model.remoteCompaction, ...(typeof model.remoteCompactionV2 === 'boolean' ? { remoteCompactionV2: model.remoteCompactionV2 } : {}) };
  const remote = record(model.remoteCompaction) ? model.remoteCompaction : {};
  if (remote.enabled === false) return { remoteCompaction: false, remoteCompactionV2: false };
  const api = remote.api ?? model.api;
  if (typeof api !== 'string') return {};
  const responses = ['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(api);
  const remoteCompactionV2 = remote.v2StreamingEnabled === true && responses;
  if (model.provider === 'openai') return { remoteCompaction: true, remoteCompactionV2 };
  if (model.provider === 'openai-codex') return { remoteCompaction: typeof remote.endpoint === 'string' && remote.endpoint.trim().length > 0, remoteCompactionV2 };
  if (model.api !== 'anthropic-messages') return { remoteCompaction: remote.enabled === true && responses, remoteCompactionV2 };
  const compat = record(model.compat) ? model.compat : {};
  if (compat.supportsServerCompaction === undefined) return { remoteCompactionV2 };
  if (compat.supportsServerCompaction !== true) return { remoteCompaction: false, remoteCompactionV2 };
  if (model.transport === 'pi-native' && compat.firstPartyProvider === true) return { remoteCompaction: true, remoteCompactionV2 };
  const endpoint = model.provider === 'anthropic' ? process.env.ANTHROPIC_BASE_URL ?? model.baseUrl ?? 'https://api.anthropic.com' : model.baseUrl;
  let supported = false;
  if (typeof endpoint === 'string') try {
    const { hostname, pathname } = new URL(endpoint);
    supported = hostname === 'api.anthropic.com' || /^(?:[a-z0-9-]+[-.])?aiplatform\.googleapis\.com$/.test(hostname) || hostname.endsWith('.services.ai.azure.com') && (pathname === '/' || pathname === '/anthropic' || pathname.startsWith('/anthropic/')) || /^aws-external-anthropic\.[a-z0-9-]+\.api\.aws$/.test(hostname);
  } catch { /* An unresolved endpoint cannot establish eligibility. */ }
  return { remoteCompaction: supported && (compat.firstPartyProvider === true || model.provider === 'google-vertex' || remote.enabled === true), remoteCompactionV2 };
}

/** Allowlisted capacity/capability fields only; credentials/commands are not interpreted. */
export function capacityModels(value: unknown): Omit<ModelCapacity, 'windowSource'>[] {
  if (!Array.isArray(value)) return [];
  const models: Omit<ModelCapacity, 'windowSource'>[] = [];
  for (const item of value) if (record(item) && typeof item.provider === 'string' && typeof item.id === 'string' && positive(item.contextWindow)) {
    models.push({ provider: item.provider, id: item.id, ...(typeof item.name === 'string' ? { name: item.name } : {}), contextWindow: item.contextWindow, ...(Array.isArray(item.input) && item.input.every(value => typeof value === 'string') ? { input: item.input as string[] } : {}), ...remoteCompactionCapabilities(item) });
  }
  return models;
}
function catalogModels(value: unknown): Omit<CatalogModel, 'observedAt'>[] {
  if (!Array.isArray(value)) return [];
  const models: Omit<CatalogModel, 'observedAt'>[] = [];
  for (const item of value) {
    const capacity = capacityModels([item])[0];
    if (capacity) models.push(capacity);
    else if (record(item) && typeof item.provider === 'string' && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim()) models.push({ provider: item.provider, id: item.id, name: item.name });
  }
  return models;
}

export class ModelCapacityResolver {
  private readonly runtime = new Map<string, CatalogModel>();
  private readonly catalog = new Map<string, CatalogModel>();
  private loaded?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly catalogPath: string, private readonly agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent')) {}
  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      try {
        const saved: unknown = JSON.parse(await readFile(this.catalogPath, 'utf8'));
        if (!record(saved) || !Array.isArray(saved.models)) return;
        for (const item of saved.models) {
          const model = catalogModels([item])[0];
          if (model && record(item) && positive(item.observedAt)) this.catalog.set(JSON.stringify([model.provider, model.id]), { ...model, observedAt: item.observedAt });
        }
      } catch { /* A missing or corrupt cache does not invent a model window. */ }
    })();
  }
  capture(models: unknown): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const model of catalogModels(models)) {
      const key = JSON.stringify([model.provider, model.id]);
      const previous = this.runtime.get(key);
      if (previous?.contextWindow === model.contextWindow && previous?.name === model.name && previous?.remoteCompaction === model.remoteCompaction && previous?.remoteCompactionV2 === model.remoteCompactionV2 && JSON.stringify(previous?.input) === JSON.stringify(model.input)) continue;
      this.runtime.set(key, { ...model, observedAt: now });
      changed = true;
    }
    if (!changed) return this.writing;
    this.writing = this.writing.catch(() => {}).then(async () => {
      await this.load();
      for (const [key, model] of this.runtime) this.catalog.set(key, model);
      await mkdir(dirname(this.catalogPath), { recursive: true });
      const temporary = `${this.catalogPath}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, updatedAt: now, models: [...this.catalog.values()] }), { mode: 0o600 });
      await rename(temporary, this.catalogPath);
    });
    return this.writing;
  }
  async names(): Promise<ModelName[]> {
    await this.load();
    const names: ModelName[] = [];
    for (const [key, model] of this.catalog) if (!this.runtime.has(key) && model.name) names.push({ provider: model.provider, id: model.id, name: model.name });
    for (const model of this.runtime.values()) if (model.name) names.push({ provider: model.provider, id: model.id, name: model.name });
    return names;
  }
  async resolve(provider: string, id: string): Promise<ModelCapacity | undefined> {
    const key = JSON.stringify([provider, id]);
    const runtime = this.runtime.get(key);
    if (runtime && positive(runtime.contextWindow)) { const { observedAt: _, ...model } = runtime; return { ...model, contextWindow: runtime.contextWindow, windowSource: 'runtime' }; }
    await this.load();
    const cached = this.catalog.get(key);
    if (cached && positive(cached.contextWindow)) { const { observedAt: _, ...model } = cached; return { ...model, contextWindow: cached.contextWindow, windowSource: 'catalog' }; }
    for (const extension of ['yml', 'yaml', 'json']) {
      const path = join(this.agentDir, `models.${extension}`);
      try {
        if ((await stat(path)).size > 8 * 1024 * 1024) return;
        const content = await readFile(path, 'utf8');
        // parseDocument is inert: custom tags never execute shell/env credential resolvers.
        const document = parseDocument(content, { logLevel: 'silent' });
        if (document.errors.length) return;
        const config: unknown = document.toJS({ maxAliasCount: 100 });
        if (!record(config) || !record(config.providers)) return;
        const entry = config.providers[provider];
        if (!record(entry)) return;
        const models = Array.isArray(entry.models) ? entry.models : [];
        const base = models.find(model => record(model) && model.id === id);
        const override = record(entry.modelOverrides) ? entry.modelOverrides[id] : undefined;
        const model = capacityModels([{ api: entry.api, baseUrl: entry.baseUrl, ...(record(base) ? base : {}), ...(record(override) ? override : {}), provider, id }])[0];
        return model ? { ...model, windowSource: 'config' } : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // Never expose parser errors: they can contain credential-bearing source lines.
        return;
      }
    }
  }
}

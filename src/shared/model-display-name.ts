export interface ModelName { provider: string; id: string; name?: string }

/** Provider-scoped names; the persisted source is the host's existing model catalog. */
export class ModelDisplayNames {
  private catalog = new Map<string, string>();
  private cached = new Map<string, string>();
  private revision = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.revision;
  capture(models: readonly ModelName[], source: 'catalog' | 'cached') {
    const target = source === 'catalog' ? this.catalog : this.cached;
    let changed = false;
    for (const model of models) {
      const name = model.name?.trim();
      if (!name) continue;
      const key = JSON.stringify([model.provider, model.id]);
      if (target.get(key) === name) continue;
      target.set(key, name); changed = true;
    }
    if (changed) { this.revision++; for (const listener of this.listeners) listener(); }
  }
  displayName(provider: string | undefined, id: string): string {
    let modelId = id;
    let modelProvider = provider ?? '';
    if (modelProvider && modelId.startsWith(`${modelProvider}/`)) modelId = modelId.slice(modelProvider.length + 1);
    else if (!modelProvider && modelId.includes('/')) { const slash = modelId.indexOf('/'); modelProvider = modelId.slice(0, slash); modelId = modelId.slice(slash + 1); }
    const key = JSON.stringify([modelProvider, modelId]);
    return this.catalog.get(key) ?? this.cached.get(key) ?? id;
  }
}
export const modelNames = new ModelDisplayNames();
export const modelDisplayName = (provider: string | undefined, id: string): string => modelNames.displayName(provider, id);

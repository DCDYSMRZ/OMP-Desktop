import type { ConfigEntry } from '../../shared/contracts';

export interface CompactionModel { input?: readonly string[]; remoteCompaction?: boolean; remoteCompactionV2?: boolean }
export interface CompactionPolicy { enabled: boolean; threshold?: number; speculationStart?: number; source: 'config' | 'default'; reserve?: number; budgetReserve?: number; method?: string; eligibilityUnknown?: boolean }
const defaults = ['remote', 'snapcompact', 'handoff', 'shake', 'soft'];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Port of omp's reserve, threshold and first-available-method policy. Not a prediction of an individual compaction. */
export function compactionPolicy(window: number, entries: readonly ConfigEntry[] = [], model?: CompactionModel, enabledOverride?: boolean): CompactionPolicy {
  const settings = new Map(entries.filter(entry => entry.key.startsWith('compaction.')).map(entry => [entry.key.slice(11), entry.value]));
  const enabled = (enabledOverride ?? settings.get('enabled') !== false) && settings.get('strategy') !== 'off';
  const policy: CompactionPolicy = { enabled, source: entries.length ? 'config' : 'default' };
  if (!enabled || !Number.isFinite(window) || window <= 0) return policy;
  const configuredReserve = settings.get('reserveTokens');
  const reserve = finite(configuredReserve) && configuredReserve >= 0 ? configuredReserve : undefined;
  const proportional = Math.max(1, Math.floor(window * .15));
  const R = Math.max(Math.floor(window * .15), reserve ?? 16384);
  const B = R >= window || reserve === undefined && R >= window - proportional ? proportional : R;
  const tokens = settings.get('thresholdTokens'), percent = settings.get('thresholdPercent');
  const H = finite(tokens) && tokens > 0 ? Math.min(window - 1, Math.max(1, tokens))
    : finite(percent) && percent > 0 ? Math.floor(window * Math.min(99, Math.max(1, percent)) / 100)
    : Math.max(0, Math.min(window - 1, window - B));
  Object.assign(policy, { threshold: H, reserve: R, budgetReserve: B });
  if (settings.get('asyncEnabled') === false || settings.get('experimentalContextManagement') === true) return policy;
  const configuredOrder = settings.get('methodOrder');
  const order = Array.isArray(configuredOrder) ? configuredOrder.filter((value): value is string => typeof value === 'string' && defaults.includes(value)) : defaults;
  for (const method of order) {
    if (method === 'remote') {
      const endpoint = settings.get('remoteEndpoint');
      const available = typeof endpoint === 'string' && endpoint.length > 0 || settings.get('remoteStreamingV2Enabled') !== false && model?.remoteCompactionV2 === true ? true : model?.remoteCompaction;
      if (available === undefined) { policy.eligibilityUnknown = true; break; }
      if (!available) continue;
    }
    if (method === 'snapcompact') {
      if (!model?.input) { policy.eligibilityUnknown = true; break; }
      if (!model.input.includes('image')) continue;
    }
    policy.method = method;
    if (method === 'remote' || method === 'handoff' || method === 'soft') {
      const lead = Math.min(32000, Math.max(8192, Math.floor(H * .125)));
      policy.speculationStart = Math.max(0, H - lead);
    }
    break;
  }
  return policy;
}


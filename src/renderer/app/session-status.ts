import type { SessionUsageSummary } from '../../shared/contracts';
import { record } from '../chat/model';

const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Only unpersisted sessions use native active-window statistics. Reject cross-session replies. */
export function sessionStatusUsage(value: unknown, sessionId: string): SessionUsageSummary | null {
  const data = record(value);
  if (data.sessionId !== sessionId) return null;
  const tokens = record(data.tokens);
  return { incomplete: false, input: number(tokens.input), output: number(tokens.output), cacheRead: number(tokens.cacheRead), cacheWrite: number(tokens.cacheWrite), total: number(tokens.total), cost: number(data.cost), premiumRequests: number(data.premiumRequests) };
}

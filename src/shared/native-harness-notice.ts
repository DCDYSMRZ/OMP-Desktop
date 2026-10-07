export interface NativeMessageNotice { tone: 'info' | 'error'; text: string }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';

/** Exact native harness protocol notices are neutral control flow, not tool failures. */
export function nativeHarnessNotice(value: unknown): NativeMessageNotice | undefined {
  const raw = object(value), details = object(raw.details);
  const content = typeof raw.content === 'string' ? raw.content : Array.isArray(raw.content) ? raw.content.map(block => string(object(block).text)).join('\n') : string(raw.errorMessage);
  // agent-loop.createSkippedToolResult carries authoritative execution markers; older journals retain only its text envelope.
  const nativeSkip = details.source === 'interrupt_skipped' && ((details.__synthetic === true && details.executed === false) || (details.__interrupted === true && details.execution === 'started'));
  const source = content.trim();
  const skipEnvelope = /^Skipped due to [^\r\n]+\. Do not count this skipped result as completed work or verification\./.test(source);
  const legacySkip = /^Skipped due to (?:pending (?:parent )?steering message|pending (?:system advisory|peer interrupt)|queued user message|a queued background completion(?: \(job or supervised process\))?)\.(?:\s|$)/.test(source);
  if (nativeSkip || details.skipped === true || details.interrupted === true || skipEnvelope || legacySkip || /^Wait interrupted by message(?:[.\n]|$)/.test(source)) return { tone: 'info', text: source };
  return undefined;
}

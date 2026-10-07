import type { NativeSubagent } from './contracts';

export interface NativeAsyncDeliveryJob {
  /** Job-manager identity, NOT a child agent alias. */
  id: string; type: 'task' | 'bash' | 'eval' | 'unknown';
  agentId?: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown';
  label?: string; agent?: string; durationMs?: number; duration?: string;
  observedAt?: unknown;
  result?: string; error?: string; abortReason?: string;
  meta?: unknown; schema?: unknown; raw: unknown; content?: string; ambiguous: boolean;
}
export interface NativeAsyncDelivery { jobs: NativeAsyncDeliveryJob[]; diagnostics: string[]; content: unknown; residualContent: unknown[] }
const MAX_TEXT = 1024 * 1024;
const MAX_JOBS = 10000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

const deliveryCache = new WeakMap<object, { content: unknown; details: unknown; revision: unknown; value: NativeAsyncDelivery | null }>();

/** Parse only builder-delimited job sections. Text and URIs never grant source authority. */
export function parseNativeAsyncDelivery(message: unknown): NativeAsyncDelivery | null {
  if (!record(message) || (message.role !== 'custom' && message.type !== 'custom_message') || message.customType !== 'async-result') return null;
  const cached = deliveryCache.get(message);
  if (cached && cached.content === message.content && cached.details === message.details && cached.revision === message.revision) return cached.value;
  const value = parseAsyncDelivery(message);
  deliveryCache.set(message, { content: message.content, details: message.details, revision: message.revision, value });
  return value;
}

/** Native message snapshots retain immutable content/details within a revision. */
function parseAsyncDelivery(message: Record<string, unknown>): NativeAsyncDelivery {
  const content = message.content;
  const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [content];
  const details = record(message.details) ? message.details : {};
  const rows = Array.isArray(details.jobs) ? details.jobs : [];
  const diagnostics: string[] = [];
  const jobs: NativeAsyncDeliveryJob[] = [];
  const diagnose = (reason: string) => { if (diagnostics.length < 100 && !diagnostics.includes(reason)) diagnostics.push(reason); };
  const counts = new Map<string, number>();
  for (const row of rows.slice(0, MAX_JOBS)) {
    if (!record(row) || typeof row.jobId !== 'string' || !ID.test(row.jobId)) { diagnose('A native background delivery has an invalid job identity.'); continue; }
    counts.set(row.jobId, (counts.get(row.jobId) ?? 0) + 1);
    jobs.push({ id: row.jobId, type: row.type === 'task' || row.type === 'bash' || row.type === 'eval' ? row.type : 'unknown', status: 'unknown', label: string(row.label), durationMs: typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) && row.durationMs >= 0 ? row.durationMs : undefined, meta: row.meta, schema: row.schema, raw: row, ambiguous: false });
  }
  const textBlocks = blocks.filter((block): block is Record<string, unknown> & { text: string } => record(block) && block.type === 'text' && typeof block.text === 'string');
  if (rows.length > MAX_JOBS || textBlocks.reduce((sum, block) => sum + block.text.length, 0) > MAX_TEXT) {
    diagnose('Native background delivery exceeds its parsing bounds; original content remains available.');
    for (const job of jobs) job.ambiguous = true;
    return { jobs, diagnostics, content, residualContent: blocks };
  }
  // Native builder emits one text block. Multiple text blocks remain visible but cannot prove a section association.
  if (textBlocks.length !== 1 || !jobs.length || jobs.length !== rows.length) {
    diagnose('Native background delivery has no unambiguous job sections.');
    for (const job of jobs) job.ambiguous = true;
    return { jobs, diagnostics, content, residualContent: blocks };
  }
  const source = textBlocks[0]!.text;
  const segments = new Map<string, string[]>();
  let framingValid = true;
  if (jobs.length === 1) {
    const job = jobs[0]!;
    const prefix = `<system-notice>\nBackground job ${job.id} has completed. Resume your work using the result below.\n`;
    // Unwrapped single-job payloads also occur in stored/native fixtures. A lone envelope is the job payload, not a URI-derived alias.
    const body = source.startsWith(prefix) && source.endsWith('\n</system-notice>') ? source.slice(prefix.length, -'\n</system-notice>'.length) : source;
    segments.set(job.id, [body]);
  } else {
    const markers = [...source.matchAll(/^── Job ([A-Za-z0-9][A-Za-z0-9_.-]{0,199})(?: \([^\r\n]*\))? ──$/gm)];
    // Native 95defa712b used the terse introduction; the section grammar did not change.
    framingValid = markers.length === jobs.length && (source.startsWith(`<system-notice>\n${jobs.length} background jobs have completed. Resume your work using the results below.\n\n`) || source.startsWith(`<system-notice>\n${jobs.length} Background jobs done. Resume with results below.\n\n`)) && source.endsWith('\n</system-notice>');
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index]!;
      const body = source.slice(marker.index! + marker[0].length + 1, markers[index + 1]?.index ?? source.length - '\n</system-notice>'.length);
      const previous = segments.get(marker[1]!) ?? []; previous.push(body); segments.set(marker[1]!, previous);
    }
  }
  for (const job of jobs) {
    const parts = segments.get(job.id);
    if (!framingValid || counts.get(job.id) !== 1 || parts?.length !== 1) { job.ambiguous = true; diagnose(`Ambiguous native job section: ${job.id}.`); continue; }
    job.content = parts[0]!;
    if (job.type !== 'task') { job.result = job.content; continue; }
    const envelopes = [...job.content.matchAll(/<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/g)];
    const envelope = envelopes[0];
    const identities = envelopes.map(item => /^ id="([^"<>\r\n]{1,200})" agent="[^"<>\r\n]{1,256}" status="[^"<>\r\n]{1,64}" duration="[^"<>\r\n]{1,64}"$/.exec(item[1]!)?.[1]);
    if (identities.length && identities.every(id => id === identities[0] && typeof id === 'string' && ID.test(id))) job.agentId = identities[0];
    const header = envelope && /^ id="([^"<>\r\n]{1,200})" agent="([^"<>\r\n]{1,256})" status="([^"<>\r\n]{1,64})" duration="([^"<>\r\n]{1,64})"$/.exec(envelope[1]!);
    if (envelopes.length !== 1 || (job.content.match(/<task-result\b/g)?.length ?? 0) !== 1 || (job.content.match(/<\/task-result>/g)?.length ?? 0) !== 1 || !header || !ID.test(header[1]!)) { job.ambiguous = true; diagnose(`Malformed or ambiguous native task-result for ${job.id}; settlement is unknown.`); continue; }
    const body = envelope![2]!;
    const outputs = [...body.matchAll(/<(output|preview)(?: full-output="[^"<>]*")?>\n([\s\S]*?)\n<\/\1>/g)];
    const prefix = outputs[0]?.index === undefined ? '' : body.slice(0, outputs[0].index);
    const errors = [...prefix.matchAll(/<error>([\s\S]*?)<\/error>/g)];
    const aborts = [...prefix.matchAll(/<abort-reason>([\s\S]*?)<\/abort-reason>/g)];
    const exit = /^failed \(exit (-?[0-9]+)\)$/.exec(header[3]!);
    const status = header[3] === 'completed' ? 'completed' : header[3] === 'cancelled' ? 'aborted' : header[3] === 'merge failed' || (exit && Number.isSafeInteger(Number(exit[1])) && Number(exit[1]) !== 0) ? 'failed' : 'unknown';
    if (outputs.length !== 1 || errors.length > 1 || aborts.length > 1 || (errors.length && status !== 'failed') || (aborts.length && status !== 'aborted')) { job.ambiguous = true; diagnose(`Ambiguous native task-result body for ${job.id}.`); continue; }
    job.agentId = header[1]; job.agent = header[2]; job.duration = header[4]; job.status = status;
    job.result = outputs[0]![2]; job.error = errors[0]?.[1]; job.abortReason = aborts[0]?.[1];
    if (status === 'failed' && !job.error) job.error = job.result;
    if (status === 'unknown') diagnose(`Unknown native task-result status for ${job.id}.`);
  }
  const allSegmented = jobs.every(job => job.content !== undefined);
  return { jobs, diagnostics, content, residualContent: allSegmented ? blocks.filter(block => block !== textBlocks[0]) : blocks };
}

/** Consuming wait/cancel snapshots are an independent native settlement channel. Job IDs never identify children. */
export function parseNativeJobSnapshot(message: unknown): NativeAsyncDelivery | null {
  if (!record(message) || message.role !== 'toolResult' || !['wait', 'jobs', 'cancel'].includes(String(message.toolName))) return null;
  const details = record(message.details) ? message.details : {};
  if (!Array.isArray(details.jobs)) return null;
  const jobs: NativeAsyncDeliveryJob[] = [];
  const diagnostics: string[] = [];
  for (const value of details.jobs.slice(0, MAX_JOBS)) {
    if (!record(value) || typeof value.id !== 'string' || !ID.test(value.id)) continue;
    const parsed = typeof value.resultText === 'string' ? parseNativeAsyncDelivery({ role: 'custom', customType: 'async-result', details: { jobs: [{ jobId: value.id, type: value.type }] }, content: value.resultText })?.jobs[0] : undefined;
    const alias = typeof value.agentUrlId === 'string' && ID.test(value.agentUrlId) ? value.agentUrlId : parsed?.agentId;
    const ambiguous = !!(parsed?.ambiguous || alias && parsed?.agentId && alias !== parsed.agentId);
    const status = ambiguous ? 'unknown' : parsed && parsed.status !== 'unknown' ? parsed.status : value.status === 'completed' || value.status === 'failed' || value.status === 'running' ? value.status : value.status === 'cancelled' ? 'aborted' : value.queued === true ? 'pending' : 'unknown';
    jobs.push({ ...parsed, id: value.id, agentId: alias, type: value.type === 'task' || value.type === 'bash' || value.type === 'eval' ? value.type : 'unknown', status, ambiguous, raw: value, label: string(value.label), durationMs: typeof value.durationMs === 'number' ? value.durationMs : undefined, error: parsed?.error ?? string(value.errorText), result: parsed?.result ?? string(value.resultText) });
    if (ambiguous) diagnostics.push(`Ambiguous native job snapshot: ${value.id}.`);
  }
  return { jobs, diagnostics, content: message.content, residualContent: [] };
}

export function subsetNativeAsyncDelivery(delivery: NativeAsyncDelivery, jobs: NativeAsyncDeliveryJob[], includeResidual = false): NativeAsyncDelivery {
  return { ...delivery, jobs, diagnostics: includeResidual ? delivery.diagnostics : [], residualContent: includeResidual ? delivery.residualContent : [] };
}

/** Authorized roster + actual earlier task call only. Job IDs, names and proximity are not ownership. */
export function resolveNativeTaskOwnership(delivery: NativeAsyncDelivery, agents: readonly NativeSubagent[], anchors: readonly { toolCallId: string; messageIndex: number }[], deliveryIndex: number): { linked: { job: NativeAsyncDeliveryJob; agent: NativeSubagent; toolCallId: string }[]; unlinked: { job: NativeAsyncDeliveryJob; reason: string }[] } {
  const linked: { job: NativeAsyncDeliveryJob; agent: NativeSubagent; toolCallId: string }[] = [];
  const unlinked: { job: NativeAsyncDeliveryJob; reason: string }[] = [];
  const aliases = new Map<string, NativeSubagent[]>();
  const callsById = new Map<string, { toolCallId: string; messageIndex: number }[]>();
  for (const agent of agents) {
    const alias = agent.nativeId ?? (agent.historical ? undefined : agent.id);
    if (!alias) continue;
    const matches = aliases.get(alias);
    if (matches) matches.push(agent); else aliases.set(alias, [agent]);
  }
  for (const anchor of anchors) {
    const calls = callsById.get(anchor.toolCallId);
    if (calls) calls.push(anchor); else callsById.set(anchor.toolCallId, [anchor]);
  }
  for (const job of delivery.jobs) {
    let reason = '';
    const matches = job.agentId ? aliases.get(job.agentId) ?? [] : [];
    const agent = matches.length === 1 ? matches[0] : undefined;
    const calls = agent?.parentToolCallId ? callsById.get(agent.parentToolCallId) ?? [] : [];
    if (job.type !== 'task') reason = 'Non-task background job';
    else if (job.ambiguous || !job.agentId) reason = 'Task delivery identity is unverified';
    else if (matches.length > 1) reason = 'Task alias matches multiple authorized children';
    else if (!agent) reason = 'Task alias is not in this authorized child roster';
    else if (calls.length !== 1 || calls[0]!.messageIndex >= deliveryIndex) reason = 'Original task call is unavailable or ambiguous in this history window';
    if (reason) unlinked.push({ job, reason });
    else linked.push({ job, agent: agent!, toolCallId: calls[0]!.toolCallId });
  }
  return { linked, unlinked };
}

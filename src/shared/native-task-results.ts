export interface NativeTaskDeliveryJob {
  id: string;
  status: 'completed' | 'failed' | 'aborted' | 'unknown';
  label?: string;
  agent?: string;
  durationMs?: number;
  duration?: string;
  result?: string;
  error?: string;
  abortReason?: string;
}
export interface NativeTaskDelivery { jobs: NativeTaskDeliveryJob[]; diagnostics: string[] }

const MAX_TEXT = 1024 * 1024;
const MAX_JOBS = 10000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const short = (value: unknown, limit = 4096): string | undefined => typeof value === 'string' ? value.slice(0, limit) : undefined;

/** Native async deliveries are evidence about existing tasks, never filesystem authority.
 * Header grammar follows coding-agent/task/result-summary.ts and task-summary.md.
 * Do not infer settlement from the surrounding notification ("has completed").
 */
export function parseNativeTaskDelivery(message: unknown): NativeTaskDelivery | null {
  if (!record(message) || (message.role !== 'custom' && message.type !== 'custom_message') || message.customType !== 'async-result' || !record(message.details) || !Array.isArray(message.details.jobs)) return null;
  const jobs = new Map<string, NativeTaskDeliveryJob>();
  const duplicates = new Set<string>();
  const diagnostics: string[] = [];
  const diagnose = (reason: string) => { if (diagnostics.length < 100 && !diagnostics.includes(reason)) diagnostics.push(reason); };
  let invalid = message.details.jobs.length > MAX_JOBS;
  for (const row of message.details.jobs.slice(0, MAX_JOBS)) {
    if (!record(row) || row.type !== 'task') continue;
    if (typeof row.jobId !== 'string' || !ID.test(row.jobId)) { diagnose('A native task delivery has an invalid job identity.'); continue; }
    if (jobs.has(row.jobId)) { duplicates.add(row.jobId); diagnose(`Duplicate native task delivery identity: ${row.jobId}.`); continue; }
    jobs.set(row.jobId, { id: row.jobId, status: 'unknown', label: short(row.label), ...(typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) && row.durationMs >= 0 ? { durationMs: row.durationMs } : {}) });
  }
  if (!jobs.size) return diagnostics.length || invalid ? { jobs: [], diagnostics: [...diagnostics, ...(invalid ? ['Native task delivery exceeds the job bound.'] : [])] } : null;
  let content = '';
  if (typeof message.content === 'string') content = message.content;
  else if (Array.isArray(message.content) && message.content.length <= MAX_JOBS) {
    for (const block of message.content) {
      if (record(block) && block.type === 'text' && typeof block.text === 'string') {
        if (content.length + block.text.length + 1 > MAX_TEXT) { invalid = true; break; }
        content += `${content ? '\n' : ''}${block.text}`;
      }
    }
  } else invalid = true;
  if (content.length > MAX_TEXT || invalid) {
    diagnose('Native task delivery exceeds its parsing bounds or has invalid content.');
    return { jobs: [...jobs.values()], diagnostics };
  }
  const openings = content.match(/<task-result\b/g)?.length ?? 0;
  const closings = content.match(/<\/task-result>/g)?.length ?? 0;
  if (openings !== closings || openings > MAX_JOBS) {
    diagnose('Malformed or excessive native task-result envelopes; settlement is unknown.');
    return { jobs: [...jobs.values()], diagnostics };
  }

  const seen = new Set<string>();
  const envelopes = /<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/g;
  let count = 0;
  for (const match of content.matchAll(envelopes)) {
    count++;
    // Exact native header: duplicate/extra attributes and embedded envelopes are ambiguous.
    const header = /^ id="([^"<>\r\n]{1,200})" agent="([^"<>\r\n]{1,256})" status="([^"<>\r\n]{1,64})" duration="([^"<>\r\n]{1,64})"$/.exec(match[1]!);
    if (!header || !ID.test(header[1]!) || /<\/?task-result\b/.test(match[2]!)) { invalid = true; continue; }
    const id = header[1]!;
    if (seen.has(id)) { duplicates.add(id); diagnose(`Duplicate native task-result header: ${id}.`); }
    seen.add(id);
    const job = jobs.get(id);
    if (!job) continue;
    const status = header[3]!;
    const exit = /^failed \(exit (-?[0-9]+)\)$/.exec(status);
    job.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'aborted' : status === 'merge failed' || (exit && Number.isSafeInteger(Number(exit[1])) && Number(exit[1]) !== 0) ? 'failed' : 'unknown';
    job.agent = header[2];
    job.duration = header[4];
    if (job.status === 'unknown') diagnose(`Unknown native task-result status for ${id}.`);
    const body = match[2]!;
    const outputs = [...body.matchAll(/<(output|preview)(?: full-output="[^"<>]*")?>\n([\s\S]*?)\n<\/\1>/g)];
    const prefix = outputs[0]?.index === undefined ? '' : body.slice(0, outputs[0].index);
    const errors = [...prefix.matchAll(/<error>([\s\S]*?)<\/error>/g)];
    const aborts = [...prefix.matchAll(/<abort-reason>([\s\S]*?)<\/abort-reason>/g)];
    if (outputs.length !== 1 || errors.length > 1 || aborts.length > 1 || (errors.length > 0 && job.status !== 'failed') || (aborts.length > 0 && job.status !== 'aborted')) { duplicates.add(id); diagnose(`Ambiguous native task-result body for ${id}.`); continue; }
    job.result = short(outputs[0]![2], 8192);
    job.error = short(errors[0]?.[1]);
    job.abortReason = short(aborts[0]?.[1]);
    if (job.status === 'failed' && !job.error) job.error = job.result;
  }
  if (count !== openings) invalid = true;
  if (invalid) diagnose('Malformed or ambiguous native task-result envelope; settlement is unknown.');
  for (const job of jobs.values()) {
    if (invalid || duplicates.has(job.id)) {
      job.status = 'unknown';
      delete job.agent; delete job.duration; delete job.result; delete job.error; delete job.abortReason;
    } else if (!seen.has(job.id)) diagnose(`No matching native task-result header for ${job.id}; settlement is unknown.`);
  }
  return { jobs: [...jobs.values()], diagnostics };
}

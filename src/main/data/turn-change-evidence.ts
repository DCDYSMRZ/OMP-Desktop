import { createHash } from 'node:crypto';
import type { HistoryMessage, HistoryTranscriptPage, NativeMessage, NativeSubagent, SessionResourceContext } from '../../shared/contracts';
import type { CollectedTurnEvidence, FileChangeEvidence } from '../../shared/turn-change-types';
import { normalizeToolEvidence } from '../../shared/change-net';
import { HistoryReader, HistoryRevisionChangedError } from './journal';
import { SessionResources } from './session-resources';
import { record } from './io';

export interface TurnEvidenceInput {
  context: SessionResourceContext; anchorId: string; toolCallIds?: string[];
  runtime?: { parentPath: string; sessionId: string; cwd: string; children: NativeSubagent[]; leafId?: string | null };
  onStart?: (metadata: CollectedTurnEvidence) => void;
  onOperation?: (operation: FileChangeEvidence) => void;
}
interface Source { page: HistoryTranscriptPage; context: SessionResourceContext; children?: NativeSubagent[]; childContext: SessionResourceContext; }
interface Interval { start: HistoryMessage; end?: HistoryMessage; unknownLate: boolean; late: boolean; }
interface ChildDelivery { start: number; end: number; from: string; }
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const time = (message: HistoryMessage): number | undefined => typeof message.raw.timestamp === 'number' && Number.isFinite(message.raw.timestamp) ? message.raw.timestamp : undefined;
function calls(message: HistoryMessage): { id: string; name: string; args: unknown }[] {
  if (message.raw.role !== 'assistant' || !Array.isArray(message.raw.content)) return [];
  return message.raw.content.filter(record).filter(block => block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string').map(block => ({ id: String(block.id), name: String(block.name).replace(/^functions\./, ''), args: block.arguments }));
}
function request(raw: NativeMessage): boolean {
  if (raw.display === false) return false;
  if (raw.role === 'user') return raw.attribution !== 'agent' && (raw.synthetic !== true || raw.userInitiated === true);
  return (raw.role === 'custom' || raw.role === 'hookMessage') && raw.display === true && raw.attribution === 'user' && (raw.customType === 'skill-prompt' || raw.customType === 'collab-prompt');
}
function childAssignment(raw: NativeMessage): boolean {
  // Native task assignments are agent-attributed too; only explicit steering is coordination.
  return request(raw) || raw.role === 'user' && raw.display !== false && (raw.synthetic !== true || raw.userInitiated === true) && !(raw.attribution === 'agent' && raw.steering === true);
}
function boundary(raw: NativeMessage): boolean { return raw.role === 'branchSummary' || raw.customType === 'reset_boundary'; }

/** Authorized native journals, streamed in bounded metadata pages. No history-length quotas or workspace fallback. */
export class TurnChangeEvidenceReader {
  constructor(private readonly reader: HistoryReader, private readonly resources: SessionResources) {}

  async collect(input: TurnEvidenceInput): Promise<CollectedTurnEvidence> {
    const reasons = new Set<string>(), operations: FileChangeEvidence[] = [], validations = new Map<string, string>();
    const visited = new Set<string>();
    let pending = false;
    const note = (reason: string) => { if (reasons.size < 100) reasons.add(reason); };
    const failure = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof HistoryRevisionChangedError || /changed|stale/.test(message)) throw new HistoryRevisionChangedError();
      note(message);
    };
    const diagnose = (items: string[]) => {
      for (const item of items) {
        if (/^(?:Default view follows the last persisted entry|Record at byte \d+ exceeds 16 MiB;|Archive is read-only\.|Complete historical EOF record accepted without a final newline$|Compaction .* (?:contains unavailable archive frames|archive omits \d+ characters)$|Saved image |Invalid image blob reference;|Image [a-f0-9]+ unavailable:)/.test(item)) continue;
        note(item);
      }
    };
    const nativeId = (source: Source, entry: HistoryMessage) => entry.entryId ?? entry.id.slice(source.page.session.id.length + 1);
    const hydrate = async (source: Source, entry: HistoryMessage): Promise<HistoryMessage> => {
      if (entry.raw.historyResourceDeferred !== true) return entry;
      try {
        const detail = await this.reader.readEvidenceEntry({ path: source.page.session.path, revision: source.page.revision, entryId: nativeId(source, entry) });
        return { ...entry, raw: detail.raw };
      } catch (error) { failure(error); note(`Native entry ${entry.id} payload is unavailable`); return entry; }
    };
    const load = async (context: SessionResourceContext, rosterChild?: NativeSubagent): Promise<Source> => {
      let page: HistoryTranscriptPage, children: NativeSubagent[] | undefined, childContext = context;
      if (context.kind === 'saved' && context.subagentId) {
        const saved = await this.resources.readHistorySubagent({ ...context, subagentId: context.subagentId });
        if (!saved.navigation) throw new Error(saved.diagnostics.join(' ') || 'Authorized child journal unavailable');
        diagnose(saved.diagnostics);
        page = await this.reader.readEvidence({ path: saved.session.path, leafId: saved.selectedLeafId, revision: saved.revision });
        children = saved.navigation.children;
        childContext = { kind: 'saved', parentPath: context.parentPath, leafId: context.leafId, ancestry: saved.navigation.childAncestry };
      } else if (context.kind === 'runtime' && context.subagentId) {
        const child = rosterChild ?? input.runtime?.children.find(item => item.id === context.subagentId);
        if (!input.runtime || !child?.sessionFile) throw new Error('Owned runtime child journal unavailable');
        const authorized = await this.resources.readRuntimeSubagent({ parentPath: input.runtime.parentPath, childPath: child.sessionFile, subagentId: child.nativeId ?? child.id });
        diagnose(authorized.diagnostics);
        page = await this.reader.readEvidence({ path: authorized.session.path, leafId: authorized.selectedLeafId, revision: authorized.revision });
        childContext = { kind: 'saved', parentPath: page.session.path, leafId: page.selectedLeafId };
      } else {
        const path = context.kind === 'saved' ? context.parentPath : input.runtime?.parentPath;
        if (!path) throw new Error('Owned parent journal unavailable');
        const leafId = context.kind === 'saved' ? context.leafId : input.runtime?.leafId;
        if (context.kind === 'runtime' && leafId === undefined) throw new Error('Native selected branch unavailable');
        page = await this.resources.readEvidenceParent({ path, leafId });
        childContext = { kind: 'saved', parentPath: page.session.path, leafId: page.selectedLeafId };
      }
      const previous = validations.get(page.session.path);
      if (previous !== undefined && previous !== page.revision) throw new HistoryRevisionChangedError();
      validations.set(page.session.path, page.revision); diagnose(page.diagnostics);
      return { page, context, children, childContext };
    };
    const reader = this.reader;
    async function* rows(source: Source): AsyncGenerator<HistoryMessage> {
      let before: string | undefined;
      do {
        const page = await reader.readEvidence({ path: source.page.session.path, leafId: source.page.selectedLeafId, revision: source.page.revision, before, forward: true });
        for (const entry of page.messages) yield entry;
        const next = page.hasMore ? page.nextBefore : undefined;
        if (page.hasMore && (!next || next === before)) throw new Error('Evidence metadata page cannot advance');
        before = next;
      } while (before);
    }
    const locate = async (source: Source): Promise<Interval> => {
      let current: HistoryMessage | undefined, direct: Interval | undefined, fallback: Interval | undefined, ambiguous = false;
      const wanted = new Set(input.toolCallIds ?? []);
      for await (const entry of rows(source)) {
        const starts = input.context.subagentId ? childAssignment(entry.raw) : request(entry.raw);
        const unknown = entry.raw.historyEvidenceUnknown === true;
        if (starts || boundary(entry.raw) || unknown) {
          for (const interval of [direct, fallback]) if (interval && !interval.end) interval.end = entry;
          current = starts ? entry : undefined;
        }
        for (const interval of [direct, fallback]) if (unknown && interval?.end) interval.unknownLate = true;
        if (entry.id === input.anchorId || entry.entryId === input.anchorId) {
          if (!current) throw new Error('Selected turn beginning is unavailable');
          direct = { start: current, unknownLate: false, late: true };
        }
        if (current && calls(entry).some(call => wanted.has(call.id))) {
          if (!fallback) fallback = { start: current, unknownLate: false, late: true };
          else if (fallback.start.id !== current.id) ambiguous = true;
        }
      }
      const selected = direct ?? (!ambiguous ? fallback : undefined);
      if (!selected) throw new Error('Selected turn anchor is not verified on the authorized branch');
      if (selected.end?.raw.historyEvidenceUnknown === true) note('Selected turn end crosses unavailable native metadata');
      return selected;
    };
    const childInterval = async (source: Source, deliveries: ChildDelivery[]): Promise<Interval | undefined> => {
      let interval: Interval | undefined, assigned = false, terminal = false, automatic = false, worked = false;
      let acceptedAt: number | undefined;
      const yields = new Map<string, { incremental: boolean; complete: boolean }>();
      for await (const metadata of rows(source)) {
        if (metadata.raw.historyEvidenceUnknown === true) { note(`Child generation boundary is unavailable in ${metadata.id}`); if (interval) interval.end = metadata; break; }
        const assignment = childAssignment(metadata.raw);
        if (assignment && (assigned || terminal || worked) || boundary(metadata.raw)) { if (interval) interval.end = metadata; break; }
        if (assignment) assigned = true;
        if (metadata.raw.customType === 'async-result' || metadata.raw.role === 'user' && metadata.raw.synthetic === true && metadata.raw.userInitiated !== true) automatic = true;
        const steering = metadata.raw.role === 'user' && metadata.raw.attribution === 'agent' && metadata.raw.steering === true;
        const irc = metadata.raw.role === 'custom' && metadata.raw.attribution === 'agent' && metadata.raw.customType === 'irc:incoming' && metadata.raw.display === true;
        if (terminal && (steering || irc)) {
          const sentAt = time(metadata), startedAt = interval ? time(interval.start) : undefined;
          if (steering && sentAt !== undefined && startedAt !== undefined && acceptedAt !== undefined && sentAt >= startedAt && sentAt <= acceptedAt) automatic = true;
          if (sentAt !== undefined) {
            const message = irc ? await hydrate(source, metadata) : metadata;
            const sender = record(message.raw.details) ? str(message.raw.details.from) : '';
            const matches = deliveries.filter(delivery => sentAt >= delivery.start && sentAt <= delivery.end && (!irc || sender === delivery.from));
            if (matches.length === 1) { automatic = true; deliveries.splice(deliveries.indexOf(matches[0]!), 1); }
          }
        }
        if (terminal && metadata.raw.role === 'assistant') {
          if (!automatic) { note(`Later child continuation excluded without original-task ownership: ${source.page.session.id}`); if (interval) interval.end = metadata; break; }
          terminal = false; automatic = false;
        }
        interval ??= { start: metadata, unknownLate: false, late: false };
        const entry = calls(metadata).some(call => call.name === 'yield') || metadata.raw.role === 'toolResult' && str(metadata.raw.toolName).replace(/^functions\./, '') === 'yield' ? await hydrate(source, metadata) : metadata;
        if (entry.raw.role === 'assistant') worked = true;
        for (const call of calls(entry)) if (call.name === 'yield' && record(call.args)) yields.set(call.id, { incremental: Array.isArray(call.args.type), complete: call.args.complete === true });
        if (entry.raw.role === 'toolResult' && str(entry.raw.toolName).replace(/^functions\./, '') === 'yield' && entry.raw.isError !== true) {
          const args = yields.get(str(entry.raw.toolCallId)), details = record(entry.raw.details) ? entry.raw.details : {};
          yields.delete(str(entry.raw.toolCallId));
          if (args && details.status === 'success' && (!args.incremental || args.complete || details.complete === true)) { terminal = true; automatic = false; acceptedAt = time(entry); }
        }
      }
      if (!terminal) { pending = true; note(`Original child task has no accepted terminal yield: ${source.page.session.id}`); }
      return interval;
    };
    const collectInterval = async (source: Source, interval: Interval, origin?: { parentToolCallId?: string; label: string }): Promise<string[]> => {
      const tools: string[] = [];
      let selected = false, sequence = 0;
      for await (const metadata of rows(source)) {
        if (metadata.id === interval.end?.id) break;
        if (metadata.id === interval.start.id) selected = true;
        if (!selected) continue;
        sequence++;
        if (!calls(metadata).length && metadata.raw.role !== 'toolResult') continue;
        const entry = metadata.raw.role === 'toolResult' ? metadata : await hydrate(source, metadata);
        const candidates = entry.raw.role === 'toolResult' ? [{ id: str(entry.raw.toolCallId), name: str(entry.raw.toolName).replace(/^functions\./, ''), args: undefined }] : calls(entry);
        for (const call of candidates) {
          if (!call.id || !call.name) continue;
          const matched = await reader.matchEvidenceTool({ path: source.page.session.path, revision: source.page.revision, leafId: source.page.selectedLeafId, startId: nativeId(source, interval.start), endId: interval.end ? nativeId(source, interval.end) : undefined, toolId: call.id, entryId: nativeId(source, entry), result: entry.raw.role === 'toolResult', late: interval.late && !interval.unknownLate });
          if (entry.raw.role === 'toolResult' && matched.count > 0) continue;
          if (entry.raw.role !== 'toolResult' && matched.count !== 1) { note(`Ambiguous native tool identity in ${source.page.session.id}: ${call.id}`); continue; }
          tools.push(call.id);
          const result = entry.raw.role === 'toolResult' ? await hydrate(source, entry) : matched.result ? await hydrate(source, matched.result) : undefined;
          if (entry.raw.role === 'toolResult') note(`Tool result ${entry.id} has no available call evidence`);
          if (!result) { pending = true; note(`Tool evidence ${source.page.session.id}:${call.id} is pending${matched.reused ? ' because its late identity was reused' : ''}`); }
          else if (result.raw.historyResourceDeferred === true) note(`Tool evidence ${source.page.session.id}:${call.id} content is unavailable`);
          const normalized = normalizeToolEvidence({ source: { sessionId: source.page.session.id, cwd: source.page.session.cwd, sourcePath: source.page.session.path, context: source.context, ...origin }, toolId: call.id, entryId: nativeId(source, entry), resultEntryId: result ? nativeId(source, result) : undefined, name: call.name, args: call.args, result: result?.raw, status: !result || result.raw.historyResourceDeferred === true && result.raw.historyEvidenceIndexed !== true ? 'running' : result.raw.isError === true ? 'error' : 'complete', sequence, timestamp: time(result ?? entry) });
          for (const operation of normalized) { if (input.onOperation) input.onOperation(operation); else operations.push(operation); }
        }
      }
      return tools;
    };
    let evidence: CollectedTurnEvidence = { id: createHash('sha256').update(JSON.stringify([input.context, input.anchorId])).digest('hex'), sessionId: input.runtime?.sessionId ?? '', cwd: input.runtime?.cwd ?? '', operations, toolCallIds: [], complete: false, reasons: [], pending: false };
    try {
      const source = await load(input.context);
      if (input.context.kind === 'runtime' && !input.context.subagentId && source.page.session.id !== input.runtime?.sessionId) throw new HistoryRevisionChangedError();
      const interval = await locate(source), initiating = await hydrate(source, interval.start);
      const startEntryId = interval.start.entryId;
      const beforeEntryId = startEntryId ? await reader.entryPredecessor({ path: source.page.session.path, revision: source.page.revision, entryId: startEntryId }) : undefined;
      const aliases = [...new Set([str(initiating.raw.id), str(initiating.raw.messageId)].filter(Boolean))];
      evidence = { ...evidence, id: createHash('sha256').update(JSON.stringify([source.page.session.path, source.page.session.id, startEntryId ?? interval.start.id])).digest('hex'), sessionId: source.page.session.id, cwd: source.page.session.cwd, sourcePath: source.page.session.path, startEntryId, startMessageId: aliases[0], startMessageIds: aliases, beforeEntryId, exactInterval: true, startedAt: time(initiating), endedAt: interval.end ? time(interval.end) : undefined };
      const parentTools = new Set<string>();
      let inParent = false;
      for await (const entry of rows(source)) {
        if (entry.id === interval.end?.id) break;
        if (entry.id === interval.start.id) inParent = true;
        if (inParent) for (const call of calls(entry)) parentTools.add(call.id);
      }
      evidence.toolCallIds = [...parentTools];
      // Capture binding uses verified native request/predecessor identity, never accumulated payloads.
      input.onStart?.({ ...evidence, operations: [], reasons: [], pending: true });
      const queue: { source: Source; interval: Interval; origin?: { parentToolCallId?: string; label: string } }[] = [{ source, interval }];
      visited.add(`${source.page.session.path}:${source.page.selectedLeafId}`);
      while (queue.length) {
        const work = queue.shift()!;
        let tools: string[];
        try { tools = await collectInterval(work.source, work.interval, work.origin); } catch (error) { failure(error); continue; }
        if (work.source === source) evidence.toolCallIds = [...new Set(tools)];
        const tasks = new Set<string>();
        let inInterval = false;
        for await (const entry of rows(work.source)) {
          if (entry.id === work.interval.end?.id) break;
          if (entry.id === work.interval.start.id) inInterval = true;
          if (!inInterval) continue;
          for (const call of calls(entry)) if (call.name === 'task') tasks.add(call.id);
        }
        if (!tasks.size) continue;
        let children = work.source.children;
        if (!children) {
          try { const listing = await this.resources.listHistorySubagents({ path: work.source.page.session.path, leafId: work.source.page.selectedLeafId }); children = listing.subagents; diagnose(listing.diagnostics); }
          catch (error) { failure(error); children = []; }
        }
        const candidates = children.filter(child => !!child.parentToolCallId && tasks.has(child.parentToolCallId));
        if (work.source.context.kind === 'runtime' && !work.source.context.subagentId) for (const child of input.runtime?.children ?? []) if (child.parentToolCallId && tasks.has(child.parentToolCallId) && !candidates.some(saved => (saved.nativeId ?? saved.id) === (child.nativeId ?? child.id))) candidates.push(child);
        for (const task of tasks) if (!candidates.some(child => child.parentToolCallId === task)) { pending = true; note(`Task ${work.source.page.session.id}:${task} has no authorized child evidence`); }
        const deliveries = new Map<string, ChildDelivery[]>();
        const recipients = new Set(candidates.map(child => child.nativeId ?? child.id));
        inInterval = false;
        for await (const entry of rows(work.source)) {
          if (entry.id === work.interval.end?.id) break;
          if (entry.id === work.interval.start.id) inInterval = true;
          if (!inInterval) continue;
          for (const call of calls(entry)) {
            const recipient = call.name === 'write' && record(call.args) ? /^agent:\/\/([^/]+)$/.exec(str(call.args.path))?.[1] : undefined;
            const start = time(entry);
            if (!recipient || !recipients.has(recipient) || start === undefined) continue;
            const matched = await reader.matchEvidenceTool({ path: work.source.page.session.path, revision: work.source.page.revision, leafId: work.source.page.selectedLeafId, startId: nativeId(work.source, work.interval.start), endId: work.interval.end ? nativeId(work.source, work.interval.end) : undefined, toolId: call.id, entryId: nativeId(work.source, entry), result: false, late: false });
            if (matched.count !== 1 || !matched.result) continue;
            const result = await hydrate(work.source, matched.result), end = time(result);
            const details = record(result.raw.details) ? result.raw.details : {};
            const delivery = record(details.message) ? details.message : {};
            if (result.raw.isError !== false || end === undefined || end < start || delivery.op !== 'send' || delivery.to !== recipient || !str(delivery.from) || !Array.isArray(delivery.receipts) || !delivery.receipts.some(receipt => record(receipt) && receipt.to === recipient && (receipt.outcome === 'injected' || receipt.outcome === 'woken'))) continue;
            const selected = deliveries.get(recipient) ?? [];
            selected.push({ start, end, from: str(delivery.from) });
            deliveries.set(recipient, selected);
          }
        }
        for (const child of candidates) {
          try {
            const native = work.source.context.kind === 'runtime' && !work.source.context.subagentId && input.runtime?.children.includes(child);
            const context: SessionResourceContext = native ? { kind: 'runtime', runtimeId: work.source.context.kind === 'runtime' ? work.source.context.runtimeId : '', subagentId: child.id } : { ...work.source.childContext, subagentId: child.id };
            const nested = await load(context, native ? child : undefined), key = `${nested.page.session.path}:${nested.page.selectedLeafId}`;
            if (visited.has(key)) { note('Duplicate or cyclic child task source excluded'); continue; }
            visited.add(key);
            const selected = await childInterval(nested, deliveries.get(child.nativeId ?? child.id) ?? []);
            if (selected) queue.push({ source: nested, interval: selected, origin: { parentToolCallId: child.parentToolCallId, label: child.description || child.agent || child.id } });
          } catch (error) { failure(error); }
        }
      }
    } catch (error) { failure(error); }
    for (const [path, revision] of validations) if (await reader.revision(path) !== revision) throw new HistoryRevisionChangedError();
    return { ...evidence, complete: reasons.size === 0 && !pending, pending, reasons: [...reasons] };
  }
}

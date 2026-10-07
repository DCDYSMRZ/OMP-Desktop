import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { NativeFrame, NativeState, NativeSubagent, RecordedFileChange, RuntimeEvent } from '../../shared/contracts';
import type { CollectedTurnEvidence, FileChangeEvidence, TurnChangeEvent, TurnChangeResult } from '../../shared/turn-change-types';
import { ChangeNetAccumulator, resolveFinalChanges } from '../../shared/change-net';
import { TurnSnapshotStore, type WorkspaceSnapshot } from './turn-snapshots';

interface CaptureRecord {
  id: string; runtimeId: string; sessionId: string; cwd: string; requestedCwd: string; sourcePath?: string; submissionId?: string; requestId?: string; beforeEntryId?: string | null;
  before?: WorkspaceSnapshot; after?: WorkspaceSnapshot; files?: RecordedFileChange[]; releaseResult?: () => void;
  tools: Set<string>; userAliases: Set<string>; userCount: number; userOpen: boolean; generation: number;
  state: 'preparing' | 'running' | 'settling' | 'settled' | 'interrupted'; reasons: string[]; combined: boolean;
  controller: AbortController; settling?: Promise<void>; settleRequested: boolean; waiting: boolean; terminal: boolean; interrupted: boolean;
}
export interface CaptureRuntimeState { sessionId: string; sourcePath?: string; state: NativeState; children: readonly NativeSubagent[] }
export interface TurnChangeCollection { push(operation: FileChangeEvidence): void; finish(evidence: CollectedTurnEvidence): TurnChangeResult }
interface CoordinatorOptions {
  store?: TurnSnapshotStore;
  inspect: (runtimeId: string) => Promise<CaptureRuntimeState>;
  publish: (event: TurnChangeEvent) => void;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const changing = new Set(['agent_start', 'turn_start', 'tool_execution_start', 'tool_execution_end', 'subagent_event', 'subagent_lifecycle', 'subagent_progress', 'message_start']);
const pending = (value: CaptureRuntimeState): boolean => value.state.isStreaming || value.state.isCompacting === true || value.state.hasPendingAsyncWork === true || (value.state.queuedMessageCount ?? 0) > 0 || value.state.isSettled === false || value.children.some(child => !child.historical && ['pending', 'started', 'running'].includes(child.status ?? string(child.progress?.status)));

/** Application-lifetime RAM only. Captures never grant filesystem or source authority. */
export class TurnChangeCoordinator {
  private readonly store: TurnSnapshotStore;
  private readonly records = new Map<string, CaptureRecord>();
  private readonly current = new Map<string, CaptureRecord>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(private readonly options: CoordinatorOptions) { this.store = options.store ?? new TurnSnapshotStore(); }

  async prepare(input: { runtimeId: string; sessionId: string; cwd: string; sourcePath?: string; submissionId?: string; beforeEntryId?: string | null; idle: boolean; mode: string }): Promise<string | undefined> {
    if (this.closed) return;
    const previous = this.current.get(input.runtimeId);
    if (previous?.settling) await previous.settling;
    if (this.closed || this.current.get(input.runtimeId) !== previous) return;
    if (previous && !previous.after && !previous.terminal) {
      previous.combined = true; previous.generation++;
      this.reason(previous, 'Multiple submissions share the captured interval');
      this.notify(previous); return;
    }
    if (!input.idle || input.mode !== 'prompt') return;
    this.trim();
    // Never evict an active baseline merely to admit another runtime.
    if (this.records.size >= 24) return;
    const record: CaptureRecord = { ...input, cwd: path.resolve(input.cwd), requestedCwd: path.resolve(input.cwd), id: randomUUID(), tools: new Set(), userAliases: new Set(), userCount: 0, userOpen: false, generation: 0, state: 'preparing', reasons: [], combined: false, controller: new AbortController(), settleRequested: false, waiting: false, terminal: false, interrupted: false };
    this.records.set(record.id, record); this.current.set(input.runtimeId, record);
    this.timer ??= setInterval(() => { this.store.usage(); }, 2_000); this.timer.unref();
    let before: WorkspaceSnapshot | undefined;
    try { before = await this.store.capture(input.cwd, { signal: record.controller.signal }); }
    catch (error) { if (this.live(record)) this.reason(record, `Baseline unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    if (!this.live(record)) { if (before) this.store.release(before); return; }
    record.before = before;
    if (before) record.cwd = before.root;
    for (const other of this.records.values()) {
      if (other === record || other.after || other.terminal) continue;
      const relative = path.relative(other.cwd, record.cwd), inverse = path.relative(record.cwd, other.cwd);
      if (relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) || !inverse.startsWith(`..${path.sep}`) && inverse !== '..' && !path.isAbsolute(inverse)) {
        this.reason(record, 'Concurrent workspace intervals may include changes from another session');
        this.reason(other, 'Concurrent workspace intervals may include changes from another session'); this.notify(other);
      }
    }
    record.state = 'running';
    return record.id;
  }

  accepted(id: string | undefined, data: unknown): void {
    const record = id ? this.records.get(id) : undefined;
    if (!record || record.after) return;
    if (object(data).agentInvoked === false && !record.tools.size && !record.userCount) this.drop(record);
  }

  rejected(id: string | undefined, sent: boolean): void {
    const record = id ? this.records.get(id) : undefined;
    if (!record || record.after) return;
    if (!sent) { this.drop(record); return; }
    this.interrupt(record, 'Submission ended without a confirmed stable endpoint', false);
  }

  observe(event: RuntimeEvent): void {
    if (this.closed) return;
    const record = this.current.get(event.runtimeId);
    if (!record) return;
    if (event.sessionId && event.sessionId !== record.sessionId || event.sourcePath && !this.source(record, event.sourcePath)) { this.drop(record); return; }
    // Final endpoints and turn membership are immutable; an idle close is not an interruption.
    if (record.after) return;
    if (event.kind === 'submission_started') {
      if (event.submission?.sessionId !== record.sessionId) { this.drop(record); return; }
      if (!record.requestId) record.requestId = event.submission.requestId;
      else if (record.requestId !== event.submission.requestId) { record.combined = true; record.generation++; this.reason(record, 'Multiple submissions share the captured interval'); }
      return;
    }
    if (event.kind === 'exit') { this.interrupt(record, 'Final workspace observed after runtime exit; descendant termination is not verified', true); return; }
    if (event.kind === 'error' || event.kind === 'observation_error') { this.interrupt(record, 'Runtime observation interrupted before verified settlement', false); return; }
    if (record.terminal || event.kind !== 'frame' || !event.frame) return;
    const frame = event.frame;
    if (frame.type === 'state_snapshot') {
      const state = object(frame.state);
      if (string(state.sessionId) && state.sessionId !== record.sessionId || string(state.sessionFile) && !this.source(record, string(state.sessionFile))) { this.drop(record); return; }
    }
    if (frame.type === 'tool_execution_start' || frame.type === 'tool_execution_end') {
      const id = string(frame.toolCallId); if (id && record.tools.size < 10_000) record.tools.add(id);
    }
    if (frame.type === 'message_start' || frame.type === 'message_end') this.message(record, frame);
    if (changing.has(frame.type)) record.generation++;
    if (frame.type === 'session_settled' || frame.type === 'prompt_result' && frame.sessionSettled === true) this.schedule(record);
    else if (record.waiting && ['subagent_lifecycle', 'subagent_progress', 'tool_execution_end', 'message_end'].includes(frame.type)) this.schedule(record);
  }

  private message(record: CaptureRecord, frame: NativeFrame): void {
    const message = object(frame.message);
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const item of message.content) { const block = object(item); if (block.type === 'toolCall' && typeof block.id === 'string' && record.tools.size < 10_000) record.tools.add(block.id); }
    }
    if (message.role !== 'user' || message.synthetic || message.agentId || message.agentName) return;
    const aliases = [frame.entryId, frame.messageId, message.id, message.messageId].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const known = aliases.some(id => record.userAliases.has(id));
    if (!known && (frame.type === 'message_start' || !record.userOpen)) record.userCount++;
    record.userOpen = frame.type === 'message_start';
    for (const id of aliases) if (record.userAliases.size < 100) record.userAliases.add(id);
    if (record.userCount > 1) { record.combined = true; this.reason(record, 'Multiple user messages share the captured interval'); }
  }

  private source(record: CaptureRecord, sourcePath: string | undefined): boolean {
    if (!sourcePath) return record.sourcePath === undefined;
    if (record.sourcePath && record.sourcePath !== sourcePath) return false;
    record.sourcePath = sourcePath; return true;
  }

  private live(record: CaptureRecord, generation?: number): boolean {
    return !this.closed && this.records.get(record.id) === record && this.current.get(record.runtimeId) === record && !record.controller.signal.aborted && (generation === undefined || generation === record.generation);
  }

  private interrupt(record: CaptureRecord, reason: string, terminal: boolean): void {
    record.generation++; record.controller.abort(); record.controller = new AbortController();
    record.interrupted = true; record.terminal ||= terminal; record.state = 'interrupted';
    this.reason(record, reason); this.notify(record);
    // Unknown termination gets a bounded uncertain observation; do not discard the preimage.
    this.schedule(record);
  }

  private schedule(record: CaptureRecord): void {
    if (!this.live(record) || record.after) return;
    record.settleRequested = true;
    if (record.settling) return;
    record.settleRequested = false;
    const generation = record.generation;
    record.settling = this.settle(record, generation).catch(error => {
      if (this.live(record, generation)) {
        record.state = 'interrupted'; record.interrupted = true;
        this.reason(record, `Final observation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        if (record.before) this.store.releaseContent(record.before);
        this.notify(record);
      }
    }).finally(() => {
      record.settling = undefined;
      if (record.settleRequested && this.live(record) && !record.after) this.schedule(record);
    });
  }

  private async settle(record: CaptureRecord, generation: number): Promise<void> {
    let after: WorkspaceSnapshot | undefined;
    try {
      if (!record.terminal) {
        const owner = await this.options.inspect(record.runtimeId);
        if (!this.live(record, generation)) return;
        if (owner.sessionId !== record.sessionId || !this.source(record, owner.sourcePath)) { this.drop(record); return; }
        if (pending(owner) && !record.interrupted) { record.waiting = true; record.state = 'running'; this.reason(record, 'Waiting for descendant work to settle'); return; }
      }
      if (!this.live(record, generation)) return;
      record.waiting = false; record.reasons = record.reasons.filter(reason => reason !== 'Waiting for descendant work to settle');
      record.state = 'settling';
      after = await this.store.capture(record.cwd, { signal: record.controller.signal });
      if (!this.live(record, generation)) return;
      if (!record.terminal) {
        const owner = await this.options.inspect(record.runtimeId);
        if (!this.live(record, generation)) return;
        if (owner.sessionId !== record.sessionId || !this.source(record, owner.sourcePath)) { this.drop(record); return; }
        if (pending(owner) && !record.interrupted) { record.waiting = true; record.state = 'running'; this.reason(record, 'Waiting for descendant work to settle'); return; }
      }
      if (!this.live(record, generation)) return;
      const files = resolveFinalChanges([], record.before ? this.store.pairs(record.before, after) : [], record.cwd);
      const bytes = files.reduce((sum, file) => sum + 512 + 2 * (file.path.length + file.patch.length + (file.reason?.length ?? 0)), 0);
      if (record.before) this.store.releaseContent(record.before); this.store.releaseContent(after);
      record.releaseResult = this.store.retainResult(bytes, () => { record.files = undefined; this.reason(record, 'Final text diff evicted under memory pressure'); this.notify(record); });
      if (!this.live(record, generation)) { record.releaseResult?.(); record.releaseResult = undefined; return; }
      if (record.releaseResult) record.files = files; else this.reason(record, 'Final text diff exceeds the current memory budget');
      record.after = after; after = undefined;
      record.state = record.interrupted ? 'interrupted' : 'settled'; this.notify(record);
    } finally { if (after) this.store.release(after); }
  }

  begin(evidence: CollectedTurnEvidence): TurnChangeCollection {
    this.store.usage();
    const toolIds = new Set(evidence.toolCallIds);
    const evidenceCwd = path.resolve(evidence.cwd);
    // Display/interval identity only: source authorization remains exact. These
    // are the same system-root aliases supported by workspace review paths.
    const systemCwd = process.platform === 'darwin' ? evidenceCwd.replace(/^\/private\/(?=(?:tmp|var|etc)(?:\/|$))/, '/') : evidenceCwd;
    const captures = [...this.records.values()].filter(record => {
      const recordCwd = process.platform === 'darwin' ? record.cwd.replace(/^\/private\/(?=(?:tmp|var|etc)(?:\/|$))/, '/') : record.cwd;
      if (record.combined || !evidence.exactInterval || record.sessionId !== evidence.sessionId || recordCwd !== systemCwd && record.requestedCwd !== evidenceCwd || !evidence.sourcePath || evidence.sourcePath !== record.sourcePath) return false;
      const nativeIdentity = [evidence.startEntryId, evidence.startMessageId, ...evidence.startMessageIds ?? []].some(id => id !== undefined && record.userAliases.has(id));
      const baselineBoundary = record.beforeEntryId !== undefined && evidence.beforeEntryId !== undefined && record.beforeEntryId === evidence.beforeEntryId;
      // Legacy runtimes without message IDs can still prove a unique selected
      // interval through its complete parent tool membership, never attribution.
      const toolInterval = record.tools.size > 0 && [...record.tools].every(id => toolIds.has(id));
      return nativeIdentity || baselineBoundary || toolInterval;
    });
    const record = captures.length === 1 ? captures[0] : undefined;
    const endpoints = record?.before && record.after ? this.store.pairs(record.before, record.after) : [];
    // Native journals preserve the originally authorized cwd spelling, while
    // capture roots are canonical. Rebase known aliases without rereading disk.
    if (record && path.resolve(evidence.cwd) !== record.cwd) {
      for (const endpoint of endpoints) endpoint.path = path.resolve(evidence.cwd, path.relative(record.cwd, endpoint.path));
    }
    const accumulator = new ChangeNetAccumulator({ endpoints, cwd: evidence.cwd, hashText: text => createHash('sha256').update(text).digest('hex') });
    return {
      push: operation => accumulator.push(operation),
      finish: completed => {
        if (completed.sessionId !== evidence.sessionId || completed.sourcePath !== evidence.sourcePath || completed.startEntryId !== evidence.startEntryId || completed.cwd !== evidence.cwd) throw new Error('Turn evidence identity changed during collection');
        if (record && this.records.get(record.id) !== record) throw new Error('Turn capture was released during collection');
        const files = accumulator.finish();
        const exact = new Map(record?.files?.map(file => [file.path, file]) ?? []);
        for (let index = 0; index < files.length; index++) {
          const snapshot = exact.get(files[index].path);
          if (snapshot?.countsKnown) files[index] = { ...files[index], ...snapshot, steps: files[index].steps, processTruncated: files[index].processTruncated, toolId: files[index].toolId || snapshot.toolId };
        }
        const reasons = [...new Set([...completed.reasons, ...record?.reasons ?? [], ...record?.before?.reasons ?? [], ...record?.after?.reasons ?? []])];
        const snapshot = record?.before && record.after ? record.before.complete && record.after.complete ? 'complete' : 'partial' : 'unavailable';
        const collecting = completed.pending || record?.state === 'settling' || record?.state === 'running' || record?.state === 'preparing';
        return { id: completed.id, revision: `${record?.id ?? 'history'}:${record?.generation ?? 0}:${record?.after?.completedAt ?? 0}:${Date.now()}`, state: collecting ? 'collecting' : !completed.complete || snapshot === 'partial' || reasons.length ? 'partial' : 'complete', files, coverage: { snapshot, evidence: completed.complete ? 'complete' : 'partial', reasons, excluded: [...new Set([...record?.before?.excluded ?? [], ...record?.after?.excluded ?? []])] }, observedAt: record?.after?.completedAt };
      },
    };
  }

  result(evidence: CollectedTurnEvidence): TurnChangeResult {
    const collection = this.begin(evidence);
    for (const operation of evidence.operations) collection.push(operation);
    return collection.finish(evidence);
  }

  forget(runtimeIds: readonly string[], sourcePath?: string): void {
    for (const record of this.records.values()) if (runtimeIds.includes(record.runtimeId) || sourcePath && record.sourcePath === sourcePath) this.drop(record);
  }
  dispose(): void {
    if (this.closed) return; this.closed = true; clearInterval(this.timer);
    for (const record of [...this.records.values()]) this.drop(record); this.store.dispose();
  }
  private reason(record: CaptureRecord, reason: string): void { if (record.reasons.length < 32 && !record.reasons.includes(reason)) record.reasons.push(reason); }
  private notify(record: CaptureRecord): void { if (!this.closed && this.records.get(record.id) === record) this.options.publish({ runtimeId: record.runtimeId, sessionId: record.sessionId, sourcePath: record.sourcePath }); }
  private trim(): void {
    for (const record of this.records.values()) {
      if (this.records.size < 24) break;
      if (record.after || record.terminal && !record.settling) this.drop(record);
    }
  }
  private drop(record: CaptureRecord): void {
    if (this.records.get(record.id) !== record) return;
    record.generation++; record.controller.abort(); record.settleRequested = false; record.releaseResult?.();
    if (record.before) this.store.release(record.before); if (record.after) this.store.release(record.after);
    this.records.delete(record.id);
    if (this.current.get(record.runtimeId) === record) this.current.delete(record.runtimeId);
    if (!this.records.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
}

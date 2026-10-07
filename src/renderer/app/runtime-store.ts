import { nativeError } from '../../shared/native-error';
import { presentUserError } from '../lib/user-errors';
import type { DesktopApi, ExtensionRequest, ExtensionResponse, NativeFrame, NativeModel, NativeState, NativeSubagent, RuntimeEvent, RuntimeHistory, RuntimeHistoryRead, RuntimeSourceState, SessionConnection, SessionRemovalTarget, StartSession } from '../../shared/contracts';
import { createChatState, reduceChatFrame, record, type ChatState } from '../chat/model';
import i18next from 'i18next';
import { readingAnchorMessageIds, recallReadingPosition } from '../lib/transcript-reading-position';
import { submissions } from '../chat/submissions';
import { subagentPhase } from '../workspace/subagent-model';
import { buildTranscriptEntries, turnOutcome } from '../chat/presentation';
import { plainMarkdownLine } from '../lib/markdown-plain';
import { partitionSourceDiagnostics } from '../chat/message-details';
import { UserFacingError, type UserError } from '../lib/user-errors';
import { DesktopQueue } from '../chat/composer/queue';
import type { Draft } from '../chat/composer/drafts';
import type { PromptInput } from '../../shared/contracts';
import { modelNames } from '../../shared/model-display-name';

const stateCommandFields: Record<string, readonly string[]> = {
  set_fast_mode: ['fastModeEnabled', 'fastModeActive'],
  set_auto_compaction: ['autoCompactionEnabled'],
  set_steering_mode: ['steeringMode'],
  set_follow_up_mode: ['followUpMode'],
  set_interrupt_mode: ['interruptMode'],
  set_session_name: ['sessionName'],
};

export interface RuntimeRecord { runtimeId: string; cwd: string; source: RuntimeSourceState; chat: ChatState; closed: boolean; history?: RuntimeHistory; historyPaging: boolean; historyError: Error | string; historyFollowing: boolean }
export type NoticeSeverity = 'info' | 'success' | 'warning' | 'error';
export type RuntimeNotice = { runtimeId: string; message: string; severity: NoticeSeverity; url?: string; error?: UserError; operation?: string };
export type SessionPrompt = { runtimeId: string; request: ExtensionRequest };
export type Toast = RuntimeNotice & { id: number; count: number };

export function routeSessionPrompts(prompts: readonly SessionPrompt[], runtimeId: string | null, dismissed: ReadonlySet<string>) {
  const pending = prompts.filter(item => !dismissed.has(`${item.runtimeId}:${item.request.id}`));
  const counts = new Map<string, number>();
  for (const item of pending) counts.set(item.runtimeId, (counts.get(item.runtimeId) ?? 0) + 1);
  return { prompt: pending.find(item => item.runtimeId === runtimeId), counts };
}

/** Native omp's explicit operator-stop reason, not a generic provider or transport abort. */
export function isUserInterrupt(message: string | undefined): boolean { return message === 'Interrupted by user'; }

export function classifyRuntimeNotice(runtimeId: string, frame: NativeFrame): RuntimeNotice | undefined {
  const extension = frame.type === 'extension_ui_request';
  if (extension ? !['notify', 'open_url'].includes(String(frame.method)) : !['notice', 'extension_error', 'rpc_frame_error'].includes(frame.type)) return;
  const message = String(extension ? frame.message ?? frame.instructions ?? i18next.t('omp.shell.openLink') : frame.message ?? frame.error ?? frame.type);
  // Deliberate stops are already represented by the stopped turn, not a second error surface.
  if ((frame.type === 'notice' || extension && frame.method === 'notify') && isUserInterrupt(message)) return;
  const level = extension ? frame.notifyType : frame.type === 'notice' ? frame.level : 'error';
  const severity: NoticeSeverity = level === 'error' || level === 'warning' || level === 'success' ? level : 'info';
  return { runtimeId, message, severity, ...((severity === 'error' || severity === 'warning') && frame.type !== 'rpc_frame_error' ? { error: presentUserError(nativeError(message)) } : {}), ...(extension && frame.method === 'open_url' ? { url: String(frame.url ?? frame.launchUrl ?? '') } : {}) };
}

export function appendToast(items: readonly Toast[], notice: RuntimeNotice, id: number): Toast[] {
  const repeated = items.find(item => item.runtimeId === notice.runtimeId && (item.error?.details ?? item.message) === (notice.error?.details ?? notice.message) && item.severity === notice.severity && item.url === notice.url);
  return repeated ? items.map(item => item === repeated ? { ...item, count: item.count + 1 } : item) : [...items, { ...notice, id, count: 1 }];
}

export type InboxKind = 'prompt' | 'failed' | 'completed' | 'child';
export interface InboxItem { id: number; runtimeId: string; kind: InboxKind; createdAt: number; read: boolean; promptId?: string; deadlineAt?: number; turnId?: string; subagentId?: string; durationMs?: number; snippet?: string }
export interface InboxState { items: InboxItem[]; sequence: number; turns: Record<string, { startedAt: number; settled: boolean; failed: boolean; turnId?: string }> }
export type InboxAction = { type: 'read'; id?: number; runtimeId?: string } | { type: 'forget'; ids: readonly string[] } | { type: 'prompts'; prompts: readonly SessionPrompt[]; now: number } | { type: 'transition'; previous?: ChatState; next: ChatState; away: boolean; now: number };
/** Local inbox previews only; native notifications deliberately use title/status instead. */
export function inboxSnippet(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  for (const line of value.split(/\r?\n/)) {
    const plain = plainMarkdownLine(line);
    if (plain) return plain.length > 240 ? `${plain.slice(0, 239)}…` : plain;
  }
}
export function reduceInbox(state: InboxState, action: InboxAction): InboxState {
  if (action.type === 'read') return { ...state, items: state.items.map(item => (action.id === undefined || item.id === action.id) && (action.runtimeId === undefined || item.runtimeId === action.runtimeId) ? { ...item, read: true } : item) };
  if (action.type === 'forget') return { ...state, items: state.items.filter(item => !action.ids.includes(item.runtimeId)), turns: Object.fromEntries(Object.entries(state.turns).filter(([id]) => !action.ids.includes(id))) };
  let items = state.items;
  let sequence = state.sequence;
  let turns = state.turns;
  const append = (item: Omit<InboxItem, 'id' | 'read' | 'createdAt'>) => { items = [...items, { ...item, id: ++sequence, read: false, createdAt: action.now }]; };
  if (action.type === 'prompts') {
    items = items.filter(item => item.kind !== 'prompt' || action.prompts.some(prompt => prompt.runtimeId === item.runtimeId && prompt.request.id === item.promptId));
    for (const { runtimeId, request } of action.prompts) if (!items.some(item => item.runtimeId === runtimeId && item.promptId === request.id)) append({ runtimeId, kind: 'prompt', promptId: request.id, deadlineAt: typeof request.deadlineAt === 'number' ? request.deadlineAt : undefined, snippet: inboxSnippet(request.message) ?? inboxSnippet(request.title) });
  } else {
    const { previous, next, now, away } = action;
    const runtimeId = next.runtimeId;
    const same = previous?.state.sessionId === next.state.sessionId;
    let turn = same ? turns[runtimeId] : undefined;
    if (next.state.isStreaming && (!same || !previous?.state.isStreaming)) turn = { startedAt: now, settled: false, failed: false };
    if (previous && previous.messages !== next.messages && items.some(item => item.runtimeId === runtimeId && item.turnId)) {
      const entries = buildTranscriptEntries(next.messages, next.tools, next.subagents).entries;
      items = items.map(item => {
        if (item.runtimeId !== runtimeId || !item.turnId) return item;
        const entry = entries.find(entry => entry.kind === 'assistant-turn' && entry.rows.some(row => row.id === item.turnId || row.presentation?.id === item.turnId));
        return entry && entry.id !== item.turnId ? { ...item, turnId: entry.id } : item;
      });
    }
    // Initial hydration establishes a baseline: old errors/children are not new events.
    if (same && previous) {
      const stopped = previous.state.isStreaming && !next.state.isStreaming;
      const outcome = turnOutcome(next.live.messages.length ? next.live.messages : next.messages, next.outcome);
      const failed = next.outcome === 'error' && previous.outcome !== 'error' || stopped && (outcome === 'error' || !!next.error && !isUserInterrupt(next.error));
      if (failed && !turn) turn = { startedAt: now, settled: false, failed: false };
      if (turn && next.outcome === 'aborted' && previous.outcome !== 'aborted') items = items.filter(item => !(item.runtimeId === runtimeId && item.kind === 'completed' && item.createdAt >= turn!.startedAt));
      if ((stopped || failed) && turn) {
        const turnId = buildTranscriptEntries(next.live.messages.length ? next.live.messages : next.messages, next.tools, next.subagents).entries.findLast(entry => entry.kind === 'assistant-turn')?.id ?? turn.turnId;
        const latest = (next.live.messages.length ? next.live.messages : next.messages).findLast(row => row.raw.role === 'assistant')?.raw;
        const answer = typeof latest?.content === 'string' ? latest.content : Array.isArray(latest?.content) ? latest.content.flatMap(value => { const block = record(value); return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []; }).join('\n') : undefined;
        if (failed && !turn.failed) {
          // A terminal error may arrive just after the settle frame. Replace its completion.
          items = items.filter(item => !(item.runtimeId === runtimeId && item.kind === 'completed' && item.createdAt >= turn!.startedAt));
          append({ runtimeId, kind: 'failed', turnId, snippet: inboxSnippet(next.error) ?? inboxSnippet(latest?.errorMessage) });
          turn = { ...turn, failed: true };
        } else if (stopped && !turn.settled && !turn.failed && outcome !== 'aborted' && away) append({ runtimeId, kind: 'completed', turnId, durationMs: now - turn.startedAt, snippet: inboxSnippet(answer) });
        turn = { ...turn, turnId, settled: turn.settled || stopped };
      }
      for (const child of next.subagents) {
        if (child.historical || subagentPhase(child) !== 'failed') continue;
        const before = previous.subagents.find(item => item.id === child.id && item.parentToolCallId === child.parentToolCallId);
        if (before && subagentPhase(before) === 'failed') continue;
        const turnId = child.parentToolCallId ? buildTranscriptEntries(next.live.messages.length ? next.live.messages : next.messages, next.tools, next.subagents).entries.find(entry => entry.kind === 'assistant-turn' && entry.parts.some(part => part.kind === 'tool' && part.tool.id === child.parentToolCallId))?.id : undefined;
        append({ runtimeId, kind: 'child', subagentId: child.id, turnId, snippet: inboxSnippet(child.error) ?? inboxSnippet(record(child.error).message) ?? inboxSnippet(child.description) });
      }
    }
    if (turn) turns = { ...turns, [runtimeId]: turn };
    else if (!same && turns[runtimeId]) { turns = { ...turns }; delete turns[runtimeId]; }
  }
  // Never evict a still-pending request; retain only a small tail of other events.
  const retained = new Set(items.filter(item => item.kind !== 'prompt').slice(-100).map(item => item.id));
  items = items.filter(item => item.kind === 'prompt' || retained.has(item.id));
  return { items, sequence, turns };
}

/** Native omp owns execution and history; the desktop owns unsent follow-ups. */
export class RuntimeStore {
  readonly desktopQueue = new DesktopQueue(async (item, mode) => {
    this.requireOpen(item.runtimeId);
    if (this.records[item.runtimeId].chat.state.sessionId !== item.sessionId) throw new UserFacingError(i18next.t('omp.intent.latestSourceChanged'));
    await this.sendPrompt(item.runtimeId, { ...item.input, mode });
  });
  async sendPrompt(id: string, input: PromptInput, draft?: Draft): Promise<void> {
    this.requireOpen(id);
    const current = this.records[id];
    if (input.mode === 'follow_up' || input.mode === 'prompt' && current.chat.isRunning) {
      this.desktopQueue.enqueue(id, current.chat.state.sessionId, input, draft ?? { text: input.text, attachments: [], references: [] });
      return;
    }
    const receipt = submissions.begin(id, current.chat.state.sessionId, input);
    try {
      const accepted = await this.api.sendPrompt(id, { ...input, submissionId: receipt.id, expectedSessionId: receipt.sessionId });
      submissions.accepted(receipt.id, accepted);
      const local = !!accepted.data && typeof accepted.data === 'object' && 'agentInvoked' in accepted.data && accepted.data.agentInvoked === false;
      void this.refresh(id, local).catch(error => this.notice({ runtimeId: id, message: errorText(error), severity: 'error', error: presentUserError(error) }));
    } catch (error) { submissions.rejected(receipt.id, errorText(error)); throw error; }
  }
  private records: Record<string, RuntimeRecord> = {};
  private inbox: InboxState = { items: [], sequence: 0, turns: {} };
  getInboxSnapshot = () => this.inbox.items;
  markInboxRead = (id?: number, runtimeId?: string) => { this.inbox = reduceInbox(this.inbox, { type: 'read', id, runtimeId }); for (const listener of this.listeners) listener(); };
  private updateInbox(action: InboxAction) {
    const sequence = this.inbox.sequence;
    this.inbox = reduceInbox(this.inbox, action);
    for (const item of this.inbox.items) if (item.id > sequence) this.attention?.onEvent(item);
  }
  private syncInboxPrompts() {
    this.updateInbox({ type: 'prompts', now: Date.now(), prompts: [...this.startupPrompts, ...Object.values(this.records).flatMap(record => record.closed ? [] : record.chat.prompts.map(request => ({ runtimeId: record.runtimeId, request })))] });
  }
  private listeners = new Set<() => void>();
  private early = new Map<string, RuntimeEvent[]>();
  private starting = 0;
  private pendingStarts = new Map<string, Promise<RuntimeRecord>>();
  private refreshing = new Map<string, Promise<void>>();
  private versions = new Map<string, number>();
  private snapshotVersions = new Map<string, number>();
  private sessionIds = new Map<string, string>();
  private refreshRequests = new Map<string, number>();
  private catalogDirty = new Set<string>();
  private requestTimers = new Map<string, number>();
  private detach: (() => void) | undefined;
  startupPrompts: {runtimeId:string;request:ExtensionRequest}[] = [];
  private answered = new Set<string>();
  private promptTimers = new Map<string, number>();
  private closing = new Set<string>();
  private historyVersions = new Map<string, number>();
  private forgotten = new Set<string>();
  private selectionVersions = new Map<string, number>();
  private draft?: { key: string; promise: Promise<RuntimeRecord>; id?: string };
  private draftCleanup: Promise<void> = Promise.resolve();
  private quietDrafts = new Set<string>();
  private startingDraft = false;
  getDraft(key: string) { return this.draft?.key === key && this.draft.id ? this.records[this.draft.id] : undefined; }
  isDraft(id: string) { return this.quietDrafts.has(id); }
  showDraft(key: string, cwd: string): Promise<RuntimeRecord> {
    if (this.draft?.key === key) return this.draft.promise;
    this.releaseDraft();
    const promise = this.draftCleanup.then(async () => {
      this.startingDraft = true;
      try { const record = await this.startConnection({ cwd, draft: true }); draft.id = record.runtimeId; this.publishStartup(); return record; }
      finally { this.startingDraft = false; }
    });
    const draft: NonNullable<RuntimeStore['draft']> = { key, promise };
    this.draft = draft;
    return draft.promise;
  }
  releaseDraft(key?: string): Promise<void> {
    const draft = this.draft;
    if (!draft || key !== undefined && key !== draft.key) return this.draftCleanup;
    this.draft = undefined;
    this.draftCleanup = draft.promise.then(async record => {
      try { await this.api.closeSession(record.runtimeId); }
      catch (error) { if (!this.records[record.runtimeId]?.closed) throw error; }
      finally { this.forget([record.runtimeId]); this.quietDrafts.delete(record.runtimeId); }
    }, () => undefined);
    return this.draftCleanup;
  }
  adoptDraft(key: string) {
    if (this.draft?.key !== key) return;
    if (this.draft.id) this.quietDrafts.delete(this.draft.id);
    this.draft = undefined;
  }
  private notice(notice: RuntimeNotice) { if (!this.quietDrafts.has(notice.runtimeId) && (!this.startingDraft || !!this.records[notice.runtimeId])) this.emitNotice(notice); }
  forget(ids: readonly string[]) {
    submissions.forget(ids);
    this.desktopQueue.forget(ids);
    this.inbox = reduceInbox(this.inbox, { type: 'forget', ids });
    const next = { ...this.records };
    for (const id of ids) {
      this.forgotten.add(id); delete next[id]; this.early.delete(id);
      this.closing.delete(id);
      this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
      this.historyVersions.set(id, (this.historyVersions.get(id) ?? 0) + 1);
      this.snapshotVersions.delete(id); this.catalogDirty.delete(id);
      if (this.requestTimers.has(id)) { window.clearTimeout(this.requestTimers.get(id)); this.requestTimers.delete(id); }
      for (const [key, timer] of this.promptTimers) if (key.startsWith(`${id}:`)) { window.clearTimeout(timer); this.promptTimers.delete(key); }
    }
    this.startupPrompts = this.startupPrompts.filter(item => !this.forgotten.has(item.runtimeId));
    this.records = next; this.publishStartup();
  }
  updateSource(id: string, source: RuntimeSourceState) {
    const record = this.records[id];
    if (record && source.sessionId === record.chat.state.sessionId) this.publish({ ...record, source });
  }
  forgetClosed() {
    this.forget(Object.values(this.records).filter(record => record.closed).map(record => record.runtimeId));
  }
  get hasStarting() { return this.starting > 0; }
  private clearPromptTimer(id: string, requestId: string) {
    const key = `${id}:${requestId}`;
    const timer = this.promptTimers.get(key);
    window.clearTimeout(timer);
    this.promptTimers.delete(key);
  }
  private publishStartup() { this.syncInboxPrompts(); this.records = {...this.records}; for (const listener of this.listeners) listener(); }
  constructor(private api: DesktopApi, private emitNotice: (notice: RuntimeNotice) => void, private historyChanged: () => void, private attention?: { isAway: (runtimeId: string) => boolean; onEvent: (item: InboxItem) => void }) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.records;
  connect() {
    this.detach = this.api.onRuntimeEvent(this.receive);
    return () => {
      this.detach?.(); this.detach = undefined;
      for (const timer of this.promptTimers.values()) window.clearTimeout(timer);
      this.promptTimers.clear();
      for (const timer of this.requestTimers.values()) window.clearTimeout(timer);
      this.requestTimers.clear();
    };
  }
  private publish(record: RuntimeRecord, quiet = false) {
    if (this.forgotten.has(record.runtimeId)) return;
    const previous = this.records[record.runtimeId];
    if (record.chat.models !== previous?.chat.models) modelNames.capture(record.chat.models, 'catalog');
    this.records = { ...this.records, [record.runtimeId]: record };
    if (!quiet && !this.quietDrafts.has(record.runtimeId) && previous?.chat !== record.chat) this.updateInbox({ type: 'transition', previous: previous?.chat, next: record.chat, away: this.attention?.isAway(record.runtimeId) ?? false, now: Date.now() });
    this.syncInboxPrompts();
    for (const listener of this.listeners) listener();
    if (record.closed || previous && previous.chat.state.sessionId !== record.chat.state.sessionId) this.desktopQueue.pause(record.runtimeId);
    else if (record.chat.isSettled && !previous?.chat.isSettled) this.desktopQueue.settled(record.runtimeId, record.chat.state.sessionId);
  }
  private apply(id: string, frame: NativeFrame) {
    const record = this.records[id];
    if (record) {
      const chat = reduceChatFrame(record.chat, frame.type === 'command_output' ? { ...frame, historyFollowing: record.historyFollowing } : frame);
      if (!record.historyFollowing && ['message_start', 'message_update', 'message_end', 'command_output'].includes(frame.type)) chat.messages = record.chat.messages;
      this.publish({ ...record, chat });
    }
  }
  receive = (event: RuntimeEvent) => {
    if (this.forgotten.has(event.runtimeId)) return;
    if (event.kind === 'submission_started') { if (event.submission) submissions.started(event.runtimeId, event.submission); return; }
    if (event.frame) submissions.receive(event.runtimeId, event.frame);
    if (event.kind === 'exit' || event.kind === 'error') submissions.unobserved(event.runtimeId);
    let incoming = event.frame;
    if (incoming?.type === 'extension_ui_request') {
      const key = `${event.runtimeId}:${incoming.id}`;
      if (incoming.method === 'cancel') {
        this.answered.add(`${event.runtimeId}:${incoming.targetId}`);
        this.clearPromptTimer(event.runtimeId, String(incoming.targetId));
      }
      if (['select','confirm','input','editor'].includes(String(incoming.method))) {
        const receivedAt = typeof incoming.receivedAt === 'number' && Number.isFinite(incoming.receivedAt) ? incoming.receivedAt : Date.now();
        const deadlineAt = typeof incoming.timeout === 'number' && Number.isFinite(incoming.timeout) && incoming.timeout >= 0 ? receivedAt + incoming.timeout : undefined;
        incoming = { ...incoming, receivedAt, deadlineAt };
        event = { ...event, frame: incoming };
        if (deadlineAt !== undefined && !this.promptTimers.has(key) && !this.answered.has(key)) {
          const requestId = String(incoming.id);
          this.promptTimers.set(key, window.setTimeout(() => {
            void this.respond(event.runtimeId, {id:requestId,cancelled:true,timedOut:true}).catch(error => this.notice({ runtimeId: event.runtimeId, message: errorText(error), severity: 'error', error: presentUserError(error) }));
            // Expired prompts leave the queue even if a click already owns the response.
            this.startupPrompts = this.startupPrompts.filter(item=>item.runtimeId!==event.runtimeId||item.request.id!==requestId);
            this.apply(event.runtimeId, { type: 'extension_ui_response', id: requestId });
            this.publishStartup();
          }, Math.max(0, deadlineAt - Date.now())));
        }
      }
    }
    if (event.kind === 'exit' || event.kind === 'error') {
      for (const [key,timer] of this.promptTimers) if (key.startsWith(`${event.runtimeId}:`)) { clearTimeout(timer); this.promptTimers.delete(key); }
    }
    const record = this.records[event.runtimeId];
    if (!record) {
      if (this.starting) {
        const pending = this.early.get(event.runtimeId) ?? []; pending.push(event); this.early.set(event.runtimeId, pending);
        const frame = event.frame;
        if (frame?.type === 'extension_ui_request') {
          if (['select','confirm','input','editor'].includes(String(frame.method)) && !this.startupPrompts.some(item=>item.runtimeId===event.runtimeId&&item.request.id===frame.id)) this.startupPrompts.push({runtimeId:event.runtimeId,request:frame as ExtensionRequest});
          if (frame.method === 'cancel') this.startupPrompts = this.startupPrompts.filter(item=>item.runtimeId!==event.runtimeId||item.request.id!==frame.targetId);
          const notice = classifyRuntimeNotice(event.runtimeId, frame);
          if (notice) this.notice(notice);
        }
        if (event.kind === 'exit' || event.kind === 'error') this.startupPrompts = this.startupPrompts.filter(item=>item.runtimeId!==event.runtimeId);
        this.publishStartup();
      }
      return;
    }
    const id = event.runtimeId;
    if (event.kind === 'frame' && event.frame?.type === 'response') {
      if (event.frame.success === false && !this.closing.has(id)) this.apply(id, event.frame);
      return;
    }
    if (event.kind === 'observation_error') {
      if (this.closing.has(id) || !event.error || event.sessionId !== record.chat.state.sessionId || event.sourcePath !== record.source.path) return;
      this.apply(id, { type: 'notice', level: 'error', message: event.error, origin: 'desktop' });
      this.notice({ runtimeId: id, message: event.error, severity: 'error' });
      return;
    }
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    if (event.kind !== 'frame') {
      if (record.closed) return;
      const expected = this.closing.has(id) && event.kind === 'exit';
      const message = expected ? i18next.t('omp.shell.connectionClosed') : 'Runtime exited: ' + (event.error || String(event.exitCode ?? 'signal'));
      const chat = reduceChatFrame(record.chat,{type:event.kind==='exit'?'runtime_exit':'runtime_error',error:message});
      if (expected) chat.error = record.chat.error;
      this.publish({ ...record, closed: true, chat }, expected);
      if (event.kind === 'exit') void this.api.getRuntimeAccess(id).then(access => this.updateSource(id, access.source)).catch(() => { /* The crash notice already explains the lost runtime. */ });
      if (!expected) this.notice({ runtimeId: id, message, severity: 'error' });
      this.historyChanged();
      return;
    }
    const frame = event.frame;
    if (!frame || record.closed) return;
    if (frame.type === 'extension_ui_request' && this.answered.has(`${id}:${frame.id}`)) return;
    this.apply(id, frame);
    if (frame.type === 'message_end' && frame.message && typeof frame.message === 'object' && 'role' in frame.message && frame.message.role === 'assistant') {
      window.clearTimeout(this.requestTimers.get(id));
      this.requestTimers.set(id, window.setTimeout(() => {
        this.requestTimers.delete(id);
        void this.refreshContext(id).catch(error => { if (!this.closing.has(id)) this.notice({ runtimeId: id, message: errorText(error), severity: 'error', error: presentUserError(error) }); });
      }, 400));
    }
    const notice = classifyRuntimeNotice(id, frame);
    if (notice) this.notice(notice);
    if (['session_settled','prompt_result','auto_compaction_end'].includes(frame.type) && this.records[id].chat.refreshMessages) this.snapshotVersions.set(id, (this.snapshotVersions.get(id) ?? 0) + 1);
    if (frame.type === 'model_changed') void this.refreshSelection(id, true).catch(error => this.notice({ runtimeId: id, message: errorText(error), severity: 'error', error: presentUserError(error) }));
    if (frame.type === 'config_update') this.catalogDirty.add(id);
    if (['agent_end','session_settled','prompt_result','config_update','session_info_update','auto_compaction_end'].includes(frame.type) || /retry|fallback|queue|todo|goal/.test(frame.type)) void this.refresh(id).catch(error => { if (!this.closing.has(id)) this.notice({ runtimeId: id, message: errorText(error), severity: 'error', error: presentUserError(error) }); });
    if (frame.type === 'tool_execution_end' && (frame.toolName === 'todo' || this.records[id].chat.tools[String(frame.toolCallId)]?.name === 'todo')) void this.refresh(id).catch(error => { if (!this.closing.has(id)) this.notice({ runtimeId: id, message: errorText(error), severity: 'error', error: presentUserError(error) }); });
    if (frame.type === 'session_settled' || frame.type === 'session_info_update') this.historyChanged();
  };
  private async refreshContext(id: string): Promise<void> {
    const previous = this.records[id];
    if (!previous || previous.closed) return;
    const state = await this.api.request<NativeState>(id, { type: 'get_state' });
    const current = this.records[id];
    if (!current || current.closed || current.chat.state.sessionId !== previous.chat.state.sessionId || state.sessionId !== current.chat.state.sessionId || state.sessionFile !== current.chat.state.sessionFile || state.model?.id !== current.chat.state.model?.id || state.model?.provider !== current.chat.state.model?.provider) return;
    // Token frames must not invalidate request-level occupancy. Preserve current
    // execution/queue state rather than applying an older full state snapshot.
    this.publish({ ...current, chat: { ...current.chat, state: { ...current.chat.state, contextUsage: state.contextUsage, contextUsageObservedAt: Date.now(), autoCompactionEnabled: state.autoCompactionEnabled, systemPrompt: state.systemPrompt, dumpTools: state.dumpTools } } });
  }
  async start(options: StartSession): Promise<RuntimeRecord> {
    if (options.sessionPath && options.mode !== 'fork') {
      const existing = Object.values(this.records).find(record => !record.closed && record.source.path === options.sessionPath);
      if (existing) return existing;
      const pending = this.pendingStarts.get(options.sessionPath);
      if (pending) return pending;
    }
    const start = this.startConnection(options);
    if (options.sessionPath && options.mode !== 'fork') this.pendingStarts.set(options.sessionPath, start);
    try { return await start; } finally { if (options.sessionPath && options.mode !== 'fork') this.pendingStarts.delete(options.sessionPath); }
  }
  private async startConnection(options: StartSession) {
    this.starting++;
    try {
      const connection: SessionConnection = await this.api.startSession(options);
      if (options.draft) this.quietDrafts.add(connection.runtimeId);
      this.sessionIds.set(connection.runtimeId, connection.state.sessionId);
      this.publish({ runtimeId: connection.runtimeId, cwd: connection.cwd, source: connection.source, chat: createChatState(connection), closed: false, history: connection.history, historyPaging: false, historyError: connection.history?.error ?? '', historyFollowing: true });
      this.applyHistoryDiagnostics(connection.runtimeId, connection.historyDiagnostics ?? []);
      const events = this.early.get(connection.runtimeId) ?? [];
      this.early.delete(connection.runtimeId);
      for (const event of events) {
        if(event.frame?.type==='extension_ui_request' && ['notify','open_url'].includes(String(event.frame.method))) continue;
        this.receive(event);
      }
      this.startupPrompts = this.startupPrompts.filter(item=>item.runtimeId!==connection.runtimeId);
      this.publishStartup();
      if (!this.records[connection.runtimeId].closed) void this.refresh(connection.runtimeId).catch(error => { if (!this.closing.has(connection.runtimeId)) this.notice({ runtimeId: connection.runtimeId, message: errorText(error), severity: 'error', error: presentUserError(error) }); });
      return this.records[connection.runtimeId];
    } finally { this.starting--; if (!this.starting) { this.early.clear(); this.startupPrompts=[]; this.publishStartup(); } }
  }
  refresh(id: string, messages = false): Promise<void> {
    if (messages) this.snapshotVersions.set(id, (this.snapshotVersions.get(id) ?? 0) + 1);
    this.refreshRequests.set(id, (this.refreshRequests.get(id) ?? 0) + 1);
    const pending = this.refreshing.get(id);
    if (pending) return pending;
    const work = this.refreshLoop(id).finally(() => { this.refreshing.delete(id); });
    this.refreshing.set(id, work);
    return work;
  }
  private async refreshLoop(id: string) {
    let seen = -1;
    let requestedRefresh = -1;
    do {
      const record = this.records[id];
      if (!record || record.closed) return;
      seen = this.versions.get(id) ?? 0;
      requestedRefresh = this.refreshRequests.get(id) ?? 0;
      const state = await this.api.request<NativeState>(id, { type: 'get_state' });
      if (!this.records[id] || this.records[id].closed) return;
      if (seen !== (this.versions.get(id) ?? 0)) continue;
      const changedSession = state.sessionId !== (this.sessionIds.get(id) ?? record.chat.state.sessionId) || state.sessionFile !== record.chat.state.sessionFile;
      this.sessionIds.set(id, state.sessionId);
      if (changedSession) {
        this.historyVersions.set(id, (this.historyVersions.get(id) ?? 0) + 1);
        const source: RuntimeSourceState = { status: 'unavailable', sessionId: state.sessionId, path: state.sessionFile, reason: 'Checking changed native source' };
        const chat = createChatState({runtimeId:id,cwd:record.cwd,source,state,messages:[],models:record.chat.models,commands:record.chat.commands,thinkingLevels:record.chat.thinkingLevels});
        // First persistence assigns a source, not a new process-local message
        // lifecycle. Keep observations; source authorization is still reset.
        if (state.sessionId === record.chat.state.sessionId && !record.chat.state.sessionFile) { chat.live = record.chat.live; chat.commandOutputs = record.chat.commandOutputs; chat.messages = record.chat.messages.filter(row => row.source === 'live' || row.source === 'event'); chat.tools = record.chat.tools; }
        this.publish({...record,source,history:undefined,historyFollowing:true,historyError:'',chat});
      }
      if (changedSession || record.chat.refreshMessages) this.snapshotVersions.set(id, (this.snapshotVersions.get(id) ?? 0) + 1);
      if (this.catalogDirty.has(id) || state.model?.id !== record.chat.state.model?.id || state.model?.provider !== record.chat.state.model?.provider) {
        this.catalogDirty.delete(id);
        const [levels, models] = await Promise.all([
          this.api.request<{levels:string[]}>(id,{type:'get_available_thinking_levels'}),
          this.api.request<{models:NativeModel[]}>(id,{type:'get_available_models'}),
        ]);
        this.apply(id,{type:'thinking_levels_snapshot',levels:levels.levels});
        this.apply(id,{type:'models_snapshot',models:models.models});
      }
      const children = await this.api.request<{ subagents: NativeSubagent[] }>(id, { type: 'get_subagents' });
      if (seen !== (this.versions.get(id) ?? 0) || !this.records[id] || this.records[id].closed) continue;
      this.apply(id, { type: 'state_snapshot', state });
      this.apply(id, { type: 'subagents_snapshot', subagents: children.subagents });
      const access = await this.api.getRuntimeAccess(id);
      if (!this.records[id] || this.records[id].closed || seen !== (this.versions.get(id) ?? 0)) continue;
      if (this.records[id].chat.state.sessionFile !== state.sessionFile || access.source.sessionId !== state.sessionId) continue;
      this.updateSource(id, access.source);
      const requested = this.snapshotVersions.get(id) ?? 0;
      if (requested && !state.isStreaming && !state.isCompacting) {
        await this.loadHistory(id, false);
        if (seen === (this.versions.get(id) ?? 0) && !this.records[id]?.closed && requested === this.snapshotVersions.get(id)) this.snapshotVersions.delete(id);
      }
      const current = this.records[id];
      if (current?.chat.historySource && !current.closed) {
        try {
          const saved = await this.api.listHistorySubagents({ path: current.chat.historySource.path, leafId: current.chat.historySource.leafId });
          if (seen === (this.versions.get(id) ?? 0) && this.records[id] && !this.records[id].closed) {
            this.apply(id, { type: 'saved_subagents_snapshot', subagents: saved.subagents, historySource: current.chat.historySource });
            const refreshed = this.records[id];
            if (refreshed.history && saved.diagnostics.length) this.publish({ ...refreshed, history: { ...refreshed.history, diagnostics: [...new Set([...refreshed.history.diagnostics, ...saved.diagnostics])] } });
          }
        } catch (error) {
          const refreshed = this.records[id];
          if (seen === (this.versions.get(id) ?? 0) && refreshed && !refreshed.closed && refreshed.history) this.publish({ ...refreshed, history: { ...refreshed.history, diagnostics: [...new Set([...refreshed.history.diagnostics, errorText(error)])] } });
        }
      }
    } while (requestedRefresh !== (this.refreshRequests.get(id) ?? 0));
  }
  async older(id: string, beforeEntryId?: string): Promise<void> {
    const record = this.records[id];
    if (!record || record.closed || record.historyPaging || (!beforeEntryId && !record.history?.hasMore)) return;
    const before = beforeEntryId ?? record.history?.messageIds?.[0];
    if (!before) return;
    await this.loadHistory(id, false, { beforeEntryId: before, leafId: record.history?.historySource?.leafId });
  }
  async latest(id: string): Promise<void> {
    this.requireOpen(id);
    await this.loadHistory(id, true);
  }
  private async loadHistory(id: string, latest: boolean, requested?: RuntimeHistoryRead): Promise<void> {
    const record = this.records[id];
    if (!record || record.closed) { if (latest) throw new UserFacingError(i18next.t('omp.intent.latestChanged')); return; }
    const version = (this.historyVersions.get(id) ?? 0) + 1;
    this.historyVersions.set(id, version);
    const eventVersion = this.versions.get(id) ?? 0;
    const position = recallReadingPosition(`${id}:${record.chat.state.sessionId}`);
    const anchorId = readingAnchorMessageIds(position).find(anchor => record.history?.messageIds?.includes(anchor));
    // Reading geometry never selects a historical branch. Only explicit paging
    // leaves the native latest source; an anchored latest reader keeps its tail.
    const following = latest || (!requested && record.historyFollowing);
    const options = requested ?? (following ? {} : { anchorId: anchorId ?? record.history?.messageIds?.at(-1), leafId: record.history?.historySource?.leafId });
    this.publish({ ...record, historyPaging: true, historyError: '' });
    try {
      let snapshot = await this.api.readRuntimeHistory(id, options);
      const oldestId = following && !latest && anchorId ? record.history?.messageIds?.[0] : undefined;
      let restoredPages = 0;
      while (!snapshot.error && oldestId && snapshot.hasMore && !snapshot.messageIds?.includes(oldestId)) {
        if (restoredPages++ >= 8) throw new UserFacingError(i18next.t('omp.history.revisionChanged'));
        const beforeEntryId = snapshot.messageIds?.[0];
        if (!beforeEntryId || !snapshot.historySource) throw new UserFacingError(i18next.t('omp.history.revisionChanged'));
        const page = await this.api.readRuntimeHistory(id, { beforeEntryId, leafId: snapshot.historySource.leafId });
        if (this.historyVersions.get(id) !== version || (this.versions.get(id) ?? 0) !== eventVersion) break;
        if (page.error) throw new Error(page.error);
        if (page.revision !== snapshot.revision || page.source.sessionId !== snapshot.source.sessionId || page.historySource?.path !== snapshot.historySource.path || page.historySource?.leafId !== snapshot.historySource.leafId || !page.messageIds?.length || page.messageIds.includes(beforeEntryId)) throw new UserFacingError(i18next.t('omp.history.revisionChanged'));
        snapshot = { ...snapshot, messages: [...page.messages, ...snapshot.messages], messageIds: [...page.messageIds, ...snapshot.messageIds!], messageResourceReferences: [...(page.messageResourceReferences ?? page.messages.map(() => undefined)), ...(snapshot.messageResourceReferences ?? snapshot.messages.map(() => undefined))], hasMore: page.hasMore, nextBefore: page.nextBefore, diagnostics: [...new Set([...snapshot.diagnostics, ...page.diagnostics])] };
      }
      const current = this.records[id];
      if (!current || current.closed || this.historyVersions.get(id) !== version) { if (latest) throw new UserFacingError(i18next.t('omp.intent.latestChanged')); return; }
      if (following && (this.versions.get(id) ?? 0) !== eventVersion) {
        if (latest) throw new UserFacingError(i18next.t('omp.intent.latestChanged'));
        this.publish({ ...current, historyPaging: false }); return;
      }
      if (snapshot.error) throw new Error(snapshot.error);
      let chat = reduceChatFrame(current.chat, { type: 'messages_snapshot', messages: snapshot.messages, messageIds: snapshot.messageIds, messageResourceReferences: snapshot.messageResourceReferences, reconcileLive: following });
      chat = { ...chat, historySource: snapshot.historySource };
      if (snapshot.source.sessionId !== current.chat.state.sessionId || current.chat.state.sessionFile !== record.chat.state.sessionFile) {
        if (latest) throw new UserFacingError(i18next.t('omp.intent.latestSourceChanged'));
        this.publish({ ...current, historyPaging: false }); return;
      }
      this.publish({ ...current, source: snapshot.source, chat, history: snapshot, historyPaging: false, historyError: snapshot.error ?? '', historyFollowing: following });
      this.applyHistoryDiagnostics(id, snapshot.diagnostics);
    } catch (error) {
      const current = this.records[id];
      if (current && this.historyVersions.get(id) === version) this.publish({ ...current, historyPaging: false, historyError: error instanceof UserFacingError ? error : errorText(error) });
      if (latest || requested) throw error;
    }
  }
  private async refreshSelection(id: string, model: boolean, version = this.selectionVersions.get(id)) {
    const previous = this.records[id];
    const [state, levels] = await Promise.all([
      this.api.request<NativeState>(id, { type: 'get_state' }),
      model ? this.api.request<{ levels: string[] }>(id, { type: 'get_available_thinking_levels' }) : undefined,
    ]);
    const current = this.records[id];
    if (!current || current.closed || current.chat.state.sessionId !== previous?.chat.state.sessionId || state.sessionId !== current.chat.state.sessionId || version !== this.selectionVersions.get(id)) return;
    this.publish({ ...current, chat: { ...current.chat, ...(levels ? { thinkingLevels: levels.levels } : {}), state: { ...current.chat.state, model: state.model, thinkingLevel: state.thinkingLevel } } });
  }
  async command<T = unknown>(id: string, frame: NativeFrame): Promise<T> {
    this.requireOpen(id);
    if (frame.type === 'abort' || frame.type === 'abort_and_prompt') this.desktopQueue.pause(id);
    if (frame.type === 'set_model' || frame.type === 'set_thinking_level') {
      const previous = this.records[id];
      const version = (this.selectionVersions.get(id) ?? 0) + 1;
      this.selectionVersions.set(id, version);
      const model = frame.type === 'set_model';
      const selected = model ? previous.chat.models.find(item => item.provider === frame.provider && item.id === frame.modelId) : undefined;
      this.publish({ ...previous, chat: { ...previous.chat, state: { ...previous.chat.state, ...(model ? { model: selected ?? { provider: String(frame.provider), id: String(frame.modelId) } } : { thinkingLevel: String(frame.level) }) } } });
      let result: T;
      try { result = await this.api.request<T>(id, frame); }
      catch (error) {
        const current = this.records[id];
        if (current && !current.closed && current.chat.state.sessionId === previous.chat.state.sessionId && this.selectionVersions.get(id) === version) this.publish({ ...current, chat: { ...current.chat, state: { ...current.chat.state, model: previous.chat.state.model, thinkingLevel: previous.chat.state.thinkingLevel } } });
        throw error;
      }
      await this.refreshSelection(id, model, version);
      return result;
    }
    const result = await this.api.request<T>(id, frame);
    const fields = stateCommandFields[frame.type];
    if (fields) {
      const state = await this.api.request<NativeState>(id, { type: 'get_state' });
      const current = this.records[id];
      if (current && !current.closed && current.chat.state.sessionId === state.sessionId) this.publish({ ...current, chat: { ...current.chat, state: { ...current.chat.state, ...Object.fromEntries(fields.map(key => [key, state[key]])) } } });
      if (frame.type === 'set_session_name') this.historyChanged();
      return result;
    }
    if (frame.type.startsWith('get_') || frame.type === 'export_html' || frame.type === 'set_auto_retry') return result;
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    if (frame.type === 'branch' || frame.type === 'compact') this.snapshotVersions.set(id, (this.snapshotVersions.get(id) ?? 0) + 1);
    if (frame.type === 'login') this.catalogDirty.add(id);
    await this.refresh(id);
    if (frame.type === 'branch' && result && typeof result === 'object' && 'text' in result && typeof result.text === 'string' && !('cancelled' in result && result.cancelled)) {
      this.apply(id,{type:'extension_ui_request',id:`branch:${String(frame.entryId)}`,method:'set_editor_text',text:result.text});
    }
    this.historyChanged();
    return result;
  }
  requireOpen(id: string) { if (!this.records[id] || this.records[id].closed) throw new UserFacingError(i18next.t('omp.shell.connectionEnded')); }
  /** Source provenance stays in source details; only material history problems become transcript notices, once each. */
  private applyHistoryDiagnostics(id: string, diagnostics: readonly string[]) {
    for (const message of partitionSourceDiagnostics(diagnostics).material) if (this.records[id] && !this.records[id].chat.notices.some(notice => notice.diagnostic === message)) this.apply(id, { type: 'notice', level: 'warning', message, origin: 'desktop' });
  }
  async respond(id: string, response: ExtensionResponse) {
    const key = `${id}:${response.id}`;
    if (this.answered.has(key)) return;
    const request = this.startupPrompts.find(item=>item.runtimeId===id&&item.request.id===response.id)?.request ?? this.records[id]?.chat.prompts.find(item=>item.id===response.id);
    const deadlineAt = typeof request?.deadlineAt === 'number' ? request.deadlineAt : undefined;
    if (!this.startupPrompts.some(item=>item.runtimeId===id&&item.request.id===response.id)) this.requireOpen(id);
    // Claim before awaiting IPC so a click and deadline cannot both answer.
    this.answered.add(key);
    try { await this.api.respond(id, response); }
    catch (error) {
      if (!response.timedOut && (deadlineAt === undefined || deadlineAt > Date.now())) this.answered.delete(key);
      else {
        this.clearPromptTimer(id, response.id);
        this.startupPrompts = this.startupPrompts.filter(item=>item.runtimeId!==id||item.request.id!==response.id);
        this.apply(id, { type: 'extension_ui_response', id: response.id });
        this.publishStartup();
      }
      throw error;
    }
    this.clearPromptTimer(id, response.id);
    this.startupPrompts = this.startupPrompts.filter(item=>item.runtimeId!==id||item.request.id!==response.id);
    this.apply(id, { type: 'extension_ui_response', id: response.id });
    this.publishStartup();
  }
  async remove(target: SessionRemovalTarget) {
    const ids = Object.values(this.records).filter(record => record.chat.state.sessionId === target.sessionId && (target.kind === 'runtime' ? record.runtimeId === target.runtimeId : record.source.path === target.path)).map(record => record.runtimeId);
    for (const id of ids) this.closing.add(id);
    try { return await this.api.removeSession(target); }
    finally { for (const id of ids) if (!this.records[id]?.closed) this.closing.delete(id); }
  }
  async close(id: string) {
    this.closing.add(id);
    try { await this.api.closeSession(id); } catch (error) { this.closing.delete(id); throw error; }
    const record = this.records[id];
    if (record && !record.closed) this.publish({ ...record, closed: true, chat: { ...reduceChatFrame(record.chat,{type:'runtime_exit',error:i18next.t('omp.shell.connectionClosed')}), error: record.chat.error } }, true);
    if (this.records[id]) { const access = await this.api.getRuntimeAccess(id); this.updateSource(id, access.source); }
    this.historyChanged();
  }
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

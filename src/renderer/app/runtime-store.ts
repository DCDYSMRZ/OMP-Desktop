import type { DesktopApi, ExtensionRequest, ExtensionResponse, NativeFrame, NativeModel, NativeState, NativeSubagent, RuntimeEvent, SessionConnection, StartSession } from '../../shared/contracts';
import { createChatState, reduceChatFrame, type ChatState } from '../chat/model';
import i18next from 'i18next';

export interface RuntimeRecord { runtimeId: string; cwd: string; chat: ChatState; closed: boolean }
export type RuntimeNotice = { runtimeId: string; message: string; error?: boolean; url?: string };

/** Owns projections only. Native omp owns execution, queues and durable history. */
export class RuntimeStore {
  private records: Record<string, RuntimeRecord> = {};
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
  private detach: (() => void) | undefined;
  startupPrompts: {runtimeId:string;request:ExtensionRequest}[] = [];
  private answered = new Set<string>();
  private promptTimers = new Map<string, number>();
  private closing = new Set<string>();
  forgetClosed() {
    this.records = Object.fromEntries(Object.entries(this.records).filter(([,record])=>!record.closed));
    this.publishStartup();
  }
  get hasStarting() { return this.starting > 0; }
  private clearPromptTimer(id: string, requestId: string) {
    const key = `${id}:${requestId}`;
    const timer = this.promptTimers.get(key);
    window.clearTimeout(timer);
    this.promptTimers.delete(key);
  }
  private publishStartup() { this.records = {...this.records}; for (const listener of this.listeners) listener(); }
  constructor(private api: DesktopApi, private notice: (notice: RuntimeNotice) => void, private historyChanged: () => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.records;
  connect() {
    this.detach = this.api.onRuntimeEvent(this.receive);
    return () => {
      this.detach?.(); this.detach = undefined;
      for (const timer of this.promptTimers.values()) window.clearTimeout(timer);
      this.promptTimers.clear();
    };
  }
  private publish(record: RuntimeRecord) { this.records = { ...this.records, [record.runtimeId]: record }; for (const listener of this.listeners) listener(); }
  private apply(id: string, frame: NativeFrame) {
    const record = this.records[id];
    if (record) this.publish({ ...record, chat: reduceChatFrame(record.chat, frame) });
  }
  receive = (event: RuntimeEvent) => {
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
            void this.respond(event.runtimeId, {id:requestId,cancelled:true,timedOut:true}).catch(error => this.notice({runtimeId:event.runtimeId,message:errorText(error),error:true}));
            // Expired prompts leave the queue even if a click already owns the response.
            this.startupPrompts = this.startupPrompts.filter(item=>item.runtimeId!==event.runtimeId||item.request.id!==requestId);
            this.apply(event.runtimeId, { type: 'extension_ui_response', id: requestId });
            this.publishStartup();
          }, Math.max(0, deadlineAt - Date.now())));
        }
      }
    }
    if (event.kind !== 'frame') {
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
          if (frame.method === 'notify' || frame.method === 'open_url') this.notice({runtimeId:event.runtimeId,message:String(frame.message??frame.instructions??i18next.t('omp.shell.openLink')),url:frame.method==='open_url'?String(frame.url??frame.launchUrl??''):undefined,error:frame.notifyType==='error'});
        }
        if (event.kind !== 'frame') this.startupPrompts = this.startupPrompts.filter(item=>item.runtimeId!==event.runtimeId);
        this.publishStartup();
      }
      return;
    }
    const id = event.runtimeId;
    if (event.kind === 'frame' && event.frame?.type === 'response') {
      if (event.frame.success === false) this.apply(id, event.frame);
      return;
    }
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    if (event.kind !== 'frame') {
      const expected = this.closing.has(id) && event.kind === 'exit' && !event.error && (event.exitCode === 0 || event.exitCode === null);
      const message = expected ? i18next.t('omp.shell.connectionClosed') : event.error || (event.kind === 'exit' ? i18next.t('omp.shell.runtimeExited',{code:event.exitCode ?? 'signal'}) : i18next.t('omp.shell.connectionFailed'));
      const chat = reduceChatFrame(record.chat,{type:event.kind==='exit'?'runtime_exit':'runtime_error',error:message});
      this.publish({ ...record, closed: true, chat });
      if (!expected) this.notice({ runtimeId: id, message, error: true });
      this.historyChanged();
      return;
    }
    const frame = event.frame;
    if (!frame || record.closed) return;
    if (frame.type === 'extension_ui_request' && this.answered.has(`${id}:${frame.id}`)) return;
    this.apply(id, frame);
    if (frame.type === 'extension_ui_request') {
      if (frame.method === 'notify') this.notice({ runtimeId: id, message: String(frame.message ?? ''), error: frame.notifyType === 'error' });
      if (frame.method === 'open_url') this.notice({ runtimeId: id, message: String(frame.instructions ?? i18next.t('omp.shell.openLink')), url: String(frame.url ?? frame.launchUrl ?? '') });
    }
    if (frame.type === 'notice' || frame.type === 'extension_error' || frame.type === 'rpc_frame_error') this.notice({ runtimeId: id, message: String(frame.message ?? frame.error ?? frame.type), error: frame.level === 'error' || frame.type !== 'notice' });
    if (['session_settled','prompt_result','auto_compaction_end'].includes(frame.type) && this.records[id].chat.refreshMessages) this.snapshotVersions.set(id, (this.snapshotVersions.get(id) ?? 0) + 1);
    if (frame.type === 'model_changed' || frame.type === 'config_update') this.catalogDirty.add(id);
    if (['agent_end','session_settled','prompt_result','model_changed','thinking_level_changed','config_update','session_info_update','auto_compaction_end'].includes(frame.type) || /retry|fallback|queue|todo|goal/.test(frame.type)) void this.refresh(id).catch(error => this.notice({ runtimeId: id, message: errorText(error), error: true }));
    if (frame.type === 'session_settled' || frame.type === 'session_info_update') this.historyChanged();
  };
  async start(options: StartSession): Promise<RuntimeRecord> {
    if (options.sessionPath && options.mode !== 'fork') {
      const existing = Object.values(this.records).find(record => !record.closed && record.chat.state.sessionFile === options.sessionPath);
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
      this.sessionIds.set(connection.runtimeId, connection.state.sessionId);
      this.publish({ runtimeId: connection.runtimeId, cwd: connection.cwd, chat: createChatState(connection), closed: false });
      for (const message of connection.historyDiagnostics ?? []) this.apply(connection.runtimeId, { type: 'notice', level: 'warning', message });
      const events = this.early.get(connection.runtimeId) ?? [];
      this.early.delete(connection.runtimeId);
      this.startupPrompts = this.startupPrompts.filter(item=>item.runtimeId!==connection.runtimeId);
      for (const event of events) {
        if(event.frame?.type==='extension_ui_request' && ['notify','open_url'].includes(String(event.frame.method))) continue;
        this.receive(event);
      }
      this.publishStartup();
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
      if (this.records[id]?.closed) return;
      if (seen !== (this.versions.get(id) ?? 0)) continue;
      const changedSession = state.sessionId !== (this.sessionIds.get(id) ?? record.chat.state.sessionId);
      this.sessionIds.set(id, state.sessionId);
      if (changedSession) {
        this.publish({...record,chat:createChatState({runtimeId:id,cwd:record.cwd,state,messages:[],models:record.chat.models,commands:record.chat.commands,thinkingLevels:record.chat.thinkingLevels})});
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
      if (seen !== (this.versions.get(id) ?? 0) || this.records[id]?.closed) continue;
      this.apply(id, { type: 'state_snapshot', state });
      this.apply(id, { type: 'subagents_snapshot', subagents: children.subagents });
      const requested = this.snapshotVersions.get(id) ?? 0;
      if (requested && !state.isStreaming && !state.isCompacting) {
        const snapshot = await this.api.readRuntimeHistory(id);
        // A streaming frame received while paging invalidates this projection.
        if (seen === (this.versions.get(id) ?? 0) && !this.records[id]?.closed) {
          this.apply(id, { type: 'messages_snapshot', messages: snapshot.messages, messageIds: snapshot.messageIds, messageResourceReferences: snapshot.messageResourceReferences });
          this.apply(id, { type: 'saved_subagents_snapshot', subagents: snapshot.savedSubagents, historySource: snapshot.historySource });
          for (const message of snapshot.diagnostics) if (!this.records[id].chat.notices.some(notice => notice.text === message)) this.apply(id, { type: 'notice', level: 'warning', message });
          if (requested === this.snapshotVersions.get(id)) this.snapshotVersions.delete(id);
        }
      }
    } while (requestedRefresh !== (this.refreshRequests.get(id) ?? 0));
  }
  async command<T = unknown>(id: string, frame: NativeFrame): Promise<T> {
    this.requireOpen(id);
    const result = await this.api.request<T>(id, frame);
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    if (frame.type === 'branch') this.snapshotVersions.set(id, (this.snapshotVersions.get(id) ?? 0) + 1);
    if (frame.type === 'login') this.catalogDirty.add(id);
    await this.refresh(id);
    if (frame.type === 'branch' && result && typeof result === 'object' && 'text' in result && typeof result.text === 'string' && !('cancelled' in result && result.cancelled)) {
      this.apply(id,{type:'extension_ui_request',id:`branch:${String(frame.entryId)}`,method:'set_editor_text',text:result.text});
    }
    if (frame.type === 'set_model') {
      const result = await this.api.request<{ levels: string[] }>(id, { type: 'get_available_thinking_levels' });
      this.apply(id, { type: 'thinking_levels_snapshot', levels: result.levels });
    }
    this.historyChanged();
    return result;
  }
  requireOpen(id: string) { if (!this.records[id] || this.records[id].closed) throw new Error(i18next.t('omp.shell.connectionEnded')); }
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
  async close(id: string) {
    this.closing.add(id);
    try { await this.api.closeSession(id); } finally { this.closing.delete(id); }
    const record = this.records[id];
    if (record && !record.closed) this.publish({ ...record, closed: true, chat: reduceChatFrame(record.chat,{type:'runtime_exit',error:i18next.t('omp.shell.connectionClosed')}) });
    this.historyChanged();
  }
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

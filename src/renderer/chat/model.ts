import { nativeError } from '../../shared/native-error';
import type { ExtensionRequest, NativeCommand, NativeFrame, NativeMessage, NativeModel, NativeState, NativeSubagent, SessionConnection } from '../../shared/contracts';
import { subagentPhase } from '../workspace/subagent-model';
import { nativeEventPresentation } from './native-message-semantics';
import { normalizeAgentFrame, reconcileAgent, settleAgentMessage } from '../../shared/subagent-evidence';
import i18next from 'i18next';
import { presentUserError } from '../lib/user-errors';
import { errorsMessages } from '../locales/messages/errors';

export interface ChatMessage { id: string; source: 'history' | 'live' | 'event'; raw: NativeMessage; streaming: boolean; resourceReference?: string; presentation?: { id: string; sessionId: string } }
export interface ToolActivity { id: string; name: string; args?: unknown; result?: unknown; stream?: unknown; status: 'pending' | 'running' | 'complete' | 'error' | 'interrupted'; todoRevision?: number; }
export interface SessionCommandOutput { row: ChatMessage; sessionId: string; before?: string; after?: string }
export interface ChatState {
  runtimeId: string; state: NativeState; messages: ChatMessage[]; models: NativeModel[]; commands: NativeCommand[]; thinkingLevels: string[];
  isRunning: boolean; isSettled: boolean; error?: string; prompts: ExtensionRequest[]; subagents: NativeSubagent[];
  savedSubagents: NativeSubagent[]; liveSubagents: NativeSubagent[]; historySource?: SessionConnection['historySource'];
  tools: Record<string, ToolActivity>; notices: { id: number; level: string; text: string; nativeMessage?: string; origin?: 'omp'; category?: string; diagnostic?: unknown; values?: Record<string, unknown> }[];
  statuses: Record<string, string>; widgets: Record<string, { lines: string[]; placement: string }>;
  editorText?: { id: string; text: string }; refreshState: boolean; refreshMessages: boolean; sequence: number; outcome?: string;
  live: NativeLiveSequence;
  commandOutputs: SessionCommandOutput[];
  requestTiming?: { startedAt: number; endedAt?: number };
  /** Renderer observation order, independent of native message timestamps. */
  todoRevision?: number; todoStateRevision?: number;
}
type Obj = Record<string, unknown>;
export const record = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
export const text = (value: unknown): string => typeof value === 'string' ? value : '';
export function printable(value: unknown): string { return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2); }
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => { const b = record(block); return text(b.text) || text(b.thinking); }).filter(Boolean).join('\n');
}
export function messageText(raw: NativeMessage): string { return contentText(raw.content) || text(raw.output) || text(raw.summary) || text(raw.text); }
function messageTools(tools: ChatState['tools'], raw: NativeMessage, mutable = false): ChatState['tools'] {
  let next = tools;
  if (Array.isArray(raw.content)) for (const value of raw.content) {
    const block = record(value);
    if (block.type !== 'toolCall' || typeof block.id !== 'string') continue;
    const old = next[block.id];
    if (!mutable && next === tools) next = { ...tools };
    next[block.id] = { ...old, id: block.id, name: text(block.name), args: block.arguments, status: old?.status ?? 'pending' };
  }
  if (raw.role === 'toolResult' && typeof raw.toolCallId === 'string') {
    const id = raw.toolCallId;
    if (!mutable && next === tools) next = { ...tools };
    next[id] = { ...next[id], id, name: text(raw.toolName) || next[id]?.name || 'Tool', result: raw, status: raw.isError ? 'error' : 'complete' };
  }
  return next;
}
function history(messages: NativeMessage[], session: string, messageIds?: readonly unknown[], messageResourceReferences?: readonly unknown[]): Pick<ChatState, 'messages' | 'tools'> {
  const tools: ChatState['tools'] = {};
  // This map is private to the bulk projection; copying it per row is quadratic.
  const rows = messages.map((raw, index) => { messageTools(tools, raw, true); return { id: text(messageIds?.[index]) || `history:${session}:${index}`, source: 'history' as const, raw, streaming: false, resourceReference: text(messageResourceReferences?.[index]) || undefined }; });
  return { messages: rows, tools };
}

/** Native turn-persistence discriminators, never prose or snapshot position. */
function persistenceKey(raw: NativeMessage): string | undefined {
  if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) return;
  if (raw.role === 'assistant' && text(raw.provider) && text(raw.model) && text(raw.stopReason)) return JSON.stringify([raw.role, raw.timestamp, raw.provider, raw.model, text(raw.responseId), raw.stopReason]);
  if (raw.role === 'toolResult' && text(raw.toolCallId) && text(raw.toolName)) return JSON.stringify([raw.role, raw.timestamp, raw.toolCallId, raw.toolName]);
  if (raw.role === 'user' || raw.role === 'developer') return JSON.stringify([raw.role, raw.timestamp, text(raw.attribution)]);
  if (raw.role === 'custom' && text(raw.customType)) return JSON.stringify([raw.role, raw.customType, raw.timestamp, text(raw.attribution), raw.display]);
}

/** Keep only window-local presentation continuity; canonical IDs/resources stay native. */
export function reconcilePresentation(previous: readonly ChatMessage[], incoming: ChatMessage[], sessionId: string, allowLive: boolean, messageIds?: readonly unknown[]): ChatMessage[] {
  const byId = new Map(previous.map(row => [row.id, row]));
  const unique = (rows: readonly ChatMessage[]) => {
    const candidates = new Map<string, ChatMessage | null>();
    for (const row of rows) {
      const key = persistenceKey(row.raw);
      if (key) candidates.set(key, candidates.has(key) ? null : row);
    }
    return candidates;
  };
  const oldCandidates = allowLive ? unique(previous) : undefined;
  const newCandidates = allowLive ? unique(incoming) : undefined;
  return incoming.map((row, index) => {
    // Index fallback IDs are not durable identities; backfill can reuse them.
    if (!text(messageIds?.[index])) return row;
    const existing = byId.get(row.id);
    if (existing?.source === 'history') return existing.presentation?.sessionId === sessionId ? { ...row, presentation: existing.presentation } : row;
    const key = persistenceKey(row.raw);
    const candidate = key && newCandidates?.get(key) === row ? oldCandidates?.get(key) : undefined;
    // Timestamp collisions are possible natively. Ambiguity must mount cold.
    if (candidate?.source !== 'live' || candidate.streaming || candidate.presentation?.sessionId !== sessionId) return row;
    return { ...row, presentation: candidate.presentation };
  });
}
export interface NativeLiveSequence { messages: ChatMessage[]; open: string[]; sequence: number; truncated: number; uncertain: boolean }
export function createNativeLiveSequence(): NativeLiveSequence { return { messages: [], open: [], sequence: 0, truncated: 0, uncertain: false }; }
/** Unkeyed compatibility is lifecycle-local, never a recovered native identity. */
export function reduceNativeLiveSequence(s: NativeLiveSequence, frame: NativeFrame, runtimeId: string, sessionId: string, limit = 256): NativeLiveSequence {
  if (['agent_end', 'runtime_exit', 'runtime_error'].includes(frame.type)) return { ...s, open: [], messages: s.messages.map(row => row.streaming ? { ...row, streaming: false } : row) };
  if (!['message_start', 'message_update', 'message_end'].includes(frame.type)) return s;
  const event = record(frame.assistantMessageEvent);
  const snapshot = record(frame.message ?? event.partial ?? event.message);
  const nativeId = text(frame.messageId);
  const prefix = `live:${runtimeId}:`;
  let sequence = s.sequence;
  let open = [...s.open];
  let uncertain = s.uncertain || !nativeId;
  let id = nativeId ? `${prefix}${nativeId}` : frame.type === 'message_start' ? '' : open.at(-1) ?? '';
  const candidate = s.messages.find(row => row.id === id);
  // A keyed lifecycle can never be stolen by an unkeyed frame. Role changes
  // in filtered/malformed streams start a separate uncertain row.
  if (!nativeId && (id.startsWith(prefix) || candidate && snapshot.role && candidate.raw.role !== snapshot.role)) { id = ''; uncertain = true; }
  if (!id) id = `compat:${runtimeId}:${++sequence}`;
  if (frame.type !== 'message_end' && !open.includes(id)) open.push(id);
  if (frame.type === 'message_end') open = open.filter(value => value !== id);
  const index = s.messages.findIndex(row => row.id === id);
  let raw = snapshot as NativeMessage;
  if (!raw.role) {
    const previous = index >= 0 ? s.messages[index].raw : { role: 'assistant', content: [] };
    raw = previous;
    const contentIndex = Number(event.contentIndex);
    if (typeof event.delta === 'string' && Number.isInteger(contentIndex) && contentIndex >= 0 && contentIndex < 10000) {
      const content = Array.isArray(previous.content) ? [...previous.content] : [];
      const block = { ...record(content[contentIndex]) };
      if (event.type === 'text_delta') { block.type = 'text'; block.text = text(block.text) + event.delta; }
      else if (event.type === 'thinking_delta') { block.type = 'thinking'; block.thinking = text(block.thinking) + event.delta; }
      else if (event.type === 'toolcall_delta') { block.type = 'toolCall'; block.partialArguments = text(block.partialArguments) + event.delta; }
      content[contentIndex] = block; raw = { ...previous, content };
    }
  }
  const row: ChatMessage = { id, source: 'live', raw, streaming: frame.type !== 'message_end', presentation: { id, sessionId } };
  const messages = [...s.messages];
  if (index >= 0) messages[index] = row; else messages.push(row);
  const excess = Math.max(0, messages.length - limit);
  const retained = excess ? messages.slice(excess) : messages;
  const ids = new Set(retained.map(value => value.id));
  return { messages: retained, open: open.filter(value => ids.has(value)), sequence, truncated: s.truncated + excess, uncertain };
}
export function reconcileNativeLiveSequence(s: NativeLiveSequence, durableRows: ChatMessage[], sessionId: string): NativeLiveSequence {
  const reconciled = reconcilePresentation(s.messages, durableRows, sessionId, true, durableRows.map(row => row.source === 'history' ? row.id : undefined));
  const matched = new Set(reconciled.flatMap(row => row.presentation ? [row.presentation.id] : []));
  return { ...s, messages: s.messages.filter(row => !matched.has(row.presentation?.id ?? row.id)) };
}
/** Correlate only within a task owner; evidence chronology, not transport, owns phase. */
function mergeSubagents(saved: NativeSubagent[], live: NativeSubagent[]): NativeSubagent[] {
  const byNativeId = new Map<string, NativeSubagent[]>();
  for (const child of saved) if (child.nativeId) {
    const matches = byNativeId.get(child.nativeId);
    if (matches) matches.push(child); else byNativeId.set(child.nativeId, [child]);
  }
  const replacements = new Map<string, NativeSubagent>();
  const unmatched: NativeSubagent[] = [];
  for (const child of live) {
    const candidates = (byNativeId.get(child.id) ?? []).filter(item => !child.parentToolCallId || !item.parentToolCallId || child.parentToolCallId === item.parentToolCallId);
    const match = candidates.length === 1 ? candidates[0] : undefined;
    if (!match) { unmatched.push(child); continue; }
    replacements.set(match.id, { ...reconcileAgent(child, match), agent: child.agent ?? match.agent, description: child.description ?? match.description, task: child.task ?? match.task, assignment: child.assignment ?? match.assignment, id: match.id, nativeId: child.id, savedId: match.id, historical: false });
  }
  return [...saved.map(child => replacements.get(child.id) ?? child), ...unmatched];
}
/** Native task arrays and consuming job snapshots share the main-process evidence model. */
function mergeTaskResultSubagents(s: ChatState, tool: ToolActivity | undefined): ChatState {
  if (!tool || !s.liveSubagents.length) return s;
  const liveSubagents = settleAgentMessage(s.liveSubagents, { ...record(tool.result), role: 'toolResult', toolName: tool.name, toolCallId: tool.id });
  return { ...s, liveSubagents, subagents: mergeSubagents(s.savedSubagents, liveSubagents) };
}

/** Queued messages keep native settlement open, but do not imply execution. */
export function nativeExecutionActive(state: NativeState): boolean {
  return state.isStreaming || state.isCompacting === true || state.hasPendingAsyncWork === true;
}

export function createChatState(connection: SessionConnection): ChatState {
  return { runtimeId: connection.runtimeId, state: connection.state, ...history(connection.messages, connection.state.sessionId, connection.messageIds, connection.messageResourceReferences),
    savedSubagents: connection.savedSubagents ?? [], liveSubagents: [], historySource: connection.historySource,
    models: connection.models, commands: connection.commands, thinkingLevels: connection.thinkingLevels,
    isRunning: nativeExecutionActive(connection.state),
    isSettled: connection.state.isSettled === true, prompts: [], subagents: connection.savedSubagents ?? [], notices: [], statuses: {}, widgets: {}, refreshState: false, refreshMessages: false, sequence: 0, live: createNativeLiveSequence(), commandOutputs: [] };
}
function notice(s: ChatState, level: string, value: unknown, native = false): ChatState {
  const raw = typeof value === 'string' ? value : printable(value);
  if (s.notices.some(item => item.level === level && item.diagnostic === value)) return s;
  const error = presentUserError(native ? nativeError(raw) : raw);
  const failed = level === 'error' || level === 'warning';
  const body = failed ? `${error.message} ${error.action}` : raw;
  return { ...s, sequence: s.sequence + 1, notices: [...s.notices.slice(-99), { id: s.sequence + 1, level, text: body, nativeMessage: failed ? error.nativeMessage : undefined, origin: native ? 'omp' : undefined, diagnostic: value }] };
}
function noticeText(key: keyof typeof errorsMessages['en'], values: Record<string, string | number> = {}): string {
  const fallback = errorsMessages[i18next.language?.startsWith('en') ? 'en' : 'zh-CN'][key];
  return i18next.t(key, { defaultValue: fallback, ...values }) || fallback.replace(/{{(\w+)}}/g, (_, name: string) => String(values[name] ?? ''));
}
function progressNotice(s: ChatState, category: string, body: string, frame: NativeFrame, level = 'info', values?: Record<string, unknown>, nativeMessage?: string): ChatState {
  const old = s.notices.find(item => item.category === category);
  const item = { id: old?.id ?? s.sequence + 1, category, level, text: body, nativeMessage, origin: 'omp' as const, values, diagnostic: frame };
  return { ...s, refreshState: true, sequence: s.sequence + 1, notices: old ? s.notices.map(value => value === old ? item : value) : [...s.notices.slice(-99), item] };
}
/** Only verified message identities place ephemeral command output in a window. */
function mergeCommandOutputs(rows: ChatMessage[], outputs: SessionCommandOutput[], sessionId: string, latest: boolean): ChatMessage[] {
  const positions = new Map(rows.map((row, index) => [row.id, index]));
  const gaps = new Map<number, ChatMessage[]>();
  for (const output of outputs) {
    if (output.sessionId !== sessionId) continue;
    const before = output.before ? positions.get(output.before) : undefined;
    const after = output.after ? positions.get(output.after) : undefined;
    let gap: number | undefined;
    if (after !== undefined && (!output.before || before !== undefined && before < after)) gap = after;
    else if (!output.after && latest && before !== undefined && before === rows.length - 1) gap = rows.length;
    else if (!output.before && !output.after && latest && !rows.length) gap = 0;
    if (gap === undefined) continue;
    const group = gaps.get(gap) ?? []; group.push(output.row); gaps.set(gap, group);
  }
  const merged: ChatMessage[] = [];
  for (let index = 0; index <= rows.length; index++) { merged.push(...(gaps.get(index) ?? [])); if (index < rows.length) merged.push(rows[index]); }
  return merged;
}
function upsertMessage(s: ChatState, frame: NativeFrame): ChatState {
  const live = reduceNativeLiveSequence(s.live, frame, s.runtimeId, s.state.sessionId);
  const byId = new Map(live.messages.map(row => [row.id, row]));
  const existing = new Set(s.messages.map(row => row.id));
  const messages = [...s.messages.filter(row => row.source !== 'live' || byId.has(row.id)).map(row => byId.get(row.id) ?? row), ...live.messages.filter(row => !existing.has(row.id))];
  let tools = s.tools;
  const previous = new Map(s.live.messages.map(row => [row.id, row]));
  for (const row of live.messages) if (previous.get(row.id) !== row) tools = messageTools(tools, row.raw);
  const appended = live.messages.find(row => !previous.has(row.id));
  const commandOutputs = appended ? s.commandOutputs.map(output => !output.after && output.before !== appended.id ? { ...output, after: appended.id } : output) : s.commandOutputs;
  let next = { ...s, live, commandOutputs, messages, tools, ...(record(frame.message).errorMessage ? { error: text(record(frame.message).errorMessage) } : {}) };
  const raw = record(frame.message) as NativeMessage;
  const tool = tools[text(raw.toolCallId)];
  if (frame.type === 'message_end' && raw.role === 'toolResult' && tool?.name === 'todo' && tool.status === 'complete' && tool.todoRevision === undefined && Array.isArray(record(record(tool.result).details).phases)) {
    const todoRevision = (s.todoRevision ?? 0) + 1;
    next = { ...next, todoRevision, tools: { ...tools, [tool.id]: { ...tool, todoRevision } } };
  }
  return raw.role === 'toolResult' ? mergeTaskResultSubagents(next, next.tools[text(raw.toolCallId)]) : next;
}
export function reduceChatFrame(s: ChatState, f: NativeFrame): ChatState {
  switch (f.type) {
    case 'state_snapshot': {
      const state = { ...s.state, ...record(f.state) } as NativeState;
      if (state.sessionId !== s.state.sessionId || s.state.sessionFile !== undefined && state.sessionFile !== s.state.sessionFile) s = { ...s, messages: [], tools: {}, live: createNativeLiveSequence(), commandOutputs: [], requestTiming: undefined, historySource: undefined, todoRevision: 0, todoStateRevision: undefined };
      const todoRevision = 'todoPhases' in record(f.state) ? (s.todoRevision ?? 0) + 1 : s.todoRevision;
      return { ...s, state, todoRevision, todoStateRevision: 'todoPhases' in record(f.state) ? todoRevision : s.todoStateRevision, refreshState: false, isSettled: state.isSettled === true, isRunning: nativeExecutionActive(state) };
    }
    case 'messages_snapshot': {
      const snapshot = history(Array.isArray(f.messages) ? f.messages as NativeMessage[] : [], s.state.sessionId, Array.isArray(f.messageIds) ? f.messageIds : undefined, Array.isArray(f.messageResourceReferences) ? f.messageResourceReferences : undefined);
      const messages = reconcilePresentation(s.messages, snapshot.messages, s.state.sessionId, f.reconcileLive === true, Array.isArray(f.messageIds) ? f.messageIds : undefined);
      const reconciled = f.reconcileLive === true && Array.isArray(f.messageIds) && f.messageIds.length === snapshot.messages.length ? reconcileNativeLiveSequence(s.live, snapshot.messages, s.state.sessionId) : s.live;
      const live = f.reconcileLive === true && !s.state.isStreaming ? { ...reconciled, messages: reconciled.messages.filter(row => row.streaming) } : reconciled;
      let tools = snapshot.tools;
      if (f.reconcileLive === true) for (const row of live.messages) tools = messageTools(tools, row.raw);
      for (const [id, tool] of Object.entries(s.tools)) {
        if (tools[id]?.status === 'pending' && (tool.status === 'running' || tool.status === 'pending')) tools = { ...tools, [id]: tool };
        else if (tools[id]?.name === 'todo' && tool.todoRevision !== undefined) tools = { ...tools, [id]: { ...tools[id], todoRevision: tool.todoRevision } };
      }
      const aliases = new Map<string, string>();
      for (const row of messages) { aliases.set(row.id, row.id); if (row.presentation) aliases.set(row.presentation.id, row.id); }
      const commandOutputs = s.commandOutputs.map(output => ({ ...output, before: output.before ? aliases.get(output.before) ?? output.before : undefined, after: output.after ? aliases.get(output.after) ?? output.after : undefined }));
      const rows = [...messages, ...(f.reconcileLive === true ? live.messages : [])];
      return { ...s, ...snapshot, live, tools, commandOutputs, messages: mergeCommandOutputs(rows, commandOutputs, s.state.sessionId, f.reconcileLive !== false), refreshMessages: false };
    }
    case 'saved_subagents_snapshot': {
      const savedSubagents = Array.isArray(f.subagents) ? f.subagents as NativeSubagent[] : [];
      return { ...s, savedSubagents, historySource: f.historySource as ChatState['historySource'], subagents: mergeSubagents(savedSubagents, s.liveSubagents) };
    }
    case 'models_snapshot': return { ...s, models: f.models as NativeModel[] };
    case 'thinking_levels_snapshot': return { ...s, thinkingLevels: f.levels as string[] };
    case 'agent_start': case 'turn_start': return { ...s, requestTiming: s.requestTiming && s.requestTiming.endedAt === undefined ? s.requestTiming : { startedAt: typeof f.timestamp === 'number' ? f.timestamp : Date.now() }, error: undefined, outcome: undefined, isRunning: true, isSettled: false, state: { ...s.state, isStreaming: true, isSettled: false } };
    case 'message_start': case 'message_update': case 'message_end': {
      const incoming = record(f.message);
      const receivedContent = Array.isArray(incoming.content) && incoming.content.some(value => { const block = record(value); return block.type === 'toolCall' || !!text(block.text) || !!text(block.thinking); });
      const next = upsertMessage(receivedContent && incoming.stopReason !== 'error' ? { ...s, state: { ...s.state, providerRetry: undefined } } : s, f);
      if (f.type !== 'message_end') return next;
      const message = record(f.message);
      const liveSubagents = settleAgentMessage(next.liveSubagents, message);
      return { ...next, liveSubagents, subagents: mergeSubagents(next.savedSubagents, liveSubagents) };
    }
    case 'agent_end': {
      // A terminal turn can leave a paused queue or native background work; neither is settlement.
      const state = { ...s.state, ...(f.isTerminal === true ? { isStreaming: false, providerRetry: undefined } : {}) };
      const live = reduceNativeLiveSequence(s.live, f, s.runtimeId, s.state.sessionId);
      return { ...s, state, live, messages: s.messages.map(row => row.streaming ? { ...row, streaming: false } : row), isRunning: nativeExecutionActive(state), refreshState: true };
    }
    case 'session_settled': return { ...s, requestTiming: s.requestTiming ? { ...s.requestTiming, endedAt: s.requestTiming.endedAt ?? (typeof f.timestamp === 'number' ? f.timestamp : Date.now()) } : undefined, isRunning: false, isSettled: true, refreshState: true, refreshMessages: true, state: { ...s.state, providerRetry: undefined, isStreaming: false, isSettled: true, hasPendingAsyncWork: false, queuedMessageCount: 0 } };
    case 'prompt_result': {
      const error = text(record(f.error).message) || text(f.error);
      const next = f.sessionSettled === true ? reduceChatFrame(s, { type: 'session_settled', timestamp: f.timestamp }) : s;
      return { ...next, outcome: text(f.status), error: error || s.error, refreshState: true };
    }
    case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': case 'tool_stream_update': {
      const id = text(f.toolCallId); if (!id) return s;
      const old = s.tools[id]; const ended = f.type === 'tool_execution_end';
      if (!ended && (old?.status === 'complete' || old?.status === 'error' || old?.status === 'interrupted')) return s;
      const tool: ToolActivity = { ...old, id, name: text(f.toolName) || old?.name || 'Tool', args: f.args ?? old?.args,
        status: ended ? (f.isError || record(f.result).isError ? 'error' : 'complete') : 'running',
        result: ended ? f.result : f.partialResult ?? old?.result, stream: f.update ?? old?.stream };
      if (ended && tool.name === 'todo' && tool.status === 'complete' && tool.todoRevision === undefined && Array.isArray(record(record(tool.result).details).phases)) {
        const todoRevision = (s.todoRevision ?? 0) + 1;
        tool.todoRevision = todoRevision;
        s = { ...s, todoRevision };
      }
      return mergeTaskResultSubagents({ ...s, tools: { ...s.tools, [id]: tool } }, tool);
    }
    case 'available_commands_update': return { ...s, commands: f.commands as NativeCommand[] };
    case 'model_changed': return { ...s, refreshState: true };
    case 'config_update': return { ...s, state: { ...s.state, ...(f.model ? { model: f.model as NativeModel } : {}), ...(typeof f.thinkingLevel === 'string' ? { thinkingLevel: f.thinkingLevel } : {}) }, refreshState: true };
    case 'thinking_level_changed': return { ...s, state: { ...s.state, thinkingLevel: text(f.thinkingLevel ?? f.level) }, refreshState: true };
    case 'session_info_update': {
      const sessionId = text(f.sessionId) || s.state.sessionId;
      return { ...s, ...(sessionId !== s.state.sessionId ? { messages: [], tools: {}, live: createNativeLiveSequence(), commandOutputs: [], historySource: undefined, todoRevision: 0, todoStateRevision: undefined } : {}), state: { ...s.state, sessionName: text(f.title) || s.state.sessionName, sessionId } };
    }
    case 'auto_compaction_start': return progressNotice({ ...s, isRunning: true, isSettled: false, state: { ...s.state, isCompacting: true } }, 'compaction', noticeText('omp.errors.compacting'), f);
    case 'auto_compaction_end': {
      const failure = text(f.errorMessage) || text(f.error);
      return progressNotice({ ...s, state: { ...s.state, isCompacting: false }, refreshMessages: true }, 'compaction', noticeText(f.aborted ? 'omp.errors.compactionStopped' : failure ? 'omp.errors.compactionFailed' : f.skipped ? 'omp.errors.compactionSkipped' : 'omp.errors.compacted'), f, !f.aborted && failure ? 'error' : 'info', { aborted: !!f.aborted, skipped: !!f.skipped, errorMessage: failure }, !f.aborted && failure ? failure : undefined);
    }
    case 'auto_retry_start': return { ...s, state: { ...s.state, providerRetry: f }, refreshState: true };
    case 'auto_retry_end': {
      const failure = text(f.finalError) || text(f.errorMessage);
      const next = { ...s, state: { ...s.state, providerRetry: undefined }, error: f.success || f.aborted ? undefined : failure, outcome: f.aborted ? 'aborted' : s.outcome, refreshState: true };
      if (f.success || f.aborted || !failure) return next;
      const error = presentUserError(nativeError(failure));
      return progressNotice(next, 'retry', `${error.message} ${error.action}`, f, 'error', { errorMessage: failure }, error.nativeMessage);
    }
    case 'retry_fallback_applied': return progressNotice(s, 'fallback', noticeText('omp.errors.fallback'), f, 'warning');
    case 'retry_fallback_succeeded': return progressNotice(s, 'fallback', noticeText('omp.errors.fallbackSucceeded'), f);
    case 'todo_reminder': {
      const todos = Array.isArray(f.todos) ? f.todos.map(record) : [];
      const remaining = todos.filter(todo => todo.status !== 'completed');
      return progressNotice(s, 'todo', noticeText('omp.errors.todoReminder', { count: remaining.length }), f, 'info', { remaining: remaining.length, attempt: f.attempt, maxAttempts: f.maxAttempts });
    }
    case 'todo_auto_clear': return progressNotice(s, 'todo', noticeText('omp.errors.todoCleared'), f);
    case 'goal_updated': {
      const goal = record(f.goal);
      const status = text(goal.status);
      const statusKey = status === 'completed' ? 'omp.errors.goalCompleted' : status === 'active' ? 'omp.errors.goalActive' : 'omp.errors.goalUpdated';
      const title = f.goal === null ? noticeText('omp.errors.goalCleared') : noticeText(statusKey);
      const usage = typeof goal.tokensUsed === 'number' ? ` · ${goal.tokensUsed}${typeof goal.tokenBudget === 'number' ? `/${goal.tokenBudget}` : ''} tokens` : '';
      return progressNotice(s, 'goal', `${title}${text(goal.objective) ? ` · ${text(goal.objective)}` : ''}${usage}`, f, 'info', goal);
    }
    case 'command_output': {
      const row: ChatMessage = { id: `event:${s.runtimeId}:${s.sequence + 1}`, source: 'event', streaming: false, raw: { role: 'command_output', content: text(f.text) } };
      const before = s.live.messages.at(-1)?.id ?? (f.historyFollowing !== false ? s.messages.findLast(message => message.source !== 'event')?.id : undefined);
      const commandOutputs = [...s.commandOutputs.slice(-99), { row, sessionId: s.state.sessionId, before }];
      const retained = new Set(commandOutputs.map(output => output.row.id));
      const next = { ...s, commandOutputs, sequence: s.sequence + 1, messages: [...s.messages.filter(message => message.source !== 'event' || retained.has(message.id)), row] };
      return s.commandOutputs.length >= 100 ? progressNotice(next, 'command-retention', i18next.t('omp.intent.commandRetention'), f, 'warning') : next;
    }
    case 'notice': return notice(s, text(f.level) || 'info', f.message, f.origin !== 'desktop');
    case 'extension_error': case 'rpc_frame_error': return notice({ ...s, error: text(f.error) || printable(f.error) }, 'error', f.error, f.type === 'extension_error');
    case 'runtime_error': case 'runtime_exit': {
      const liveSubagents = s.liveSubagents.map(child => ['completed', 'failed', 'aborted'].includes(subagentPhase(child)) ? child : { ...child, status: 'unknown', observationLost: true, observationReason: text(f.error) || 'Native runtime is no longer observed', progress: { ...child.progress, status: 'unknown' } });
      s = { ...s, live: reduceNativeLiveSequence(s.live, f, s.runtimeId, s.state.sessionId) };
      return { ...s, liveSubagents, subagents: mergeSubagents(s.savedSubagents, liveSubagents), isRunning: false, isSettled: false, prompts: [], error: text(f.error) || 'Runtime exited', tools: Object.fromEntries(Object.entries(s.tools).map(([id, tool]) => [id, tool.status === 'running' || tool.status === 'pending' ? { ...tool, status: 'interrupted' as const } : tool])), messages: s.messages.map(row => row.streaming ? { ...row, streaming: false } : row), state: { ...s.state, isStreaming: false, isCompacting: false, isSettled: false, hasPendingAsyncWork: undefined, queuedMessageCount: undefined, tokensPerSecond: null } };
    }
    case 'response': return f.success === false ? { ...s, error: text(f.error), refreshState: true } : s;
    case 'extension_ui_response': return { ...s, prompts: s.prompts.filter(p => p.id !== f.id) };
    case 'extension_ui_request': {
      if (typeof f.id !== 'string' || !f.id || typeof f.method !== 'string' || !f.method) return notice({ ...s, error: 'Malformed extension_ui_request: id and method must be non-empty strings' }, 'error', 'Malformed extension_ui_request: id and method must be non-empty strings');
      const method = f.method;
      if (method === 'cancel') return { ...s, prompts: s.prompts.filter(p => p.id !== f.targetId) };
      if (['select', 'confirm', 'input', 'editor'].includes(method)) {
        const invalidString = ['title', 'message', 'placeholder', 'prefill'].find(key => f[key] !== undefined && typeof f[key] !== 'string');
        const invalidOptions = f.options !== undefined && (!Array.isArray(f.options) || !f.options.every(option => typeof option === 'string'));
        const invalidDetails = f.optionDetails !== undefined && (!Array.isArray(f.optionDetails) || !f.optionDetails.every(detail => detail !== null && typeof detail === 'object' && !Array.isArray(detail) && (record(detail).description === undefined || typeof record(detail).description === 'string')));
        const invalidTimeout = f.timeout !== undefined && (typeof f.timeout !== 'number' || !Number.isFinite(f.timeout) || f.timeout < 0);
        if (invalidString || invalidOptions || invalidDetails || invalidTimeout || (method === 'select' && !Array.isArray(f.options))) {
          const error = `Malformed extension_ui_request ${f.id}: invalid ${invalidString || (invalidTimeout ? 'timeout' : invalidDetails ? 'optionDetails' : 'options')}`;
          return notice({ ...s, error }, 'error', error);
        }
        const request: ExtensionRequest = { ...f, type: 'extension_ui_request', id: f.id, method, receivedAt: typeof f.receivedAt === 'number' && Number.isFinite(f.receivedAt) ? f.receivedAt : Date.now() };
        return { ...s, prompts: [...s.prompts.filter(p => p.id !== request.id), request] };
      }
      if (method === 'set_editor_text') return { ...s, editorText: { id: text(f.id), text: text(f.text) } };
      if (method === 'setStatus') { const statuses = { ...s.statuses }; const key = text(f.statusKey); if (typeof f.statusText === 'string') statuses[key] = f.statusText; else delete statuses[key]; return { ...s, statuses }; }
      if (method === 'setWidget') { const widgets = { ...s.widgets }; const key = text(f.widgetKey); if (Array.isArray(f.widgetLines)) widgets[key] = { lines: f.widgetLines.map(String), placement: text(f.widgetPlacement) || 'aboveEditor' }; else delete widgets[key]; return { ...s, widgets }; }
      if (method === 'setTitle') return { ...s, state: { ...s.state, sessionName: text(f.title) } };
      return s; // notify/open_url are global AppShell surfaces, never auto-opened here.
    }
    case 'subagent_lifecycle': case 'subagent_progress': case 'subagent_event': {
      const payload = record(f.payload); const progress = record(payload.progress);
      const id = text(payload.id) || text(progress.id); if (!id) return s;
      const index = s.liveSubagents.findIndex(a => a.id === id); const old = s.liveSubagents[index];
      const agent = normalizeAgentFrame(old, f.type, payload);
      if (!agent) return s;
      const liveSubagents = [...s.liveSubagents]; if (index >= 0) liveSubagents[index] = agent; else liveSubagents.push(agent);
      return { ...s, liveSubagents, subagents: mergeSubagents(s.savedSubagents, liveSubagents) };
    }
    case 'subagents_snapshot': {
      const active = Array.isArray(f.subagents) ? f.subagents as NativeSubagent[] : [];
      const subagents = [...s.liveSubagents];
      for (const snapshot of active) {
        const index = subagents.findIndex(agent => agent.id === snapshot.id);
        const agent = normalizeAgentFrame(subagents[index], 'snapshot', snapshot);
        if (!agent) continue;
        if (index < 0) subagents.push(agent); else subagents[index] = agent;
      }
      return { ...s, liveSubagents: subagents, subagents: mergeSubagents(s.savedSubagents, subagents) };
    }
    default: {
      const event = nativeEventPresentation(f);
      return event ? progressNotice(s, event.key, `${event.label}${event.text ? ` · ${event.text}` : ''}`, f, event.tone === 'error' ? 'error' : 'info') : s;
    }
  }
}

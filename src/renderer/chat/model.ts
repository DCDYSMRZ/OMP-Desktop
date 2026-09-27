import type { ExtensionRequest, NativeCommand, NativeFrame, NativeMessage, NativeModel, NativeState, NativeSubagent, SessionConnection } from '../../shared/contracts';
import { subagentIndex, subagentPhase } from '../workspace/subagent-model';

export interface ChatMessage { id: string; source: 'history' | 'live' | 'event'; raw: NativeMessage; streaming: boolean; resourceReference?: string }
export interface ToolActivity { id: string; name: string; args?: unknown; result?: unknown; stream?: unknown; status: 'pending' | 'running' | 'complete' | 'error' | 'interrupted'; }
export interface ChatState {
  runtimeId: string; state: NativeState; messages: ChatMessage[]; models: NativeModel[]; commands: NativeCommand[]; thinkingLevels: string[];
  isRunning: boolean; isSettled: boolean; error?: string; prompts: ExtensionRequest[]; subagents: NativeSubagent[];
  savedSubagents: NativeSubagent[]; liveSubagents: NativeSubagent[]; historySource?: SessionConnection['historySource'];
  tools: Record<string, ToolActivity>; notices: { id: number; level: string; text: string; category?: string; diagnostic?: unknown }[];
  statuses: Record<string, string>; widgets: Record<string, { lines: string[]; placement: string }>;
  editorText?: { id: string; text: string }; refreshState: boolean; refreshMessages: boolean; sequence: number; outcome?: string;
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
function messageTools(tools: ChatState['tools'], raw: NativeMessage): ChatState['tools'] {
  let next = tools;
  if (Array.isArray(raw.content)) for (const value of raw.content) {
    const block = record(value);
    if (block.type !== 'toolCall' || typeof block.id !== 'string') continue;
    const old = next[block.id];
    next = { ...next, [block.id]: { ...old, id: block.id, name: text(block.name), args: block.arguments, status: old?.status ?? 'pending' } };
  }
  if (raw.role === 'toolResult' && typeof raw.toolCallId === 'string') {
    const id = raw.toolCallId;
    next = { ...next, [id]: { ...next[id], id, name: text(raw.toolName) || next[id]?.name || 'Tool', result: raw, status: raw.isError ? 'error' : 'complete' } };
  }
  return next;
}
function history(messages: NativeMessage[], session: string, messageIds?: readonly unknown[], messageResourceReferences?: readonly unknown[]): Pick<ChatState, 'messages' | 'tools'> {
  let tools: ChatState['tools'] = {};
  const rows = messages.map((raw, index) => { tools = messageTools(tools, raw); return { id: text(messageIds?.[index]) || `history:${session}:${index}`, source: 'history' as const, raw, streaming: false, resourceReference: text(messageResourceReferences?.[index]) || undefined }; });
  return { messages: rows, tools };
}
/** Correlate native identity only inside its task owner; live execution always owns status/metrics. */
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
    replacements.set(match.id, { ...child, agent: child.agent ?? match.agent, description: child.description ?? match.description, task: child.task ?? match.task, assignment: child.assignment ?? match.assignment, id: match.id, nativeId: child.id, savedId: match.id, historical: false });
  }
  return [...saved.map(child => replacements.get(child.id) ?? child), ...unmatched];
}
/** Task results carry terminal diagnostics omitted by the lifecycle event. */
function mergeTaskResultSubagents(s: ChatState, tool: ToolActivity | undefined): ChatState {
  if (tool?.name !== 'task' || !s.liveSubagents.length) return s;
  const details = record(record(tool.result).details);
  const rows = [...(Array.isArray(details.results) ? details.results : []), ...(Array.isArray(details.progress) ? details.progress : [])];
  if (!rows.length) return s;
  let changed = false;
  const liveSubagents = s.liveSubagents.map(child => {
    // Reused native IDs from another task must never inherit this outcome.
    if (child.parentToolCallId !== tool.id) return child;
    for (const value of rows) {
      const row = record(value);
      const id = text(row.id);
      const index = typeof row.index === 'number' && Number.isSafeInteger(row.index) && row.index >= 0 ? row.index : undefined;
      if (id ? id !== child.id && id !== child.nativeId : index === undefined || index !== subagentIndex(child)) continue;
      const phase = row.aborted === true ? 'aborted' : text(row.error) || typeof row.exitCode === 'number' && row.exitCode !== 0 ? 'failed' : row.exitCode === 0 ? 'completed' : subagentPhase({ id: child.id, status: text(row.status) });
      if (phase !== 'completed' && phase !== 'failed' && phase !== 'aborted') continue;
      const previousPhase = subagentPhase(child);
      const terminal = previousPhase === 'completed' || previousPhase === 'failed' || previousPhase === 'aborted';
      const status = terminal ? child.status ?? previousPhase : phase;
      const error = text(child.error) || text(child.progress?.error) || text(row.error);
      const abortReason = text(child.abortReason) || text(child.progress?.abortReason) || text(row.abortReason);
      if (status === child.status && error === text(child.error) && abortReason === text(child.abortReason)) return child;
      changed = true;
      return { ...child, status, ...(error ? { error } : {}), ...(abortReason ? { abortReason } : {}) };
    }
    return child;
  });
  return changed ? { ...s, liveSubagents, subagents: mergeSubagents(s.savedSubagents, liveSubagents) } : s;
}

export function createChatState(connection: SessionConnection): ChatState {
  return { runtimeId: connection.runtimeId, state: connection.state, ...history(connection.messages, connection.state.sessionId, connection.messageIds, connection.messageResourceReferences),
    savedSubagents: connection.savedSubagents ?? [], liveSubagents: [], historySource: connection.historySource,
    models: connection.models, commands: connection.commands, thinkingLevels: connection.thinkingLevels,
    isRunning: connection.state.isStreaming || connection.state.isCompacting === true || connection.state.hasPendingAsyncWork === true || (connection.state.queuedMessageCount ?? 0) > 0,
    isSettled: connection.state.isSettled === true, prompts: [], subagents: connection.savedSubagents ?? [], notices: [], statuses: {}, widgets: {}, refreshState: false, refreshMessages: false, sequence: 0 };
}
function notice(s: ChatState, level: string, value: unknown): ChatState {
  const body = typeof value === 'string' ? value : printable(value);
  return { ...s, sequence: s.sequence + 1, notices: [...s.notices.slice(-99), { id: s.sequence + 1, level, text: body }] };
}
function progressNotice(s: ChatState, category: string, body: string, frame: NativeFrame, level = 'info'): ChatState {
  const old = s.notices.find(item => item.category === category);
  const item = { id: old?.id ?? s.sequence + 1, category, level, text: body, diagnostic: frame };
  return { ...s, refreshState: true, sequence: s.sequence + 1, notices: old ? s.notices.map(value => value === old ? item : value) : [...s.notices.slice(-99), item] };
}
function upsertMessage(s: ChatState, frame: NativeFrame): ChatState {
  const event = record(frame.assistantMessageEvent);
  const snapshot = frame.message ?? event.partial ?? event.message;
  const liveId = text(frame.messageId);
  // Native IDs are process-local; never compare them with snapshot indices or entry IDs.
  const id = `live:${s.runtimeId}:${liveId || `unkeyed-${s.sequence + 1}`}`;
  const index = s.messages.findIndex(row => row.id === id);
  let raw = record(snapshot) as NativeMessage;
  if (!raw.role) {
    const previous = index >= 0 ? s.messages[index].raw : { role: 'assistant', content: [] };
    raw = previous;
    const contentIndex = Number(event.contentIndex);
    if (typeof event.delta === 'string' && Number.isInteger(contentIndex) && contentIndex >= 0) {
      const content = Array.isArray(previous.content) ? [...previous.content] : [];
      const block = { ...record(content[contentIndex]) };
      if (event.type === 'text_delta') { block.type = 'text'; block.text = text(block.text) + event.delta; }
      else if (event.type === 'thinking_delta') { block.type = 'thinking'; block.thinking = text(block.thinking) + event.delta; }
      else if (event.type === 'toolcall_delta') { block.type = 'toolCall'; block.partialArguments = text(block.partialArguments) + event.delta; }
      content[contentIndex] = block; raw = { ...previous, content };
    }
  }
  const row: ChatMessage = { id, source: 'live', raw, streaming: frame.type !== 'message_end' };
  const messages = [...s.messages];
  if (index >= 0) messages[index] = row; else messages.push(row);
  const next = { ...s, messages, tools: messageTools(s.tools, raw), sequence: s.sequence + (index < 0 ? 1 : 0), ...(raw.errorMessage ? { error: text(raw.errorMessage) } : {}) };
  return raw.role === 'toolResult' ? mergeTaskResultSubagents(next, next.tools[text(raw.toolCallId)]) : next;
}
export function reduceChatFrame(s: ChatState, f: NativeFrame): ChatState {
  switch (f.type) {
    case 'state_snapshot': {
      const state = { ...s.state, ...record(f.state) } as NativeState;
      return { ...s, state, refreshState: false, isSettled: state.isSettled === true, isRunning: state.isStreaming || state.isCompacting === true || state.hasPendingAsyncWork === true || (state.queuedMessageCount ?? 0) > 0 };
    }
    case 'messages_snapshot': {
      const snapshot = history(Array.isArray(f.messages) ? f.messages as NativeMessage[] : [], s.state.sessionId, Array.isArray(f.messageIds) ? f.messageIds : undefined, Array.isArray(f.messageResourceReferences) ? f.messageResourceReferences : undefined);
      return { ...s, ...snapshot, messages: [...snapshot.messages, ...s.messages.filter(row => row.source === 'event')], refreshMessages: false };
    }
    case 'saved_subagents_snapshot': {
      const savedSubagents = Array.isArray(f.subagents) ? f.subagents as NativeSubagent[] : [];
      return { ...s, savedSubagents, historySource: f.historySource as ChatState['historySource'], subagents: mergeSubagents(savedSubagents, s.liveSubagents) };
    }
    case 'models_snapshot': return { ...s, models: f.models as NativeModel[] };
    case 'thinking_levels_snapshot': return { ...s, thinkingLevels: f.levels as string[] };
    case 'agent_start': case 'turn_start': return { ...s, error: undefined, outcome: undefined, isRunning: true, isSettled: false, state: { ...s.state, isStreaming: true, isSettled: false } };
    case 'message_start': case 'message_update': case 'message_end': return upsertMessage(s, f);
    case 'agent_end': return { ...s, refreshState: true }; // A yielded agent can still own background work.
    case 'session_settled': return { ...s, isRunning: false, isSettled: true, refreshState: true, refreshMessages: true, state: { ...s.state, isStreaming: false, isSettled: true, hasPendingAsyncWork: false, queuedMessageCount: 0 } };
    case 'prompt_result': {
      const error = text(record(f.error).message) || text(f.error);
      return { ...s, outcome: text(f.status), error: error || s.error, refreshState: true, ...(f.sessionSettled === true ? { isSettled: true, isRunning: false, refreshMessages: true } : {}) };
    }
    case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end': case 'tool_stream_update': {
      const id = text(f.toolCallId); if (!id) return s;
      const old = s.tools[id]; const ended = f.type === 'tool_execution_end';
      if (!ended && (old?.status === 'complete' || old?.status === 'error' || old?.status === 'interrupted')) return s;
      const tool: ToolActivity = { ...old, id, name: text(f.toolName) || old?.name || 'Tool', args: f.args ?? old?.args,
        status: ended ? (f.isError || record(f.result).isError ? 'error' : 'complete') : 'running',
        result: ended ? f.result : f.partialResult ?? old?.result, stream: f.update ?? old?.stream };
      return mergeTaskResultSubagents({ ...s, tools: { ...s.tools, [id]: tool } }, tool);
    }
    case 'available_commands_update': return { ...s, commands: f.commands as NativeCommand[] };
    case 'model_changed': return { ...s, refreshState: true };
    case 'config_update': return { ...s, state: { ...s.state, ...(f.model ? { model: f.model as NativeModel } : {}), ...(typeof f.thinkingLevel === 'string' ? { thinkingLevel: f.thinkingLevel } : {}) }, refreshState: true };
    case 'thinking_level_changed': return { ...s, state: { ...s.state, thinkingLevel: text(f.thinkingLevel ?? f.level) }, refreshState: true };
    case 'session_info_update': return { ...s, state: { ...s.state, sessionName: text(f.title) || s.state.sessionName, sessionId: text(f.sessionId) || s.state.sessionId } };
    case 'auto_compaction_start': return progressNotice({ ...s, isRunning: true, isSettled: false, state: { ...s.state, isCompacting: true } }, 'compaction', 'Compacting native context…', f);
    case 'auto_compaction_end': return progressNotice({ ...s, state: { ...s.state, isCompacting: false }, refreshMessages: true }, 'compaction', text(f.errorMessage) || text(f.error) || (f.aborted ? 'Compaction aborted' : f.skipped ? 'Compaction skipped' : 'Context compaction finished'), f, f.errorMessage || f.error ? 'error' : 'info');
    case 'auto_retry_start': return progressNotice(s, 'retry', `Retry ${f.attempt}/${f.maxAttempts}${typeof f.delayMs === 'number' ? ` in ${Math.ceil(f.delayMs / 1000)}s` : ''}${text(f.errorMessage) ? ` · ${text(f.errorMessage)}` : ''}`, f, 'warning');
    case 'auto_retry_end': return progressNotice(s, 'retry', f.success ? `Retry ${f.attempt} succeeded` : text(f.finalError) || 'Retry failed', f, f.success ? 'info' : 'error');
    case 'retry_fallback_applied': return progressNotice(s, 'fallback', `Model fallback · ${text(f.from)} → ${text(f.to)}${text(f.reason) ? ` · ${text(f.reason)}` : ''}`, f, 'warning');
    case 'retry_fallback_succeeded': return progressNotice(s, 'fallback', `Fallback succeeded · ${text(f.model)}`, f);
    case 'todo_reminder': {
      const todos = Array.isArray(f.todos) ? f.todos.map(record) : [];
      const remaining = todos.filter(todo => todo.status !== 'completed');
      return progressNotice(s, 'todo', `${remaining.length} tasks remaining · reminder ${f.attempt}/${f.maxAttempts}`, f);
    }
    case 'todo_auto_clear': return progressNotice(s, 'todo', 'Completed task list cleared', f);
    case 'goal_updated': {
      const goal = record(f.goal);
      return progressNotice(s, 'goal', f.goal === null ? 'Goal cleared' : `Goal ${text(goal.status)} · ${text(goal.objective)}${typeof goal.tokensUsed === 'number' ? ` · ${goal.tokensUsed}${typeof goal.tokenBudget === 'number' ? `/${goal.tokenBudget}` : ''} tokens` : ''}`, f);
    }
    case 'command_output': return { ...s, sequence: s.sequence + 1, messages: [...s.messages, { id: `event:${s.runtimeId}:${s.sequence + 1}`, source: 'event', streaming: false, raw: { role: 'command_output', content: text(f.text) } }] };
    case 'notice': return notice(s, text(f.level) || 'info', f.message);
    case 'extension_error': case 'rpc_frame_error': return notice({ ...s, error: text(f.error) || printable(f.error) }, 'error', f.error);
    case 'runtime_error': case 'runtime_exit': return { ...s, isRunning: false, isSettled: false, prompts: [], error: text(f.error) || 'Runtime exited', tools: Object.fromEntries(Object.entries(s.tools).map(([id, tool]) => [id, tool.status === 'running' || tool.status === 'pending' ? { ...tool, status: 'interrupted' as const } : tool])), messages: s.messages.map(row => row.streaming ? { ...row, streaming: false } : row), state: { ...s.state, isStreaming: false, isSettled: false } };
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
      const restarted = f.type === 'subagent_lifecycle' && payload.status === 'started';
      const differentOwner = old && (old.parentToolCallId && payload.parentToolCallId ? old.parentToolCallId !== payload.parentToolCallId : old.sessionFile && payload.sessionFile ? old.sessionFile !== payload.sessionFile : false);
      if (differentOwner && !restarted) return s;
      const terminal = old && ['completed', 'failed', 'aborted', 'cancelled', 'stopped', 'timed_out', 'denied'].includes(old.status ?? '');
      const previous = restarted ? differentOwner ? { id } : { id, agent: old?.agent, description: old?.description, task: old?.task, assignment: old?.assignment, sessionFile: old?.sessionFile, parentToolCallId: old?.parentToolCallId } : old;
      const agent: NativeSubagent = { ...previous, ...payload, id, ...(f.type === 'subagent_progress' ? { progress: { ...old?.progress, ...progress }, status: terminal ? old.status : text(progress.status) || old?.status } : {}), ...(f.type === 'subagent_event' ? { lastEvent: payload.event, eventCount: Number(old?.eventCount ?? 0) + 1 } : {}) };
      const liveSubagents = [...s.liveSubagents]; if (index >= 0) liveSubagents[index] = agent; else liveSubagents.push(agent);
      return { ...s, liveSubagents, subagents: mergeSubagents(s.savedSubagents, liveSubagents) };
    }
    case 'subagents_snapshot': {
      const active = Array.isArray(f.subagents) ? f.subagents as NativeSubagent[] : [];
      const subagents = [...s.liveSubagents];
      for (const snapshot of active) {
        const index = subagents.findIndex(agent => agent.id === snapshot.id);
        if (index < 0) { subagents.push(snapshot); continue; }
        const old = subagents[index];
        const differentOwner = old.parentToolCallId && snapshot.parentToolCallId ? old.parentToolCallId !== snapshot.parentToolCallId : old.sessionFile && snapshot.sessionFile ? old.sessionFile !== snapshot.sessionFile : false;
        if (differentOwner) continue;
        const terminal = ['completed', 'failed', 'aborted', 'cancelled', 'stopped', 'timed_out', 'denied'].includes(old.status ?? '');
        subagents[index] = { ...old, ...snapshot, task: snapshot.task ?? old.task, assignment: snapshot.assignment ?? old.assignment, description: snapshot.description ?? old.description, progress: { ...old.progress, ...snapshot.progress }, status: terminal ? old.status : snapshot.status ?? old.status };
      }
      return { ...s, liveSubagents: subagents, subagents: mergeSubagents(s.savedSubagents, subagents) };
    }
    default: return /retry|fallback|queue|todo|goal/.test(f.type) ? progressNotice(s, f.type, text(f.message) || f.type.replaceAll('_', ' '), f, f.type.includes('error') ? 'error' : 'info') : s;
  }
}

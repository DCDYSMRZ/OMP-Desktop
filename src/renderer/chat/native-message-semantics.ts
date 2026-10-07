import type { NativeMessage, NativeSubagent } from '../../shared/contracts';
import type { NativeAsyncDeliveryJob } from '../../shared/native-task-results';
import type { NativeMessageNotice } from '../../shared/native-harness-notice';

export type NativeActor = 'user' | 'assistant' | 'agent' | 'tool' | 'session' | 'unknown';
export interface MessageSemantics {
  visible: boolean;
  actor: NativeActor;
  family: 'request' | 'assistant' | 'activity' | 'boundary' | 'instruction' | 'unknown';
  initiatesTurn: boolean;
  /** Invisible causal marker retained by request grouping, never conversation content. */
  trigger?: 'reminder';
  label: string;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const customLabels: Record<string, string> = {
  'skill-prompt': 'Skill request', 'collab-prompt': 'Collaborative input',
  'background-tan-dispatch': 'Background dispatch', 'live-delegation': 'Voice delegation',
  'async-result': 'Background results', 'lsp-late-diagnostic': 'Late diagnostics', advisor: 'Advisor notes',
  'irc:incoming': 'Incoming peer message', 'irc:relay': 'Peer relay', 'irc:autoreply': 'Peer auto-reply', 'irc:workpool': 'Peer workpool',
  'launch-completion': 'Process completion', handoff: 'Handoff context', reset_boundary: 'Context reset',
};

/** Presentation never changes the raw role, attribution or identity namespace. */
export function messageSemantics(raw: NativeMessage): MessageSemantics {
  const custom = raw.role === 'custom' || raw.role === 'hookMessage';
  const type = string(raw.customType);
  const attributed: NativeActor = raw.attribution === 'user' ? 'user' : raw.attribution === 'agent' ? 'agent' : 'unknown';
  if (raw.role === 'system' || raw.role === 'developer' || raw.display === false || (custom && raw.display !== true)) return { visible: false, actor: attributed === 'unknown' ? 'session' : attributed, family: 'instruction', initiatesTurn: false, label: 'Hidden instructions', trigger: 'reminder' };
  if (raw.role === 'user') {
    const requested = raw.synthetic !== true || raw.userInitiated === true;
    return { visible: true, actor: attributed === 'agent' || !requested ? 'agent' : 'user', family: requested && attributed !== 'agent' ? 'request' : 'activity', initiatesTurn: requested && attributed !== 'agent', label: attributed === 'agent' ? 'Agent assignment' : requested ? 'You' : 'Automatic continuation' };
  }
  if (raw.role === 'assistant') return { visible: true, actor: 'assistant', family: 'assistant', initiatesTurn: false, label: 'Assistant' };
  if (raw.role === 'toolResult') return { visible: true, actor: 'tool', family: 'activity', initiatesTurn: false, label: string(raw.toolName) || 'Tool result' };
  if (raw.role === 'branchSummary' || raw.role === 'compactionSummary' || (custom && type === 'reset_boundary')) return { visible: true, actor: 'session', family: 'boundary', initiatesTurn: false, label: raw.role === 'branchSummary' ? 'Branch summary' : raw.role === 'compactionSummary' ? 'Context compaction' : 'Context reset' };
  if (raw.role === 'bashExecution' || raw.role === 'pythonExecution' || raw.role === 'fileMention') return { visible: true, actor: 'user', family: 'activity', initiatesTurn: false, label: raw.role === 'fileMention' ? 'Attached files' : raw.role === 'bashExecution' ? 'Shell execution' : 'Python execution' };
  if (custom) {
    const initiatesTurn = attributed === 'user' && (type === 'skill-prompt' || type === 'collab-prompt');
    return { visible: true, actor: attributed === 'unknown' ? 'session' : attributed, family: initiatesTurn ? 'request' : 'activity', initiatesTurn, label: Object.hasOwn(customLabels, type) ? customLabels[type]! : type || 'Native message' };
  }
  return { visible: true, actor: attributed === 'unknown' ? raw.toolCallId ? 'tool' : 'session' : attributed, family: raw.role === 'command_output' ? 'activity' : 'unknown', initiatesTurn: false, label: raw.role === 'command_output' ? 'Command output' : raw.role || 'Native content' };
}

/** Flags match native ai/error/flags; legacy persisted markers remain supported. */
export function nativeMessageNotice(raw: NativeMessage): NativeMessageNotice | undefined {
  const error = string(raw.errorMessage);
  const flags = typeof raw.errorId === 'number' ? raw.errorId : 0;
  if (raw.role === 'assistant') {
    if ((flags & 0x02000000) !== 0 || error === '__omp.silent_abort__') return undefined;
    const recovery = object(raw.retryRecovery);
    if (recovery.kind === 'auto-retry' && (recovery.status === 'recovered' || recovery.status === 'superseded')) return { tone: 'info', text: string(recovery.note) || (recovery.status === 'recovered' ? 'Recovered after retry' : 'Attempt superseded by retry') };
    if ((flags & 0x04000000) !== 0 || error === 'Interrupted by user') return { tone: 'info', text: 'Interrupted by user' };
    if (raw.stopReason === 'aborted') return { tone: 'info', text: error && error !== 'Request was aborted' ? error : 'Operation aborted' };
  }
  if (error) return { tone: 'error', text: error };
  if (raw.stopReason === 'error' || raw.isError === true) return { tone: 'error', text: 'Native operation failed' };
  return undefined;
}

/** Only declared display fields: never recursively mine provider payloads or signatures. */
export function declaredNativeContent(value: unknown): unknown[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (Array.isArray(value)) return value;
  const data = object(value);
  if (data.display === false || ['redactedThinking', 'providerPayload', 'signature', 'thinkingSignature'].includes(string(data.type))) return [];
  if (data.content !== undefined) {
    if (typeof data.content === 'string') return [{ type: 'text', text: data.content }];
    if (Array.isArray(data.content)) return data.content;
    if (data.content !== null && typeof data.content === 'object') return [data.content];
  }
  for (const key of ['text', 'message', 'summary', 'output', 'description', 'body']) if (typeof data[key] === 'string') return [{ type: 'text', text: data[key] }];
  return [];
}

export interface NativeEventPresentation { key: string; label: string; text: string; tone: 'info' | 'progress' | 'error' | 'success'; terminal: boolean }
/** One replaceable lifecycle slot per family; callers bound retained unknown families. */
export function nativeEventPresentation(event: Record<string, unknown>): NativeEventPresentation | undefined {
  const type = string(event.type);
  const error = string(event.errorMessage) || string(event.finalError) || string(event.error);
  const declared = string(event.text) || string(event.message) || string(event.reason) || string(event.summary) || string(event.content) || (Array.isArray(event.content) ? event.content.map(block => { const content = object(block); return content.type === 'text' ? string(content.text) : ''; }).filter(Boolean).join('\n') : '');
  if (event.display === false) return undefined;
  if (type === 'auto_retry_start') return { key: 'retry', label: 'Retrying', text: `Attempt ${event.attempt ?? '?'}${typeof event.maxAttempts === 'number' ? `/${event.maxAttempts}` : ''}${typeof event.delayMs === 'number' ? ` · waiting ${Math.ceil(event.delayMs / 1000)}s` : ''}${error ? ` · ${error}` : ''}`, tone: 'progress', terminal: false };
  if (type === 'auto_retry_end') return { key: 'retry', label: 'Retry', text: event.success === true ? 'Retry succeeded' : error || 'Retry ended without success', tone: event.success === true ? 'success' : 'error', terminal: true };
  if (type === 'auto_compaction_start') return { key: 'compaction', label: 'Context compaction', text: 'Compacting native context', tone: 'progress', terminal: false };
  if (type === 'auto_compaction_end') return { key: 'compaction', label: 'Context compaction', text: error || (event.aborted ? 'Compaction aborted' : event.skipped ? 'Compaction skipped' : 'Context compaction finished'), tone: error ? 'error' : 'info', terminal: true };
  if (type === 'retry_fallback_applied' || type === 'retry_fallback_succeeded') return { key: 'fallback', label: 'Provider recovery', text: declared || (type === 'retry_fallback_applied' ? `${string(event.from)} → ${string(event.to)}` : `Fallback succeeded · ${string(event.model)}`), tone: type.endsWith('succeeded') ? 'success' : 'progress', terminal: type.endsWith('succeeded') };
  if (type === 'goal_updated') { const goal = object(event.goal); return { key: 'goal', label: 'Session goal', text: event.goal === null ? 'Goal cleared' : [string(goal.status), string(goal.objective)].filter(Boolean).join(' · '), tone: 'info', terminal: true }; }
  // Request/response ownership and state frames belong to their existing native reducers.
  if (/^(?:extension_ui_|subagent_)/.test(type) || ['message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'agent_start', 'agent_end', 'turn_start', 'turn_end', 'session_info_update', 'session_state', 'response', 'prompt_result', 'state', 'runtime_state', 'queue_updated', 'pong', 'heartbeat'].includes(type)) return undefined;
  if (!declared && !error) return undefined;
  const failed = !!error || event.level === 'error';
  return { key: type === 'command_output' ? 'command' : type.slice(0, 120) || 'notice', label: type === 'command_output' ? 'Command output' : type.replace(/[_:]/g, ' ') || 'Session activity', text: error || declared, tone: failed ? 'error' : 'info', terminal: true };
}

/** B supplies ownership proof only for C-resolved task-stage subsets; an outcome alone never proves ownership. */
export function nativeTaskDeliveryLinkVerified(job: Pick<NativeAsyncDeliveryJob, 'type' | 'agentId' | 'ambiguous'>, ownershipVerified: boolean, child: NativeSubagent | undefined): boolean {
  return job.type === 'task' && !job.ambiguous && !!job.agentId && ownershipVerified && !!child
    && !!child.parentToolCallId
    && (child.nativeId ?? (child.historical ? undefined : child.id)) === job.agentId;
}

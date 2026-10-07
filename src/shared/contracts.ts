import type { ChangeOrigin, TurnChangeEvent, TurnChangeQuery, TurnChangeResult } from './turn-change-types';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type NativeFrame = { type: string; [key: string]: unknown };
export type NativeMessage = { role: string; content?: unknown; timestamp?: number; [key: string]: unknown };
export interface NativeModel { id: string; name?: string; provider: string; contextWindow?: number; reasoning?: boolean; [key: string]: unknown }
export interface NativeCommand { name: string; description?: string; aliases?: string[]; source?: string; [key: string]: unknown }
export interface NativeTodoItem { content: string; status: 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'; blocker?: string; details?: string; notes?: string[] }
export interface NativeTodoPhase { name: string; tasks: NativeTodoItem[] }
export interface NativeState { sessionId: string; sessionFile?: string; sessionName?: string; model?: NativeModel; thinkingLevel?: string; isStreaming: boolean; isSettled?: boolean; isCompacting?: boolean; queuedMessageCount?: number; hasPendingAsyncWork?: boolean; contextUsage?: { tokens: number; contextWindow: number; percent: number }; todoPhases?: NativeTodoPhase[]; fastModeEnabled?: boolean; fastModeActive?: boolean; tokensPerSecond?: number | null; steeringMode?: 'all' | 'one-at-a-time'; followUpMode?: 'all' | 'one-at-a-time'; interruptMode?: 'immediate' | 'wait'; autoCompactionEnabled?: boolean; messageCount?: number; [key: string]: unknown }
export interface NativeSubagent { id: string; nativeId?: string; savedId?: string; historical?: boolean; savedAncestry?: SavedSubagentEdge[]; savedChildren?: NativeSubagent[]; agent?: string; description?: string; task?: string; status?: string; sessionFile?: string; parentToolCallId?: string; progress?: Record<string, unknown>; [key: string]: unknown }
export interface ExtensionRequest { type: 'extension_ui_request'; id: string; method: string; title?: string; message?: string; options?: string[]; optionDetails?: { description?: string }[]; placeholder?: string; prefill?: string; timeout?: number; [key: string]: unknown }
export interface ExtensionResponse { id: string; value?: string; confirmed?: boolean; cancelled?: boolean; timedOut?: boolean }
export interface RuntimeInfo { available: boolean; path?: string; version?: string; error?: string }
export interface RuntimeEvent { runtimeId: string; kind: 'frame' | 'error' | 'exit' | 'observation_error' | 'submission_started'; frame?: NativeFrame; submission?: { submissionId?: string; requestId: string; sessionId?: string }; error?: string; exitCode?: number | null; sessionId?: string; sourcePath?: string }
export interface StartSession { cwd: string; sessionPath?: string; mode?: 'resume' | 'fork'; draft?: boolean }
export type RuntimeSourceState = { status: 'unpersisted'; sessionId: string; path?: string; reason?: string } | { status: 'persisted'; sessionId: string; path: string; reason?: string } | { status: 'unavailable'; sessionId: string; path?: string; reason?: string };
export interface RuntimeShutdownOutcome { clean: boolean; forced: boolean; exitCode: number | null; signal?: string; error?: string }
export type SessionRemovalTarget = ({ kind: 'runtime'; runtimeId: string; sessionId: string } | { kind: 'saved'; path: string; sessionId: string }) & { allowUncertain?: boolean };
export interface SessionRemovalResult { disposition: 'discarded' | 'trashed' | 'partial' | 'retained'; sourceRemoved: boolean; sessionId: string; sourcePath?: string; affectedRuntimeIds: string[]; trashed: string[]; retained: { path: string; reason: string; reasonCode?: 'shared' | 'workspace' | 'provenance' | 'writer' | 'unverified'; kind?: 'companion' | 'source' | 'associated' }[]; errors: string[]; warnings: string[]; preferences?: DesktopPreferences; occupancy?: { status: 'external' | 'unknown'; reason: string } }
/** Desktop history metadata is index-aligned with messages and never added to native raw payloads. */
export interface RuntimeHistoryRead { before?: string; beforeEntryId?: string; anchorId?: string; leafId?: string | null }
export interface RuntimeHistory { source: RuntimeSourceState; messages: NativeMessage[]; messageIds?: string[]; messageResourceReferences?: (string | undefined)[]; savedSubagents?: NativeSubagent[]; historySource?: { path: string; leafId: string | null }; revision?: string; hasMore: boolean; nextBefore?: string; diagnostics: string[]; error?: string }
export interface SessionConnection { source: RuntimeSourceState; runtimeId: string; cwd: string; state: NativeState; messages: NativeMessage[]; messageIds?: string[]; messageResourceReferences?: (string | undefined)[]; savedSubagents?: NativeSubagent[]; historySource?: RuntimeHistory['historySource']; historyDiagnostics?: string[]; history?: RuntimeHistory; models: NativeModel[]; commands: NativeCommand[]; thinkingLevels: string[] }
export interface SessionSummary { id: string; path: string; cwd: string; recordedCwd?: string; title: string; preview: string; updatedAt: string; createdAt?: string; sourceKind: 'journal' | 'archive'; writable: boolean; canFork: boolean; parentSession?: string; previousSessionFiles?: string[] }
/** Match is an exclusive-end UTF-16 range in snippet, ready for renderer highlighting. */
export interface MessageSearchHit { path: string; title: string; cwd: string; entryId: string; role: 'user' | 'assistant' | 'toolResult'; snippet: string; match: [number, number]; timestamp?: number; toolName?: string; position?: number }
export type SearchCoverageReason = 'time' | 'file' | 'directory' | 'bytes' | 'results' | 'unreadable' | 'malformed' | 'cancelled';
export interface MessageSearchCoverage { complete: boolean; reasons: SearchCoverageReason[]; scannedFiles: number; candidateFiles: number; includesToolContent: true; excludes: ['attachments', 'sidecars', 'thinking'] }
export interface MessageSearchResult { results: MessageSearchHit[]; truncated: boolean; diagnostics: string[]; coverage: MessageSearchCoverage }
export interface HistorySourceDiagnostic { path: string; message: string; kind: 'unavailable' | 'malformed' | 'unsupported' | 'limit' }
export interface HistoryListing { sessions: SessionSummary[]; diagnostics: HistorySourceDiagnostic[] }
export interface SessionAccess { status: 'idle' | 'external' | 'owned' | 'unknown'; pending?: boolean; reason?: string; checkedAt: number; occupancySource?: 'presence'; confidence?: 'exact'; }
/** Read-only activity evidence; independent of ownership and permission to send. */
export interface ObservedActivity { state: 'running' | 'idle' | 'stale' | 'unknown'; source: 'runtime' | 'journal' | 'presence'; confidence: 'exact' | 'inferred'; requestStartedAt?: number; currentTool?: { toolCallId: string; name: string; startedAt?: number; intent?: string }; lastAppendAt?: number; owner: 'external' | 'owned' | 'none' | 'unknown'; childrenRevision?: string }
export interface SessionSummary { activity?: ObservedActivity['state']; activitySource?: ObservedActivity['source'] }
export type PresenceEvent = { event: 'state'; sessionFile: string | null; sessionId: string; state: 'running' | 'idle'; since: number; requestStartedAt?: number; currentTool?: ObservedActivity['currentTool'] } | { event: 'delta'; messageId?: string; kind: 'text' | 'thinking'; text: string } | { event: 'tool'; phase: 'start' | 'end'; toolCallId: string; name: string; isError?: boolean } | { event: 'message_end'; messageId?: string } | { event: 'switch'; from: string | null; to: string | null } | { event: 'turn_end' };
export interface ObservedTail { id: string; messageId?: string; startedAt: number; content: ({ type: 'text'; text: string } | { type: 'thinking'; thinking: string })[]; ended: boolean }
export interface HistorySnapshot { activity?: ObservedActivity; liveTail?: ObservedTail[] }
export interface RuntimeAccess extends SessionAccess { source: RuntimeSourceState; canSend: boolean; canFork: boolean }
export interface HistoryMessage { id: string; entryId?: string; resourceReference?: string; raw: NativeMessage }
export interface HistoryTreeNode { id: string; entryId?: string; parentId: string | null; type: string; timestamp: string; role?: string; label?: string; preview: string }
export interface HistoryRead { path: string; leafId?: string | null; before?: string; beforeEntryId?: string; anchorId?: string }
export interface HistorySnapshot { session: SessionSummary; revision: string; leafId: string | null; selectedLeafId: string | null; messages: HistoryMessage[]; hasMore: boolean; nextBefore?: string; sourceReference?: string; diagnostics: string[]; access: SessionAccess }
export interface HistorySnapshot { selection?: { model?: NativeModel; thinkingLevel?: string | null } }
export type HistoryTranscriptPage = Omit<HistorySnapshot, 'access'>;
/** Entry anchors and restored tail pages carry the accepted child branch/revision; cursors bind their own source. */
export interface ChildHistoryRead { before?: string; beforeEntryId?: string; childLeafId?: string | null; childRevision?: string }
/** Verified persisted edges, always resolved again from the original authorized parent. */
export interface SavedSubagentEdge { subagentId: string; leafId: string | null; revision: string }
export interface SavedSubagentNavigation { ancestry: SavedSubagentEdge[]; ancestors: NativeSubagent[]; children: NativeSubagent[]; childAncestry: SavedSubagentEdge[] }
export type SavedSubagentPage = HistoryTranscriptPage & { navigation?: SavedSubagentNavigation };
export interface SessionResourcePage { name: string; kind: 'text' | 'image' | 'binary'; content?: string; dataUrl?: string; imageReferences?: { reference: string; name: string }[]; nextCursor?: string; diagnostics: string[]; sourceLabel: string }
export interface SessionResourcePage { display?: { title: string; content: string; language?: string; truncated?: boolean } }
export type SessionResourceContext = { kind: 'saved'; parentPath: string; leafId?: string | null; subagentId?: string; ancestry?: SavedSubagentEdge[] } | { kind: 'runtime'; runtimeId: string; subagentId?: string };
export type SessionParentResolution = { status: 'none' | 'missing' | 'ambiguous'; parentSession?: string; reason: string } | { status: 'resolved'; parentSession: string; session: SessionSummary };
export interface HistoryTreeSnapshot { revision: string; leafId: string | null; nodes: HistoryTreeNode[]; hasMore: boolean; nextBefore?: string; diagnostics: string[] }
export type HistoryEvent = { path: string; kind: 'snapshot'; snapshot: HistorySnapshot } | { path: string; kind: 'presence'; activity: ObservedActivity; liveTail: ObservedTail[] } | { path: string; kind: 'access'; access: SessionAccess } | { path: string; kind: 'error'; error: string } | { path: string; kind: 'activity'; activity: ObservedActivity['state']; activitySource?: ObservedActivity['source']; updatedAt: string } | { path: string; kind: 'listing'; listing: HistoryListing };
export interface DesktopPreferences { language: 'zh-CN' | 'en'; fontSize: number; fontFamily: string; sidebarWidth: number; panelWidth: number; chatContentWidth: number; executablePath: string; preferredEditor: 'system' | 'vscode' | 'cursor' | 'zed'; profile: string; lastWorkspace: string; recentWorkspaces: string[]; pinnedSessions: string[]; enterToSend: boolean; notifications: boolean }
export interface DesktopPreferences { terminalPresence: boolean }
export interface PresenceSettingsStatus { path: string; installedVersion: string | null; participating: number; nonParticipating: number; error?: string }
export interface DesktopPreferences { messageMeta: 'always' | 'hover'; durationStyle: 'units' | 'clock' }
export interface DesktopPreferences { hiddenProjects: string[]; collapsedProjects: Record<string, boolean>; sidebarStateMigrated: boolean }
export interface SessionUsageSummary { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number; cost?: number; contextTokens?: number; observedAt?: number; incomplete: boolean }
export interface SessionUsageSummary { mainCost?: number; subagentCost?: number; premiumRequests?: number; model?: { provider: string; id: string; name?: string }; contextWindow?: number; windowSource?: 'runtime' | 'catalog' | 'config'; contextState?: 'measured' | 'compacted'; compactedTokens?: number; latest?: { cost?: number; tokens?: number } }
export interface SessionModelCapacity { provider: string; id: string; name?: string; contextWindow: number; windowSource: 'runtime' | 'catalog' | 'config' }
export interface SessionUsageSummary { unrecordedSubagents?: number }
export interface SessionUsageSummary { nonMessageTokens?: number; compactionEpoch?: number; historyRewriteTokensRemoved?: number; contextPrompt?: { systemPrompt: string[]; dumpTools: unknown[]; partial?: boolean } }
export interface SessionModelCapacity { input?: string[]; remoteCompaction?: boolean; remoteCompactionV2?: boolean }
export interface Bootstrap { preferences: DesktopPreferences; runtime: RuntimeInfo; platform: string; home: string; configuredModel?: string; modelNames?: { provider: string; id: string; name?: string }[] }
export interface ConfigEntry { key: string; type: string; description: string; value?: JsonValue; redacted?: boolean; credential?: boolean }
export interface SettingsSnapshot { entries: ConfigEntry[]; directory: string }
export interface SettingsWriteResult { snapshot: SettingsSnapshot; overriddenBy?: string; fallbackEnv?: string }
export interface DesktopDiagnostics { desktopVersion: string; electron: string; chrome: string; node: string; omp: RuntimeInfo; presenceVersion: string | null; logsDirectory: string }
export interface Attachment { id: string; name: string; path?: string; source: 'disk' | 'clipboard'; expiresAt: number; size: number; kind: 'image' | 'text'; previewUrl?: string }
export interface PromptInput { text: string; attachmentIds?: string[]; mode?: 'prompt' | 'steer' | 'follow_up' | 'abort_and_prompt'; submissionId?: string }
export interface PromptSubmission extends PromptInput { expectedSessionId: string }
/** UI correlation is not a native command ID. The host allocates requestId. */
export interface PromptAcceptance { requestId: string; data: unknown }
export interface PreparedPrompt { message: string; images?: { type: 'image'; data: string; mimeType: string }[] }
export interface FileEntry { name: string; path: string; kind: 'file' | 'directory'; size: number }
export interface FileSearchResult { entries: FileEntry[]; truncated: boolean; diagnostics: string[] }
export interface FileContent { path: string; name: string; kind: 'text' | 'image' | 'binary' | 'tooLarge'; size: number; content?: string; dataUrl?: string; language?: string }
export interface RecordedChangeStep { toolId: string; patch: string; added: number; removed: number; countsKnown: boolean; unknownReason?: string; firstChangedLine?: number; operation?: 'create' | 'update' | 'delete' | 'move'; command?: string; binary?: boolean; origin?: ChangeOrigin }
/** One final net file result. Steps are optional process evidence, never the final patch or totals. */
export interface RecordedFileChange { path: string; op: 'create' | 'update' | 'delete' | 'move'; sourcePath?: string; patch: string; added: number; removed: number; countsKnown: boolean; content: 'complete' | 'partial' | 'unavailable' | 'binary'; evidence: 'snapshot' | 'reconstructed' | 'recorded'; reason?: string; toolId: string; firstChangedLine?: number; steps: RecordedChangeStep[]; processTruncated?: boolean }
export interface WorkspaceDiff { available: boolean; reason?: string; repositories?: string[]; unversionedPaths?: string[]; files: { path: string; status: string; patch: string; repo?: string; patchDeferred?: boolean; added?: number; removed?: number }[] }
export interface PanelRequest { kind: 'file' | 'files' | 'changes' | 'tasks' | 'session' | 'subagent' | 'resource'; path?: string; turnChanges?: TurnChangeResult; turnChangeQuery?: TurnChangeQuery; line?: number; endLine?: number; subagentId?: string; context?: SessionResourceContext; reference?: string; originTurnId?: string; originTabId?: string }
export interface DesktopApi {
  bootstrap(): Promise<Bootstrap>;
  getWindowChrome(): Promise<{ fullscreen: boolean }>;
  onWindowChrome(listener: (state: { fullscreen: boolean }) => void): () => void;
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  getPresenceSettings(): Promise<PresenceSettingsStatus>;
  getDesktopDiagnostics(): Promise<DesktopDiagnostics>;
  openLogsFolder(): Promise<void>;
  chooseWorkspace(): Promise<string | null>;
  chooseExecutable(): Promise<string | null>;
  chooseSessionFile(): Promise<string | null>;
  checkRuntime(): Promise<RuntimeInfo>;
  openNativeLogin(): Promise<void>;
  listHistory(options?: { cwd?: string; query?: string }): Promise<HistoryListing>;
  getSessionUsage(path: string, leafId?: string | null): Promise<SessionUsageSummary>;
  getModelCapacity(provider: string, id: string): Promise<SessionModelCapacity | undefined>;
  searchMessages(request: { query: string; limit?: number; path?: string }): Promise<MessageSearchResult>;
  onMenuCommand(listener: (command: string) => void): () => void;
  readHistory(options: HistoryRead): Promise<HistorySnapshot>;
  readHistoryTree(path: string, before?: string): Promise<HistoryTreeSnapshot>;
  listHistorySubagents(options: { path: string; leafId?: string | null }): Promise<{ subagents: NativeSubagent[]; diagnostics: string[] }>;
  readHistorySubagent(options: { parentPath: string; subagentId: string; leafId?: string | null; ancestry?: SavedSubagentEdge[] } & ChildHistoryRead): Promise<SavedSubagentPage>;
  readSessionArtifact(options: { context: SessionResourceContext; reference: string; cursor?: string }): Promise<SessionResourcePage>;
  readRuntimeSubagent(options: { runtimeId: string; subagentId: string } & ChildHistoryRead): Promise<HistoryTranscriptPage>;
  getTurnChanges(query: TurnChangeQuery): Promise<TurnChangeResult>;
  onTurnChanges(listener: (event: TurnChangeEvent) => void): () => void;
  resolveHistoryParent(path: string): Promise<SessionParentResolution>;
  readSessionEntry(options: { parentPath: string; entryId: string; cursor?: string }): Promise<SessionResourcePage>;
  watchHistory(options: HistoryRead): Promise<HistorySnapshot>;
  unwatchHistory(): Promise<void>;
  onHistoryEvent(listener: (event: HistoryEvent) => void): () => void;
  readRuntimeHistory(runtimeId: string, options?: RuntimeHistoryRead): Promise<RuntimeHistory>;
  /** Observes owned runtime access and persisted-source recovery; not an exclusive lease. */
  getRuntimeAccess(runtimeId: string): Promise<RuntimeAccess>;
  startSession(options: StartSession): Promise<SessionConnection>;
  closeSession(runtimeId: string): Promise<void>;
  removeSession(target: SessionRemovalTarget): Promise<SessionRemovalResult>;
  request<T = unknown>(runtimeId: string, command: NativeFrame): Promise<T>;
  sendPrompt(runtimeId: string, input: PromptSubmission): Promise<PromptAcceptance>;
  respond(runtimeId: string, response: ExtensionResponse): Promise<void>;
  onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
  listSettings(cwd: string): Promise<SettingsSnapshot>;
  setSetting(cwd: string, key: string, value: JsonValue): Promise<SettingsWriteResult>;
  resetSetting(cwd: string, key: string): Promise<SettingsWriteResult>;
  chooseAttachments(cwd: string): Promise<Attachment[]>;
  addDroppedFiles(cwd: string, files: File[]): Promise<Attachment[]>;
  addImageAttachment(cwd: string, input: { name: string; mimeType: string; data: Uint8Array }): Promise<Attachment>;
  removeAttachment(id: string): Promise<void>;
  listFiles(cwd: string, relativePath?: string): Promise<FileEntry[]>;
  searchFiles(cwd: string, query: string): Promise<FileSearchResult>;
  readFile(cwd: string, path: string): Promise<FileContent>;
  gitDiff(cwd: string, path?: string, referencedPaths?: string[]): Promise<WorkspaceDiff>;
  revealFile(cwd: string, path: string): Promise<void>;
  openInEditor(request: { cwd: string; path: string; line?: number; column?: number }): Promise<void>;
  quickLook(request: { cwd: string; path: string }): Promise<void>;
  startFileDrag(request: { cwd: string; path: string }): void;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  setAttention(options: { badge: string; bounce?: 'informational' | 'critical' }): Promise<void>;
  notify(options: { title: string; body: string; runtimeId: string }): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  onNotificationClick(listener: (runtimeId: string) => void): () => void;
}
declare global { interface Window { ompDesktop: DesktopApi } }

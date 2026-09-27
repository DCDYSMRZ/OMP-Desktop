export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type NativeFrame = { type: string; [key: string]: unknown };
export type NativeMessage = { role: string; content?: unknown; timestamp?: number; [key: string]: unknown };
export interface NativeModel { id: string; name?: string; provider: string; contextWindow?: number; reasoning?: boolean; [key: string]: unknown }
export interface NativeCommand { name: string; description?: string; aliases?: string[]; source?: string; [key: string]: unknown }
export interface NativeState { sessionId: string; sessionFile?: string; sessionName?: string; model?: NativeModel; thinkingLevel?: string; isStreaming: boolean; isSettled?: boolean; isCompacting?: boolean; queuedMessageCount?: number; hasPendingAsyncWork?: boolean; [key: string]: unknown }
export interface NativeSubagent { id: string; nativeId?: string; savedId?: string; historical?: boolean; agent?: string; description?: string; task?: string; status?: string; sessionFile?: string; parentToolCallId?: string; progress?: Record<string, unknown>; [key: string]: unknown }
export interface ExtensionRequest { type: 'extension_ui_request'; id: string; method: string; title?: string; message?: string; options?: string[]; optionDetails?: { description?: string }[]; placeholder?: string; prefill?: string; timeout?: number; [key: string]: unknown }
export interface ExtensionResponse { id: string; value?: string; confirmed?: boolean; cancelled?: boolean; timedOut?: boolean }
export interface RuntimeInfo { available: boolean; path?: string; version?: string; error?: string }
export interface RuntimeEvent { runtimeId: string; kind: 'frame' | 'error' | 'exit'; frame?: NativeFrame; error?: string; exitCode?: number | null }
export interface StartSession { cwd: string; sessionPath?: string; mode?: 'resume' | 'fork' }
/** Desktop history metadata is index-aligned with messages and never added to native raw payloads. */
export interface RuntimeHistory { messages: NativeMessage[]; messageIds?: string[]; messageResourceReferences?: (string | undefined)[]; savedSubagents?: NativeSubagent[]; historySource?: { path: string; leafId: string | null }; diagnostics: string[] }
export interface SessionConnection { runtimeId: string; cwd: string; state: NativeState; messages: NativeMessage[]; messageIds?: string[]; messageResourceReferences?: (string | undefined)[]; savedSubagents?: NativeSubagent[]; historySource?: RuntimeHistory['historySource']; historyDiagnostics?: string[]; models: NativeModel[]; commands: NativeCommand[]; thinkingLevels: string[] }
export interface SessionSummary { id: string; path: string; cwd: string; recordedCwd?: string; title: string; preview: string; updatedAt: string; createdAt?: string; sourceKind: 'journal' | 'archive'; writable: boolean; canFork: boolean; parentSession?: string; previousSessionFiles?: string[] }
export interface HistorySourceDiagnostic { path: string; message: string; kind: 'unavailable' | 'malformed' | 'unsupported' | 'limit' }
export interface HistoryListing { sessions: SessionSummary[]; diagnostics: HistorySourceDiagnostic[] }
export interface SessionAccess { status: 'idle' | 'external' | 'owned' | 'unknown'; reason?: string; checkedAt: number }
export interface RuntimeAccess extends SessionAccess { canFork: boolean }
export interface HistoryMessage { id: string; entryId?: string; resourceReference?: string; raw: NativeMessage }
export interface HistoryTreeNode { id: string; entryId?: string; parentId: string | null; type: string; timestamp: string; role?: string; label?: string; preview: string }
export interface HistoryRead { path: string; leafId?: string | null; before?: string }
export interface HistorySnapshot { session: SessionSummary; revision: string; leafId: string | null; selectedLeafId: string | null; messages: HistoryMessage[]; hasMore: boolean; nextBefore?: string; sourceReference?: string; diagnostics: string[]; access: SessionAccess }
export type HistoryTranscriptPage = Omit<HistorySnapshot, 'access'>;
export interface SessionResourcePage { name: string; kind: 'text' | 'image' | 'binary'; content?: string; dataUrl?: string; imageReferences?: { reference: string; name: string }[]; nextCursor?: string; diagnostics: string[]; sourceLabel: string }
export interface HistoryTreeSnapshot { revision: string; leafId: string | null; nodes: HistoryTreeNode[]; hasMore: boolean; nextBefore?: string; diagnostics: string[] }
export type HistoryEvent = { path: string; kind: 'snapshot'; snapshot: HistorySnapshot } | { path: string; kind: 'access'; access: SessionAccess } | { path: string; kind: 'error'; error: string };
export interface DesktopPreferences { theme: 'system' | 'light' | 'dark'; language: 'zh-CN' | 'en'; fontSize: number; fontFamily: string; sidebarWidth: number; panelWidth: number; chatContentWidth: number; executablePath: string; profile: string; lastWorkspace: string; recentWorkspaces: string[]; pinnedSessions: string[]; enterToSend: boolean }
export interface Bootstrap { preferences: DesktopPreferences; runtime: RuntimeInfo; platform: string; home: string }
export interface ConfigEntry { key: string; type: string; description: string; value?: JsonValue; redacted?: boolean; credential?: boolean }
export interface SettingsSnapshot { entries: ConfigEntry[]; directory: string }
export interface SettingsWriteResult { snapshot: SettingsSnapshot; overriddenBy?: string; fallbackEnv?: string }
export interface Attachment { id: string; name: string; path?: string; source: 'disk' | 'clipboard'; expiresAt: number; size: number; kind: 'image' | 'text'; previewUrl?: string }
export interface PromptInput { text: string; attachmentIds?: string[]; mode?: 'prompt' | 'steer' | 'follow_up' }
export interface PreparedPrompt { message: string; images?: { type: 'image'; data: string; mimeType: string }[] }
export interface FileEntry { name: string; path: string; kind: 'file' | 'directory'; size: number }
export interface FileSearchResult { entries: FileEntry[]; truncated: boolean; diagnostics: string[] }
export interface FileContent { path: string; name: string; kind: 'text' | 'image' | 'binary' | 'tooLarge'; size: number; content?: string; dataUrl?: string; language?: string }
export interface WorkspaceDiff { available: boolean; reason?: string; files: { path: string; status: string; patch: string }[] }
export interface PanelRequest { kind: 'file' | 'changes' | 'subagent' | 'resource'; path?: string; subagentId?: string; parentPath?: string; reference?: string; leafId?: string | null }
export interface DesktopApi {
  bootstrap(): Promise<Bootstrap>;
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  chooseWorkspace(): Promise<string | null>;
  chooseExecutable(): Promise<string | null>;
  chooseSessionFile(): Promise<string | null>;
  checkRuntime(): Promise<RuntimeInfo>;
  listHistory(options?: { cwd?: string; query?: string }): Promise<HistoryListing>;
  readHistory(options: HistoryRead): Promise<HistorySnapshot>;
  readHistoryTree(path: string, before?: string): Promise<HistoryTreeSnapshot>;
  listHistorySubagents(options: { path: string; leafId?: string | null }): Promise<{ subagents: NativeSubagent[]; diagnostics: string[] }>;
  readHistorySubagent(options: { parentPath: string; subagentId: string; leafId?: string | null; before?: string }): Promise<HistoryTranscriptPage>;
  readSessionArtifact(options: { parentPath: string; reference: string; cursor?: string; subagentId?: string; leafId?: string | null }): Promise<SessionResourcePage>;
  readSessionEntry(options: { parentPath: string; entryId: string; cursor?: string }): Promise<SessionResourcePage>;
  watchHistory(options: HistoryRead): Promise<HistorySnapshot>;
  unwatchHistory(): Promise<void>;
  onHistoryEvent(listener: (event: HistoryEvent) => void): () => void;
  readRuntimeHistory(runtimeId: string): Promise<RuntimeHistory>;
  /** Observes owned runtime access and persisted-source recovery; not an exclusive lease. */
  getRuntimeAccess(runtimeId: string): Promise<RuntimeAccess>;
  startSession(options: StartSession): Promise<SessionConnection>;
  closeSession(runtimeId: string): Promise<void>;
  request<T = unknown>(runtimeId: string, command: NativeFrame): Promise<T>;
  sendPrompt(runtimeId: string, input: PromptInput): Promise<unknown>;
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
  gitDiff(cwd: string, path?: string): Promise<WorkspaceDiff>;
  revealFile(cwd: string, path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
}
declare global { interface Window { ompDesktop: DesktopApi } }

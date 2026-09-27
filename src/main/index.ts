import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveInstallation } from './omp/discovery';
import { OmpRuntimeService } from './omp/service';
import { SessionAdmissions, requireWritable } from './omp/admission';
import { HistoryReader } from './data/journal';
import { SessionResources } from './data/session-resources';
import { inspectSessionAccess } from './data/occupancy';
import { resolveHistoryRoots } from './data/roots';
import type { ExecutionContext } from './omp/cli';
import { NativeDataService } from './data/service';
import { WorkspaceService } from './workspace/service';
import type { DesktopPreferences, ExtensionResponse, HistoryEvent, HistoryMessage, HistoryRead, HistorySnapshot, JsonValue, NativeFrame, NativeMessage, PromptInput, RuntimeAccess, RuntimeHistory, SessionAccess, SessionConnection } from '../shared/contracts';
import { record } from './omp/framing';

const outputDirectory = dirname(fileURLToPath(import.meta.url));
const rendererPath = join(outputDirectory, '../renderer/index.html');
const rendererFileUrl = pathToFileURL(rendererPath).href;
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
if (devUrl) {
  const url = new URL(devUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('The renderer development URL must be local HTTP');
  }
}
if (process.env.OMP_DESKTOP_USER_DATA) {
  if (!isAbsolute(process.env.OMP_DESKTOP_USER_DATA)) throw new Error('OMP_DESKTOP_USER_DATA must be absolute');
  app.setPath('userData', process.env.OMP_DESKTOP_USER_DATA);
}

let window: BrowserWindow | null = null;
let quitting = false;
let drained = false;
const workspaces = new Set<string>();
const sessions = new Set<string>();
const ownedRuntimes = new Set<string>();
const workspace = new WorkspaceService();
const historyReader = new HistoryReader();
const sessionResources = new SessionResources(historyReader, async path => (await resolveHistoryRoots(await historyContext(path))).blobs);
const admissions = new SessionAdmissions();
const sessionWorkspaces = new Map<string, string>();
const runtimeHydrations = new Map<string, Promise<RuntimeHistory>>();
let stopHistoryWatch: (() => void) | undefined;
let watchGeneration = 0;
let discoveredInstallation: { info: { available: boolean; path?: string }; env: NodeJS.ProcessEnv } | undefined;
const runtime = new OmpRuntimeService((event) => {
  // Every worker belongs to this window; the runtime ID preserves background-session routing.
  // Events during start can precede the connection response: the renderer queues unknown IDs.
  if (event.kind !== 'exit') ownedRuntimes.add(event.runtimeId);
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('desktop:runtimeEvent', event);
  }
  if (event.kind === 'exit') ownedRuntimes.delete(event.runtimeId);
});
const data: NativeDataService = new NativeDataService({
  userDataDir: app.getPath('userData'),
  getContext,
  getHistoryContext: cwd => historyContext('', cwd),
});
async function getContext(cwd: string): Promise<ExecutionContext> {
  // Preferences are a local JSON read, never bootstrap/config/native discovery: no cycle.
  const preferences = await data.getPreferences();
  const installation = await resolveInstallation(preferences.executablePath || undefined);
  discoveredInstallation = installation;
  if (!installation.info.available || !installation.info.path) {
    throw new Error(installation.info.error || 'No supported local omp installation was found');
  }
  if (quitting) throw new Error('OMP-Desktop is shutting down');
  return { executable: installation.info.path, env: installation.env, cwd, profile: preferences.profile || undefined };
}

async function historyContext(path: string, cwd?: string): Promise<ExecutionContext> {
  const preferences = await data.getPreferences();
  // Viewing never launches discovery's login shell or omp --version.
  return { executable: discoveredInstallation?.info.available ? discoveredInstallation.info.path || '' : '', env: discoveredInstallation?.env ?? { ...process.env }, cwd: cwd || sessionWorkspaces.get(path) || preferences.lastWorkspace || homedir(), profile: preferences.profile || undefined };
}
async function approvedSession(value: unknown): Promise<string> {
  const requested = text(value, 'session path');
  let path: string;
  try { path = await localPath(requested, 'file'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('The source session has not been persisted or is no longer available.');
    throw error;
  }
  if (!sessions.has(path)) throw new Error('Choose a native session file or select it from history first');
  sessions.add(path);
  return path;
}
async function historyOptions(value: unknown): Promise<HistoryRead> {
  const options = object(value, 'history read');
  fields(options, ['path', 'leafId', 'before']);
  return { path: await approvedSession(options.path), ...(options.leafId !== undefined ? { leafId: options.leafId === null ? null : text(options.leafId, 'leafId', 512) } : {}), ...(options.before !== undefined ? { before: text(options.before, 'before', 4096) } : {}) };
}
async function sessionAccess(path: string, context?: ExecutionContext): Promise<SessionAccess> {
  try {
    const current = context ?? await historyContext(path);
    const roots = await resolveHistoryRoots(current);
    const facts = runtime.ownedFacts();
    return await inspectSessionAccess(path, { terminalDirectory: roots.terminals, executable: current.executable, ownedPids: facts.map(fact => fact.pid), ownedSessionPaths: facts.flatMap(fact => fact.sessionPath ? [fact.sessionPath] : []), allocatedSessionPaths: facts.flatMap(fact => fact.allocated && fact.sessionPath ? [fact.sessionPath] : []) });
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error), checkedAt: Date.now() };
  }
}
async function getRuntimeAccess(runtimeId: string): Promise<RuntimeAccess> {
  const fact = runtime.ownedFacts().find(fact => fact.runtimeId === runtimeId);
  if (!fact) return { status: 'unknown', reason: 'Native runtime is unavailable or closing.', checkedAt: Date.now(), canFork: false };
  // Only the validated initial new-session identity can omit its journal path.
  // Missing identity on an existing session must not be mistaken for ownership.
  if (!fact.sessionPath) {
    return runtime.canUseUnpersistedHistory(runtimeId)
      ? { status: 'owned', checkedAt: Date.now(), canFork: false }
      : { status: 'unknown', reason: 'Native session identity is unavailable.', checkedAt: Date.now(), canFork: false };
  }
  const sessionId = runtime.getConnection(runtimeId).state.sessionId;
  const [access, canFork] = await Promise.all([
    sessionAccess(fact.sessionPath, runtime.getContext(runtimeId)),
    historyReader.canFork(fact.sessionPath, sessionId),
  ]);
  const current = runtime.ownedFacts().find(current => current.runtimeId === runtimeId);
  if (quitting || !ownedRuntimes.has(runtimeId) || !current || current.pid !== fact.pid || current.sessionPath !== fact.sessionPath || runtime.getConnection(runtimeId).state.sessionId !== sessionId) {
    return { status: 'unknown', reason: 'Native runtime identity changed during access inspection.', checkedAt: Date.now(), canFork: false };
  }
  if (canFork) { sessions.add(fact.sessionPath); sessionWorkspaces.set(fact.sessionPath, runtime.getCwd(runtimeId)); }
  return { ...access, canFork };
}
async function pinHistory(options: HistoryRead): Promise<HistoryRead> {
  if (options.leafId !== undefined) return options;
  const owner = runtime.ownedFacts().find(fact => fact.sessionPath === options.path);
  if (!owner) return options;
  const identity = await runtime.getHistoryIdentity(owner.runtimeId);
  if (identity.path !== options.path) throw new Error('Native session changed while selecting its history branch');
  return { ...options, leafId: identity.leafId };
}
async function readHistory(options: HistoryRead): Promise<HistorySnapshot> {
  const roots = await resolveHistoryRoots(await historyContext(options.path));
  const pinned = await pinHistory(options);
  const [snapshot, access] = await Promise.all([historyReader.read(pinned, roots.blobs), sessionAccess(options.path)]);
  return { ...snapshot, ...(options.leafId === undefined && pinned.leafId !== undefined ? { leafId: pinned.leafId } : {}), access };
}
function historyEvent(event: HistoryEvent): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('desktop:historyEvent', event);
}
async function watchHistory(options: HistoryRead): Promise<HistorySnapshot> {
  stopHistoryWatch?.();
  const generation = ++watchGeneration;
  const initial = await readHistory(options);
  if (generation !== watchGeneration || quitting) throw new Error('History watch was replaced');
  let revision = initial.revision;
  let access = initial.access;
  let selectedLeafId = initial.selectedLeafId;
  let reading = false;
  let probing = false;
  let stopped = false;
  let readError: string | undefined;
  const durableTimer = setInterval(async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      await approvedSession(options.path);
      const pinned = await pinHistory(options);
      const nextRevision = await historyReader.revision(options.path);
      if (!readError && nextRevision === revision && (pinned.leafId === undefined || pinned.leafId === selectedLeafId)) return;
      const roots = await resolveHistoryRoots(await historyContext(options.path));
      const snapshot = await historyReader.read(pinned, roots.blobs);
      if (stopped) return;
      revision = snapshot.revision;
      selectedLeafId = snapshot.selectedLeafId;
      readError = undefined;
      historyEvent({ path: options.path, kind: 'snapshot', snapshot: { ...snapshot, ...(options.leafId === undefined && pinned.leafId !== undefined ? { leafId: pinned.leafId } : {}), access } });
    } catch (error) {
      if (!stopped) {
        readError = error instanceof Error ? error.message : String(error);
        access = { status: 'unknown', reason: readError, checkedAt: Date.now() };
        historyEvent({ path: options.path, kind: 'access', access });
        historyEvent({ path: options.path, kind: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    } finally { reading = false; }
  }, 750);
  const accessTimer = setInterval(async () => {
    if (stopped || probing) return;
    probing = true;
    try {
      const next = await sessionAccess(options.path);
      if (stopped) return;
      access = readError ? { status: 'unknown', reason: readError, checkedAt: Date.now() } : next;
      historyEvent({ path: options.path, kind: 'access', access });
    } finally { probing = false; }
  }, 1750);
  stopHistoryWatch = () => { stopped = true; clearInterval(durableTimer); clearInterval(accessTimer); };
  return initial;
}
function readRuntimeHistory(runtimeId: string): Promise<RuntimeHistory> {
  const pending = runtimeHydrations.get(runtimeId);
  if (pending) return pending;
  const next = hydrateRuntimeHistory(runtimeId).finally(() => runtimeHydrations.delete(runtimeId));
  runtimeHydrations.set(runtimeId, next);
  return next;
}
async function hydrateRuntimeHistory(runtimeId: string): Promise<RuntimeHistory> {
  const identity = await runtime.getHistoryIdentity(runtimeId);
  const { path, leafId } = identity;
  if (path) {
    let exists = false;
    try { await stat(path); exists = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !runtime.canUseUnpersistedHistory(runtimeId)) throw error;
    }
    if (exists) {
      runtime.markHistoryPersisted(runtimeId);
      const reader = new HistoryReader();
      try {
        sessions.add(path);
        sessionWorkspaces.set(path, runtime.getCwd(runtimeId));
        const roots = await resolveHistoryRoots(runtime.getContext(runtimeId));
        const pages: HistoryMessage[][] = [];
        const diagnostics = new Set<string>();
        let before: string | undefined;
        let revision: string | undefined;
        let bytes = 0;
        const cursors = new Set<string>();
        do {
          if (quitting) throw new Error('OMP-Desktop is shutting down');
          const page = await reader.read({ path, leafId, before }, roots.blobs);
          revision ??= page.revision;
          if (page.revision !== revision) throw new Error('Durable history changed during hydration; refresh again');
          if (page.selectedLeafId !== leafId) throw new Error('Durable history does not contain the active native branch');
          bytes += Buffer.byteLength(JSON.stringify(page.messages));
          if (bytes > 128 * 1024 * 1024) throw new Error('Durable history exceeds the desktop hydration limit; use the paginated history viewer');
          pages.push(page.messages);
          for (const diagnostic of page.diagnostics) diagnostics.add(diagnostic);
          before = page.hasMore ? page.nextBefore : undefined;
          if (page.hasMore && (!before || cursors.has(before))) throw new Error('Durable history paging did not advance');
          if (before) cursors.add(before);
        } while (before);
        const saved = await new SessionResources(reader, async () => roots.blobs).listHistorySubagents({ path, leafId });
        for (const diagnostic of saved.diagnostics) diagnostics.add(diagnostic);
        const current = await runtime.getHistoryIdentity(runtimeId);
        if (current.path !== path || current.leafId !== leafId || await reader.revision(path) !== revision) throw new Error('Native history changed during hydration; refresh again');
        pages.reverse();
        return { messages: pages.flatMap(page => page.map(message => message.raw)), messageIds: pages.flatMap(page => page.map(message => message.id)), messageResourceReferences: pages.flatMap(page => page.map(message => message.resourceReference)), savedSubagents: saved.subagents, historySource: { path, leafId }, diagnostics: [...diagnostics] };
      } finally { reader.close(); }
    }
  }
  if (!runtime.canUseUnpersistedHistory(runtimeId)) throw new Error('Durable session path is unavailable');
  const messages: NativeMessage[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  let total: number | undefined;
  do {
    const page = await runtime.request<{ messages: NativeMessage[]; nextCursor?: string; totalMessages: number }>(runtimeId, { type: 'get_messages_page', limit: 100, ...(cursor ? { cursor } : {}) });
    if (!record(page) || !Array.isArray(page.messages) || !page.messages.every(message => record(message) && typeof message.role === 'string') || !Number.isSafeInteger(page.totalMessages) || page.totalMessages < 0 || (page.nextCursor !== undefined && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new Error('Invalid live native history page');
    total ??= page.totalMessages;
    if (page.totalMessages !== total) throw new Error('Live history changed during hydration');
    bytes += Buffer.byteLength(JSON.stringify(page.messages));
    if (bytes > 128 * 1024 * 1024) throw new Error('Live native history exceeds the desktop hydration limit');
    for (const message of page.messages) messages.push(message);
    if (messages.length > total) throw new Error('Live history exceeds its declared message count');
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Live native history paging did not advance');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (messages.length !== total) throw new Error('Live native history paging ended early');
  return { messages, diagnostics: [] };
}
async function hydrateConnection(connection: SessionConnection): Promise<SessionConnection> {
  const history = await readRuntimeHistory(connection.runtimeId);
  connection.messages = history.messages;
  connection.messageIds = history.messageIds;
  connection.messageResourceReferences = history.messageResourceReferences;
  connection.savedSubagents = history.savedSubagents;
  connection.historySource = history.historySource;
  connection.historyDiagnostics = history.diagnostics;
  return connection;
}
async function mutateRuntime<T>(runtimeId: string, operation: () => Promise<T>): Promise<T> {
  return admissions.run(`runtime:${runtimeId}`, async () => {
    await runtime.request(runtimeId, { type: 'get_state' });
    const path = runtime.getSessionPath(runtimeId);
    if (!path) throw new Error('Native session ownership cannot be verified without its current path');
    const perform = async () => {
      await runtime.request(runtimeId, { type: 'get_state' });
      if (runtime.getSessionPath(runtimeId) !== path) throw new Error('Native session changed during admission; retry on its current session');
      requireWritable(await sessionAccess(path, runtime.getContext(runtimeId)));
      const result = await operation();
      // Submission has already succeeded; a state refresh error must not invite a duplicate send.
      try { await runtime.request(runtimeId, { type: 'get_state' }); }
      catch (error) {
        if (window && !window.isDestroyed()) window.webContents.send('desktop:runtimeEvent', { runtimeId, kind: 'error', error: error instanceof Error ? error.message : String(error) });
      }
      return result;
    };
    return admissions.run(path, perform);
  });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`Unsupported field: ${key}`);
  }
}
function text(value: unknown, name: string, max = 4096, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) {
    throw new TypeError(`${name} must be ${empty ? 'a' : 'a non-empty'} string of at most ${max} characters`);
  }
  return value;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`);
  return value;
}
function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}
function stringList(value: unknown, name: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${name} must contain at most ${maxItems} items`);
  return value.map((item) => text(item, name));
}
async function localPath(value: unknown, kind: 'directory' | 'file'): Promise<string> {
  const path = text(value, kind);
  if (!isAbsolute(path)) throw new TypeError(`${kind} path must be absolute`);
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new TypeError(`Expected a ${kind}`);
  return canonical;
}
async function approvedWorkspace(value: unknown): Promise<string> {
  const cwd = await localPath(value, 'directory');
  if (!workspaces.has(cwd)) throw new Error('Select this workspace with the desktop folder picker first');
  return cwd;
}
function ownedRuntime(value: unknown): string {
  const id = text(value, 'runtimeId', 256);
  if (!ownedRuntimes.has(id)) throw new Error('The session is not owned by this window or has exited');
  return id;
}
function fileArgument(value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  return text(value, 'path', 4096, optional);
}
function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 16) throw new TypeError('Setting value is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return text(value, 'setting value', 131072, true);
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new TypeError('Setting array is too large');
    return value.map((item) => jsonValue(item, depth + 1));
  }
  const record = object(value, 'setting value');
  if (Object.keys(record).length > 4096) throw new TypeError('Setting object is too large');
  const result: Record<string, JsonValue> = Object.create(null);
  for (const [key, item] of Object.entries(record)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('Unsafe setting key');
    result[text(key, 'setting key', 512)] = jsonValue(item, depth + 1);
  }
  return result;
}
function commandArgument(value: unknown): NativeFrame {
  const command = object(value, 'command');
  const type = text(command.type, 'command type', 80);
  switch (type) {
    case 'abort':
    case 'get_state':
    case 'get_available_models':
    case 'get_available_thinking_levels':
    case 'get_subagents':
    case 'get_branch_messages':
    case 'get_login_providers':
      fields(command, ['type']);
      return { type };
    case 'get_messages_page': {
      fields(command, ['type', 'cursor', 'limit']);
      const result: NativeFrame = { type };
      if (command.cursor !== undefined) result.cursor = text(command.cursor, 'cursor', 4096);
      if (command.limit !== undefined) {
        const limit = number(command.limit, 'limit', 1, 1000);
        if (!Number.isInteger(limit)) throw new TypeError('limit must be an integer');
        result.limit = limit;
      }
      return result;
    }
    case 'login':
      fields(command, ['type', 'providerId']);
      return { type, providerId: text(command.providerId, 'provider ID', 256) };
    case 'set_model':
      fields(command, ['type', 'provider', 'modelId']);
      return { type, provider: text(command.provider, 'provider', 256), modelId: text(command.modelId, 'modelId', 512) };
    case 'set_thinking_level': {
      fields(command, ['type', 'level']);
      const level = text(command.level, 'level', 32);
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(level)) throw new TypeError('Invalid thinking level');
      return { type, level };
    }
    case 'set_session_name':
      fields(command, ['type', 'name']);
      return { type, name: text(command.name, 'session name', 1024) };
    case 'branch':
      fields(command, ['type', 'entryId']);
      return { type, entryId: text(command.entryId, 'entryId', 256) };
    case 'get_subagent_messages': {
      fields(command, ['type', 'subagentId', 'fromByte']);
      const result: NativeFrame = { type, subagentId: text(command.subagentId, 'subagentId', 256) };
      if (command.fromByte !== undefined) {
        const fromByte = number(command.fromByte, 'fromByte', 0, Number.MAX_SAFE_INTEGER);
        if (!Number.isInteger(fromByte)) throw new TypeError('fromByte must be an integer');
        result.fromByte = fromByte;
      }
      return result;
    }
    default: throw new Error(`The desktop does not expose native command: ${type}`);
  }
}
function allowedDocument(url: string): boolean {
  try {
    const candidate = new URL(url);
    candidate.hash = '';
    if (devUrl) {
      const expected = new URL(devUrl);
      expected.hash = '';
      return candidate.href === expected.href;
    }
    return candidate.href === rendererFileUrl;
  } catch { return false; }
}
function ipc(name: string, count: number, handler: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`desktop:${name}`, (event, ...args: unknown[]) => {
    if (quitting || !window || event.sender !== window.webContents || !event.senderFrame ||
      event.senderFrame !== window.webContents.mainFrame || !allowedDocument(event.senderFrame.url)) {
      throw new Error('Untrusted desktop IPC sender');
    }
    if (args.length !== count) throw new TypeError(`Invalid argument count for ${name}`);
    return handler(...args);
  });
}
async function externalUrl(value: unknown): Promise<void> {
  const url = new URL(text(value, 'URL', 8192));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Only HTTP(S) links without credentials are allowed');
  await shell.openExternal(url.href);
}

async function start(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  const preferences = await data.getPreferences();
  // Native vibrancy must match the app preference before the window is created.
  nativeTheme.themeSource = preferences.theme;
  workspaces.add(await localPath(homedir(), 'directory'));
  for (const path of [preferences.lastWorkspace, ...preferences.recentWorkspaces]) {
    if (!path) continue;
    try { workspaces.add(await localPath(path, 'directory')); } catch (error) {
      // A removed disk/workspace must not prevent the user opening the folder picker.
      console.warn(`Stored workspace is unavailable: ${path}`, error);
    }
  }
  ipc('bootstrap', 0, async () => {
    const current = await data.getPreferences();
    const installation = await resolveInstallation(current.executablePath || undefined);
    discoveredInstallation = installation;
    return { preferences: current, runtime: installation.info, platform: process.platform, home: homedir() };
  });
  ipc('checkRuntime', 0, async () => {
    const installation = await resolveInstallation((await data.getPreferences()).executablePath || undefined);
    discoveredInstallation = installation;
    return installation.info;
  });
  ipc('setPreferences', 1, async (value) => {
    const patch = object(value, 'preferences');
    fields(patch, ['theme', 'language', 'fontSize', 'fontFamily', 'sidebarWidth', 'panelWidth', 'chatContentWidth', 'executablePath', 'profile', 'lastWorkspace', 'recentWorkspaces', 'pinnedSessions', 'enterToSend']);
    const result: Partial<DesktopPreferences> = {};
    for (const [key, item] of Object.entries(patch)) {
      switch (key) {
        case 'theme':
          if (typeof item !== 'string' || !['system', 'light', 'dark'].includes(item)) throw new TypeError('Invalid theme');
          result.theme = item as DesktopPreferences['theme']; break;
        case 'language':
          if (item !== 'zh-CN' && item !== 'en') throw new TypeError('Invalid language');
          result.language = item; break;
        case 'fontSize': result.fontSize = number(item, key, 10, 32); break;
        case 'fontFamily': result.fontFamily = text(item, key, 512, true); break;
        case 'sidebarWidth': result.sidebarWidth = number(item, key, 180, 600); break;
        case 'panelWidth': result.panelWidth = number(item, key, 1, Number.MAX_SAFE_INTEGER); break;
        case 'chatContentWidth': result.chatContentWidth = number(item, key, 360, 1600); break;
        case 'enterToSend': result.enterToSend = bool(item, key); break;
        case 'executablePath': {
          const path = text(item, key, 4096, true);
          result.executablePath = path ? await localPath(path, 'file') : '';
          if (result.executablePath) await access(result.executablePath, constants.X_OK);
          break;
        }
        case 'profile': {
          const profile = text(item, key, 64, true);
          if (profile && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile)) throw new TypeError('Invalid native profile name');
          result.profile = profile; break;
        }
        case 'lastWorkspace': result.lastWorkspace = item === '' ? '' : await approvedWorkspace(item); break;
        case 'recentWorkspaces': {
          const requested = stringList(item, key, 40);
          const stored = new Set((await data.getPreferences()).recentWorkspaces);
          // Historical entries may live on disconnected disks. Keeping their labels grants
          // no file access; only new entries must pass the current workspace grant check.
          result.recentWorkspaces = await Promise.all(requested.map((path) =>
            stored.has(path) ? Promise.resolve(path) : approvedWorkspace(path)));
          break;
        }
        case 'pinnedSessions': result.pinnedSessions = stringList(item, key, 200); break;
      }
    }
    if (result.profile !== undefined || result.executablePath !== undefined) {
      if (result.executablePath !== undefined) discoveredInstallation = undefined;
      ++watchGeneration;
      stopHistoryWatch?.();
      stopHistoryWatch = undefined;
    }
    const preferences = await data.setPreferences(result);
    if (result.theme !== undefined) nativeTheme.themeSource = preferences.theme;
    return preferences;
  });
  ipc('chooseWorkspace', 0, async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const cwd = await localPath(result.filePaths[0], 'directory');
    workspaces.add(cwd);
    return cwd;
  });
  ipc('chooseExecutable', 0, async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Choose installed omp executable', properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = await localPath(result.filePaths[0], 'file');
    await access(path, constants.X_OK);
    return path;
  });
  ipc('chooseSessionFile', 0, async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Choose native omp session', properties: ['openFile'], filters: [{ name: 'Native omp session', extensions: ['jsonl'] }, { name: 'All files (including custom session paths)', extensions: ['*'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = await localPath(result.filePaths[0], 'file');
    sessions.add(path);
    return path;
  });
  ipc('listHistory', 1, async (value) => {
    const options = value === undefined ? {} : object(value, 'history options');
    fields(options, ['cwd', 'query']);
    const history = await data.listHistory({
      cwd: options.cwd === undefined ? undefined : await approvedWorkspace(options.cwd),
      query: options.query === undefined ? undefined : text(options.query, 'query', 1024, true),
    });
    for (const session of history.sessions) {
      sessions.add(session.path);
      sessionWorkspaces.set(session.path, session.cwd);
      // Native header paths are grants, not guesses from encoded directory names.
      try { workspaces.add(await localPath(session.cwd, 'directory')); } catch (error) {
        console.warn(`History workspace is unavailable: ${session.cwd}`, error);
      }
    }
    return history;
  });
  ipc('readHistory', 1, async value => readHistory(await historyOptions(value)));
  ipc('readHistoryTree', 2, async (value, before) => {
    const pinned = await pinHistory({ path: await approvedSession(value) });
    const tree = await historyReader.tree(pinned.path, before === undefined ? undefined : text(before, 'tree cursor', 4096));
    if (pinned.leafId !== undefined) {
      return { ...tree, leafId: pinned.leafId };
    }
    return tree;
  });
  ipc('watchHistory', 1, async value => watchHistory(await historyOptions(value)));
  ipc('unwatchHistory', 0, () => { ++watchGeneration; stopHistoryWatch?.(); stopHistoryWatch = undefined; });
  ipc('readRuntimeHistory', 1, id => readRuntimeHistory(ownedRuntime(id)));
  ipc('getRuntimeAccess', 1, id => getRuntimeAccess(ownedRuntime(id)));
  ipc('listHistorySubagents', 1, async value => {
    const options = object(value, 'history subagents');
    fields(options, ['path', 'leafId']);
    return sessionResources.listHistorySubagents(await pinHistory(await historyOptions(options)));
  });
  ipc('readHistorySubagent', 1, async value => {
    const options = object(value, 'history subagent');
    fields(options, ['parentPath', 'subagentId', 'leafId', 'before']);
    const parent = await pinHistory(await historyOptions({ path: options.parentPath, leafId: options.leafId }));
    return sessionResources.readHistorySubagent({ parentPath: parent.path, leafId: parent.leafId, subagentId: text(options.subagentId, 'subagent ID', 1024), ...(options.before === undefined ? {} : { before: text(options.before, 'before', 4096) }) });
  });
  ipc('readSessionArtifact', 1, async value => {
    const options = object(value, 'session artifact');
    fields(options, ['parentPath', 'reference', 'cursor', 'subagentId', 'leafId']);
    const parent = await historyOptions({ path: options.parentPath, leafId: options.leafId });
    const subagentId = options.subagentId === undefined ? undefined : text(options.subagentId, 'subagent ID', 1024);
    const pinned = subagentId === undefined ? parent : await pinHistory(parent);
    return sessionResources.readSessionArtifact({ parentPath: pinned.path, leafId: pinned.leafId, subagentId, reference: text(options.reference, 'artifact reference', 8192), ...(options.cursor === undefined ? {} : { cursor: text(options.cursor, 'cursor', 4096) }) });
  });
  ipc('readSessionEntry', 1, async value => {
    const options = object(value, 'session entry');
    fields(options, ['parentPath', 'entryId', 'cursor']);
    return sessionResources.readSessionEntry({ parentPath: await approvedSession(options.parentPath), entryId: text(options.entryId, 'entry ID', 512), ...(options.cursor === undefined ? {} : { cursor: text(options.cursor, 'cursor', 4096) }) });
  });
  ipc('startSession', 1, async (value) => {
    const options = object(value, 'session options');
    fields(options, ['cwd', 'sessionPath', 'mode']);
    const cwd = await approvedWorkspace(options.cwd);
    const mode = options.mode === undefined ? 'resume' : text(options.mode, 'mode', 16);
    if (mode !== 'resume' && mode !== 'fork') throw new TypeError('Invalid session mode');
    if (mode === 'fork' && !options.sessionPath) throw new TypeError('Fork requires a persisted source session');
    const requestedPath = options.sessionPath === undefined ? undefined : text(options.sessionPath, 'session path');
    const sessionPath = requestedPath === undefined ? undefined : await approvedSession(requestedPath);
    const context = await getContext(cwd);
    const launch = async () => {
      if (quitting) throw new Error('OMP-Desktop is shutting down');
      if (sessionPath) {
        const source = await historyReader.resourceContext(sessionPath);
        if (mode === 'resume' && (!source.session.writable || source.session.sourceKind === 'archive')) throw new Error('This saved source cannot be resumed in place. Archived sessions are read-only.');
        if (mode === 'fork' && !source.session.canFork) throw new Error(source.diagnostics.find(message => /fork/i.test(message)) || 'Native fork is unavailable for this saved source; its source and artifacts cannot be safely materialized.');
      }
      if (sessionPath && mode === 'resume') {
        requireWritable(await sessionAccess(sessionPath, context));
        const existing = runtime.ownedFacts().find(fact => fact.sessionPath === sessionPath);
        if (existing) return hydrateConnection(runtime.getConnection(existing.runtimeId));
      }
      const source = sessionPath && mode === 'fork' ? await historyReader.forkSource(sessionPath) : undefined;
      let connection: SessionConnection | undefined;
      try {
        connection = await runtime.start({ cwd, sessionPath: source?.path ?? sessionPath, mode }, context);
        ownedRuntimes.add(connection.runtimeId);
        if (source?.verify) {
          const destination = runtime.getSessionPath(connection.runtimeId);
          if (!destination || destination === sessionPath || destination === source.path) throw new Error('Native fork did not create a distinct durable session');
          await source.verify(destination);
        }
        const hydrated = await hydrateConnection(connection);
        await source?.cleanup?.();
        return hydrated;
      } catch (error) {
        const createdPath = mode === 'fork' ? connection?.state.sessionFile : undefined;
        const failure = createdPath
          ? new Error(`Native fork startup did not complete. The new session was retained at ${createdPath}; the original source is unchanged. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
          : error;
        const failures: unknown[] = [failure];
        if (connection) {
          try { await runtime.close(connection.runtimeId); } catch (closeError) { failures.push(closeError); }
          ownedRuntimes.delete(connection.runtimeId);
        }
        try { await source?.cleanup?.(); } catch (cleanupError) { failures.push(cleanupError); }
        if (failures.length > 1) throw new AggregateError(failures, `Native fork/startup and cleanup failed${createdPath ? `; new session retained at ${createdPath}` : ''}`);
        throw failure;
      }
    };
    return sessionPath && mode === 'resume' ? admissions.run(sessionPath, launch) : launch();
  });
  ipc('closeSession', 1, async (id) => {
    const runtimeId = ownedRuntime(id);
    await runtime.close(runtimeId);
    ownedRuntimes.delete(runtimeId);
  });
  ipc('request', 2, (id, value) => {
    const runtimeId = ownedRuntime(id);
    const command = commandArgument(value);
    if (command.type.startsWith('get_') || command.type === 'abort') return runtime.request(runtimeId, command);
    return mutateRuntime(runtimeId, () => runtime.request(runtimeId, command));
  });
  ipc('sendPrompt', 2, async (id, value) => {
    const runtimeId = ownedRuntime(id);
    const input = object(value, 'prompt');
    fields(input, ['text', 'attachmentIds', 'mode']);
    const mode = input.mode === undefined ? 'prompt' : text(input.mode, 'mode', 16);
    if (!['prompt', 'steer', 'follow_up'].includes(mode)) throw new TypeError('Invalid prompt mode');
    const prompt: PromptInput = { text: text(input.text, 'prompt text', 1048576, true), mode: mode as PromptInput['mode'] };
    if (input.attachmentIds !== undefined) prompt.attachmentIds = stringList(input.attachmentIds, 'attachmentIds', 32);
    if (!prompt.text.trim() && !prompt.attachmentIds?.length) throw new TypeError('Enter a message or add an attachment');
    return mutateRuntime(runtimeId, async () => {
      const path = runtime.getSessionPath(runtimeId);
      const prepared = await workspace.preparePrompt(runtime.getCwd(runtimeId), prompt);
      await runtime.request(runtimeId, { type: 'get_state' });
      if (runtime.getSessionPath(runtimeId) !== path) throw new Error('Native session changed while preparing attachments; retry on its current session');
      if (path) requireWritable(await sessionAccess(path, runtime.getContext(runtimeId)));
      const accepted = await runtime.request(runtimeId, { type: mode, ...prepared });
      // Keep grants when preparation or submission rejects so the draft can be retried.
      await Promise.all((prompt.attachmentIds ?? []).map(attachmentId => workspace.removeAttachment(attachmentId)));
      return accepted;
    });
  });
  ipc('respond', 2, async (id, value) => {
    const response = object(value, 'extension response');
    fields(response, ['id', 'value', 'confirmed', 'cancelled', 'timedOut']);
    const result: ExtensionResponse = { id: text(response.id, 'request ID', 256) };
    if (response.value !== undefined) result.value = text(response.value, 'response value', 1048576, true);
    if (response.confirmed !== undefined) result.confirmed = bool(response.confirmed, 'confirmed');
    if (response.cancelled !== undefined) result.cancelled = bool(response.cancelled, 'cancelled');
    if (response.timedOut !== undefined) result.timedOut = bool(response.timedOut, 'timedOut');
    const runtimeId = ownedRuntime(id);
    // Never enqueue UI replies behind a native request that may be awaiting them.
    // Cancellation/denial must remain available even when ownership is uncertain.
    if (!result.cancelled && !result.timedOut && !(result.confirmed === false && result.value === undefined)) {
      const path = runtime.getSessionPath(runtimeId);
      if (path) requireWritable(await sessionAccess(path, runtime.getContext(runtimeId)));
      else if (!runtime.isInitializing(runtimeId)) throw new Error('Native session ownership cannot be verified without its current path');
    }
    await runtime.respond(runtimeId, result);
  });
  ipc('listSettings', 1, async (cwd) => data.listSettings(await approvedWorkspace(cwd)));
  ipc('setSetting', 3, async (cwd, key, value) => {
    const checked = jsonValue(value);
    if (JSON.stringify(checked).length > 262144) throw new TypeError('Setting value exceeds 256 KiB');
    return data.setSetting(await approvedWorkspace(cwd), text(key, 'setting key', 256), checked);
  });
  ipc('resetSetting', 2, async (cwd, key) => data.resetSetting(await approvedWorkspace(cwd), text(key, 'setting key', 256)));
  ipc('chooseAttachments', 1, async (cwd) => {
    const root = await approvedWorkspace(cwd);
    const result = await dialog.showOpenDialog(window!, { title: 'Attach local files', properties: ['openFile', 'multiSelections'] });
    return result.canceled ? [] : workspace.authorizeAttachments(root, result.filePaths);
  });
  ipc('addDroppedFiles', 2, async (cwd, paths) => {
    const root = await approvedWorkspace(cwd);
    const files = await Promise.all(stringList(paths, 'dropped files', 32).map((path) => localPath(path, 'file')));
    return workspace.authorizeAttachments(root, files);
  });
  ipc('addImageAttachment', 2, async (cwd, value) => {
    const root = await approvedWorkspace(cwd);
    const input = object(value, 'clipboard image');
    fields(input, ['name', 'mimeType', 'data']);
    if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0 || input.data.byteLength > 10 * 1024 * 1024) throw new TypeError('Clipboard image must contain at most 10 MiB of bytes');
    return workspace.addImageAttachment(root, { name: text(input.name, 'image name', 512), mimeType: text(input.mimeType, 'image MIME type', 128), data: input.data });
  });
  ipc('removeAttachment', 1, (id) => workspace.removeAttachment(text(id, 'attachment ID', 256)));
  ipc('listFiles', 2, async (cwd, path) => workspace.listFiles(await approvedWorkspace(cwd), fileArgument(path, true)));
  ipc('searchFiles', 2, async (cwd, query) => workspace.searchFiles(await approvedWorkspace(cwd), text(query, 'query', 1024, true)));
  ipc('readFile', 2, async (cwd, path) => workspace.readFile(await approvedWorkspace(cwd), text(path, 'path')));
  ipc('gitDiff', 2, async (cwd, path) => workspace.gitDiff(await approvedWorkspace(cwd), fileArgument(path, true)));
  ipc('revealFile', 2, async (cwd, path) => {
    const resolved = await workspace.resolvePath(await approvedWorkspace(cwd), text(path, 'path'));
    shell.showItemInFolder(resolved);
  });
  ipc('openExternal', 1, externalUrl);
  ipc('copyText', 1, (value) => clipboard.writeText(text(value, 'clipboard text', 8388608, true)));
  ipc('windowAction', 1, (action) => {
    if (action === 'minimize') window!.minimize();
    else if (action === 'maximize') window!.isMaximized() ? window!.unmaximize() : window!.maximize();
    else if (action === 'close') window!.close();
    else throw new TypeError('Invalid window action');
  });

  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 600, show: false,
    title: 'OMP-Desktop', backgroundColor: process.platform === 'darwin' ? '#00000000' : '#191919',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const } : {}),
    webPreferences: {
      preload: join(outputDirectory, '../preload/index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
    },
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void externalUrl(url).catch((error) => dialog.showErrorBox('Cannot open link', String(error)));
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!allowedDocument(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.on('will-download', (event, item, contents) => {
    if (!window || contents !== window.webContents || !item.getURL().startsWith('blob:')) {
      event.preventDefault();
      return;
    }
    // Do not setSavePath: Electron presents the native Save dialog for the user's export.
    item.once('done', (_event, state) => {
      if (state === 'interrupted') dialog.showErrorBox('Download failed', 'The exported file could not be saved.');
    });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox('OMP-Desktop renderer stopped', `Reason: ${details.reason}. Owned omp sessions will be stopped.`);
    app.quit();
  });
  window.on('close', (event) => { if (!drained) { event.preventDefault(); app.quit(); } });
  window.on('closed', () => { ++watchGeneration; stopHistoryWatch?.(); historyReader.close(); window = null; });
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(rendererPath);
  window.show();
}

app.on('before-quit', (event) => {
  if (drained) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  ++watchGeneration;
  stopHistoryWatch?.();
  historyReader.close();
  void runtime.closeAll().catch((error) => {
    dialog.showErrorBox('Could not cleanly stop omp', String(error));
  }).finally(() => { drained = true; app.quit(); });
});
app.on('window-all-closed', () => app.quit());
void app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox('OMP-Desktop could not start', String(error));
  app.quit();
});

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, shell, type MenuItemConstructorOptions } from 'electron';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveInstallation } from './omp/discovery';
import { OmpRuntimeService } from './omp/service';
import { NativeResponseError } from './omp/responses';
import { nativeError } from '../shared/native-error';
import { SessionAdmissions, SessionHistoryGrants, requireWritable } from './omp/admission';
import { withRemovalRuntimeAdmission } from './omp/removal-admission';
import { HistoryReader } from './data/journal';
import { ChildJournalObserver, ListedJournalObserver, SessionPresenceObserver } from './data/session-observer';
import { HistoryDiscovery } from './data/history-discovery';
import { SessionResources } from './data/session-resources';
import { inspectSessionAccess } from './data/occupancy';
import { removeSession, inspectRemovalWriters, requireRemovalAccess } from './data/session-removal';
import { resolveHistoryRoots } from './data/roots';
import type { ExecutionContext } from './omp/cli';
import { readConfiguredModel } from './omp/configured-model';
import { clearNativeLoginScripts, openNativeLogin } from './omp/native-login';
import { NativeDataService } from './data/service';
import { validatePreferences } from './data/preferences';
import { SessionUsageReader } from './data/session-usage';
import { ModelCapacityResolver } from './data/model-capacity';
import { WorkspaceService } from './workspace/service';
import { TurnChangeEvidenceReader, type TurnEvidenceInput } from './data/turn-change-evidence';
import { TurnChangeCoordinator, type TurnChangeCollection } from './workspace/turn-change-coordinator';
import type { TurnChangeQuery, TurnChangeResult } from '../shared/turn-change-types';
import type { ChildHistoryRead, DesktopPreferences, ExtensionResponse, HistoryEvent, HistoryRead, HistorySnapshot, JsonValue, NativeFrame, NativeMessage, PromptInput, RuntimeAccess, RuntimeEvent, RuntimeHistory, RuntimeHistoryRead, RuntimeInfo, SavedSubagentEdge, SessionAccess, SessionConnection, SessionSummary, SessionRemovalTarget } from '../shared/contracts';
import { record } from './omp/framing';
import { lifecycleDecision, quitDialogOptions, validateAttention, validateNotification, validateWindowTitle, shouldNotify } from './lifecycle';
import { MessageSearch } from './data/message-search';
import { shortcutDefinitions } from '../renderer/app/shortcuts';
import { openInPreferredEditor, validateDesktopFileRequest } from './desktop-objects';
import { getPresenceInstallation, presenceResourcePath, syncPresenceInstallation } from './presence-install';
import { getPresenceProcessCounts, watchPresenceChanges } from './data/presence';

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
let quitConfirmed = false;
let confirmingQuit = false;
const workspaces = new Set<string>();
const sessions = new SessionHistoryGrants();
const ownedRuntimes = new Set<string>();
const workspace = new WorkspaceService();
const historyReader = new HistoryReader();
const sessionResources = new SessionResources(historyReader, async path => (await resolveHistoryRoots(await historyContext(path))).blobs, async path => path === watchedPath ? watchedActivity : undefined);
const admissions = new SessionAdmissions();
const sessionWorkspaces = new Map<string, string>();
const grantedSummaries = new Map<string, SessionSummary>();
const listedObserver = new ListedJournalObserver(session => {
  if (sessions.has(session.path)) historyEvent({ path: session.path, kind: 'activity', activity: session.path === watchedPath ? watchedActivity?.state ?? session.activity ?? 'unknown' : session.activity ?? 'unknown', activitySource: session.path === watchedPath ? watchedActivity?.source ?? session.activitySource : session.activitySource, updatedAt: session.updatedAt });
});
const historyDiscovery = new HistoryDiscovery({
  roots: async () => { const roots = await resolveHistoryRoots(await historyContext('')); return [roots.sessions, roots.archives, roots.registry]; },
  list: () => listHistory(),
  publish: listing => historyEvent({ path: '', kind: 'listing', listing }),
  onError: error => historyEvent({ path: '', kind: 'error', error: error instanceof Error ? error.message : String(error) }),
});
let stopHistoryWatch: (() => void) | undefined;
let watchedPath: string | undefined;
let watchedActivity: HistorySnapshot['activity'];
let sourceGeneration = 0;
const removedRuntimes = new Set<string>();
const knownRuntimes = new Set<string>();
let watchGeneration = 0;
let discoveredInstallation: { info: RuntimeInfo; env: NodeJS.ProcessEnv } | undefined;
const modelCapacity = new ModelCapacityResolver(join(app.getPath('userData'), 'model-capacity.json'));
const runtime = new OmpRuntimeService((event) => {
  if (removedRuntimes.has(event.runtimeId)) return;
  turnChanges.observe(event);
  // Every worker belongs to this window; the runtime ID preserves background-session routing.
  // Events during start can precede the connection response: the renderer queues unknown IDs.
  if (event.kind !== 'exit') ownedRuntimes.add(event.runtimeId);
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('desktop:runtimeEvent', event);
  }
  if (event.kind === 'exit') ownedRuntimes.delete(event.runtimeId);
}, path => historyReader.nativeEntriesCursor(path), models => { void modelCapacity.capture(models).catch(() => { /* Runtime values remain usable if the local catalog cannot be persisted. */ }); }, presenceResourcePath(app.isPackaged, process.resourcesPath, outputDirectory));
const turnChanges = new TurnChangeCoordinator({
  inspect: async runtimeId => {
    const owner = await runtime.getOwnedChildren(runtimeId);
    return { sessionId: owner.sessionId, sourcePath: owner.parentPath, state: runtime.getConnection(runtimeId).state, children: owner.children };
  },
  publish: event => { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('desktop:turnChanges', event); },
});
async function readTurnChanges(input: TurnEvidenceInput): Promise<TurnChangeResult> {
  // Each admitted collection owns its one-source index; concurrent UI/child
  // reads must not repeatedly evict and rebuild another query's journal.
  const reader = new HistoryReader();
  const resources = new SessionResources(reader, async path => (await resolveHistoryRoots(await historyContext(path))).blobs, async path => path === watchedPath ? watchedActivity : undefined);
  const evidenceReader = new TurnChangeEvidenceReader(reader, resources);
  let collection: TurnChangeCollection | undefined;
  try {
    const evidence = await evidenceReader.collect({
      ...input,
      onStart: metadata => { collection = turnChanges.begin(metadata); },
      onOperation: operation => {
        if (!collection) throw new Error('Turn evidence arrived before its authorized interval');
        collection.push(operation);
      },
    });
    return collection ? collection.finish(evidence) : turnChanges.result(evidence);
  } finally { reader.close(); }
}
const turnChangeReads = new Map<string, Promise<TurnChangeResult>>();
let activeTurnChangeReads = 0;
const waitingTurnChangeReads: (() => void)[] = [];
async function collectTurnChanges(operation: () => Promise<TurnChangeResult>): Promise<TurnChangeResult> {
  if (activeTurnChangeReads >= 2) await new Promise<void>(resolve => waitingTurnChangeReads.push(resolve));
  else activeTurnChangeReads++;
  try {
    if (quitting) throw new Error('Application is closing');
    return await operation();
  } finally {
    const next = waitingTurnChangeReads.shift();
    if (next) next(); else activeTurnChangeReads--;
  }
}
const data: NativeDataService = new NativeDataService({
  userDataDir: app.getPath('userData'),
  getContext,
  getHistoryContext: cwd => historyContext('', cwd),
});
const messageSearch = new MessageSearch(() => historyContext(''), approvedSession);
async function getContext(cwd: string): Promise<ExecutionContext> {
  // Preferences are a local JSON read, never bootstrap/config/native discovery: no cycle.
  const preferences = await data.getPreferences();
  const installation = discoveredInstallation ?? await resolveInstallation(preferences.executablePath || undefined);
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
  try { return await sessions.approve(requested); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('The source session has not been persisted or is no longer available.');
    throw error;
  }
}
async function historyOptions(value: unknown): Promise<HistoryRead> {
  const options = object(value, 'history read');
  fields(options, ['path', 'leafId', 'before', 'beforeEntryId', 'anchorId']);
  return { path: await approvedSession(options.path), ...runtimeHistoryOptions(options, true) };
}
async function sessionAccess(path: string, context?: ExecutionContext): Promise<SessionAccess> {
  try {
    const current = context ?? await historyContext(path);
    const roots = await resolveHistoryRoots(current);
    const facts = runtime.ownedFacts();
    return await inspectSessionAccess(path, { terminalDirectory: roots.terminals, executable: current.executable, desktopPid: process.pid, ownedFacts: () => runtime.ownedFacts(), ownedPids: facts.map(fact => fact.pid), ownedSessionPaths: facts.flatMap(fact => fact.sessionPath ? [fact.sessionPath] : []), allocatedSessionPaths: facts.flatMap(fact => fact.allocated && fact.sessionPath ? [fact.sessionPath] : []) });
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error), checkedAt: Date.now() };
  }
}
async function getRuntimeAccess(runtimeId: string): Promise<RuntimeAccess> {
  const source = await runtime.getSourceState(runtimeId);
  const fact = runtime.ownedFacts().find(fact => fact.runtimeId === runtimeId);
  const denied = (reason: string): RuntimeAccess => ({ source, status: 'unknown', reason, checkedAt: Date.now(), canSend: false, canFork: false });
  if (!fact) return denied('Native runtime is unavailable or closing.');
  if (!fact.sessionPath) return denied('Native session ownership cannot be verified without its current path');
  const sessionId = runtime.getConnection(runtimeId).state.sessionId;
  // Owned RPC children are admitted by their native identity, not machine-wide
  // process churn. Shared-source admission happens before launching the child.
  const access: SessionAccess = { status: 'owned', occupancySource: 'presence', confidence: 'exact', checkedAt: Date.now() };
  const canFork = source.status === 'persisted' && await historyReader.canFork(fact.sessionPath, sessionId);
  const current = runtime.ownedFacts().find(current => current.runtimeId === runtimeId);
  if (quitting || !ownedRuntimes.has(runtimeId) || !current || current.pid !== fact.pid || current.sessionPath !== fact.sessionPath || runtime.getConnection(runtimeId).state.sessionId !== sessionId || source.sessionId !== sessionId || source.path !== fact.sessionPath) return denied('Native runtime identity changed during access inspection.');
  if (canFork) runtime.markHistoryPersisted(runtimeId, { sessionId, path: fact.sessionPath });
  const latestSource = await runtime.getSourceState(runtimeId);
  const finalOwner = runtime.ownedFacts().find(current => current.runtimeId === runtimeId);
  if (!ownedRuntimes.has(runtimeId) || removedRuntimes.has(runtimeId) || !finalOwner || finalOwner.pid !== fact.pid || finalOwner.sessionPath !== fact.sessionPath || runtime.getConnection(runtimeId).state.sessionId !== sessionId || runtime.getSessionPath(runtimeId) !== fact.sessionPath) return denied('Native runtime identity changed during source inspection.');
  if (latestSource.status === 'persisted') { sessions.add(fact.sessionPath); sessionWorkspaces.set(fact.sessionPath, runtime.getCwd(runtimeId)); if (!grantedSummaries.has(fact.sessionPath)) historyDiscovery.request(); }
  const writable = access.status === 'owned' || access.status === 'idle';
  return { ...access, source: latestSource, canSend: writable && latestSource.status !== 'unavailable', canFork: canFork && latestSource.status === 'persisted' };
}
async function listHistory(options: { cwd?: string; query?: string } = {}) {
  const generation = sourceGeneration;
  const history = await data.listHistory(options);
  if (generation !== sourceGeneration) throw new Error('History sources changed during listing; refresh again');
  for (const session of history.sessions) {
    session.activity = session.path === watchedPath ? watchedActivity?.state : undefined;
    if (session.sourceKind === 'archive') session.canFork = false;
    sessions.add(await realpath(session.path));
    grantedSummaries.set(session.path, session);
    sessionWorkspaces.set(session.path, session.cwd);
    try { workspaces.add(await localPath(session.cwd, 'directory')); } catch (error) { console.warn(`History workspace is unavailable: ${session.cwd}`, error); }
  }
  await listedObserver.observe(history.sessions);
  if (generation !== sourceGeneration) throw new Error('History sources changed during listing; refresh again');
  return history;
}
async function pinHistory(options: HistoryRead): Promise<HistoryRead> {
  if (options.leafId !== undefined) return options;
  const owner = runtime.ownedFacts().find(fact => fact.sessionPath === options.path);
  if (!owner) return options;
  const identity = await runtime.getHistoryIdentity(owner.runtimeId);
  if (identity.path !== options.path) throw new Error('Native session changed while selecting its history branch');
  return { ...options, leafId: identity.leafId };
}
async function readHistory(options: HistoryRead, reader = historyReader, accessOverride?: SessionAccess): Promise<HistorySnapshot> {
  const generation = sourceGeneration;
  const roots = await resolveHistoryRoots(await historyContext(options.path));
  const pinned = await pinHistory(options);
  const [snapshot, access] = await Promise.all([reader.read(pinned, roots.blobs), accessOverride ?? sessionAccess(options.path)]);
  if (snapshot.session.sourceKind === 'archive') {
    const readiness = await reader.forkAvailability(options.path);
    snapshot.session = { ...snapshot.session, canFork: readiness.canFork };
    if (readiness.reason && !snapshot.diagnostics.includes(readiness.reason)) snapshot.diagnostics = [...snapshot.diagnostics, readiness.reason];
  }
  if (generation !== sourceGeneration || !sessions.has(options.path)) throw new Error('History source changed during reading');
  const activity = !access.pending && options.leafId === undefined && snapshot.session.sourceKind === 'journal' ? await reader.activity(options.path, snapshot.selectedLeafId, access) : undefined;
  snapshot.session = { ...snapshot.session, activity: activity?.state };
  grantedSummaries.set(snapshot.session.path, snapshot.session);
  return { ...snapshot, ...(options.leafId === undefined && pinned.leafId !== undefined ? { leafId: pinned.leafId } : {}), access, activity };
}
function historyEvent(event: HistoryEvent): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('desktop:historyEvent', event);
}
async function watchHistory(options: HistoryRead): Promise<HistorySnapshot> {
  stopHistoryWatch?.();
  watchedPath = options.path; watchedActivity = undefined;
  const generation = ++watchGeneration;
  // Child resource reads use the shared reader; never evict this follower's tail.
  const reader = new HistoryReader();
  const children = new ChildJournalObserver();
  let current: HistorySnapshot;
  try { current = await readHistory(options, reader, { status: 'unknown', pending: true, checkedAt: 0 }); } catch (error) { reader.close(); throw error; }
  if (generation !== watchGeneration || quitting) { reader.close(); throw new Error('History watch was replaced'); }
  let access = current.access;
  let reading = false, probing = false, stopped = false, dirty = false;
  let readError: string | undefined;
  let childrenRevision: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  const presence = new SessionPresenceObserver(options.path, event => {
    if (stopped || generation !== watchGeneration || !presence.activity) return;
    presence.reconcile(current.messages);
    watchedActivity = presence.activity;
    current = { ...current, activity: presence.activity, liveTail: presence.tails };
    historyEvent({ path: options.path, kind: 'presence', activity: presence.activity, liveTail: presence.tails });
    historyEvent({ path: options.path, kind: 'activity', activity: presence.activity.state, activitySource: 'presence', updatedAt: current.session.updatedAt });
    if (event?.event !== 'delta') void reconcile();
  });
  presence.reconcile(current.messages);
  const reconcile = async () => {
    if (stopped) return;
    if (reading) { dirty = true; return; }
    reading = true; dirty = false; clearTimeout(timer);
    try {
      await approvedSession(options.path);
      const pinned = await pinHistory(options);
      const nextRevision = await reader.revision(options.path);
      const childState = await children.poll(options.path);
      const changed = !!readError || nextRevision !== current.revision || (pinned.leafId !== undefined && pinned.leafId !== current.selectedLeafId);
      let snapshot = current;
      if (changed) {
        const roots = await resolveHistoryRoots(await historyContext(options.path));
        snapshot = { ...await reader.read(pinned, roots.blobs), access };
        if (snapshot.session.sourceKind === 'archive') {
          const readiness = await reader.forkAvailability(options.path);
          snapshot.session = { ...snapshot.session, canFork: readiness.canFork };
          if (readiness.reason) snapshot.diagnostics = [...snapshot.diagnostics, readiness.reason];
        }
      }
      const activity = options.leafId === undefined && snapshot.session.sourceKind === 'journal' ? presence.activity ?? await reader.activity(options.path, snapshot.selectedLeafId, access, childState) : undefined;
      presence.reconcile(snapshot.messages);
      if (stopped || generation !== watchGeneration) return;
      if (changed || JSON.stringify(activity) !== JSON.stringify(current.activity)) {
        current = { ...snapshot, session: { ...snapshot.session, activity: activity?.state, activitySource: activity?.source }, activity, access, liveTail: presence.tails };
        watchedActivity = activity; grantedSummaries.set(current.session.path, current.session);
        historyEvent({ path: options.path, kind: 'snapshot', snapshot: current });
      }
      // Child evidence changes even when a pinned branch has no activity or presence owns activity.
      const childrenChanged = childrenRevision !== undefined && childState.revision !== childrenRevision;
      childrenRevision = childState.revision;
      if (childrenChanged && window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('desktop:turnChanges', { sourcePath: options.path });
      readError = undefined;
    } catch (error) {
      if (!stopped) { readError = error instanceof Error ? error.message : String(error); historyEvent({ path: options.path, kind: 'error', error: readError }); }
    } finally {
      reading = false;
      if (!stopped) timer = setTimeout(() => { void reconcile(); }, dirty ? 0 : current.activity?.state === 'running' || readError ? 500 : 2000);
    }
  };
  // Directory hints survive atomic replacement; polling remains authoritative.
  try { watcher = watch(dirname(options.path), () => { void reconcile(); }); watcher.on('error', () => { watcher?.close(); watcher = undefined; }); } catch { /* Reconciliation still observes missed/unavailable hints. */ }
  const refreshAccess = async () => {
    if (stopped || probing) return;
    probing = true;
    try {
      const next = await sessionAccess(options.path);
      if (stopped) return;
      access = next; current = { ...current, access }; historyEvent({ path: options.path, kind: 'access', access });
      if (options.leafId === undefined && current.session.sourceKind === 'journal') await presence.poll(access);
      void reconcile();
    } finally { probing = false; }
  };
  const presenceWatch = watchPresenceChanges(() => { void refreshAccess(); });
  const focusAccess = () => { void refreshAccess(); };
  window?.on('focus', focusAccess);
  stopHistoryWatch = () => { stopped = true; presence.close(); presenceWatch(); window?.removeListener('focus', focusAccess); clearTimeout(timer); watcher?.close(); reader.close(); watchedActivity = undefined; };
  if (stopped || generation !== watchGeneration) { presence.close(); throw new Error('History watch was replaced'); }
  watchedActivity = current.activity;
  timer = setTimeout(() => { void refreshAccess(); void reconcile(); }, 0);
  return current;
}
function runtimeHistoryOptions(value: unknown, withPath = false): RuntimeHistoryRead {
  const options = value === undefined ? {} : object(value, 'runtime history');
  fields(options, [...(withPath ? ['path'] : []), 'before', 'beforeEntryId', 'anchorId', 'leafId']);
  const result: RuntimeHistoryRead = {};
  for (const key of ['before', 'beforeEntryId', 'anchorId'] as const) if (options[key] !== undefined) result[key] = text(options[key], key, 4096);
  if (options.leafId !== undefined) result.leafId = options.leafId === null ? null : text(options.leafId, 'leafId', 512);
  if ([result.before, result.beforeEntryId, result.anchorId].filter(value => value !== undefined).length > 1) throw new Error('Select one history cursor or reading anchor');
  return result;
}
async function readRuntimeHistory(runtimeId: string, options: RuntimeHistoryRead = {}): Promise<RuntimeHistory> {
  const generation = sourceGeneration;
  const identity = await runtime.getHistoryIdentity(runtimeId);
  const { path, leafId } = identity;
  if (path) {
    let exists = false;
    try { await stat(path); exists = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !runtime.canUseUnpersistedHistory(runtimeId)) throw error;
    }
    if (exists) {
      runtime.markHistoryPersisted(runtimeId, { sessionId: identity.sessionId, path });
      if (!grantedSummaries.has(path)) historyDiscovery.request();
      const reader = new HistoryReader();
      try {
        const roots = await resolveHistoryRoots(runtime.getContext(runtimeId));
        const selectedLeaf = options.leafId === undefined ? leafId : options.leafId;
        const page = await reader.read({ path, ...options, leafId: selectedLeaf }, roots.blobs);
        const current = await runtime.request<{sessionId:string}>(runtimeId, {type:'get_state'});
        if (runtime.getSessionPath(runtimeId) !== path || current.sessionId !== page.session.id) throw new Error('Native session changed while reading durable history');
        const source = await runtime.getSourceState(runtimeId);
        if (generation !== sourceGeneration || removedRuntimes.has(runtimeId) || source.sessionId !== identity.sessionId || source.path !== path) throw new Error('Native history source changed during reading');
        sessions.add(path); sessionWorkspaces.set(path, runtime.getCwd(runtimeId)); grantedSummaries.set(path, page.session);
        return { source, messages: page.messages.map(message => message.raw), messageIds: page.messages.map(message => message.id), messageResourceReferences: page.messages.map(message => message.resourceReference), historySource: { path, leafId: page.selectedLeafId }, revision: page.revision, hasMore: page.hasMore, nextBefore: page.nextBefore, diagnostics: page.diagnostics };
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
  const current = await runtime.getHistoryIdentity(runtimeId);
  if (current.sessionId !== identity.sessionId || current.path !== path) throw new Error('Native session changed while reading live history');
  const source = await runtime.getSourceState(runtimeId);
  if (generation !== sourceGeneration || removedRuntimes.has(runtimeId) || source.sessionId !== identity.sessionId || source.path !== path) throw new Error('Native live source changed during reading');
  return { source, messages, hasMore: false, diagnostics: [] };
}
async function hydrateConnection(connection: SessionConnection): Promise<SessionConnection> {
  let history: RuntimeHistory;
  try { history = await readRuntimeHistory(connection.runtimeId); }
  catch (error) {
    const message = `Durable history is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    history = { source: await runtime.getSourceState(connection.runtimeId), messages: [], hasMore: false, diagnostics: [message], error: message };
  }
  connection.history = history;
  connection.source = history.source;
  // The native runtime allocates its canonical journal path before first
  // persistence. Grant that trusted identity before exposing its row: a close
  // must not race the history listing or a later access refresh.
  if (history.source.path && history.source.status !== 'unavailable') {
    sessions.grantSource(history.source);
    sessionWorkspaces.set(history.source.path, connection.cwd);
  }
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
    const sessionId = runtime.getConnection(runtimeId).state.sessionId;
    if (!path) throw new Error('Native session ownership cannot be verified without its current path');
    const perform = async () => {
      await runtime.request(runtimeId, { type: 'get_state' });
      if (runtime.getSessionPath(runtimeId) !== path || runtime.getConnection(runtimeId).state.sessionId !== sessionId) throw new Error('Native session changed during admission; retry on its current session');
      const access = await getRuntimeAccess(runtimeId);
      requireWritable(access);
      if (!access.canSend || runtime.getSessionPath(runtimeId) !== path || runtime.getConnection(runtimeId).state.sessionId !== sessionId) throw new Error(access.reason || access.source.reason || 'Native session changed or is unavailable during admission');
      const result = await operation();
      // Submission has already succeeded; a state refresh error must not invite a duplicate send.
      const refreshSessionId = runtime.getConnection(runtimeId).state.sessionId;
      const refreshPath = runtime.getSessionPath(runtimeId);
      try { await runtime.request(runtimeId, { type: 'get_state' }); }
      catch (error) {
        if (window && !window.isDestroyed()) window.webContents.send('desktop:runtimeEvent', { runtimeId, kind: 'observation_error', sessionId: refreshSessionId, sourcePath: refreshPath, error: error instanceof Error ? error.message : String(error) } satisfies RuntimeEvent);
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
    case 'get_session_stats':
    case 'export_html':
    case 'abort_retry':
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
      return { type, level };
    }
    case 'set_session_name':
      fields(command, ['type', 'name']);
      return { type, name: text(command.name, 'session name', 1024) };
    case 'branch':
      fields(command, ['type', 'entryId']);
      return { type, entryId: text(command.entryId, 'entryId', 256) };
    case 'set_fast_mode': case 'set_auto_compaction': case 'set_auto_retry':
      fields(command, ['type', 'enabled']);
      return { type, enabled: bool(command.enabled, 'enabled') };
    case 'set_steering_mode': case 'set_follow_up_mode': case 'set_interrupt_mode': {
      fields(command, ['type', 'mode']);
      const mode = text(command.mode, 'mode', 32);
      if (!(type === 'set_interrupt_mode' ? ['immediate', 'wait'] : ['all', 'one-at-a-time']).includes(mode)) throw new TypeError('Invalid native queue mode');
      return { type, mode };
    }
    case 'compact':
      fields(command, ['type', 'customInstructions']);
      return { type, ...(command.customInstructions === undefined ? {} : { customInstructions: text(command.customInstructions, 'custom instructions', 65536, true) }) };
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
  ipcMain.handle(`desktop:${name}`, async (event, ...args: unknown[]) => {
    if (quitting || !window || event.sender !== window.webContents || !event.senderFrame ||
      event.senderFrame !== window.webContents.mainFrame || !allowedDocument(event.senderFrame.url)) {
      throw new Error('Untrusted desktop IPC sender');
    }
    if (args.length !== count) throw new TypeError(`Invalid argument count for ${name}`);
    try { return await handler(...args); }
    catch (error) {
      if (error instanceof NativeResponseError) return { desktopNativeFailure: nativeError(error.message, error.command, error.code) };
      throw error;
    }
  });
}
async function externalUrl(value: unknown): Promise<void> {
  const url = new URL(text(value, 'URL', 8192));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Only HTTP(S) links without credentials are allowed');
  await shell.openExternal(url.href);
}

/** Native editing stays native; application commands use the renderer's single registry. */
function applicationMenu(language: DesktopPreferences['language'], send: (command: string) => void): MenuItemConstructorOptions[] {
  const zh = language === 'zh-CN';
  const labels: Record<string, [string, string]> = {
    'new-session': ['新建对话', 'New Conversation'], 'open-workspace': ['打开工作区…', 'Open Workspace…'],
    palette: ['搜索与操作…', 'Search and Actions…'], 'quick-open': ['查找文件…', 'Find File…'],
    'search-messages': ['搜索全部消息…', 'Search All Messages…'], find: ['在对话中查找…', 'Find in Conversation…'],
    'toggle-sidebar': ['切换侧边栏', 'Toggle Sidebar'], 'toggle-panel': ['切换工作面板', 'Toggle Work Panel'],
    settings: ['设置…', 'Settings…'], shortcuts: ['键盘快捷键', 'Keyboard Shortcuts'],
    'close-tab': ['关闭标签页', 'Close Tab'], 'next-tab': ['下一个标签页', 'Next Tab'],
    'prev-tab': ['上一个标签页', 'Previous Tab'], 'jump-latest': ['跳到最新消息', 'Jump to Latest'],
    stop: ['停止当前任务', 'Stop Current Run'],
  };
  const command = (id: string): MenuItemConstructorOptions => ({
    id, label: labels[id]![zh ? 0 : 1], accelerator: shortcutDefinitions.find(item => item.id === id)?.binding,
    click: () => send(id),
  });
  const separator: MenuItemConstructorOptions = { type: 'separator' };
  const mac = process.platform === 'darwin';
  return [
    ...(mac ? [{ label: app.name, submenu: [
      { role: 'about', label: zh ? `关于 ${app.name}` : `About ${app.name}` }, separator, command('settings'), separator,
      { role: 'services', label: zh ? '服务' : 'Services' }, separator,
      { role: 'hide', label: zh ? `隐藏 ${app.name}` : `Hide ${app.name}` },
      { role: 'hideOthers', label: zh ? '隐藏其他应用' : 'Hide Others' },
      { role: 'unhide', label: zh ? '全部显示' : 'Show All' }, separator,
      { role: 'quit', label: zh ? `退出 ${app.name}` : `Quit ${app.name}` },
    ] } satisfies MenuItemConstructorOptions] : []),
    { label: zh ? '文件' : 'File', submenu: [command('new-session'), command('open-workspace'), separator, command('close-tab'),
      ...(!mac ? [separator, command('settings'), { role: 'quit' as const, label: zh ? '退出' : 'Quit' }] : []),
    ] },
    { label: zh ? '编辑' : 'Edit', submenu: [
      { role: 'undo', label: zh ? '撤销' : 'Undo' }, { role: 'redo', label: zh ? '重做' : 'Redo' }, separator,
      { role: 'cut', label: zh ? '剪切' : 'Cut' }, { role: 'copy', label: zh ? '复制' : 'Copy' },
      { role: 'paste', label: zh ? '粘贴' : 'Paste' }, { role: 'selectAll', label: zh ? '全选' : 'Select All' },
      separator, command('find'), command('search-messages'),
    ] },
    { label: zh ? '视图' : 'View', submenu: [command('palette'), command('quick-open'), separator,
      command('toggle-sidebar'), command('toggle-panel'), separator, command('jump-latest'), command('stop'),
      separator, { role: 'togglefullscreen', label: zh ? '切换全屏' : 'Toggle Full Screen' },
    ] },
    { role: 'windowMenu', label: zh ? '窗口' : 'Window', submenu: [
      { role: 'minimize', label: zh ? '最小化' : 'Minimize' }, { role: 'zoom', label: zh ? '缩放' : 'Zoom' },
      separator, command('next-tab'), command('prev-tab'),
      ...(mac ? [separator, { role: 'front' as const, label: zh ? '前置全部窗口' : 'Bring All to Front' }] : []),
    ] },
    { role: 'help', label: zh ? '帮助' : 'Help', submenu: [command('shortcuts')] },
  ];
}
function installApplicationMenu(language: DesktopPreferences['language']): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu(language, command => {
    if (quitting || !window || window.isDestroyed() || window.webContents.isDestroyed() || !allowedDocument(window.webContents.getURL())) return;
    showWindow();
    window.webContents.send('desktop:menuCommand', command);
  })));
}

async function start(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  const preferences = await data.getPreferences();
  const installationReady = resolveInstallation(preferences.executablePath || undefined).then(installation => { discoveredInstallation = installation; return installation; });
  void installationReady.catch(() => undefined);
  let startupDraft: { cwd: string; connection: Promise<SessionConnection> } | undefined;
  if (preferences.lastWorkspace) {
    const cwd = preferences.lastWorkspace;
    const connection = installationReady.then(async () => {
      const canonical = await localPath(cwd, 'directory');
      workspaces.add(canonical);
      const connected = await runtime.start({ cwd: canonical, draft: true }, await getContext(canonical));
      if (quitting) { await runtime.close(connected.runtimeId); throw new Error('Desktop is shutting down'); }
      ownedRuntimes.add(connected.runtimeId); knownRuntimes.add(connected.runtimeId);
      return hydrateConnection(connected);
    });
    startupDraft = { cwd, connection };
    void connection.catch(() => undefined);
  }
  const configuredModelReady = installationReady.then(async installation => {
    if (!installation.info.available || !preferences.lastWorkspace) return undefined;
    return readConfiguredModel(await getContext(preferences.lastWorkspace));
  });
  // Match the renderer's fixed neutral dark baseline before creating native vibrancy.
  nativeTheme.themeSource = 'dark';
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
    const installation = discoveredInstallation ?? await installationReady;
    discoveredInstallation = installation;
    try { await syncPresenceInstallation(await historyContext(''), current.terminalPresence, presenceResourcePath(app.isPackaged, process.resourcesPath, outputDirectory)); }
    catch (error) { console.warn('Presence extension installation was left unchanged', error); }
    return { preferences: current, runtime: installation.info, platform: process.platform, home: homedir(), configuredModel: await configuredModelReady, modelNames: await modelCapacity.names() };
  });
  ipc('checkRuntime', 0, async () => {
    const installation = await resolveInstallation((await data.getPreferences()).executablePath || undefined);
    discoveredInstallation = installation;
    return installation.info;
  });
  const nativeLoginDirectory = join(app.getPath('userData'), 'tmp', 'native-login');
  await clearNativeLoginScripts(nativeLoginDirectory);
  ipc('openNativeLogin', 0, async () => {
    await openNativeLogin(nativeLoginDirectory, await getContext(homedir()), path => shell.openPath(path));
  });
  ipc('getPresenceSettings', 0, async () => ({ ...await getPresenceInstallation(await historyContext('')), ...await getPresenceProcessCounts() }));
  ipc('getDesktopDiagnostics', 0, async () => {
    const [installation, presence] = await Promise.all([resolveInstallation((await data.getPreferences()).executablePath || undefined), getPresenceInstallation(await historyContext(''))]);
    return { desktopVersion: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, omp: installation.info, presenceVersion: presence.installedVersion, logsDirectory: app.getPath('logs') };
  });
  ipc('openLogsFolder', 0, async () => {
    const directory = app.getPath('logs');
    await mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  ipc('setPreferences', 1, async (value) => {
    const patch = validatePreferences(value);
    const result: Partial<DesktopPreferences> = {};
    for (const [key, item] of Object.entries(patch)) {
      switch (key) {
        case 'terminalPresence': result.terminalPresence = bool(item, key); break;
        case 'language':
          if (item !== 'zh-CN' && item !== 'en') throw new TypeError('Invalid language');
          result.language = item; break;
        case 'fontSize': result.fontSize = number(item, key, 10, 32); break;
        case 'fontFamily': result.fontFamily = text(item, key, 512, true); break;
        case 'sidebarWidth': result.sidebarWidth = number(item, key, 180, 600); break;
        case 'panelWidth': result.panelWidth = number(item, key, 1, Number.MAX_SAFE_INTEGER); break;
        case 'chatContentWidth': result.chatContentWidth = number(item, key, 360, 1600); break;
        case 'enterToSend': result.enterToSend = bool(item, key); break;
        case 'notifications': result.notifications = bool(item, key); break;
        case 'messageMeta': result.messageMeta = patch.messageMeta; break;
        case 'durationStyle': result.durationStyle = patch.durationStyle; break;
        case 'hiddenProjects': result.hiddenProjects = patch.hiddenProjects; break;
        case 'collapsedProjects': result.collapsedProjects = patch.collapsedProjects; break;
        case 'sidebarStateMigrated': result.sidebarStateMigrated = patch.sidebarStateMigrated; break;
        case 'preferredEditor': result.preferredEditor = patch.preferredEditor; break;
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
          // Canonicalization can map a new spelling (e.g. /tmp vs /private/tmp) onto an existing entry; keep the first.
          result.recentWorkspaces = [...new Set(await Promise.all(requested.map((path) =>
            stored.has(path) ? Promise.resolve(path) : approvedWorkspace(path))))];
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
    return admissions.run('desktop:preferences', async () => {
      if (result.terminalPresence !== undefined || result.profile !== undefined || result.lastWorkspace !== undefined) {
        const current = await data.getPreferences();
        const next = { ...current, ...result };
        const context = { ...await historyContext(''), profile: next.profile || undefined, cwd: next.lastWorkspace || homedir() };
        await syncPresenceInstallation(context, next.terminalPresence, presenceResourcePath(app.isPackaged, process.resourcesPath, outputDirectory));
      }
      const preferences = await data.setPreferences(result);
      if (result.profile !== undefined || result.executablePath !== undefined || result.lastWorkspace !== undefined) { sourceGeneration++; historyDiscovery.request(); }
      if (result.language !== undefined) installApplicationMenu(preferences.language);
      if (result.profile !== undefined || result.executablePath !== undefined) messageSearch.cancel();
      return preferences;
    });
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
  const sessionUsage = new SessionUsageReader(options => sessionResources.resolveUsageChildren(options));
  ipc('getSessionUsage', 2, async (value, selectedLeaf) => {
    const path = await approvedSession(value);
    const leafId = selectedLeaf === undefined || selectedLeaf === null ? selectedLeaf : text(selectedLeaf, 'leafId', 512);
    const pinned = await pinHistory({ path, leafId });
    const summary = await sessionUsage.read(path, pinned.leafId);
    const capacity = summary.model ? await modelCapacity.resolve(summary.model.provider, summary.model.id) : undefined;
    return capacity ? { ...summary, model: { provider: capacity.provider, id: capacity.id, name: capacity.name }, contextWindow: capacity.contextWindow, windowSource: capacity.windowSource } : summary;
  });
  ipc('getModelCapacity', 2, async (provider, id) => modelCapacity.resolve(text(provider, 'provider', 512), text(id, 'model', 512)));
  ipc('getWindowChrome', 0, () => ({ fullscreen: window?.isFullScreen() ?? false }));
  ipc('listHistory', 1, async (value) => {
    const options = value === undefined ? {} : object(value, 'history options');
    fields(options, ['cwd', 'query']);
    return listHistory({ cwd: options.cwd === undefined ? undefined : await approvedWorkspace(options.cwd), query: options.query === undefined ? undefined : text(options.query, 'query', 1024, true) });
  });
  ipc('searchMessages', 1, async value => {
    const options = object(value, 'message search');
    fields(options, ['query', 'limit', 'path']);
    const generation = sourceGeneration;
    const result = await messageSearch.search({
      query: text(options.query, 'query', 1024, true),
      ...(options.limit === undefined ? {} : { limit: number(options.limit, 'limit', 1, 100) }),
      ...(options.path === undefined ? {} : { path: text(options.path, 'session path') }),
    });
    if (generation !== sourceGeneration) throw new Error('History sources changed during search; search again');
    for (const hit of result.results) {
      sessions.add(hit.path);
      sessionWorkspaces.set(hit.path, hit.cwd);
    }
    return result;
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
  ipc('watchHistory', 1, async value => { const generation = ++watchGeneration; stopHistoryWatch?.(); stopHistoryWatch = undefined; watchedPath = undefined; const options = await historyOptions(value); if (generation !== watchGeneration) throw new Error('History watch was replaced'); return watchHistory(options); });
  ipc('unwatchHistory', 0, () => { ++watchGeneration; stopHistoryWatch?.(); stopHistoryWatch = undefined; watchedPath = undefined; });
  ipc('readRuntimeHistory', 2, (id, options) => readRuntimeHistory(ownedRuntime(id), runtimeHistoryOptions(options)));
  ipc('getRuntimeAccess', 1, async value => { const id = text(value, 'runtimeId', 256); if (!knownRuntimes.has(id) || removedRuntimes.has(id)) throw new Error('This runtime is not owned by this window'); if (!runtime.ownedFacts().some(fact => fact.runtimeId === id)) await runtime.close(id); return getRuntimeAccess(id); });
  ipc('listHistorySubagents', 1, async value => {
    const options = object(value, 'history subagents');
    fields(options, ['path', 'leafId']);
    return sessionResources.listHistorySubagents(await pinHistory(await historyOptions(options)));
  });
  const savedAncestry = (value: unknown): SavedSubagentEdge[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length >= 63) throw new TypeError('Invalid saved task ancestry bound');
    return value.map(item => {
      const edge = object(item, 'saved task edge');
      fields(edge, ['subagentId', 'leafId', 'revision']);
      return { subagentId: text(edge.subagentId, 'saved task ID', 1024), leafId: edge.leafId === null ? null : text(edge.leafId, 'selected task leaf', 512), revision: text(edge.revision, 'selected task revision', 1024) };
    });
  };
  ipc('getTurnChanges', 1, async value => {
    const input = object(value, 'turn changes');
    fields(input, ['context', 'anchorId', 'toolCallIds']);
    const rawContext = object(input.context, 'turn source');
    const anchorId = text(input.anchorId, 'turn anchor', 4096);
    const toolCallIds = input.toolCallIds === undefined ? undefined : stringList(input.toolCallIds, 'turn tool identities', 1000);
    const subagentId = rawContext.subagentId === undefined ? undefined : text(rawContext.subagentId, 'subagent ID', 1024);
    let query: TurnChangeQuery;
    if (rawContext.kind === 'saved') {
      fields(rawContext, ['kind', 'parentPath', 'leafId', 'subagentId', 'ancestry']);
      const pinned = await pinHistory(await historyOptions({ path: rawContext.parentPath, leafId: rawContext.leafId }));
      query = { context: { kind: 'saved', parentPath: pinned.path, leafId: pinned.leafId, subagentId, ancestry: savedAncestry(rawContext.ancestry) }, anchorId, toolCallIds };
    } else {
      if (rawContext.kind !== 'runtime') throw new TypeError('Invalid turn change source');
      fields(rawContext, ['kind', 'runtimeId', 'subagentId']);
      query = { context: { kind: 'runtime', runtimeId: ownedRuntime(rawContext.runtimeId), subagentId }, anchorId, toolCallIds };
    }
    const key = JSON.stringify(query);
    const previous = turnChangeReads.get(key);
    if (previous) return previous;
    const generation = sourceGeneration;
    const operation = collectTurnChanges(async (): Promise<TurnChangeResult> => {
      if (query.context.kind === 'saved') {
        const result = await readTurnChanges(query);
        if (quitting || sourceGeneration !== generation || !sessions.has(query.context.parentPath)) throw new Error('Turn source changed during collection');
        return result;
      }
      const runtimeId = query.context.runtimeId;
      const identity = await runtime.getHistoryIdentity(runtimeId);
      const owner = await runtime.getOwnedChildren(runtimeId);
      if (identity.sessionId !== owner.sessionId || identity.path !== owner.parentPath) throw new Error('Native turn source changed before collection');
      if (query.context.subagentId && !owner.children.some(child => child.id === query.context.subagentId && child.sessionFile)) throw new Error('Native child is not authorized for turn changes');
      const result = await readTurnChanges({ ...query, runtime: { ...owner, cwd: runtime.getCwd(runtimeId), leafId: identity.leafId } });
      const current = await runtime.getOwnedChildren(runtimeId);
      const selected = await runtime.getHistoryIdentity(runtimeId);
      if (quitting || sourceGeneration !== generation || !knownRuntimes.has(runtimeId) || removedRuntimes.has(runtimeId) || selected.path !== identity.path || selected.leafId !== identity.leafId || current.sessionId !== owner.sessionId || current.parentPath !== owner.parentPath) throw new Error('Native turn selection changed during collection');
      for (const child of owner.children) {
        const next = current.children.find(item => item.id === child.id);
        if (!next || next.sessionFile !== child.sessionFile || next.parentToolCallId !== child.parentToolCallId) throw new Error('Native child ownership changed during turn collection');
      }
      return result;
    });
    turnChangeReads.set(key, operation);
    try { return await operation; } finally { if (turnChangeReads.get(key) === operation) turnChangeReads.delete(key); }
  });
  const childReading = (options: Record<string, unknown>): ChildHistoryRead => ({
    ...(options.before === undefined ? {} : { before: text(options.before, 'before', 4096) }),
    ...(options.beforeEntryId === undefined ? {} : { beforeEntryId: text(options.beforeEntryId, 'child entry anchor', 4096) }),
    ...(options.childLeafId === undefined ? {} : { childLeafId: options.childLeafId === null ? null : text(options.childLeafId, 'selected child leaf', 512) }),
    ...(options.childRevision === undefined ? {} : { childRevision: text(options.childRevision, 'selected child revision', 1024) }),
  });
  ipc('readHistorySubagent', 1, async value => {
    const options = object(value, 'history subagent');
    fields(options, ['parentPath', 'subagentId', 'leafId', 'ancestry', 'before', 'beforeEntryId', 'childLeafId', 'childRevision']);
    const parent = await pinHistory(await historyOptions({ path: options.parentPath, leafId: options.leafId }));
    return sessionResources.readHistorySubagent({ parentPath: parent.path, leafId: parent.leafId, ancestry: savedAncestry(options.ancestry), subagentId: text(options.subagentId, 'subagent ID', 1024), ...childReading(options) });
  });
  ipc('resolveHistoryParent', 1, async value => sessionResources.resolveParentSession({ path: await approvedSession(value), sources: [...grantedSummaries.values()] }));
  ipc('readRuntimeSubagent', 1, async value => {
    const options = object(value, 'runtime child history');
    fields(options, ['runtimeId', 'subagentId', 'before', 'beforeEntryId', 'childLeafId', 'childRevision']);
    const runtimeId = ownedRuntime(options.runtimeId);
    const subagentId = text(options.subagentId, 'native child ID', 1024);
    const owner = await runtime.getOwnedChildren(runtimeId);
    const child = owner.children.find(child => child.id === subagentId);
    if (!child?.sessionFile) throw new Error('Native child source is not currently authorized by this runtime; use saved recovery if available');
    const page = await sessionResources.readRuntimeSubagent({ parentPath: owner.parentPath, childPath: child.sessionFile, subagentId, ...childReading(options) });
    const current = await runtime.getOwnedChildren(runtimeId);
    const currentChild = current.children.find(item => item.id === subagentId);
    if (current.sessionId !== owner.sessionId || current.parentPath !== owner.parentPath || currentChild?.sessionFile !== child.sessionFile || currentChild?.parentToolCallId !== child.parentToolCallId) throw new Error('Native child ownership changed during history read');
    return page;
  });
  ipc('readSessionArtifact', 1, async value => {
    const options = object(value, 'session artifact');
    fields(options, ['context', 'reference', 'cursor']);
    const context = object(options.context, 'resource context');
    const reference = text(options.reference, 'resource reference', 8192);
    const cursor = options.cursor === undefined ? undefined : text(options.cursor, 'cursor', 4096);
    const subagentId = context.subagentId === undefined ? undefined : text(context.subagentId, 'child ID', 1024);
    if (context.kind === 'saved') {
      fields(context, ['kind', 'parentPath', 'leafId', 'subagentId', 'ancestry']);
      const parent = await pinHistory(await historyOptions({ path: context.parentPath, leafId: context.leafId }));
      return sessionResources.readSessionArtifact({ parentPath: parent.path, leafId: parent.leafId, ancestry: savedAncestry(context.ancestry), subagentId, reference, cursor });
    }
    if (context.kind !== 'runtime') throw new TypeError('Invalid resource context');
    fields(context, ['kind', 'runtimeId', 'subagentId']);
    const runtimeId = ownedRuntime(context.runtimeId);
    const owner = await runtime.getOwnedChildren(runtimeId);
    const child = subagentId === undefined ? undefined : owner.children.find(child => child.id === subagentId);
    if (subagentId !== undefined && !child?.sessionFile) throw new Error('Native child resource is not currently authorized by this runtime');
    const identity = reference.startsWith('agent://') ? await runtime.getHistoryIdentity(runtimeId) : undefined;
    if (identity && identity.path !== owner.parentPath) throw new Error('Native output parent changed before reading');
    const page = await sessionResources.readRuntimeArtifact({ parentPath: owner.parentPath, childPath: child?.sessionFile, subagentId, nativeSubagents: owner.children, leafId: identity?.leafId, reference, cursor });
    const current = await runtime.getOwnedChildren(runtimeId);
    const currentChild = subagentId === undefined ? undefined : current.children.find(item => item.id === subagentId);
    if (current.sessionId !== owner.sessionId || current.parentPath !== owner.parentPath || currentChild?.sessionFile !== child?.sessionFile || currentChild?.parentToolCallId !== child?.parentToolCallId) throw new Error('Native ownership changed during resource read');
    if (reference.startsWith('agent://')) for (const previous of owner.children) {
      const next = current.children.find(item => item.id === previous.id);
      if (!next || next.sessionFile !== previous.sessionFile || next.parentToolCallId !== previous.parentToolCallId) throw new Error('Native output ownership changed during resource read');
    }
    if (identity) {
      const next = await runtime.getHistoryIdentity(runtimeId);
      if (next.path !== identity.path || next.leafId !== identity.leafId) throw new Error('Native output ancestry changed during reading');
    }
    return page;
  });
  ipc('readSessionEntry', 1, async value => {
    const options = object(value, 'session entry');
    fields(options, ['parentPath', 'entryId', 'cursor']);
    return sessionResources.readSessionEntry({ parentPath: await approvedSession(options.parentPath), entryId: text(options.entryId, 'entry ID', 512), ...(options.cursor === undefined ? {} : { cursor: text(options.cursor, 'cursor', 4096) }) });
  });
  ipc('startSession', 1, async (value) => {
    const options = object(value, 'session options');
    fields(options, ['cwd', 'sessionPath', 'mode', 'draft']);
    const cwd = await approvedWorkspace(options.cwd);
    const mode = options.mode === undefined ? 'resume' : text(options.mode, 'mode', 16);
    if (mode !== 'resume' && mode !== 'fork') throw new TypeError('Invalid session mode');
    if (mode === 'fork' && !options.sessionPath) throw new TypeError('Fork requires a persisted source session');
    if (options.draft !== undefined && typeof options.draft !== 'boolean') throw new TypeError('Invalid draft flag');
    if (options.draft && options.sessionPath) throw new TypeError('Drafts cannot resume a saved session');
    const requestedPath = options.sessionPath === undefined ? undefined : text(options.sessionPath, 'session path');
    const sessionPath = requestedPath === undefined ? undefined : await approvedSession(requestedPath);
    const context = await getContext(cwd);
    if (options.draft === true && !sessionPath && startupDraft) {
      const warm = startupDraft; startupDraft = undefined;
      if (await localPath(warm.cwd, 'directory') === cwd) return warm.connection;
      void warm.connection.then(connection => runtime.close(connection.runtimeId)).catch(() => undefined);
    }
    const launch = async () => {
      if (quitting) throw new Error('OMP-Desktop is shutting down');
      if (sessionPath) {
        await approvedSession(sessionPath);
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
        connection = await runtime.start({ cwd, sessionPath: source?.path ?? sessionPath, mode, draft: options.draft === true }, context);
        ownedRuntimes.add(connection.runtimeId);
        knownRuntimes.add(connection.runtimeId);
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
    return sessionPath ? admissions.run(sessionPath, launch) : launch();
  });
  ipc('closeSession', 1, async (id) => {
    const runtimeId = ownedRuntime(id);
    await admissions.run(`runtime:${runtimeId}`, async () => { const path = runtime.getSessionPath(runtimeId); const close = async () => { const outcome = await runtime.close(runtimeId); ownedRuntimes.delete(runtimeId); if (outcome.error) throw new Error(outcome.error); }; if (path) await admissions.run(path, close); else await close(); });
  });
  const retainedRevealPaths = new Set<string>();
  ipc('removeSession', 1, async value => {
    retainedRevealPaths.clear();
    const input = object(value, 'session removal');
    const sessionId = text(input.sessionId, 'sessionId', 512);
    let target: SessionRemovalTarget;
    if (input.allowUncertain !== undefined && typeof input.allowUncertain !== 'boolean') throw new TypeError('Invalid removal confirmation');
    if (input.kind === 'runtime') { fields(input, ['kind', 'runtimeId', 'sessionId', 'allowUncertain']); target = { kind: 'runtime', runtimeId: text(input.runtimeId, 'runtimeId', 256), sessionId, allowUncertain: input.allowUncertain === true }; }
    else if (input.kind === 'saved') { fields(input, ['kind', 'path', 'sessionId', 'allowUncertain']); target = { kind: 'saved', path: text(input.path, 'session path'), sessionId, allowUncertain: input.allowUncertain === true }; }
    else throw new TypeError('Invalid session removal target');
    const result = await removeSession(target, { trashItem: path => shell.trashItem(path), withAdmission: async (target, run) => {
        const id = target.kind === 'runtime' ? target.runtimeId : undefined;
        if (id && (!knownRuntimes.has(id) || removedRuntimes.has(id))) throw new Error('This runtime is not owned by this window');
        if (id && ownedRuntimes.has(id)) await runtime.request(id, { type: 'get_state' });
        const binding = id ? await runtime.getSourceState(id) : { status: 'persisted' as const, sessionId, path: await approvedSession(target.kind === 'saved' ? target.path : undefined) };
        if (binding.sessionId !== sessionId) throw new Error('Native session identity changed before removal');
        const path = binding.path;
        const context = id ? runtime.getContext(id) : await historyContext(path!);
        return withRemovalRuntimeAdmission(admissions, target, binding, {
          identities: () => [...knownRuntimes].map(runtimeId => ({ runtimeId, sessionId: runtime.getConnection(runtimeId).state.sessionId, path: runtime.getSessionPath(runtimeId) })),
          close: runtimeId => runtime.close(runtimeId),
        }, async lifecycle => {
          if (id && ownedRuntimes.has(id)) await runtime.request(id, { type: 'get_state' });
          const source = id ? await runtime.getSourceState(id) : binding;
          if (source.sessionId !== sessionId || source.path !== path) throw new Error('Native source changed while waiting for removal admission');
          lifecycle.revalidate();
          const affectedRuntimeIds = lifecycle.runtimeIds;
          const result = await run({ sessionId, source, initialEmpty: !!id && source.status === 'unpersisted', affectedRuntimeIds, roots: await resolveHistoryRoots(context), inspectWriters: inspectRemovalWriters,
            close: lifecycle.close,
            revalidate: async phase => {
              lifecycle.revalidate();
              if (id) {
                if (phase === 'before-close' && ownedRuntimes.has(id)) await runtime.request(id, { type: 'get_state' });
                const current = runtime.getConnection(id).state;
                if (current.sessionId !== sessionId || runtime.getSessionPath(id) !== path) throw new Error('Native session changed during removal');
              } else if (!path || !sessions.has(path)) throw new Error('Saved source grant was revoked');
              if (path) {
                // An owned runtime is shut down before probing; absent initial allocations
                // have nothing on disk to occupy and are discarded without a probe.
                const currentSource = id ? await runtime.getSourceState(id) : source;
                if (currentSource.status !== 'unpersisted' && !(phase === 'before-close' && lifecycle.close)) requireRemovalAccess(await sessionAccess(path, context), target.allowUncertain);
                lifecycle.revalidate();
                if (runtime.ownedFacts().some(fact => fact.sessionPath === path && !affectedRuntimeIds.includes(fact.runtimeId))) throw new Error('Another connected runtime acquired this source during removal');
                if (id && (runtime.getConnection(id).state.sessionId !== sessionId || runtime.getSessionPath(id) !== path)) throw new Error('Native identity changed during removal inspection');
              } else if (!id || source.status !== 'unpersisted') throw new Error('Removal requires a proven source identity');
            },
          });
          if (result.sourceRemoved) {
            sourceGeneration++;
            turnChanges.forget(result.affectedRuntimeIds, result.sourcePath);
            for (const id of result.affectedRuntimeIds) { removedRuntimes.add(id); knownRuntimes.delete(id); ownedRuntimes.delete(id); }
            if (result.sourcePath) { sessions.delete(result.sourcePath); grantedSummaries.delete(result.sourcePath); sessionWorkspaces.delete(result.sourcePath); if (watchedPath === result.sourcePath) { ++watchGeneration; stopHistoryWatch?.(); stopHistoryWatch = undefined; watchedPath = undefined; } }
            try { result.preferences = await admissions.run('desktop:preferences', async () => { const preferences = await data.getPreferences(); const pins = new Set([...(result.sourcePath ? [result.sourcePath] : []), ...result.affectedRuntimeIds.map(id => `runtime:${id}`)]); return data.setPreferences({ pinnedSessions: preferences.pinnedSessions.filter(path => !pins.has(path)) }); }); }
            catch (error) { result.disposition = 'partial'; result.warnings.push(`Conversation removed, but pin cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
          }
          return result;
        });
    }});
    for (const item of result.retained.slice(0, 10000)) retainedRevealPaths.add(item.path);
    return result;
  });
  ipc('request', 2, async (id, value) => {
    const runtimeId = ownedRuntime(id);
    const command = commandArgument(value);
    if (command.type === 'export_html') {
      const state = runtime.getConnection(runtimeId).state;
      const choice = await dialog.showSaveDialog(window!, { title: 'Export native session HTML', defaultPath: join(runtime.getCwd(runtimeId), `session-${state.sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.html`), filters: [{ name: 'HTML', extensions: ['html'] }] });
      if (choice.canceled || !choice.filePath) return { cancelled: true };
      const outputPath = choice.filePath;
      return mutateRuntime(runtimeId, () => runtime.request(runtimeId, { type: 'export_html', outputPath }));
    }
    if (command.type.startsWith('get_') || command.type === 'abort') return runtime.request(runtimeId, command);
    return mutateRuntime(runtimeId, () => runtime.request(runtimeId, command));
  });
  ipc('sendPrompt', 2, async (id, value) => {
    const runtimeId = ownedRuntime(id);
    const input = object(value, 'prompt');
    fields(input, ['text', 'attachmentIds', 'mode', 'submissionId', 'expectedSessionId']);
    const mode = input.mode === undefined ? 'prompt' : text(input.mode, 'mode', 16);
    if (!['prompt', 'steer', 'follow_up', 'abort_and_prompt'].includes(mode)) throw new TypeError('Invalid prompt mode');
    const prompt: PromptInput = { text: text(input.text, 'prompt text', 1048576, true), mode: mode as PromptInput['mode'] };
    if (input.attachmentIds !== undefined) prompt.attachmentIds = stringList(input.attachmentIds, 'attachmentIds', 32);
    if (input.submissionId !== undefined) prompt.submissionId = text(input.submissionId, 'submission ID', 128);
    const expectedSessionId = text(input.expectedSessionId, 'expected session ID', 256);
    if (!prompt.text.trim() && !prompt.attachmentIds?.length) throw new TypeError('Enter a message or add an attachment');
    return mutateRuntime(runtimeId, async () => {
      const path = runtime.getSessionPath(runtimeId);
      const sessionId = runtime.getConnection(runtimeId).state.sessionId;
      if (sessionId !== expectedSessionId) throw new Error('Native session changed before prompt admission; original input was not sent');
      const prepared = await workspace.preparePrompt(runtime.getCwd(runtimeId), prompt);
      await runtime.request(runtimeId, { type: 'get_state' });
      if (runtime.getSessionPath(runtimeId) !== path || runtime.getConnection(runtimeId).state.sessionId !== sessionId) throw new Error('Native session changed while preparing attachments; retry on its current session');
      const access = await getRuntimeAccess(runtimeId);
      requireWritable(access);
      if (!access.canSend || runtime.getSessionPath(runtimeId) !== path || runtime.getConnection(runtimeId).state.sessionId !== sessionId) throw new Error(access.reason || access.source.reason || 'Native identity changed during prompt admission');
      const baselineIdentity = await runtime.getHistoryIdentity(runtimeId);
      if (baselineIdentity.sessionId !== sessionId || baselineIdentity.path !== path) throw new Error('Native branch changed before preparing the change baseline');
      const state = runtime.getConnection(runtimeId).state;
      const capture = await turnChanges.prepare({ runtimeId, sessionId, cwd: runtime.getCwd(runtimeId), sourcePath: path, beforeEntryId: baselineIdentity.leafId, submissionId: prompt.submissionId, mode, idle: !state.isStreaming && !state.isCompacting && !state.hasPendingAsyncWork && (state.queuedMessageCount ?? 0) === 0 && state.isSettled !== false });
      let sent = false;
      try {
        await runtime.request(runtimeId, { type: 'get_state' });
        const currentAccess = await getRuntimeAccess(runtimeId);
        requireWritable(currentAccess);
        if (quitting || !currentAccess.canSend || runtime.getSessionPath(runtimeId) !== path || runtime.getConnection(runtimeId).state.sessionId !== sessionId) throw new Error('Native identity changed while preparing the change baseline; input was not sent');
        sent = true;
        const accepted = await runtime.submitPrompt(runtimeId, { type: mode, ...prepared }, expectedSessionId, prompt.submissionId);
        turnChanges.accepted(capture, accepted.data);
        // Keep grants when preparation or submission rejects so the draft can be retried.
        await Promise.all((prompt.attachmentIds ?? []).map(attachmentId => workspace.removeAttachment(attachmentId)));
        return accepted;
      } catch (error) { turnChanges.rejected(capture, sent); throw error; }
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
      const state = runtime.isInitializing(runtimeId) ? undefined : runtime.getConnection(runtimeId).state;
      if (path) requireWritable(await sessionAccess(path, runtime.getContext(runtimeId)));
      else if (!runtime.isInitializing(runtimeId)) throw new Error('Native session ownership cannot be verified without its current path');
      if (state && (runtime.getConnection(runtimeId).state.sessionId !== state.sessionId || runtime.getSessionPath(runtimeId) !== path)) throw new Error('Native session changed during response admission');
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
  ipc('gitDiff', 3, async (cwd, path, references) => {
    if (references !== undefined && (!Array.isArray(references) || references.length > 500)) throw new TypeError('Expected at most 500 referenced paths');
    return workspace.gitDiff(await approvedWorkspace(cwd), fileArgument(path, true), references === undefined ? undefined : (references as unknown[]).map(value => text(value, 'referenced path')));
  });
  ipc('revealFile', 2, async (cwd, path) => {
    const requested = text(path, 'path');
    const resolved = retainedRevealPaths.has(requested) ? requested : await workspace.resolvePath(await approvedWorkspace(cwd), requested);
    shell.showItemInFolder(resolved);
  });
  ipc('openInEditor', 1, async value => {
    const request = validateDesktopFileRequest(value, true);
    const cwd = await approvedWorkspace(request.cwd);
    const path = await workspace.resolvePath(cwd, request.path);
    const preferences = await data.getPreferences();
    const installation = preferences.preferredEditor === 'system' ? undefined : discoveredInstallation ?? await resolveInstallation(preferences.executablePath || undefined);
    if (installation) discoveredInstallation = installation;
    await openInPreferredEditor(preferences.preferredEditor, { ...request, cwd, path }, installation?.env ?? process.env, path => shell.openPath(path));
  });
  ipc('quickLook', 1, async value => {
    const request = validateDesktopFileRequest(value);
    const path = await workspace.resolvePath(await approvedWorkspace(request.cwd), request.path);
    if (process.platform === 'darwin' && window && !window.isDestroyed()) window.previewFile(path);
  });
  ipcMain.on('desktop:startFileDrag', (event, ...args: unknown[]) => {
    if (quitting || !window || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame || !allowedDocument(event.senderFrame.url)) return;
    const source = window;
    void (async () => {
      if (args.length !== 1) throw new TypeError('Invalid argument count for startFileDrag');
      const request = validateDesktopFileRequest(args[0]);
      const cwd = await approvedWorkspace(request.cwd);
      const path = await workspace.resolvePath(cwd, request.path);
      const icon = await app.getFileIcon(path, { size: 'normal' });
      // Recheck after icon loading, including navigation and symlink changes.
      if (quitting || source.isDestroyed() || event.sender.isDestroyed() || event.senderFrame !== source.webContents.mainFrame || !allowedDocument(event.senderFrame.url)) return;
      if (await workspace.resolvePath(cwd, request.path) !== path) throw new Error('File changed during drag');
      event.sender.startDrag({ file: path, icon });
    })().catch(error => { console.warn('Desktop file drag failed:', error); });
  });
  ipc('openExternal', 1, externalUrl);
  ipc('copyText', 1, (value) => clipboard.writeText(text(value, 'clipboard text', 8388608, true)));
  ipc('windowAction', 1, (action) => {
    if (action === 'minimize') window!.minimize();
    else if (action === 'maximize') window!.isMaximized() ? window!.unmaximize() : window!.maximize();
    else if (action === 'close') window!.close();
    else throw new TypeError('Invalid window action');
  });
  ipc('setAttention', 1, (value) => {
    const { badge, bounce } = validateAttention(value);
    if (process.platform !== 'darwin') return;
    app.dock?.setBadge(badge);
    if (bounce && badge && (!window!.isVisible() || !window!.isFocused())) app.dock?.bounce(bounce);
  });
  ipc('setWindowTitle', 1, (value) => window!.setTitle(validateWindowTitle(value)));
  ipc('notify', 1, async (value) => {
    const payload = validateNotification(value);
    if ((!knownRuntimes.has(payload.runtimeId) && !ownedRuntimes.has(payload.runtimeId)) || removedRuntimes.has(payload.runtimeId)) throw new Error('Unknown notification session');
    const preferences = await data.getPreferences();
    if (!window || window.isDestroyed() || quitting || !shouldNotify(preferences.notifications, window.isVisible(), window.isFocused()) || !Notification.isSupported()) return;
    const notification = new Notification({ title: payload.title, body: payload.body });
    notification.once('click', () => {
      if (!window || window.isDestroyed() || quitting || removedRuntimes.has(payload.runtimeId)) return;
      showWindow();
      window.webContents.send('desktop:notificationClick', payload.runtimeId);
    });
    notification.show();
  });

  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 600, show: false,
    title: 'OMP-Desktop', backgroundColor: process.platform === 'darwin' ? '#00000000' : '#181818',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window' as const, visualEffectState: 'followWindow' as const } : {}),
    webPreferences: {
      preload: join(outputDirectory, '../preload/index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
    },
  });
  installApplicationMenu(preferences.language);
  const publishChrome = () => window?.webContents.send('desktop:windowChrome', { fullscreen: window.isFullScreen() });
  window.on('enter-full-screen', publishChrome);
  window.on('leave-full-screen', publishChrome);
  window.on('page-title-updated', event => event.preventDefault());
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
    quitConfirmed = true; // Renderer failure must retain the existing unconditional drain.
    app.quit();
  });
  window.on('close', (event) => {
    if (drained) return;
    event.preventDefault();
    if (quitting || confirmingQuit) return;
    if (lifecycleDecision('close', process.platform, runtime.ownedRunningCount()) === 'hide') window?.hide();
    else app.quit(); // before-quit owns confirmation and cleanup on every platform.
  });
  window.on('closed', () => { ++watchGeneration; stopHistoryWatch?.(); messageSearch.cancel(); historyReader.close(); window = null; });
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(rendererPath);
  window.show();
  void historyDiscovery.start();
}

function showWindow(): void {
  if (!window || window.isDestroyed() || quitting) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
app.on('activate', showWindow);

async function confirmQuit(): Promise<void> {
  confirmingQuit = true;
  try {
    const { language } = await data.getPreferences();
    const count = runtime.ownedRunningCount();
    if (count > 0) {
      showWindow();
      const options = quitDialogOptions(language, count);
      const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (result.response !== 0) return;
    }
    quitConfirmed = true;
    app.quit();
  } catch (error) {
    dialog.showErrorBox('OMP-Desktop', String(error));
  } finally { confirmingQuit = false; }
}

app.on('before-quit', (event) => {
  if (drained) return;
  event.preventDefault();
  if (quitting) return;
  if (confirmingQuit && !quitConfirmed) return;
  if (!quitConfirmed && lifecycleDecision('quit', process.platform, runtime.ownedRunningCount()) === 'confirm') {
    if (!confirmingQuit) void confirmQuit();
    return;
  }
  quitting = true;
  turnChanges.dispose();
  ++watchGeneration;
  stopHistoryWatch?.();
  listedObserver.close();
  historyDiscovery.close();
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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionResponse, NativeCommand, NativeFrame, NativeModel, NativeState, NativeSubagent, RuntimeEvent, RuntimeShutdownOutcome, RuntimeSourceState, SessionConnection, StartSession } from '../../shared/contracts';
import type { ExecutionContext } from './cli';
import { MAX_LOGICAL_BYTES, NativeFrameDecoder, record } from './framing';
import { NativeResponses } from './responses';
import { signalOwned } from './process';
import { normalizeAgentFrame, settleAgentMessage } from '../../shared/subagent-evidence';

interface Runtime {
  id: string; cwd: string; child: ChildProcessWithoutNullStreams; decoder: NativeFrameDecoder; responses: NativeResponses;
  ready: Promise<void>; readyResolve: () => void; readyReject: (error: Error) => void;
  exited: Promise<void>; exitResolve: () => void; didExit: boolean; sawReady: boolean;
  published: boolean; queue: RuntimeEvent[]; queueBytes: number; writeBytes: number; stderr: Buffer;
  error?: Error; closing?: Promise<RuntimeShutdownOutcome>; closingRequested: boolean; env: NodeJS.ProcessEnv;
  exitCode: number | null; exitSignal?: string; forced: boolean; shutdownError?: string;
  sessionPath?: string; context: ExecutionContext; connection?: SessionConnection; state?: NativeState;
  initialSource?: { sessionId: string; path?: string }; stateRequest: number; sourceObservation: number;
  /** Backend-selected New/fork identity. First persistence keeps it; any identity change revokes it. */
  allocatedSource?: { sessionId: string; path?: string };
  stateApplied?: number; sourceRead?: Promise<void>;
  children?: Map<string, NativeSubagent>;
  activityRevision?: number;
  draftConfig?: string;
}

export class OmpRuntimeService {
  private runtimes = new Map<string, Runtime>();
  private closed = new Map<string, RuntimeShutdownOutcome>();
  constructor(
    private readonly event: (event: RuntimeEvent) => void,
    private readonly historyCursor: (path: string) => Promise<{ sessionId: string; since?: string }>,
    private readonly captureModels?: (models: unknown) => void,
    private readonly presenceExtensionPath = fileURLToPath(new URL('../../../resources/omp-desktop-presence.ts', import.meta.url)),
  ) {}

  async start(options: StartSession, context: ExecutionContext): Promise<SessionConnection> {
    if (options.cwd !== context.cwd) throw new Error('Native execution context does not match the selected workspace');
    if (options.draft && options.sessionPath) throw new Error('A draft cannot resume a saved session');
    // Native --config overlays override autoResume without changing user settings.
    // Unlike the new_session RPC, SDK startup creates a lazy, unpersisted session.
    let draftConfig: string | undefined;
    if (options.draft) {
      draftConfig = await mkdtemp(join(tmpdir(), 'omp-desktop-draft-'));
      try { await writeFile(join(draftConfig, 'config.yml'), 'autoResume: false\n', { mode: 0o600 }); }
      catch (error) { await rm(draftConfig, { recursive: true, force: true }); throw error; }
    }
    const args = [...(context.profile ? ['--profile', context.profile] : []), '--mode', 'rpc-ui', '-e', this.presenceExtensionPath, ...(options.sessionPath ? [options.mode === 'fork' ? '--fork' : '--resume', options.sessionPath] : [])];
    if (draftConfig) args.push('--config', join(draftConfig, 'config.yml'));
    // Piped desktop children must not inherit the launching terminal's breadcrumb identity.
    const env = { ...context.env };
    for (const key of ['ZELLIJ_PANE_ID', 'ZELLIJ_SESSION_NAME', 'TMUX_PANE', 'CMUX_SURFACE_ID', 'KITTY_WINDOW_ID', 'WEZTERM_PANE', 'TERM_SESSION_ID', 'WT_SESSION']) delete env[key];
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const child = spawn(context.executable, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    const runtime: Runtime = { id: randomUUID(), cwd: options.cwd, child, decoder: new NativeFrameDecoder(), responses: new NativeResponses(), ready: ready.promise, readyResolve: ready.resolve, readyReject: ready.reject, exited: exited.promise, exitResolve: exited.resolve, didExit: false, sawReady: false, published: false, queue: [], queueBytes: 0, writeBytes: 0, stderr: Buffer.alloc(0), closingRequested: false, env, context: { ...context, env }, sessionPath: options.mode === 'fork' ? undefined : options.sessionPath, exitCode: null, forced: false, stateRequest: 0, sourceObservation: 0 };
    runtime.draftConfig = draftConfig;
    this.runtimes.set(runtime.id, runtime);
    child.stdout.on('data', (data: Buffer) => {
      if (runtime.error) return;
      try { runtime.decoder.push(data, frame => this.frame(runtime, frame)); }
      catch (error) { this.fail(runtime, error instanceof Error ? error : new Error('Native RPC decode failed')); }
    });
    child.stderr.on('data', (data: Buffer) => {
      const limit = 64 * 1024;
      runtime.stderr = data.length >= limit ? Buffer.from(data.subarray(data.length - limit)) : Buffer.concat([runtime.stderr.subarray(Math.max(0, runtime.stderr.length + data.length - limit)), data]);
    });
    child.stdout.on('end', () => {
      try { runtime.decoder.finish(); }
      catch (error) { this.fail(runtime, error instanceof Error ? error : new Error('Incomplete native RPC output')); return; }
      const error = new Error(`Native RPC stdout closed${this.diagnostic(runtime)}`);
      runtime.responses.terminate(error);
      runtime.readyReject(error);
      if (!runtime.closingRequested) this.fail(runtime, error);
    });
    child.stdout.on('error', () => this.fail(runtime, new Error('Native RPC stdout failed')));
    child.stderr.on('error', () => this.fail(runtime, new Error('Native RPC stderr failed')));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (!runtime.closingRequested) this.fail(runtime, new Error(`Native RPC stdin failed (${error.code ?? 'write error'})`));
    });
    child.on('error', (error: NodeJS.ErrnoException) => this.fail(runtime, new Error(`Unable to launch omp (${error.code ?? 'spawn error'})`)));
    child.on('close', (code, signal) => {
      runtime.didExit = true;
      runtime.exitCode = code;
      runtime.exitSignal = signal ?? undefined;
      const error = runtime.error ?? new Error(`omp exited (${signal ?? `code ${code}`})${this.diagnostic(runtime)}`);
      runtime.readyReject(error);
      runtime.responses.terminate(error);
      runtime.decoder.reset();
      if (code !== 0 && !runtime.error) { runtime.error = error; this.emit(runtime, { runtimeId: runtime.id, kind: 'error', error: error.message }, true); }
      this.emit(runtime, { runtimeId: runtime.id, kind: 'exit', exitCode: code }, true);
      runtime.exitResolve();
    });
    try {
      await runtime.ready;
      const negotiated = await this.request<{ protocolVersion: number }>(runtime.id, { type: 'negotiate_protocol', protocolVersion: 2 });
      if (!record(negotiated) || negotiated.protocolVersion !== 2) throw new Error('Native RPC v2 negotiation failed');
      let state = await this.request<NativeState>(runtime.id, { type: 'get_state' });
      if (!options.sessionPath && !options.draft) {
        const previousId = state.sessionId;
        const fresh = await this.request<{ cancelled: boolean }>(runtime.id, { type: 'new_session' });
        if (!record(fresh) || fresh.cancelled !== false) throw new Error('Native new session was cancelled');
        state = await this.request<NativeState>(runtime.id, { type: 'get_state' });
        if (state.sessionId === previousId) throw new Error('Native new session did not select a fresh identity');
        // Native new_session owns persistence (including its empty journal). Never
        // manufacture a source or classify a missing result as an initial draft.
        runtime.initialSource = { sessionId: state.sessionId, path: runtime.sessionPath };
        runtime.allocatedSource = { sessionId: state.sessionId, path: runtime.sessionPath };
        if (runtime.sessionPath) this.markHistoryPersisted(runtime.id, { sessionId: state.sessionId, path: runtime.sessionPath });
      }
      if (options.draft) {
        runtime.initialSource = { sessionId: state.sessionId, path: runtime.sessionPath };
        runtime.allocatedSource = { ...runtime.initialSource };
      }
      if (options.mode === 'fork' && runtime.sessionPath && runtime.sessionPath !== options.sessionPath) {
        // Native forkFrom atomically writes the fork before launch completes.
        runtime.allocatedSource = { sessionId: state.sessionId, path: runtime.sessionPath };
        this.markHistoryPersisted(runtime.id, { sessionId: state.sessionId, path: runtime.sessionPath });
      }
      const [models, commands, levels] = await Promise.all([
        this.request<{ models: NativeModel[] }>(runtime.id, { type: 'get_available_models' }),
        this.request<{ commands: NativeCommand[] }>(runtime.id, { type: 'get_available_commands' }),
        this.request<{ levels: string[] }>(runtime.id, { type: 'get_available_thinking_levels' }),
      ]);
      if (!record(models) || !Array.isArray(models.models) || !models.models.every(model => record(model) && typeof model.id === 'string' && typeof model.provider === 'string')) throw new Error('Invalid native models response');
      if (!record(commands) || !Array.isArray(commands.commands) || !commands.commands.every(command => record(command) && typeof command.name === 'string')) throw new Error('Invalid native commands response');
      if (!record(levels) || !Array.isArray(levels.levels) || !levels.levels.every(level => typeof level === 'string')) throw new Error('Invalid native thinking levels response');
      const subscription = await this.request<{ level: string }>(runtime.id, { type: 'set_subagent_subscription', level: 'events' });
      if (!record(subscription) || subscription.level !== 'events') throw new Error('Native subagent subscription was not enabled');
      if (runtime.error || runtime.didExit || runtime.closingRequested) throw runtime.error ?? new Error('Native runtime closed during initialization');
      // Publication is scheduled only after source observation completes.
      const source = await this.getSourceState(runtime.id);
      if (runtime.error || runtime.didExit || runtime.closingRequested) throw runtime.error ?? new Error('Native runtime closed during initialization');
      runtime.connection = { runtimeId: runtime.id, cwd: runtime.cwd, state, source, messages: [], models: models.models, commands: commands.commands, thinkingLevels: levels.levels };
      setImmediate(() => {
        runtime.published = true;
        const queue = runtime.queue;
        runtime.queue = [];
        runtime.queueBytes = 0;
        for (const event of queue) this.event(event);
      });
      return runtime.connection;
    } catch (error) {
      const outcome = await this.close(runtime.id);
      if (outcome.error) throw new AggregateError([error, new Error(outcome.error)], `${error instanceof Error ? error.message : String(error)}; shutdown: ${outcome.error}`);
      throw error;
    }
  }

  async submitPrompt(runtimeId: string, command: NativeFrame, expectedSessionId: string, submissionId?: string): Promise<{ requestId: string; data: unknown }> {
    const requestId = `prompt:${randomUUID()}`;
    const runtime = this.get(runtimeId);
    if (runtime.state?.sessionId !== expectedSessionId) throw new Error('Native session changed before prompt submission; original input was not sent');
    this.emit(runtime, { runtimeId, kind: 'submission_started', submission: { submissionId, requestId, sessionId: runtime.state?.sessionId } });
    const data = await this.requestWithId(runtimeId, command, requestId);
    return { requestId, data };
  }
  request<T = unknown>(runtimeId: string, command: NativeFrame): Promise<T> {
    return this.requestWithId<T>(runtimeId, command, `rpc:${randomUUID()}`);
  }
  private async requestWithId<T = unknown>(runtimeId: string, command: NativeFrame, id: string): Promise<T> {
    const runtime = this.get(runtimeId);
    if (runtime.closingRequested || runtime.didExit || runtime.error) return Promise.reject(runtime.error ?? new Error('Native runtime is closed'));
    if (!record(command) || typeof command.type !== 'string' || !command.type || command.type === 'extension_ui_response') return Promise.reject(new Error('Invalid native request; UI replies use the response side channel'));
    if (command.id !== undefined) throw new Error('Native request IDs are host-owned');
    if (command.type === 'set_thinking_level' && (typeof command.level !== 'string' || !command.level.length || command.level.length > 32 || !runtime.connection?.thinkingLevels.includes(command.level))) throw new TypeError('Invalid thinking level');
    const stateRequest = command.type === 'get_state' ? ++runtime.stateRequest : undefined;
    const activityRevision = runtime.activityRevision;
    const response = runtime.responses.register(id, command.type);
    void this.write(runtime, { ...command, id }).catch(error => runtime.responses.reject(id, error instanceof Error ? error : new Error('Native request write failed')));
    const result = await response;
    if (command.type === 'get_available_thinking_levels') {
      if (!record(result) || !Array.isArray(result.levels) || !result.levels.every(level => typeof level === 'string')) throw new Error('Invalid native thinking levels response');
      if (runtime.connection) runtime.connection.thinkingLevels = result.levels;
    }
    if (command.type === 'set_model') {
      const levels = await this.request<{ levels: string[] }>(runtimeId, { type: 'get_available_thinking_levels' });
      this.emit(runtime, { runtimeId, kind: 'frame', frame: { type: 'thinking_levels_snapshot', levels: levels.levels } });
    }
    if (command.type === 'get_available_models' && record(result)) this.captureModels?.(result.models);
    if (command.type === 'get_state' && record(result) && record(result.model)) this.captureModels?.([result.model]);
    if (command.type === 'get_state') {
      if (!record(result) || typeof result.sessionId !== 'string' || !result.sessionId || typeof result.isStreaming !== 'boolean' || (result.sessionFile !== undefined && typeof result.sessionFile !== 'string')) throw new Error('Invalid native session state');
      const path = typeof result.sessionFile === 'string' && result.sessionFile ? await canonicalSessionPath(resolve(runtime.cwd, result.sessionFile)) : undefined;
      if (runtime.closingRequested || runtime.didExit) throw new Error('Native state observation was superseded');
      if (stateRequest! < (runtime.stateApplied ?? 0)) {
        if (runtime.state?.sessionId !== result.sessionId || runtime.sessionPath !== path) throw new Error('Native state observation was superseded');
        // A newer completed read already contains at least this caller's snapshot.
        // Preserve its streaming/queue state instead of publishing an older reply.
        return runtime.state as T;
      }
      runtime.stateApplied = stateRequest;
      if (runtime.state?.sessionId !== result.sessionId) runtime.children?.clear();
      if (runtime.initialSource && (runtime.initialSource.sessionId !== result.sessionId || runtime.initialSource.path !== path)) runtime.initialSource = undefined;
      // A pathless allocation adopts its first durable path; a changed id or path revokes it.
      if (runtime.allocatedSource?.sessionId !== result.sessionId || (runtime.allocatedSource.path !== undefined && runtime.allocatedSource.path !== path)) runtime.allocatedSource = undefined;
      else if (runtime.allocatedSource.path === undefined && path) runtime.allocatedSource = { sessionId: result.sessionId, path };
      if (runtime.state?.sessionId !== result.sessionId || runtime.sessionPath !== path) {
        runtime.sourceObservation++;
        if (runtime.connection) runtime.connection.source = { status: 'unavailable', sessionId: result.sessionId, path, reason: 'Native source identity changed; refresh required' };
      }
      runtime.sessionPath = path;
      const previous = runtime.state;
      runtime.state = result as unknown as NativeState;
      if (previous?.sessionId === runtime.state.sessionId && activityRevision !== runtime.activityRevision) {
        runtime.state = { ...runtime.state, isStreaming: previous.isStreaming, isSettled: previous.isSettled, isCompacting: previous.isCompacting, hasPendingAsyncWork: previous.hasPendingAsyncWork, queuedMessageCount: previous.queuedMessageCount };
      }
      if (runtime.connection) runtime.connection.state = runtime.state;
      return runtime.state as T;
    }
    if (command.type === 'get_subagents') {
      if (!record(result) || !Array.isArray(result.subagents)) throw new Error('Invalid native child roster');
      for (const child of result.subagents) if (record(child) && typeof child.id === 'string') {
        runtime.children ??= new Map();
        const normalized = normalizeAgentFrame(runtime.children.get(child.id), 'snapshot', child);
        if (normalized) runtime.children.set(child.id, normalized);
      }
    }
    return result as T;
  }

  async respond(runtimeId: string, response: ExtensionResponse): Promise<void> {
    const runtime = this.get(runtimeId);
    if (runtime.closingRequested || runtime.didExit || runtime.error) throw runtime.error ?? new Error('Native runtime is closed');
    if (typeof response.id !== 'string' || !response.id || (response.value !== undefined && typeof response.value !== 'string') || (response.confirmed !== undefined && typeof response.confirmed !== 'boolean') || (response.cancelled !== undefined && typeof response.cancelled !== 'boolean') || (response.timedOut !== undefined && typeof response.timedOut !== 'boolean')) throw new Error('Invalid extension UI response');
    await this.write(runtime, { ...response, type: 'extension_ui_response' });
  }

  getCwd(runtimeId: string): string { return this.get(runtimeId).cwd; }

  getContext(runtimeId: string): ExecutionContext { return this.get(runtimeId).context; }
  getSessionPath(runtimeId: string): string | undefined { return this.get(runtimeId).sessionPath; }
  isInitializing(runtimeId: string): boolean { return this.get(runtimeId).connection === undefined; }
  getConnection(runtimeId: string): SessionConnection {
    const connection = this.get(runtimeId).connection;
    if (!connection) throw new Error('Native runtime is still initializing');
    return connection;
  }
  canUseUnpersistedHistory(runtimeId: string): boolean {
    const runtime = this.get(runtimeId);
    return !runtime.didExit && !runtime.closingRequested && !runtime.error && this.isInitialSource(runtime);
  }
  private isInitialSource(runtime: Runtime): boolean {
    return runtime.initialSource !== undefined && runtime.state?.sessionId === runtime.initialSource.sessionId && runtime.sessionPath === runtime.initialSource.path;
  }
  markHistoryPersisted(runtimeId: string, identity: { sessionId: string; path: string }): void {
    const runtime = this.get(runtimeId);
    if (runtime.state?.sessionId !== identity.sessionId || runtime.sessionPath !== identity.path) throw new Error('Native source changed during durable observation');
    runtime.initialSource = undefined;
  }
  getSourceState(runtimeId: string): Promise<RuntimeSourceState> {
    const runtime = this.get(runtimeId);
    // Queue rather than coalesce: a post-mutation caller must perform its own
    // filesystem observation, not reuse a snapshot started before the mutation.
    const observation = (runtime.sourceRead ?? Promise.resolve()).then(() => this.observeSourceState(runtimeId));
    runtime.sourceRead = observation.then(() => {}, () => {});
    return observation;
  }
  private async observeSourceState(runtimeId: string): Promise<RuntimeSourceState> {
    const runtime = this.get(runtimeId);
    const sessionId = runtime.state?.sessionId;
    if (!sessionId) throw new Error('Native source identity is unavailable');
    const path = runtime.sessionPath;
    const observation = runtime.sourceObservation;
    let source: RuntimeSourceState;
    try {
      if (!path) {
        source = this.isInitialSource(runtime) ? { status: 'unpersisted', sessionId } : { status: 'unavailable', sessionId, reason: 'Native source path is unavailable' };
      } else {
        const info = await stat(path);
        // Any observed filesystem source permanently revokes missing-file fallback,
        // even if its contents subsequently fail validation or disappear.
        this.markHistoryPersisted(runtimeId, { sessionId, path });
        if (!info.isFile()) throw new Error('Native source is not a regular file');
        const cursor = await this.historyCursor(path);
        if (cursor.sessionId !== sessionId) throw new Error('Durable source does not match the native session');
        source = { status: 'persisted', sessionId, path };
      }
    } catch (error) {
      source = (error as NodeJS.ErrnoException).code === 'ENOENT' && this.isInitialSource(runtime)
        ? { status: 'unpersisted', sessionId, path }
        : { status: 'unavailable', sessionId, path, reason: error instanceof Error ? error.message : 'Native source is unavailable' };
    }
    if (runtime.state?.sessionId !== sessionId || runtime.sessionPath !== path || observation !== runtime.sourceObservation || (runtime.closingRequested && !this.closed.has(runtimeId))) throw new Error('Native source observation was superseded');
    if (runtime.connection) runtime.connection.source = source;
    return source;
  }
  async getOwnedChildren(runtimeId: string): Promise<{ parentPath: string; sessionId: string; children: NativeSubagent[] }> {
    const state = await this.request<NativeState>(runtimeId, { type: 'get_state' });
    const owner = this.get(runtimeId);
    if (!owner.sessionPath) throw new Error('Owned parent has no durable source identity');
    const parentPath = owner.sessionPath;
    await this.request(runtimeId, { type: 'get_subagents' });
    if (owner.connection?.state.sessionId !== state.sessionId || owner.sessionPath !== parentPath) throw new Error('Native child owner changed');
    return { parentPath, sessionId: state.sessionId, children: [...(owner.children?.values() ?? [])] };
  }
  async getHistoryIdentity(runtimeId: string): Promise<{ sessionId: string; path?: string; leafId: string | null }> {
    const state = await this.request<NativeState>(runtimeId, { type: 'get_state' });
    const path = this.getSessionPath(runtimeId);
    let since: string | undefined;
    if (path) {
      try {
        const cursor = await this.historyCursor(path);
        this.markHistoryPersisted(runtimeId, { sessionId: state.sessionId, path });
        if (cursor.sessionId !== state.sessionId) throw new Error('Durable source does not match the native session');
        since = cursor.since;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !this.canUseUnpersistedHistory(runtimeId)) throw error;
      }
    } else if (!this.canUseUnpersistedHistory(runtimeId)) throw new Error('Durable session path is unavailable');
    // get_tree serializes every historical body and can fail in the native producer.
    // The durable cursor bounds get_entries to the unseen suffix; ONLY its returned
    // leafId selects ancestry, including when the native selection is not the tail.
    const entries = await this.request<{ entries: unknown[]; leafId: string | null }>(runtimeId, { type: 'get_entries', ...(since === undefined ? {} : { since }) });
    if (!record(entries) || !Array.isArray(entries.entries) || (entries.leafId !== null && (typeof entries.leafId !== 'string' || !entries.leafId))) throw new Error('Invalid native history entries identity');
    const current = await this.request<NativeState>(runtimeId, { type: 'get_state' });
    if (current.sessionId !== state.sessionId || this.getSessionPath(runtimeId) !== path) throw new Error('Native session changed while reading its active history branch');
    return { sessionId: state.sessionId, path, leafId: entries.leafId };
  }
  ownedFacts(): { pid: number; sessionPath?: string; runtimeId: string; allocated: boolean }[] {
    return [...this.runtimes.values()].filter(runtime => !runtime.didExit && !runtime.closingRequested && !runtime.error && runtime.child.pid !== undefined)
      .map(runtime => ({ pid: runtime.child.pid!, sessionPath: runtime.sessionPath, runtimeId: runtime.id, allocated: runtime.sessionPath !== undefined && runtime.allocatedSource?.sessionId === runtime.state?.sessionId && runtime.allocatedSource?.path === runtime.sessionPath }));
  }

  /** Count parent sessions once, including their background jobs and live children. */
  ownedRunningCount(): number {
    let count = 0;
    for (const runtime of this.runtimes.values()) {
      if (runtime.didExit || runtime.closingRequested || runtime.error) continue;
      const state = runtime.state;
      let active = !runtime.connection || state?.isStreaming === true || state?.isCompacting === true || state?.hasPendingAsyncWork === true || state?.isSettled === false || (state?.queuedMessageCount ?? 0) > 0;
      if (!active && runtime.children) for (const child of runtime.children.values()) {
        if (!child.historical && ['pending', 'started', 'running'].includes(child.status || String(child.progress?.status ?? ''))) { active = true; break; }
      }
      if (active) count++;
    }
    return count;
  }

  close(runtimeId: string): Promise<RuntimeShutdownOutcome> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) return Promise.resolve(this.closed.get(runtimeId) ?? { clean: false, forced: false, exitCode: null, error: 'Unknown native runtime' });
    runtime.closing ??= this.shutdown(runtime);
    return runtime.closing;
  }
  getShutdownOutcome(runtimeId: string): RuntimeShutdownOutcome | undefined { return this.closed.get(runtimeId); }

  async closeAll(): Promise<void> {
    const results = await Promise.all([...this.runtimes.keys()].filter(id => !this.closed.has(id)).map(id => this.close(id)));
    const errors = results.flatMap(result => result.error ? [new Error(result.error)] : []);
    if (errors.length) throw new AggregateError(errors, 'Some owned omp processes could not be closed');
  }

  private get(id: string): Runtime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error('Unknown native runtime');
    return runtime;
  }

  private frame(runtime: Runtime, frame: NativeFrame): void {
    if (frame.type === 'ready') {
      if (runtime.sawReady) throw new Error('Native runtime sent duplicate readiness');
      runtime.decoder.configure(frame);
      runtime.sawReady = true;
      runtime.readyResolve();
      return;
    }
    if (!runtime.sawReady) throw new Error('Native runtime sent a frame before readiness');
    if (frame.type === 'response') {
      const matched = runtime.responses.accept(frame);
      // Enable synchronously: the next chunk may be in the same stdout data callback.
      if (matched && frame.command === 'negotiate_protocol' && frame.success && record(frame.data) && frame.data.protocolVersion === 2) runtime.decoder.enableV2();
      if (matched) return;
      // Native can send a post-acceptance prompt error response. Preserve it for the UI.
    }
    if (frame.type === 'rpc_frame_error') {
      throw new Error(typeof frame.error === 'string' ? frame.error : 'Native RPC could not deliver a complete frame');
    }
    if (frame.type === 'thinking_levels_snapshot' && runtime.connection && Array.isArray(frame.levels) && frame.levels.every(level => typeof level === 'string')) runtime.connection.thinkingLevels = frame.levels;
    // Keep shutdown decisions current even while the renderer is hidden. An
    // agent_end is only a yield: async jobs may still wake the session again.
    if (runtime.state) {
      let activity: Partial<NativeState> | undefined;
      if (frame.type === 'agent_start' || frame.type === 'turn_start') activity = { isStreaming: true, isSettled: false };
      else if (frame.type === 'agent_end' && frame.isTerminal !== false) activity = { isStreaming: false };
      else if (frame.type === 'session_settled' || (frame.type === 'prompt_result' && frame.sessionSettled === true)) activity = { isStreaming: false, isSettled: true, hasPendingAsyncWork: false, queuedMessageCount: 0 };
      else if (frame.type === 'auto_compaction_start') activity = { isCompacting: true };
      else if (frame.type === 'auto_compaction_end') activity = { isCompacting: false };
      if (activity) {
        runtime.activityRevision = (runtime.activityRevision ?? 0) + 1;
        runtime.state = { ...runtime.state, ...activity };
        if (runtime.connection) runtime.connection.state = runtime.state;
      }
    }
    if (['subagent_lifecycle', 'subagent_progress'].includes(frame.type) && record(frame.payload)) {
      const progress = record(frame.payload.progress) ? frame.payload.progress : {};
      const id = typeof frame.payload.id === 'string' ? frame.payload.id : typeof progress.id === 'string' ? progress.id : undefined;
      if (id) {
        runtime.children ??= new Map();
        const child = normalizeAgentFrame(runtime.children.get(id), frame.type, frame.payload);
        if (child) runtime.children.set(id, child);
      }
    }
    if (runtime.children?.size && (frame.type === 'message_end' || frame.type === 'tool_execution_end')) {
      const message = frame.type === 'message_end' ? frame.message : { ...(record(frame.result) ? frame.result : {}), role: 'toolResult', toolName: frame.toolName, toolCallId: frame.toolCallId };
      for (const child of settleAgentMessage([...runtime.children.values()], message)) runtime.children.set(child.id, child);
    }
    if (frame.type === 'extension_ui_request') frame.receivedAt = Date.now();
    this.emit(runtime, { runtimeId: runtime.id, kind: 'frame', frame }, frame.type === 'extension_ui_request');
  }

  private emit(runtime: Runtime, event: RuntimeEvent, immediate = false): void {
    if (runtime.published || immediate) { this.event(event); return; }
    runtime.queueBytes += Buffer.byteLength(JSON.stringify(event));
    if (runtime.queueBytes > MAX_LOGICAL_BYTES || runtime.queue.length >= 10000) throw new Error('Native startup event queue exceeded its memory limit');
    runtime.queue.push(event);
  }

  private write(runtime: Runtime, frame: NativeFrame): Promise<void> {
    if (!runtime.child.stdin.writable || runtime.didExit) return Promise.reject(new Error('Native RPC stdin is closed'));
    let line: string;
    try { line = `${JSON.stringify(frame)}\n`; } catch { return Promise.reject(new Error('Native request is not serializable')); }
    const bytes = Buffer.byteLength(line);
    // Native stdin accepts ordinary JSONL, not rpc_chunk envelopes.
    if (bytes > MAX_LOGICAL_BYTES || runtime.writeBytes + bytes > MAX_LOGICAL_BYTES) return Promise.reject(new Error('Native request exceeds the desktop write memory limit'));
    runtime.writeBytes += bytes;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    runtime.child.stdin.write(line, error => {
      runtime.writeBytes -= bytes;
      if (error) reject(new Error('Failed to write native RPC request')); else resolve();
    });
    return promise;
  }

  private fail(runtime: Runtime, error: Error): void {
    if (runtime.error) return;
    runtime.error = error;
    runtime.readyReject(error);
    runtime.responses.terminate(error);
    runtime.decoder.reset();
    this.emit(runtime, { runtimeId: runtime.id, kind: 'error', error: error.message }, true);
    void this.close(runtime.id).then(outcome => {
      if (outcome.error && outcome.error !== error.message) this.event({ runtimeId: runtime.id, kind: 'error', error: outcome.error });
    });
  }

  private diagnostic(runtime: Runtime): string {
    let text = runtime.stderr.toString('utf8').trim();
    for (const [key, value] of Object.entries(runtime.env)) {
      if (value && /token|secret|password|credential|api.?key/i.test(key)) text = text.split(value).join('[redacted]');
    }
    text = text.replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[redacted]');
    return text ? `: ${text}` : '';
  }

  private async waitForExit(runtime: Runtime, milliseconds: number): Promise<boolean> {
    if (runtime.didExit) return true;
    const elapsed = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => elapsed.resolve(false), milliseconds);
    try { return await Promise.race([runtime.exited.then(() => true), elapsed.promise]); }
    finally { clearTimeout(timer); }
  }

  private async shutdown(runtime: Runtime): Promise<RuntimeShutdownOutcome> {
    runtime.closingRequested = true;
    runtime.responses.terminate(new Error('Native runtime is closing'));
    runtime.readyReject(new Error('Native runtime is closing'));
    let abort: Promise<void> | undefined;
    try {
      if (!runtime.didExit && runtime.child.stdin.writable) {
        // EOF cancels native UI waits and drains accepted work, children and jobs.
        // Do not await an ACK from a serial command that may itself await UI.
        abort = this.write(runtime, { id: randomUUID(), type: 'abort' }).catch(error => {
          runtime.shutdownError = error instanceof Error ? error.message : 'Native abort could not be sent';
          this.event({ runtimeId: runtime.id, kind: 'error', error: runtime.shutdownError });
        });
        runtime.child.stdin.end();
      }
      if (!(await this.waitForExit(runtime, 5000))) {
        runtime.forced = true;
        signalOwned(runtime.child, 'SIGTERM');
        if (!(await this.waitForExit(runtime, 2000))) {
          signalOwned(runtime.child, 'SIGKILL');
          if (!(await this.waitForExit(runtime, 2000))) throw new Error('Owned omp process did not exit after forced termination');
        }
      }
      await abort;
      if (runtime.draftConfig) { await rm(runtime.draftConfig, { recursive: true, force: true }); runtime.draftConfig = undefined; }
    } catch (error) {
      runtime.shutdownError = error instanceof Error ? error.message : 'Owned native process shutdown failed';
    }
    const error = runtime.shutdownError ?? runtime.error?.message;
    const outcome: RuntimeShutdownOutcome = { clean: runtime.didExit && runtime.exitCode === 0 && !runtime.exitSignal && !runtime.forced && !error, forced: runtime.forced, exitCode: runtime.exitCode, ...(runtime.exitSignal ? { signal: runtime.exitSignal } : {}), ...(error ? { error } : {}) };
    runtime.queue = [];
    runtime.queueBytes = 0;
    runtime.children?.clear();
    // Keep the trusted identity and outcome for closed-row removal admission.
    this.closed.set(runtime.id, outcome);
    return outcome;
  }
}

/** New native sessions have a path before their first persisted message. */
export async function canonicalSessionPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(await canonicalSessionPath(dirname(path)), basename(path));
  }
}

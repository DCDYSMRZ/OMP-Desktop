import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import type { ExtensionResponse, NativeCommand, NativeFrame, NativeModel, NativeState, RuntimeEvent, SessionConnection, StartSession } from '../../shared/contracts';
import type { ExecutionContext } from './cli';
import { MAX_LOGICAL_BYTES, NativeFrameDecoder, record } from './framing';
import { NativeResponses } from './responses';
import { signalOwned } from './process';

interface Runtime {
  id: string; cwd: string; child: ChildProcessWithoutNullStreams; decoder: NativeFrameDecoder; responses: NativeResponses;
  ready: Promise<void>; readyResolve: () => void; readyReject: (error: Error) => void;
  exited: Promise<void>; exitResolve: () => void; didExit: boolean; sawReady: boolean;
  published: boolean; queue: RuntimeEvent[]; queueBytes: number; writeBytes: number; stderr: Buffer;
  error?: Error; closing?: Promise<void>; closingRequested: boolean; env: NodeJS.ProcessEnv;
  sessionPath?: string; context: ExecutionContext; connection?: SessionConnection;
  unpersistedSessionId?: string; initialNewSession: boolean;
  allocatedSession?: { id: string; path: string };
}

export class OmpRuntimeService {
  private runtimes = new Map<string, Runtime>();
  constructor(private readonly event: (event: RuntimeEvent) => void) {}

  async start(options: StartSession, context: ExecutionContext): Promise<SessionConnection> {
    if (options.cwd !== context.cwd) throw new Error('Native execution context does not match the selected workspace');
    const args = [...(context.profile ? ['--profile', context.profile] : []), '--mode', 'rpc-ui', ...(options.sessionPath ? [options.mode === 'fork' ? '--fork' : '--resume', options.sessionPath] : [])];
    // Piped desktop children must not inherit the launching terminal's breadcrumb identity.
    const env = { ...context.env };
    for (const key of ['ZELLIJ_PANE_ID', 'ZELLIJ_SESSION_NAME', 'TMUX_PANE', 'CMUX_SURFACE_ID', 'KITTY_WINDOW_ID', 'WEZTERM_PANE', 'TERM_SESSION_ID', 'WT_SESSION']) delete env[key];
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const child = spawn(context.executable, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    const runtime: Runtime = { id: randomUUID(), cwd: options.cwd, child, decoder: new NativeFrameDecoder(), responses: new NativeResponses(), ready: ready.promise, readyResolve: ready.resolve, readyReject: ready.reject, exited: exited.promise, exitResolve: exited.resolve, didExit: false, sawReady: false, published: false, queue: [], queueBytes: 0, writeBytes: 0, stderr: Buffer.alloc(0), closingRequested: false, env, context: { ...context, env }, sessionPath: options.mode === 'fork' ? undefined : options.sessionPath, initialNewSession: !options.sessionPath };
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
      const error = runtime.error ?? new Error(`omp exited (${signal ?? `code ${code}`})${this.diagnostic(runtime)}`);
      runtime.readyReject(error);
      runtime.responses.terminate(error);
      runtime.decoder.reset();
      if (code !== 0 && !runtime.error) this.emit(runtime, { runtimeId: runtime.id, kind: 'error', error: error.message }, true);
      this.emit(runtime, { runtimeId: runtime.id, kind: 'exit', exitCode: code }, true);
      runtime.exitResolve();
    });
    try {
      await runtime.ready;
      const negotiated = await this.request<{ protocolVersion: number }>(runtime.id, { type: 'negotiate_protocol', protocolVersion: 2 });
      if (!record(negotiated) || negotiated.protocolVersion !== 2) throw new Error('Native RPC v2 negotiation failed');
      const state = await this.request<NativeState>(runtime.id, { type: 'get_state' });
      if (!record(state) || typeof state.sessionId !== 'string' || typeof state.isStreaming !== 'boolean') throw new Error('Invalid native session state');
      if (runtime.initialNewSession) runtime.unpersistedSessionId = state.sessionId;
      if ((!options.sessionPath || options.mode === 'fork') && runtime.sessionPath && runtime.sessionPath !== options.sessionPath) {
        runtime.allocatedSession = { id: state.sessionId, path: runtime.sessionPath };
      }
      const models = await this.request<{ models: NativeModel[] }>(runtime.id, { type: 'get_available_models' });
      const commands = await this.request<{ commands: NativeCommand[] }>(runtime.id, { type: 'get_available_commands' });
      const levels = await this.request<{ levels: string[] }>(runtime.id, { type: 'get_available_thinking_levels' });
      if (!record(models) || !Array.isArray(models.models) || !models.models.every(model => record(model) && typeof model.id === 'string' && typeof model.provider === 'string')) throw new Error('Invalid native models response');
      if (!record(commands) || !Array.isArray(commands.commands) || !commands.commands.every(command => record(command) && typeof command.name === 'string')) throw new Error('Invalid native commands response');
      if (!record(levels) || !Array.isArray(levels.levels) || !levels.levels.every(level => typeof level === 'string')) throw new Error('Invalid native thinking levels response');
      const subscription = await this.request<{ level: string }>(runtime.id, { type: 'set_subagent_subscription', level: 'events' });
      if (!record(subscription) || subscription.level !== 'events') throw new Error('Native subagent subscription was not enabled');
      if (runtime.error || runtime.didExit || runtime.closingRequested) throw runtime.error ?? new Error('Native runtime closed during initialization');
      setImmediate(() => {
        runtime.published = true;
        const queue = runtime.queue;
        runtime.queue = [];
        runtime.queueBytes = 0;
        for (const event of queue) this.event(event);
      });
      runtime.connection = { runtimeId: runtime.id, cwd: runtime.cwd, state, messages: [], models: models.models, commands: commands.commands, thinkingLevels: levels.levels };
      return runtime.connection;
    } catch (error) {
      try { await this.close(runtime.id); }
      catch (closeError) { throw new AggregateError([error, closeError], 'Native initialization and shutdown failed'); }
      throw error;
    }
  }

  async request<T = unknown>(runtimeId: string, command: NativeFrame): Promise<T> {
    const runtime = this.get(runtimeId);
    if (runtime.closingRequested || runtime.didExit || runtime.error) return Promise.reject(runtime.error ?? new Error('Native runtime is closed'));
    if (!record(command) || typeof command.type !== 'string' || !command.type || command.type === 'extension_ui_response') return Promise.reject(new Error('Invalid native request; UI replies use the response side channel'));
    if (command.id !== undefined && (typeof command.id !== 'string' || !command.id || command.id.length > 128)) throw new Error('Invalid native request ID');
    const id = typeof command.id === 'string' ? command.id : randomUUID();
    const response = runtime.responses.register(id, command.type);
    void this.write(runtime, { ...command, id }).catch(error => runtime.responses.reject(id, error instanceof Error ? error : new Error('Native request write failed')));
    const result = await response;
    if (command.type === 'get_state') {
      if (!record(result) || typeof result.sessionId !== 'string' || typeof result.isStreaming !== 'boolean' || (result.sessionFile !== undefined && typeof result.sessionFile !== 'string')) throw new Error('Invalid native session state');
      const path = typeof result.sessionFile === 'string' && result.sessionFile ? resolve(runtime.cwd, result.sessionFile) : undefined;
      runtime.sessionPath = path ? await canonicalSessionPath(path) : undefined;
      // Desktop DTO identity must match grants/history, including before the first journal write.
      result.sessionFile = runtime.sessionPath;
      if (runtime.allocatedSession && (runtime.allocatedSession.id !== result.sessionId || runtime.allocatedSession.path !== runtime.sessionPath)) runtime.allocatedSession = undefined;
      if (runtime.connection) runtime.connection.state = result as unknown as NativeState;
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
    return runtime.unpersistedSessionId !== undefined && runtime.connection?.state.sessionId === runtime.unpersistedSessionId;
  }
  markHistoryPersisted(runtimeId: string): void { this.get(runtimeId).unpersistedSessionId = undefined; }
  async getHistoryIdentity(runtimeId: string): Promise<{ path?: string; leafId: string | null }> {
    const state = await this.request<NativeState>(runtimeId, { type: 'get_state' });
    const path = this.getSessionPath(runtimeId);
    const tree = await this.request<{ tree: unknown[]; leafId: string | null }>(runtimeId, { type: 'get_tree' });
    if (!record(tree) || !Array.isArray(tree.tree) || (tree.leafId !== null && (typeof tree.leafId !== 'string' || !tree.leafId))) throw new Error('Invalid native history tree identity');
    const current = await this.request<NativeState>(runtimeId, { type: 'get_state' });
    if (current.sessionId !== state.sessionId || this.getSessionPath(runtimeId) !== path) throw new Error('Native session changed while reading its active history branch');
    return { path, leafId: tree.leafId };
  }
  ownedFacts(): { pid: number; sessionPath?: string; runtimeId: string; allocated: boolean }[] {
    return [...this.runtimes.values()].filter(runtime => !runtime.didExit && !runtime.closingRequested && !runtime.error && runtime.child.pid !== undefined)
      .map(runtime => ({ pid: runtime.child.pid!, sessionPath: runtime.sessionPath, runtimeId: runtime.id, allocated: runtime.allocatedSession !== undefined }));
  }

  close(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) return Promise.resolve();
    runtime.closing ??= this.shutdown(runtime);
    return runtime.closing;
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.runtimes.keys()].map(id => this.close(id)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
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
    void this.close(runtime.id).catch(closeError => this.event({ runtimeId: runtime.id, kind: 'error', error: closeError instanceof Error ? closeError.message : 'Owned native process shutdown failed' }));
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

  private async shutdown(runtime: Runtime): Promise<void> {
    runtime.closingRequested = true;
    runtime.responses.terminate(new Error('Native runtime is closing'));
    runtime.readyReject(new Error('Native runtime is closing'));
    if (!runtime.didExit && runtime.child.stdin.writable) {
      // Do not wait for abort ACK: a serial native command may itself await UI.
      // EOF cancels native UI waits and lets accepted work drain.
      void this.write(runtime, { id: randomUUID(), type: 'abort' }).catch(error => {
        if (!runtime.didExit) this.event({ runtimeId: runtime.id, kind: 'error', error: error instanceof Error ? error.message : 'Native abort could not be sent' });
      });
      runtime.child.stdin.end();
    }
    if (!(await this.waitForExit(runtime, 5000))) {
      signalOwned(runtime.child, 'SIGTERM');
      if (!(await this.waitForExit(runtime, 2000))) {
        signalOwned(runtime.child, 'SIGKILL');
        if (!(await this.waitForExit(runtime, 2000))) throw new Error('Owned omp process did not exit after forced termination');
      }
    }
    runtime.queue = [];
    runtime.queueBytes = 0;
    this.runtimes.delete(runtime.id);
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

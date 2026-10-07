// omp-desktop-presence v1.0.0 (managed by OMP-Desktop)
// One transport per process; only its originating module rebinds child APIs.
// A second installed/-e module registers nothing, so one session never emits twice.
// Overlong socket addresses use /tmp/omp-presence-<uid>/ (owned directory, 0700).
// Consumers scan both directories; locks and logs always remain under the omp home.
import { constants } from 'node:fs';
import { mkdir, open, realpath, readdir, chmod, lstat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PRESENCE_EXTENSION_VERSION = '1.0.0';
const KEY = Symbol.for('omp-desktop-presence');
const MODULE = {};
interface Presence { module: object; register(api: API): void }
const LIMIT = 1024 * 1024;
interface Context {
  sessionManager: { getSessionFile(): string | undefined; getSessionId(): string };
  cwd: string; mode: string; agent: { kind: string; id: string; name: string; depth: number; parentId?: string };
  model?: { provider: string; id: string }; getContextUsage(): unknown; isIdle(): boolean;
}
interface Event { type: string; willContinue?: boolean; toolCallId?: string; toolName?: string; isError?: boolean; message?: { id?: string }; assistantMessageEvent?: { type: string; delta?: string } }
interface API { on(name: string, handler: (event: Event, ctx: Context) => void): void }
interface Entry {
  sessionFile: string | null; sessionId: string; cwd: string; agent: Context['agent']; state: 'idle' | 'running'; since: number;
  requestStartedAt?: number; currentTool?: { toolCallId: string; name: string; startedAt: number }; model?: Context['model']; contextUsage?: unknown;
}
interface Tracked { value: Entry; ctx: Context; handle?: FileHandle; acquiring?: Promise<void>; persistenceCheck?: NodeJS.Timeout; awaitingFile?: boolean; active: boolean }
interface Client { socket: Socket; input: string; subscription?: string }

function createPresence(): Presence {
  const root = join(process.env.HOME || homedir(), process.env.PI_CONFIG_DIR || process.env.OMP_CONFIG_DIR || '.omp', 'run', 'omp-desktop-presence', 'v1');
  const locks = join(root, 'sessions');
  const processStartMs = Math.round(Date.now() - process.uptime() * 1000);
  const socketName = `${process.pid}-${processStartMs}.sock`;
  let procs = join(root, 'procs');
  if (Buffer.byteLength(join(procs, socketName)) > (process.platform === 'darwin' ? 103 : 107)) {
    if (!process.getuid) throw new Error('A uid is required for the short presence socket directory');
    procs = join('/tmp', `omp-presence-${process.getuid()}`);
  }
  const socketPath = join(procs, socketName);
  const sessions = new Map<object, Tracked>(), clients = new Set<Client>();
  const owners = new WeakMap<object, API>(), apis = new WeakSet<API>();
  let mode = 'tui', stopped = false, debugBytes = 0;
  let debugQueue = Promise.resolve();
  function debug(error: unknown) {
    if (debugBytes >= 16384) return;
    const line = `${new Date().toISOString()} ${String(error).slice(0, 512)}\n`;
    debugBytes += Buffer.byteLength(line);
    debugQueue = debugQueue.then(async () => { await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(join(root, `${process.pid}-${processStartMs}.log`), line, { flag: 'a', mode: 0o600 }); }).catch(() => {});
  }
  function send(client: Client, data: unknown) {
    try {
      const line = JSON.stringify(data) + '\n';
      if (client.socket.writableLength + Buffer.byteLength(line) > LIMIT) { client.socket.destroy(); return; }
      client.socket.write(line);
    } catch (error) { client.socket.destroy(); debug(error); }
  }
  function publish(path: string | null, event: object) {
    if (path) for (const client of clients) if (client.subscription === path) send(client, event);
  }
  function state(entry: Tracked) { publish(entry.value.sessionFile, { event: 'state', ...entry.value }); }
  async function acquire(entry: Tracked) {
    if (entry.handle || entry.acquiring || !entry.active || stopped) return;
    entry.acquiring = (async () => {
      const path = entry.ctx.sessionManager.getSessionFile();
      if (!path) return;
      let canonical: string;
      try { canonical = await realpath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') debug(error); return; }
      if (!entry.active || stopped) return;
      entry.value.sessionFile = canonical;
      entry.awaitingFile = false;
      if (entry.persistenceCheck) { clearTimeout(entry.persistenceCheck); entry.persistenceCheck = undefined; }
      if (process.platform !== 'darwin') return; // Never advertise an unlocked holder on unsupported kernels.
      await mkdir(locks, { recursive: true, mode: 0o700 });
      const lock = join(locks, createHash('sha256').update(canonical).digest('hex') + '.lock');
      for (let attempt = 0; attempt < 6 && entry.active && !stopped; attempt++) {
        try {
          const handle = await open(lock, constants.O_CREAT | constants.O_RDWR | 0x10 | 0x4 | 0x01000000, 0o600);
          if (!entry.active || stopped) await handle.close(); else { entry.handle = handle; state(entry); }
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw error;
          if (attempt === 5) throw error;
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, 10); timer.unref(); });
        }
      }
    })().catch(debug).finally(() => {
      entry.acquiring = undefined;
      // Native first persistence can finish after the final message/agent event.
      // One unref timer per pending session observes that edge without writing a journal.
      // Unsent sessions never start this check; a lock, switch or shutdown ends it.
      if (entry.awaitingFile && !entry.value.sessionFile && entry.active && !stopped && !entry.persistenceCheck) {
        entry.persistenceCheck = setTimeout(() => { entry.persistenceCheck = undefined; void acquire(entry); }, 250);
        entry.persistenceCheck.unref();
      }
    });
  }
  function release(entry: Tracked) {
    entry.active = false;
    if (entry.persistenceCheck) { clearTimeout(entry.persistenceCheck); entry.persistenceCheck = undefined; }
    if (entry.handle) { void entry.handle.close().catch(debug); entry.handle = undefined; }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const entry of sessions.values()) release(entry);
    sessions.clear();
    for (const client of clients) client.socket.destroy();
    server.close();
    void unlink(socketPath).catch(() => {});
  }
  function request(client: Client, line: string) {
    try {
      const req = JSON.parse(line);
      if (!req || typeof req !== 'object') { client.socket.destroy(); return; }
      const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
      if (req.type === 'hello') send(client, { id, ok: true, protocol: 1, extensionVersion: PRESENCE_EXTENSION_VERSION, pid: process.pid, processStartMs, mode });
      else if (req.type === 'status') send(client, { id, ok: true, sessions: [...sessions.values()].filter(entry => entry.active).map(entry => entry.value) });
      else if (req.type === 'subscribe' && typeof req.sessionFile === 'string' && req.sessionFile.length <= 4096) {
        client.subscription = req.sessionFile;
        send(client, { id, ok: true });
        for (const entry of sessions.values()) if (entry.active && entry.value.sessionFile === client.subscription) send(client, { event: 'state', ...entry.value });
      } else send(client, { id, ok: false, error: 'Unknown presence request' });
    } catch { client.socket.destroy(); }
  }
  const server = createServer(socket => {
    const client: Client = { socket, input: '' };
    clients.add(client); socket.unref(); socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clients.delete(client));
    socket.on('data', (data: string) => {
      try {
        if (Buffer.byteLength(client.input) + Buffer.byteLength(data) > LIMIT) { socket.destroy(); return; }
        client.input += data;
        let end: number;
        while ((end = client.input.indexOf('\n')) >= 0 && !socket.destroyed) {
          const line = client.input.slice(0, end); client.input = client.input.slice(end + 1); request(client, line);
        }
      } catch (error) { socket.destroy(); debug(error); }
    });
  });
  server.on('error', debug);
  server.unref();
  void (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(procs, { recursive: true, mode: 0o700 });
    const directory = await lstat(procs);
    if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) throw new Error('Presence socket directory must be owned by the current uid and must not be a symlink');
    await chmod(root, 0o700); await chmod(procs, 0o700);
    if (stopped) return;
    server.listen(socketPath, () => { server.unref(); void chmod(socketPath, 0o600).catch(debug); });
    for (const name of (await readdir(procs)).slice(0, 256)) {
      if (!/^\d+-\d+\.sock$/.test(name) || name === `${process.pid}-${processStartMs}.sock`) continue;
      const path = join(procs, name), probe = createConnection(path);
      probe.unref(); probe.setTimeout(150, () => probe.destroy());
      probe.on('connect', () => probe.destroy());
      probe.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') void unlink(path).catch(() => {}); probe.destroy(); });
    }
  })().catch(debug);
  function handle(api: API, event: Event, ctx: Context) {
    try {
      if (stopped) return;
      const key = ctx.sessionManager;
      const owner = owners.get(key);
      if (owner && owner !== api) return;
      owners.set(key, api);
      if (ctx.agent.kind === 'main') mode = ctx.mode;
      let entry = sessions.get(key);
      if (event.type === 'session_shutdown') {
        if (ctx.agent.kind === 'main') stop();
        else if (entry) { release(entry); sessions.delete(key); }
        return;
      }
      if (entry && (event.type === 'session_switch' || entry.value.sessionId !== ctx.sessionManager.getSessionId())) {
        publish(entry.value.sessionFile, { event: 'switch', from: entry.value.sessionFile, to: ctx.sessionManager.getSessionFile() || null });
        release(entry); sessions.delete(key); entry = undefined;
      }
      if (!entry) {
        entry = { ctx, active: true, value: { sessionFile: null, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, agent: { ...ctx.agent }, state: ctx.isIdle() ? 'idle' : 'running', since: Date.now() } };
        sessions.set(key, entry);
      }
      entry.ctx = ctx;
      const value = entry.value;
      value.model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
      if (event.type !== 'message_update') value.contextUsage = ctx.getContextUsage();
      if (event.type === 'agent_start' || event.type === 'turn_start') {
        if (value.state !== 'running') value.since = Date.now();
        value.state = 'running'; value.requestStartedAt ??= Date.now();
      }
      if (event.type === 'agent_end' && !event.willContinue) {
        value.state = 'idle'; value.since = Date.now(); delete value.requestStartedAt; delete value.currentTool;
      }
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        const phase = event.type === 'tool_execution_start' ? 'start' : 'end';
        if (phase === 'start') value.currentTool = { toolCallId: event.toolCallId!, name: event.toolName!, startedAt: Date.now() };
        else if (value.currentTool?.toolCallId === event.toolCallId) delete value.currentTool;
        publish(value.sessionFile, { event: 'tool', phase, toolCallId: event.toolCallId, name: event.toolName, ...(phase === 'end' ? { isError: event.isError } : {}) });
      }
      if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent;
        if ((delta?.type === 'text_delta' || delta?.type === 'thinking_delta') && typeof delta.delta === 'string') publish(value.sessionFile, { event: 'delta', messageId: event.message?.id, kind: delta.type === 'text_delta' ? 'text' : 'thinking', text: delta.delta });
      } else {
        if (event.type === 'message_end' || event.type === 'turn_end') entry.awaitingFile = true;
        if (event.type === 'message_end') publish(value.sessionFile, { event: 'message_end', messageId: event.message?.id });
        if (event.type === 'turn_end') publish(value.sessionFile, { event: 'turn_end' });
        state(entry); void acquire(entry);
      }
      if (event.type === 'agent_end' && !event.willContinue && ctx.agent.kind === 'sub') { release(entry); sessions.delete(key); }
    } catch (error) { debug(error); }
  }
  return { module: MODULE, register(api: API) {
    if (apis.has(api)) return;
    apis.add(api);
    for (const name of ['session_start', 'session_switch', 'session_shutdown', 'agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_end']) api.on(name, (event, ctx) => handle(api, event, ctx));
  } };
}

export default function presence(api: API): void {
  try {
    const global = globalThis as typeof globalThis & { [KEY]?: Presence };
    const transport = global[KEY] ??= createPresence();
    if (transport.module === MODULE) transport.register(api);
  } catch { /* Presence must never interfere with omp startup or its state. */ }
}

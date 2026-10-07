import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, lstat, writeFile, readdir, rm, realpath, copyFile } from 'node:fs/promises';
import { openSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import presence from '../../resources/omp-desktop-presence';
import { pathToFileURL } from 'node:url';

// Factory integration uses fake read-only omp contexts and real OS transport/locks.
for (const longHome of [false, true]) test(`factory owns locks, children, late persistence and bounded protocol (${longHome ? 'long home fallback' : 'preferred socket'})`, { skip: process.platform !== 'darwin' }, async () => {
  const base = await mkdtemp('/tmp/pe-');
  const home = longHome ? join(base, 'long-home-'.repeat(12)) : base;
  await mkdir(home, { recursive: true });
  const oldHome = process.env.HOME; process.env.HOME = home;
  const key = Symbol.for('omp-desktop-presence');
  type Handler = Parameters<Parameters<typeof presence>[0]['on']>[1];
  const events = new Map<string, Handler>();
  const api = { on(name: string, handler: Handler) { assert.equal(events.has(name), false); events.set(name, handler); } };
  const ctx = { sessionManager: { getSessionFile: () => path, getSessionId: () => id }, agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 }, cwd: home, mode: 'rpc', isIdle: () => true, getContextUsage: () => ({ tokens: 9 }) };
  let path = join(home, 'first.jsonl'), id = 'one';
  const emit = (type: string, extra = {}, context = ctx) => events.get(type)!({ type, ...extra }, context);
  // Real kernel locks and socket readiness cannot be advanced with fake timers.
  const delay = () => { const pending = Promise.withResolvers<void>(); setTimeout(pending.resolve, 15); return pending.promise; };
  async function until(predicate: () => Promise<boolean> | boolean) { for (let i = 0; i < 150; i++) { if (await predicate()) return; await delay(); } throw new Error('Presence condition timed out'); }
  const lockPath = (file: string) => join(home, '.omp/run/omp-desktop-presence/v1/sessions', createHash('sha256').update(file).digest('hex') + '.lock');
  function held(file: string) { try { const fd = openSync(lockPath(file), constants.O_CREAT | constants.O_RDWR | 0x20 | 0x4, 0o600); closeSync(fd); return false; } catch (error) { return ['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code!); } }
  const sockets: Socket[] = [];
  try {
    await writeFile(path, '{}\n'); path = await realpath(path);
    presence(api); presence(api); emit('session_start');
    const duplicate = join(home, 'duplicate.ts');
    await copyFile(new URL('../../resources/omp-desktop-presence.ts', import.meta.url), duplicate);
    const duplicateModule = await import(pathToFileURL(duplicate).href);
    let duplicateSubscriptions = 0;
    duplicateModule.default({ on() { duplicateSubscriptions++; } });
    assert.equal(duplicateSubscriptions, 0);
    await until(() => held(path));
    const directory = longHome ? `/tmp/omp-presence-${process.getuid!()}` : join(home, '.omp/run/omp-desktop-presence/v1/procs');
    let socketPath = '';
    await until(async () => { socketPath = join(directory, (await readdir(directory)).find(name => name.startsWith(`${process.pid}-`) && name.endsWith('.sock')) || 'missing'); return !socketPath.endsWith('missing'); });
    const directoryStat = await lstat(directory);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.equal(directoryStat.uid, process.getuid!());
    const socket = createConnection(socketPath); sockets.push(socket);
    const messages: { id?: number; mode?: string; event?: string; sessions: { sessionId: string; state: string }[] }[] = []; let input = '';
    socket.setEncoding('utf8'); socket.on('data', text => { input += text; let end; while ((end = input.indexOf('\n')) >= 0) { messages.push(JSON.parse(input.slice(0, end))); input = input.slice(end + 1); } });
    socket.write(JSON.stringify({ id: 1, type: 'hello' }) + '\n' + JSON.stringify({ id: 2, type: 'status' }) + '\n' + JSON.stringify({ id: 3, type: 'subscribe', sessionFile: path }) + '\n');
    await until(() => messages.some(message => message.id === 3));
    assert.equal(messages.find(message => message.id === 1)?.mode, 'rpc');
    assert.equal(messages.find(message => message.id === 2)?.sessions[0].sessionId, 'one');
    emit('agent_start'); emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
    emit('tool_execution_start', { toolCallId: 'tool', toolName: 'read', args: { secret: 'never sent' } });
    emit('tool_execution_end', { toolCallId: 'tool', toolName: 'read', isError: false }); emit('message_end'); emit('turn_end');
    await until(() => messages.some(message => message.event === 'turn_end'));
    assert.deepEqual(messages.find(message => message.event === 'delta'), { event: 'delta', kind: 'text', text: 'hello' });
    assert.equal(JSON.stringify(messages).includes('never sent'), false);
    emit('agent_end', { willContinue: true }); socket.write('{"id":4,"type":"status"}\n');
    await until(() => messages.some(message => message.id === 4));
    assert.equal(messages.find(message => message.id === 4)?.sessions[0].state, 'running');
    let childFile = join(home, 'child.jsonl'); await writeFile(childFile, '{}\n'); childFile = await realpath(childFile);
    const child = { ...ctx, sessionManager: { getSessionFile: () => childFile, getSessionId: () => 'child' }, agent: { kind: 'sub', id: 'child', name: 'task', depth: 1 } };
    const childEvents = new Map<string, Handler>();
    presence({ on(name, handler) { childEvents.set(name, handler); } });
    childEvents.get('agent_start')!({ type: 'agent_start' }, child); await until(() => held(childFile));
    childEvents.get('agent_end')!({ type: 'agent_end' }, child); await until(() => !held(childFile));
    const first = path; path = join(home, 'late.jsonl'); id = 'late'; emit('session_switch');
    await until(() => !held(first));
    assert.equal((await readdir(home)).includes('late.jsonl'), false);
    emit('message_end'); emit('turn_end'); emit('agent_end');
    // Native first flush may become visible only after all final event handlers return.
    await delay(); await writeFile(path, '{}\n'); path = await realpath(path);
    await until(() => held(path));
    const overflow = createConnection(socketPath); sockets.push(overflow); overflow.on('error', () => {}); overflow.resume();
    overflow.write('x'.repeat(1024 * 1024 + 1)); await until(() => overflow.destroyed);
    socket.write(JSON.stringify({ id: 5, type: 'subscribe', sessionFile: path }) + '\n'); await until(() => messages.some(message => message.id === 5));
    emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(1024 * 1024) } }); await until(() => socket.destroyed);
    emit('session_shutdown'); await until(() => !held(path));
  } finally {
    emit('session_shutdown'); for (const socket of sockets) socket.destroy();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    Reflect.deleteProperty(globalThis, key); await delay(); await rm(base, { recursive: true, force: true });
  }
});

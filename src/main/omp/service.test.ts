import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeFrame, NativeState, StartSession } from '../../shared/contracts';
import { OmpRuntimeService } from './service';
import { NativeResponseError } from './responses';

/** Native replies are independent of the durable cursor and may select any branch. */
class HistoryRuntime extends OmpRuntimeService {
  path: string | undefined = '/session.jsonl';
  states = ['session', 'session'];
  reply: unknown = { entries: [], leafId: 'selected-older-branch' };
  failure?: Error;
  pathAfterEntries?: string;
  unpersisted = false;
  persisted = false;
  constructor(cursor: () => Promise<{ sessionId: string; since?: string }> = async () => ({ sessionId: 'session', since: 'disk-tail' })) { super(() => {}, cursor); }
  override getSessionPath(): string | undefined { return this.path; }
  override canUseUnpersistedHistory(): boolean { return this.unpersisted && !this.persisted; }
  override markHistoryPersisted(): void { this.persisted = true; }
  override async request<T = unknown>(_id: string, command: NativeFrame): Promise<T> {
    if (command.type === 'get_state') return { sessionId: this.states.shift() } as T;
    if (command.type !== 'get_entries') throw new Error('Whole-tree transport is unavailable');
    if (this.failure) throw this.failure;
    if (this.pathAfterEntries) this.path = this.pathAfterEntries;
    return this.reply as T;
  }
}

test('native selection, including null, never follows the durable transport cursor', async () => {
  const runtime = new HistoryRuntime();
  assert.deepEqual(await runtime.getHistoryIdentity('owned'), { sessionId: 'session', path: '/session.jsonl', leafId: 'selected-older-branch' });
  runtime.states = ['session', 'session'];
  runtime.reply = { entries: [{ id: 'another-tail' }], leafId: null };
  assert.deepEqual(await runtime.getHistoryIdentity('owned'), { sessionId: 'session', path: '/session.jsonl', leafId: null });
});

test('source identity and native session changes cannot publish an unrelated branch', async () => {
  const foreign = new HistoryRuntime(async () => ({ sessionId: 'foreign', since: 'disk-tail' }));
  await assert.rejects(foreign.getHistoryIdentity('owned'), /does not match/);
  const changed = new HistoryRuntime();
  changed.states = ['session', 'changed'];
  await assert.rejects(changed.getHistoryIdentity('owned'), /session changed/);
  const moved = new HistoryRuntime();
  moved.pathAfterEntries = '/different-session.jsonl';
  await assert.rejects(moved.getHistoryIdentity('owned'), /session changed/);
  const invalid = new HistoryRuntime();
  invalid.reply = { entries: [], leafId: '' };
  await assert.rejects(invalid.getHistoryIdentity('owned'), /Invalid native history/);
});

test('native cursor rejection propagates without falling back to disk selection', async () => {
  const runtime = new HistoryRuntime();
  const failure = new NativeResponseError('Unknown entries cursor', 'get_entries', 'unknown_since');
  runtime.failure = failure;
  await assert.rejects(runtime.getHistoryIdentity('owned'), error => error === failure);
});

test('missing durable history is allowed only before initial session persistence', async () => {
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const runtime = new HistoryRuntime(async () => { throw missing; });
  await assert.rejects(runtime.getHistoryIdentity('owned'), error => error === missing);
  runtime.unpersisted = true;
  runtime.states = ['session', 'session'];
  runtime.reply = { entries: [], leafId: null };
  assert.equal((await runtime.getHistoryIdentity('owned')).leafId, null);
  runtime.persisted = true;
  runtime.states = ['session', 'session'];
  await assert.rejects(runtime.getHistoryIdentity('owned'), error => error === missing);
});

// This executable speaks the actual bridge transport; it never launches omp or
// reads user configuration. Its journal and all process state live under mkdtemp.
const lifecyclePeer = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const config = JSON.parse(process.env.LIFECYCLE_CONFIG);
let state = { sessionId: 'auto-resumed', sessionFile: config.oldPath, isStreaming: false };
if (config.draft) {
  const overlay = process.argv[process.argv.indexOf('--config') + 1];
  if (!overlay || fs.readFileSync(overlay, 'utf8').trim() !== 'autoResume: false') throw new Error('Draft must override auto-resume');
  state = {sessionId:'fresh',sessionFile:config.path,isStreaming:false};
}
let delayedStates = [];
let heldStateReply;
function emit(frame) { process.stdout.write(JSON.stringify(frame) + '\n'); }
emit({type:'ready',protocolVersion:1,supportedProtocolVersions:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:67108864});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  let data = {};
  let hold = false;
  switch (command.type) {
    case 'negotiate_protocol': data = {protocolVersion:2}; break;
    case 'new_session':
      if (!config.cancelled && !config.unchanged) {
        state = {sessionId:'fresh',isStreaming:false,...(config.pathless ? {} : {sessionFile:config.rawPath || config.path})};
        if (!config.pathless && config.persist !== false) fs.writeFileSync(config.path, JSON.stringify({sessionId:'fresh'}));
      }
      data = {cancelled:config.cancelled === true}; break;
    case 'get_state': {
      const queued = delayedStates.shift();
      data = queued ? queued.state : state;
      hold = queued ? queued.hold : false;
      break;
    }
    case 'get_available_models': data = {models:[]}; break;
    case 'get_available_commands': data = {commands:[]}; break;
    case 'get_available_thinking_levels': data = {levels:config.levels || []}; break;
    case 'set_model': config.levels = config.draft ? ['off','low','max'] : ['off','low']; state.model = {provider:command.provider,id:command.modelId}; break;
    case 'set_thinking_level': state.thinkingLevel = command.level; break;
    case 'set_subagent_subscription': data = {level:'events'}; break;
    case 'get_entries': data = {entries:[],leafId:null}; break;
    case 'fixture_state': state = command.state; break;
    case 'fixture_states': delayedStates = command.states; break;
    case 'fixture_release': heldStateReply?.(); heldStateReply = undefined; break;
    case 'fixture_event': emit(command.frame); break;
    case 'fixture_bad_frame': emit({type:'rpc_frame_error',error:'Persistence transport failed'}); return;
  }
  const reply = () => emit({type:'response',id:command.id,command:command.type,success:true,data});
  if (hold) heldStateReply = reply; else reply();
}).on('close', () => {
  // Keep this child alive without a timer so the real parent escalation can be observed.
  if (config.hang) { require('node:net').createServer().listen(0, '127.0.0.1'); return; }
  if (config.exitCode) process.stderr.write('Session persistence failed during shutdown\n');
  process.exitCode = config.exitCode || 0;
});
process.on('SIGTERM', () => process.exit(0));
`;

async function lifecycleFixture(t: TestContext, config: Record<string, unknown> = {}, mode?: StartSession['mode']) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'omp-lifecycle-')));
  const path = join(directory, 'fresh.jsonl');
  const oldPath = join(directory, 'previous.jsonl');
  const executable = join(directory, 'native-peer');
  await writeFile(executable, `#!${process.execPath}\n${lifecyclePeer}`);
  await chmod(executable, 0o700);
  const cursor = { beforeRead: undefined as (() => Promise<void>) | undefined };
  const runtime = new OmpRuntimeService(() => {}, async source => {
    await cursor.beforeRead?.();
    return JSON.parse(await readFile(source, 'utf8')) as {sessionId:string};
  });
  t.after(async () => { try { await runtime.closeAll(); } catch { /* Tests assert intentional nonzero outcomes directly. */ } finally { await rm(directory, {recursive:true,force:true}); } });
  const start = () => runtime.start({cwd:directory,...(config.draft ? {draft:true} : {}),...(mode ? {mode,sessionPath:oldPath} : {})}, {cwd:directory,executable,env:{LIFECYCLE_CONFIG:JSON.stringify({path,oldPath,...config})}});
  return {runtime,path,oldPath,start,cursor};
}

test('warm draft startup keeps the native lazy identity and picker changes never force a journal', async t => {
  const fixture = await lifecycleFixture(t, {draft:true});
  const connection = await fixture.start();
  assert.equal(connection.state.sessionId, 'fresh');
  assert.equal(connection.source.status, 'unpersisted');
  await fixture.runtime.request(connection.runtimeId, {type:'set_model',provider:'local',modelId:'reasoner'});
  await fixture.runtime.request(connection.runtimeId, {type:'set_thinking_level',level:'max'});
  assert.equal((await fixture.runtime.request<NativeState>(connection.runtimeId, {type:'get_state'})).thinkingLevel, 'max');
  await assert.rejects(readFile(fixture.path), {code:'ENOENT'});
  assert.equal((await fixture.runtime.close(connection.runtimeId)).clean, true);
  await assert.rejects(readFile(fixture.path), {code:'ENOENT'});
});

test('New replaces an auto-resumed identity through native new_session and preserves raw state', async t => {
  const fixture = await lifecycleFixture(t, {rawPath:'fresh.jsonl'});
  const connection = await fixture.start();
  assert.equal(connection.state.sessionId, 'fresh');
  assert.deepEqual(connection.source, {status:'persisted',sessionId:'fresh',path:fixture.path});
  assert.equal(connection.state.sessionFile, 'fresh.jsonl');
  assert.equal(fixture.runtime.canUseUnpersistedHistory(connection.runtimeId), false);
});

test('New never publishes a cancelled or unchanged native identity', async t => {
  for (const config of [{cancelled:true}, {unchanged:true}]) {
    const fixture = await lifecycleFixture(t, config);
    await assert.rejects(fixture.start(), /cancelled|fresh identity/);
  }
});

test('allocated paths do not establish durability or forgive a missing native-persisted New source', async t => {
  const fixture = await lifecycleFixture(t, {persist:false});
  const connection = await fixture.start();
  assert.equal(connection.source.status, 'unavailable');
  assert.equal(fixture.runtime.canUseUnpersistedHistory(connection.runtimeId), false);
  await assert.rejects(fixture.runtime.getHistoryIdentity(connection.runtimeId), {code:'ENOENT'});
});

test('a persisted New identity stays allocated until the native identity changes', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const id = connection.runtimeId;
  const allocated = () => fixture.runtime.ownedFacts().find(fact => fact.runtimeId === id)?.allocated;
  assert.equal(connection.source.status, 'persisted');
  assert.equal(allocated(), true, 'first persistence must not revoke allocation provenance');
  await fixture.runtime.request(id, {type:'fixture_state',state:{sessionId:'switched',sessionFile:fixture.path,isStreaming:false}});
  await fixture.runtime.request(id, {type:'get_state'});
  assert.equal(allocated(), false);
  const resumed = await lifecycleFixture(t, {}, 'resume');
  const resumedConnection = await resumed.start();
  assert.equal(resumed.runtime.ownedFacts().find(fact => fact.runtimeId === resumedConnection.runtimeId)?.allocated, false);
});

test('persisted loss and missing resumed sources never become initial empty histories', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  await rm(fixture.path);
  assert.equal((await fixture.runtime.getSourceState(connection.runtimeId)).status, 'unavailable');
  await assert.rejects(fixture.runtime.getHistoryIdentity(connection.runtimeId), {code:'ENOENT'});
  const resumed = await lifecycleFixture(t, {}, 'resume');
  const resumedConnection = await resumed.start();
  assert.equal(resumedConnection.state.sessionId, 'auto-resumed');
  assert.equal(resumedConnection.source.status, 'unavailable');
});

test('pathless fresh source is readable only while its exact original identity remains', async t => {
  const fixture = await lifecycleFixture(t, {pathless:true});
  const connection = await fixture.start();
  const id = connection.runtimeId;
  assert.deepEqual(connection.source, {status:'unpersisted',sessionId:'fresh'});
  assert.equal(fixture.runtime.canUseUnpersistedHistory(id), true);
  assert.deepEqual(await fixture.runtime.getHistoryIdentity(id), {sessionId:'fresh',path:undefined,leafId:null});
  await fixture.runtime.request(id, {type:'fixture_state',state:{sessionId:'fresh',sessionFile:fixture.path,isStreaming:false}});
  await fixture.runtime.request(id, {type:'get_state'});
  assert.equal((await fixture.runtime.getSourceState(id)).status, 'unavailable');
  await fixture.runtime.request(id, {type:'fixture_state',state:{sessionId:'fresh',isStreaming:false}});
  await fixture.runtime.request(id, {type:'get_state'});
  assert.equal(fixture.runtime.canUseUnpersistedHistory(id), false);
});

test('out-of-order state replies cannot overwrite a newer native identity', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const id = connection.runtimeId;
  await fixture.runtime.request(id, {type:'fixture_states',states:[
    {state:{sessionId:'stale',isStreaming:false},hold:true},
    {state:{sessionId:'current',isStreaming:false},hold:false},
  ]});
  const stale = fixture.runtime.request(id, {type:'get_state'});
  const rejected = assert.rejects(stale, /superseded/);
  const current = await fixture.runtime.request<NativeState>(id, {type:'get_state'});
  await fixture.runtime.request(id, {type:'fixture_release'});
  await rejected;
  assert.equal(current.sessionId, 'current');
  assert.equal(fixture.runtime.getConnection(id).state.sessionId, 'current');
  assert.equal((await fixture.runtime.getSourceState(id)).sessionId, 'current');
});

test('close is single-flight, remembers clean outcomes and retains trusted source identity', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const first = fixture.runtime.close(connection.runtimeId);
  assert.equal(first, fixture.runtime.close(connection.runtimeId));
  assert.deepEqual(await first, {clean:true,forced:false,exitCode:0});
  assert.deepEqual(await fixture.runtime.close(connection.runtimeId), await first);
  assert.deepEqual(fixture.runtime.getShutdownOutcome(connection.runtimeId), await first);
  assert.equal((await fixture.runtime.getSourceState(connection.runtimeId)).status, 'persisted');
  assert.equal((await fixture.runtime.close('unknown')).clean, false);
});

test('native nonzero persistence failure survives close as a deletion-blocking outcome', async t => {
  const fixture = await lifecycleFixture(t, {exitCode:1});
  const connection = await fixture.start();
  const outcome = await fixture.runtime.close(connection.runtimeId);
  assert.equal(outcome.clean, false);
  assert.equal(outcome.forced, false);
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.error ?? '', /persistence failed/);
});

test('TERM escalation is never clean even when the child handles it with exit zero', async t => {
  // Deliberately exercises actual process-group TERM after the bridge's drain deadline.
  // Faking the parent's timer cannot prove the real child exits with code zero.
  const fixture = await lifecycleFixture(t, {hang:true});
  const connection = await fixture.start();
  const outcome = await fixture.runtime.close(connection.runtimeId);
  assert.equal(outcome.clean, false);
  assert.equal(outcome.forced, true);
  assert.equal(outcome.exitCode, 0);
});

test('closed unpersisted identity remains available for clean discard but not live history', async t => {
  const fixture = await lifecycleFixture(t, {pathless:true});
  const connection = await fixture.start();
  assert.equal((await fixture.runtime.close(connection.runtimeId)).clean, true);
  assert.deepEqual(await fixture.runtime.getSourceState(connection.runtimeId), {status:'unpersisted',sessionId:'fresh'});
  assert.equal(fixture.runtime.canUseUnpersistedHistory(connection.runtimeId), false);
});

test('identity changes irreversibly revoke the original pathless fallback', async t => {
  const fixture = await lifecycleFixture(t, {pathless:true});
  const connection = await fixture.start();
  const id = connection.runtimeId;
  await fixture.runtime.request(id, {type:'fixture_state',state:{sessionId:'different',isStreaming:false}});
  await fixture.runtime.request(id, {type:'get_state'});
  await fixture.runtime.request(id, {type:'fixture_state',state:{sessionId:'fresh',isStreaming:false}});
  await fixture.runtime.request(id, {type:'get_state'});
  const source = await fixture.runtime.getSourceState(id);
  assert.equal(source.status, 'unavailable');
  assert.equal(source.sessionId, 'fresh');
  assert.equal(fixture.runtime.canUseUnpersistedHistory(id), false);
});

test('native transport errors remain deletion-blocking even with a zero shutdown exit', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  await assert.rejects(fixture.runtime.request(connection.runtimeId, {type:'fixture_bad_frame'}), /Persistence transport failed/);
  const outcome = await fixture.runtime.close(connection.runtimeId);
  assert.equal(outcome.clean, false);
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.error ?? '', /Persistence transport failed/);
});

test('stale durable observations cannot publish source state for a changed identity', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.cursor.beforeRead = async () => { entered.resolve(); await release.promise; };
  const pending = fixture.runtime.getSourceState(connection.runtimeId);
  const rejected = assert.rejects(pending, /superseded/);
  await entered.promise;
  await fixture.runtime.request(connection.runtimeId, {type:'fixture_state',state:{sessionId:'other',isStreaming:false}});
  await fixture.runtime.request(connection.runtimeId, {type:'get_state'});
  release.resolve();
  await rejected;
  assert.equal(fixture.runtime.getConnection(connection.runtimeId).source.sessionId, 'other');
  assert.equal(fixture.runtime.getConnection(connection.runtimeId).source.status, 'unavailable');
});

test('stale history cursor completion cannot authorize another native source binding', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.cursor.beforeRead = async () => { entered.resolve(); await release.promise; };
  const pending = fixture.runtime.getHistoryIdentity(connection.runtimeId);
  const rejected = assert.rejects(pending, /source changed/);
  await entered.promise;
  await fixture.runtime.request(connection.runtimeId, {type:'fixture_state',state:{sessionId:'other',sessionFile:fixture.oldPath,isStreaming:false}});
  await fixture.runtime.request(connection.runtimeId, {type:'get_state'});
  release.resolve();
  await rejected;
  assert.equal(fixture.runtime.canUseUnpersistedHistory(connection.runtimeId), false);
});

test('overlapping unchanged native identity reads retain post-mutation freshness', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const id = connection.runtimeId;
  await fixture.runtime.request(id, {type:'fixture_states',states:[
    {state:{sessionId:'fresh',sessionFile:fixture.path,isStreaming:false,queuedMessageCount:0},hold:true},
  ]});
  const beforeMutation = fixture.runtime.request<NativeState>(id, {type:'get_state'});
  await fixture.runtime.request(id, {type:'fixture_state',state:{sessionId:'fresh',sessionFile:fixture.path,isStreaming:true,queuedMessageCount:2}});
  const afterMutation = await fixture.runtime.request<NativeState>(id, {type:'get_state'});
  assert.equal(afterMutation.isStreaming, true);
  assert.equal(afterMutation.queuedMessageCount, 2);
  await fixture.runtime.request(id, {type:'fixture_release'});
  const earlierCaller = await beforeMutation;
  assert.equal(earlierCaller.isStreaming, true);
  assert.equal(earlierCaller.queuedMessageCount, 2);
  assert.equal(fixture.runtime.getConnection(id).state.isStreaming, true);
});

test('overlapping unchanged source reads remain available to every caller', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.cursor.beforeRead = async () => { entered.resolve(); await release.promise; };
  const first = fixture.runtime.getSourceState(connection.runtimeId);
  await entered.promise;
  const second = fixture.runtime.getSourceState(connection.runtimeId);
  release.resolve();
  const sources = await Promise.all([first, second]);
  for (const source of sources) assert.deepEqual(source, {status:'persisted',sessionId:'fresh',path:fixture.path});
  assert.equal(fixture.runtime.getConnection(connection.runtimeId).source.status, 'persisted');
});

test('caller-selected IDs cannot collide with host-owned prompt requests', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const accepted = await fixture.runtime.submitPrompt(connection.runtimeId, { type: 'prompt', message: 'hello' }, connection.state.sessionId, 'renderer-local');
  assert.notEqual(accepted.requestId, 'renderer-local');
  await assert.rejects(fixture.runtime.request(connection.runtimeId, { type: 'get_state', id: accepted.requestId }), /host-owned/);
  const state = await fixture.runtime.request<NativeState>(connection.runtimeId, { type: 'get_state' });
  assert.equal(state.sessionId, 'fresh');
});

test('a replaced native session rejects the original prompt target before submission', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const originalSessionId = connection.state.sessionId;
  await fixture.runtime.request(connection.runtimeId, { type: 'fixture_state', state: { sessionId: 'replacement', isStreaming: false } });
  await fixture.runtime.request(connection.runtimeId, { type: 'get_state' });
  await assert.rejects(fixture.runtime.submitPrompt(connection.runtimeId, { type: 'prompt', message: 'belongs to original session' }, originalSessionId), /session changed/);
  assert.equal(fixture.runtime.getConnection(connection.runtimeId).state.sessionId, 'replacement');
});

test('owned running count follows events, async state, children and shutdown without polling', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const runtime = fixture.runtime;
  const event = (frame: NativeFrame) => runtime.request(connection.runtimeId, { type: 'fixture_event', frame });
  assert.equal(runtime.ownedRunningCount(), 0);
  await event({ type: 'agent_start' });
  assert.equal(runtime.ownedRunningCount(), 1);
  await event({ type: 'agent_end', isTerminal: true });
  assert.equal(runtime.ownedRunningCount(), 1, 'yielded is not settled');
  await event({ type: 'session_settled' });
  assert.equal(runtime.ownedRunningCount(), 0);
  await runtime.request(connection.runtimeId, { type: 'fixture_state', state: { sessionId: 'fresh', sessionFile: fixture.path, isStreaming: false, hasPendingAsyncWork: true } });
  await runtime.request(connection.runtimeId, { type: 'get_state' });
  assert.equal(runtime.ownedRunningCount(), 1);
  await event({ type: 'session_settled' });
  await event({ type: 'subagent_lifecycle', payload: { id: 'worker', status: 'started' } });
  assert.equal(runtime.ownedRunningCount(), 1);
  await event({ type: 'subagent_lifecycle', payload: { id: 'second', status: 'running' } });
  assert.equal(runtime.ownedRunningCount(), 1, 'children count as one parent session');
  await event({ type: 'subagent_lifecycle', payload: { id: 'worker', status: 'completed' } });
  await event({ type: 'subagent_lifecycle', payload: { id: 'second', status: 'failed' } });
  assert.equal(runtime.ownedRunningCount(), 0);
  await event({ type: 'auto_compaction_start' });
  assert.equal(runtime.ownedRunningCount(), 1);
  await event({ type: 'auto_compaction_end' });
  assert.equal(runtime.ownedRunningCount(), 0);
  await event({ type: 'agent_start' });
  await runtime.close(connection.runtimeId);
  assert.equal(runtime.ownedRunningCount(), 0);
});

test('a delayed idle snapshot cannot erase newer running events', async t => {
  const fixture = await lifecycleFixture(t);
  const connection = await fixture.start();
  const runtime = fixture.runtime;
  await runtime.request(connection.runtimeId, { type: 'fixture_states', states: [{ hold: true, state: { sessionId: 'fresh', sessionFile: fixture.path, isStreaming: false, isSettled: true } }] });
  const stale = runtime.request(connection.runtimeId, { type: 'get_state' });
  await runtime.request(connection.runtimeId, { type: 'fixture_event', frame: { type: 'agent_start' } });
  await runtime.request(connection.runtimeId, { type: 'fixture_release' });
  await stale;
  assert.equal(runtime.ownedRunningCount(), 1);
  await runtime.request(connection.runtimeId, { type: 'fixture_event', frame: { type: 'session_settled' } });
  assert.equal(runtime.ownedRunningCount(), 0);
});

test('thinking validation follows advertised max, model changes and native snapshots', async t => {
  const { runtime, start } = await lifecycleFixture(t, { levels: ['off', 'max'] });
  const connection = await start();
  await runtime.request(connection.runtimeId, { type: 'set_thinking_level', level: 'max' });
  assert.equal((await runtime.request<NativeState>(connection.runtimeId, { type: 'get_state' })).thinkingLevel, 'max');
  await assert.rejects(runtime.request(connection.runtimeId, { type: 'set_thinking_level', level: 'high' }), /Invalid thinking level/);
  await runtime.request(connection.runtimeId, { type: 'set_model', provider: 'fixture', modelId: 'limited' });
  assert.deepEqual(connection.thinkingLevels, ['off', 'low']);
  await assert.rejects(runtime.request(connection.runtimeId, { type: 'set_thinking_level', level: 'max' }), /Invalid thinking level/);
  await runtime.request(connection.runtimeId, { type: 'set_thinking_level', level: 'low' });
  await runtime.request(connection.runtimeId, { type: 'fixture_event', frame: { type: 'thinking_levels_snapshot', levels: ['off', 'max'] } });
  await runtime.request(connection.runtimeId, { type: 'set_thinking_level', level: 'max' });
});

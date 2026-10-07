import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeMessage } from '../../shared/contracts';
import { createChatState, createNativeLiveSequence, reduceNativeLiveSequence, reduceChatFrame, record, text, type ChatMessage, type ChatState } from './model';
import { assistantTurnKey, buildTranscriptEntries, buildTurnTimeline, summarizeTurn, thinkingPreview, turnOutcome, readableNativeData, retainTurnPresentation, turnPartPresentationKey, type TurnPart } from './presentation';
import { projectTurn } from './turn-model';
import { createReadingAnchor, readingAnchorAdjustment } from '../lib/transcript-reading-position';
import { projectSubmissions, isStoppedMessage } from './presentation';
import type { SubmissionReceipt } from './submissions';
import { projectYieldReport } from './presentation';
import { turnChangedFiles } from './presentation';
import { turnUsage, turnUsageTotals } from './presentation';
import { retryNoticeHasTurnError } from './presentation';

const row = (id: string, raw: NativeMessage): ChatMessage => ({ id, raw, source: 'history', streaming: false });


test('turn footer sums each request and attributed agent once without double-counting cache', () => {
 const first=row('one',{role:'assistant',usage:{input:100,output:20,cacheRead:200,totalTokens:320,cost:{total:0.003}}});
 const second=row('two',{role:'assistant',usage:{input:80,output:20,cost:{total:0.004}}});
 const child={id:'child',tokens:500,cost:0.02};
 const usage=turnUsage([first,second,first],[child,child]);
 assert.equal(usage.tokens,920); assert.equal(usage.cost,0.027); assert.equal(usage.formattedCost,'$0.03');
 assert.equal(usage.requests.length,2); assert.equal(usage.children.length,1);
 assert.deepEqual(turnUsageTotals([first,second,first],[child,child]),{tokens:920,cost:0.027,formattedTokens:'920',formattedCost:'$0.03'});
 assert.equal(turnUsage([first]).formattedCost,'<$0.01');
 assert.equal(turnUsage([row('empty',{role:'assistant'})]).tokens,undefined);
});
test('request retry failures are represented by the settled failed-turn card regardless of provider wording', () => {
 const failed=row('failed',{role:'assistant',stopReason:'error',errorMessage:'HTTP 500 Internal Server Error'});
 const retry={category:'retry',values:{errorMessage:'Error: HTTP 500 Internal Server Error'}};
 assert.equal(retryNoticeHasTurnError(retry,[failed],false),true);
 assert.equal(retryNoticeHasTurnError(retry,[failed],true),false);
 assert.equal(retryNoticeHasTurnError({...retry,category:'compaction'},[failed],false),false);
 assert.equal(retryNoticeHasTurnError({category:'retry',values:{errorMessage:'Quota exhausted'}},[failed],false),true);
 assert.equal(retryNoticeHasTurnError(retry,[failed,row('next',{role:'user',content:'Next request'})],false),false);
 assert.equal(retryNoticeHasTurnError(retry,[row('stop',{role:'assistant',stopReason:'aborted',errorMessage:'HTTP 500 Internal Server Error'})],false),false);
});

test('native fallbacks preserve readable unknown data without leaking signatures', () => {
  const raw = { type: 'future', text: 'Readable', nested: [{ signature: 'opaque', text: 'Also readable' }] };
  assert.deepEqual(readableNativeData(raw), { type: 'future', text: 'Readable', nested: [{ text: 'Also readable' }] });
  assert.equal(raw.nested[0].signature, 'opaque');
});

test('deferred saved content keeps its speaker, source action and original transcript position', () => {
  const assistant = { ...row('large-answer', { role: 'assistant', historyResourceDeferred: true, content: '' }), resourceReference: 'desktop-entry:answer' };
  const result = { ...row('large-result', { role: 'toolResult', toolName: 'read', toolCallId: 'read-call', historyResourceDeferred: true, content: '' }), resourceReference: 'desktop-entry:result' };
  const messages = [row('before', { role: 'assistant', content: 'Before' }), assistant, result, row('after', { role: 'assistant', content: 'After' })];
  const original = structuredClone(messages);
  const { entries } = buildTranscriptEntries(messages, {});
  assert.deepEqual(entries.map(entry => [entry.kind, entry.id]), [['assistant-turn', 'before']]);
  if (entries[0].kind !== 'assistant-turn') assert.fail('Expected coherent deferred turn');
  assert.deepEqual(entries[0].parts.filter(part => part.kind === 'activity' || part.kind === 'tool').map(part => [part.row.raw.role, part.row.raw.toolName, part.row.resourceReference]), [['assistant', undefined, 'desktop-entry:answer'], ['toolResult', 'read', 'desktop-entry:result']]);
  assert.deepEqual(messages, original);
});

test('native tool identity pairs child call and saved result exactly once including deferred output', () => {
  for (const deferred of [false, true]) {
    const call = row('child-message', { role: 'assistant', content: [{ type: 'thinking', thinking: 'Inspect' }, { type: 'toolCall', id: 'native-read-id', name: 'read', arguments: { path: 'file.txt' } }] });
    const result = { ...row('child-result', { role: 'toolResult', toolCallId: 'native-read-id', toolName: 'read', content: deferred ? '' : 'Unique file output', historyResourceDeferred: deferred }), resourceReference: 'desktop-entry:child-result' };
    const final = row('child-final', { role: 'assistant', content: 'Final answer' });
    const { entries } = buildTranscriptEntries([call, result, final], {});
    assert.equal(entries.length, 1);
    const entry = entries[0];
    if (entry.kind !== 'assistant-turn') assert.fail('Expected shared assistant turn');
    const tools = projectTurn(entry).chapters.flatMap(chapter => chapter.steps).filter(part => part.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].key, 'native-read-id');
    assert.notEqual(tools[0].key, 'child-message:block:1');
    assert.deepEqual(tools[0].tool.args, { path: 'file.txt' });
    assert.equal(tools[0].tool.result, result.raw);
    assert.equal(tools[0].resultRow?.resourceReference, 'desktop-entry:child-result');
    assert.deepEqual(entry.rows.map(item => item.id), ['child-message', 'child-result', 'child-final']);
    assert.deepEqual(projectTurn(entry).answer.map(part => part.kind === 'text' ? part.value : part.kind), ['Final answer']);
    const live = buildTranscriptEntries([{ ...call, id: 'live:child' }], {}).entries[0];
    if (live.kind !== 'assistant-turn') assert.fail('Expected live tool turn');
    assert.equal(assistantTurnKey(live), assistantTurnKey(entry));
  }
});


test('verified late deliveries stay with their original task and mixed residuals retain chronology', () => {
  const envelope = (id: string) => `<task-result id="${id}" agent="worker" status="completed" duration="1s">\n<output>\nResult ${id}\n</output>\n</task-result>`;
  const agents = [{ id: 'child-one', parentToolCallId: 'spawn-one' }, { id: 'child-two', parentToolCallId: 'spawn-two' }];
  const prefix = [
    row('request-one', { role: 'user', content: 'First' }),
    row('first', { role: 'assistant', content: [{ type: 'toolCall', id: 'spawn-one', name: 'task' }, { type: 'toolCall', id: 'spawn-two', name: 'task' }] }),
    row('request-two', { role: 'user', content: 'Second' }),
    row('second', { role: 'assistant', content: 'Current narration' }),
  ];
  const late = { ...row('late', { role: 'custom', customType: 'async-result', display: true, content: envelope('child-one'), details: { jobs: [{ jobId: 'job-one', type: 'task' }] } }), resourceReference: 'desktop-entry:late' };
  const linked = buildTranscriptEntries([...prefix, late], {}, agents).entries;
  const original = linked[1];
  if (original.kind !== 'assistant-turn') assert.fail('Expected originating turn');
  const task = original.parts.find(part => part.kind === 'tool' && part.tool.id === 'spawn-one');
  if (task?.kind !== 'tool') assert.fail('Expected originating task');
  assert.equal(task.activities?.[0].row, late);
  assert.equal(task.activities?.[0].canonicalAnchor, true);
  assert.equal(task.activities?.[0].delivery?.jobs[0].id, 'job-one');
  assert.deepEqual(linked.map(entry => entry.id), ['request-one', 'first', 'request-two', 'second']);
  const unowned = buildTranscriptEntries([...prefix, late], {}, []).entries.at(-1);
  if (unowned?.kind !== 'assistant-turn') assert.fail('Expected neutral delivery in current turn');
  const unownedPart = unowned.parts.find(part => part.kind === 'activity');
  if (unownedPart?.kind !== 'activity') assert.fail('Expected neutral delivery activity');
  assert.equal(unownedPart.row, late);
  assert.deepEqual(unownedPart.delivery?.jobs.map(job => job.id), ['job-one']);
  assert.equal(unownedPart.delivery?.diagnostics.length, 1);
  const content = `<system-notice>\n3 background jobs have completed. Resume your work using the results below.\n\n── Job job-one ──\n${envelope('child-one')}\n\n── Job job-two ──\n${envelope('child-two')}\n\n── Job shell ──\nShell result\n</system-notice>`;
  const image = { type: 'image', data: 'image', mimeType: 'image/png' };
  const mixed = row('mixed', { role: 'custom', customType: 'async-result', display: true, content: [{ type: 'text', text: content }, image], details: { jobs: [{ jobId: 'job-one', type: 'task' }, { jobId: 'job-two', type: 'task' }, { jobId: 'shell', type: 'bash' }] } });
  const { entries } = buildTranscriptEntries([...prefix, mixed, row('final', { role: 'assistant', content: 'Answer' })], {}, agents);
  const owner = entries[1];
  const current = entries[3];
  if (owner.kind !== 'assistant-turn' || current.kind !== 'assistant-turn') assert.fail('Expected two actual assistant turns');
  assert.deepEqual(owner.parts.flatMap(part => part.kind === 'tool' ? part.activities?.map(activity => [part.tool.id, activity.canonicalAnchor, activity.delivery?.jobs[0].id]) ?? [] : []), [['spawn-one', false, 'job-one'], ['spawn-two', false, 'job-two']]);
  const activity = current.parts.find(part => part.kind === 'activity');
  if (activity?.kind !== 'activity') assert.fail('Expected in-order residual');
  assert.equal(activity.row, mixed);
  assert.deepEqual(activity.delivery?.jobs.map(job => job.id), ['shell']);
  assert.deepEqual(activity.delivery?.residualContent, [image]);
});

test('native skill requests start turns but attributed context and unknown live activity do not', () => {
  const activity = { ...row('event', { role: 'future-native-event', content: 'Declared event text' }), source: 'event' as const };
  const { entries } = buildTranscriptEntries([
    row('start', { role: 'assistant', content: 'Before' }),
    row('context', { role: 'custom', customType: 'context', display: true, attribution: 'user', content: 'Context only' }),
    activity,
    row('skill', { role: 'custom', customType: 'skill-prompt', display: true, attribution: 'user', content: 'Expanded skill' }),
    row('answer', { role: 'assistant', content: { type: 'future-visible', text: 'Unknown display' } }),
  ], {});
  assert.deepEqual(entries.map(entry => entry.id), ['start', 'skill', 'answer']);
  if (entries[0].kind !== 'assistant-turn' || entries[2].kind !== 'assistant-turn') assert.fail('Expected native turn boundaries');
  assert.deepEqual(entries[0].parts.map(part => part.kind), ['text', 'activity', 'activity']);
  assert.equal(entries[0].parts[2].row, activity);
  const unknown = entries[2].parts[0];
  assert.equal(unknown.kind, 'content');
  if (unknown.kind === 'content') assert.deepEqual(unknown.block, { type: 'future-visible', text: 'Unknown display' });
});

test('delegation and tools stay in native process order without consuming the final response', () => {
  const messages = [row('a', { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Plan' },
    { type: 'toolCall', id: 'one', name: 'task', arguments: { task: 'Inspect' } },
    { type: 'text', text: 'Between calls' },
    { type: 'toolCall', id: 'read', name: 'read' },
    { type: 'toolCall', id: 'two', name: 'task' },
    { type: 'text', text: 'Answer' },
  ] })];
  const original = structuredClone(messages);
  const { entries, renderedTools } = buildTranscriptEntries(messages, {});
  if (entries[0].kind !== 'assistant-turn') assert.fail('Expected one turn');
  const projection = projectTurn(entries[0]);
  const parts = projection.chapters.flatMap(chapter => [...chapter.narration, ...chapter.steps]);
  assert.deepEqual(parts.map(part => part.kind === 'tool' ? part.tool.id : part.kind), ['thinking', 'one', 'text', 'read', 'two']);
  assert.deepEqual(projection.answer.map(part => part.kind === 'text' ? part.value : part.kind), ['Answer']);
  assert.deepEqual([...renderedTools], ['one', 'read', 'two']);
  assert.deepEqual(messages, original);
});

test('task identities survive live row replacement and changing process chunks', () => {
  const call = { type: 'toolCall', id: 'stable-spawn', name: 'task', arguments: { task: 'Inspect' } };
  const live = buildTranscriptEntries([{ ...row('live:runtime:message-1', { role: 'assistant', content: [call] }), source: 'live', streaming: true }], {}).entries[0];
  const saved = buildTranscriptEntries([row('journal-entry-42', { role: 'assistant', content: [{ type: 'thinking', thinking: 'Saved planning' }, call] }), row('journal-result', { role: 'toolResult', toolCallId: 'stable-spawn', toolName: 'task', content: 'Complete' }), row('journal-answer', { role: 'assistant', content: 'Done' })], {}).entries[0];
  if (live.kind !== 'assistant-turn' || saved.kind !== 'assistant-turn') assert.fail('Expected task turns');
  assert.notEqual(live.id, saved.id);
  assert.equal(assistantTurnKey(live), 'stable-spawn');
  assert.equal(assistantTurnKey(saved), assistantTurnKey(live));
  const liveStage = projectTurn(live).chapters.flatMap(chapter => chapter.steps).find(part => part.kind === 'tool');
  const savedStage = projectTurn(saved).chapters.flatMap(chapter => chapter.steps).find(part => part.kind === 'tool');
  assert.equal(liveStage?.key, 'stable-spawn');
  assert.equal(savedStage?.key, liveStage?.key);
  assert.equal(saved.parts.find(part => part.kind === 'tool')?.key, 'stable-spawn');
});

test('prepending a partial turn retains its pane identity and exact visible fragment offset', () => {
  const messages = Array.from({ length: 260 }, (_, index) => row(`narration-${index + 1}`, { role: 'assistant', content: 'Repeated narration' }));
  const initial = retainTurnPresentation(buildTranscriptEntries(messages.slice(60), {}).entries, []);
  const partial = initial[0];
  if (partial.kind !== 'assistant-turn') assert.fail('Expected partial assistant turn');
  const visible = partial.parts[0];
  const savedAnchor = createReadingAnchor({ presentationKey: visible.key, messageId: visible.row.id, turnId: partial.id }, 96)!;
  const request = row('original-request', { role: 'user', content: 'Original request' });
  const complete = retainTurnPresentation(buildTranscriptEntries([request, ...messages], {}).entries, initial);
  const turn = complete[1];
  if (turn.kind !== 'assistant-turn') assert.fail('Expected regrouped assistant turn');
  assert.equal(turn.id, 'narration-1');
  assert.equal(assistantTurnKey(turn), assistantTurnKey(partial));
  assert.equal(turn.presentation?.disclosureId, partial.presentation?.disclosureId);
  assert.deepEqual(turn.rows, messages);
  const retainedFragment = turn.parts.find(part => part.row.id === 'narration-61');
  assert.ok(retainedFragment);
  assert.equal(turnPartPresentationKey(retainedFragment), turnPartPresentationKey(visible));
  const currentAnchor = createReadingAnchor({ presentationKey: retainedFragment.key, messageId: retainedFragment.row.id, turnId: turn.id }, 3936)!;
  const enclosingTurn = createReadingAnchor({ minimapId: turn.id, turnId: turn.id }, 192)!;
  assert.equal(readingAnchorAdjustment([savedAnchor], [enclosingTurn, currentAnchor]), 3840);
  // A later layout pass must continue to restore the original offset, not learn
  // the clamped/interim geometry or substitute the newly prepended turn header.
  assert.equal(readingAnchorAdjustment([savedAnchor], [enclosingTurn, { ...currentAnchor, top: 156 }]), 60);
  assert.equal(readingAnchorAdjustment([savedAnchor], [{ ...currentAnchor, top: 96 }]), 0);
});

test('turn presentation continuity uses source identity, not repeated prose across requests', () => {
  const oldRows = [row('first-answer', { role: 'assistant', content: 'Repeated answer' })];
  const previous = retainTurnPresentation(buildTranscriptEntries(oldRows, {}).entries, []);
  const entries = retainTurnPresentation(buildTranscriptEntries([
    ...oldRows, row('new-request', { role: 'user', content: 'Again' }),
    row('second-answer', { role: 'assistant', content: 'Repeated answer' }),
  ], {}).entries, previous);
  const first = entries[0], second = entries[2];
  if (first.kind !== 'assistant-turn' || second.kind !== 'assistant-turn') assert.fail('Expected separate native turns');
  assert.notEqual(assistantTurnKey(first), assistantTurnKey(second));
  assert.notEqual(first.presentation?.disclosureId, second.presentation?.disclosureId);
});

const freshPresentation = () => createChatState({ runtimeId: 'worker', cwd: '/workspace', source: { status: 'unpersisted', sessionId: 'session' }, state: { sessionId: 'session', isStreaming: false, isSettled: true }, messages: [], models: [], commands: [], thinkingLevels: [] });
const response = (timestamp: number, content: unknown): NativeMessage => ({ role: 'assistant', timestamp, provider: 'native', model: 'model', stopReason: 'stop', content });
const lastTurn = (chat: ChatState) => {
  const entry = buildTranscriptEntries(chat.messages, chat.tools).entries.at(-1);
  if (entry?.kind !== 'assistant-turn') assert.fail('Expected assistant turn');
  return entry;
};

test('observed response parts retain their enclosing and material identities through native settlement', () => {
  for (const name of ['read', 'task']) {
    const call = response(100, [{ type: 'thinking', thinking: 'Plan' }, { type: 'toolCall', id: 'call', name }]);
    const result: NativeMessage = { role: 'toolResult', timestamp: 101, toolCallId: 'call', toolName: name, content: 'Result' };
    const answer = response(102, [{ type: 'text', text: 'First paragraph' }, { type: 'text', text: 'Second paragraph' }, { type: 'image', data: 'image', mimeType: 'image/png' }]);
    let chat = reduceChatFrame(freshPresentation(), { type: 'agent_start' });
    chat = reduceChatFrame(chat, { type: 'message_end', messageId: 'call-message', message: call });
    chat = reduceChatFrame(chat, { type: 'message_end', messageId: 'result-message', message: result });
    chat = reduceChatFrame(chat, { type: 'message_start', messageId: 'answer-message', message: answer });
    const running = lastTurn(chat);
    const runningKeys = running.parts.map(turnPartPresentationKey);
    assert.equal(projectTurn(running).answer.every(part => part.row.streaming), true);
    chat = reduceChatFrame(chat, { type: 'message_end', messageId: 'answer-message', message: answer });
    assert.deepEqual(lastTurn(chat).parts.map(turnPartPresentationKey), runningKeys);
    assert.equal(chat.messages.at(-1)?.streaming, false);
    chat = reduceChatFrame(chat, { type: 'session_settled' });
    chat = reduceChatFrame(chat, { type: 'messages_snapshot', reconcileLive: true, messages: [call, result, answer], messageIds: ['entry-call', 'entry-result', 'entry-answer'], messageResourceReferences: ['resource-call', 'resource-result', 'resource-answer'] });
    const saved = lastTurn(chat);
    assert.equal(assistantTurnKey(saved), assistantTurnKey(running));
    assert.deepEqual(saved.parts.map(turnPartPresentationKey), runningKeys);
    assert.deepEqual(projectTurn(saved).answer.map(part => part.key), ['entry-answer:block:0', 'entry-answer:block:1', 'entry-answer:block:2']);
    assert.deepEqual(chat.messages.map(row => [row.id, row.source, row.streaming, row.resourceReference]), [['entry-call', 'history', false, 'resource-call'], ['entry-result', 'history', false, 'resource-result'], ['entry-answer', 'history', false, 'resource-answer']]);
    assert.equal(chat.messages[2].raw, answer);
    assert.equal(chat.isRunning, false);
    assert.equal(chat.isSettled, true);
    // Backfill retains exact journal matches, never assigning old messages live identities.
    chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [response(1, 'Older answer'), { role: 'user', content: 'Current prompt' }, call, result, answer], messageIds: ['older', 'prompt', 'entry-call', 'entry-result', 'entry-answer'] });
    assert.equal(chat.messages[0].presentation, undefined);
    assert.equal(assistantTurnKey(lastTurn(chat)), assistantTurnKey(running));
    assert.deepEqual(lastTurn(chat).parts.map(turnPartPresentationKey), runningKeys);
    const cold = reduceChatFrame(freshPresentation(), { type: 'messages_snapshot', reconcileLive: true, messages: [answer], messageIds: ['entry-answer'] });
    assert.equal(cold.messages[0].presentation, undefined);
    assert.equal(turnPartPresentationKey(lastTurn(cold).parts[0]), 'entry-answer:block:0');
  }
});

test('ambiguous, unobserved, cross-session and backfilled messages never borrow a live presentation', () => {
  const answer = response(100, 'Repeated prose');
  const other = { ...answer, content: 'Different prose with colliding native metadata' };
  const ended = (messages: NativeMessage[]) => messages.reduce((chat, message, index) => reduceChatFrame(chat, { type: 'message_end', messageId: `message-${index}`, message }), freshPresentation());
  const cases = [
    { chat: ended([answer, other]), messages: [answer], ids: ['saved'], latest: true },
    { chat: ended([answer]), messages: [answer, other], ids: ['saved-one', 'saved-two'], latest: true },
    { chat: ended([answer]), messages: [answer], ids: ['older-page'], latest: false },
    { chat: ended([answer]), messages: [answer], ids: undefined, latest: true },
    { chat: ended([{ ...answer, timestamp: undefined }]), messages: [{ ...answer, timestamp: undefined }], ids: ['saved'], latest: true },
    { chat: ended([answer]), messages: [response(101, 'Repeated prose')], ids: ['saved'], latest: true },
    { chat: reduceChatFrame(ended([answer]), { type: 'state_snapshot', state: { sessionId: 'different-session' } }), messages: [answer], ids: ['saved'], latest: true },
  ];
  for (const item of cases) {
    const chat = reduceChatFrame(item.chat, { type: 'messages_snapshot', messages: item.messages, messageIds: item.ids, reconcileLive: item.latest });
    assert.deepEqual(chat.messages.map(row => row.presentation), item.messages.map(() => undefined));
    assert.deepEqual(chat.messages.map(row => row.raw), item.messages);
  }
  let chat = reduceChatFrame(ended([answer]), { type: 'messages_snapshot', messages: [answer], messageIds: ['saved'], reconcileLive: true });
  assert.equal(chat.messages[0].presentation?.id, 'live:worker:message-0');
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [], messageIds: [] });
  chat = reduceChatFrame(chat, { type: 'messages_snapshot', messages: [answer], messageIds: ['saved'], reconcileLive: true });
  assert.equal(chat.messages[0].presentation, undefined);
});

test('latest durable history does not borrow or discard an unmatched open live message', () => {
  const answer = response(100, 'Still streaming');
  const open = reduceChatFrame(freshPresentation(), { type: 'message_start', messageId: 'open', message: answer });
  const hydrated = reduceChatFrame(open, { type: 'messages_snapshot', messages: [answer], messageIds: ['saved'], reconcileLive: true });
  const durable = hydrated.messages.find(message => message.id === 'saved');
  assert.ok(durable);
  assert.equal(durable.source, 'history');
  assert.equal(durable.streaming, false);
  assert.equal(durable.presentation, undefined);
  assert.equal(durable.raw, answer);
  assert.deepEqual(hydrated.messages.filter(message => message.source === 'live'), open.messages);
  assert.deepEqual(hydrated.messages.map(message => message.id), ['saved', open.messages[0].id]);
});

test('accepted request header keeps its identity through the first reasoning message and settlement', () => {
  const user=row('request',{role:'user',content:'Question'});
  const pending=retainTurnPresentation([{kind:'message',id:user.id,row:user},{kind:'assistant-turn',id:'pending-turn:request',rows:[],parts:[]}],[]);
  const response=row('reply',{role:'assistant',content:[{type:'thinking',thinking:'Reason'},{type:'text',text:'Answer'}]});
  const live=retainTurnPresentation(buildTranscriptEntries([user,{...response,streaming:true}],{}).entries,pending);
  const saved=retainTurnPresentation(buildTranscriptEntries([user,response],{}).entries,live);
  for(const entries of [pending,live,saved]) { const turn=entries[1]; assert.equal(turn.kind,'assistant-turn'); if(turn.kind==='assistant-turn') assert.equal(assistantTurnKey(turn),'pending-turn:request'); }
  const unrelated=retainTurnPresentation(buildTranscriptEntries([row('other',{role:'user',content:'Question'}),response],{}).entries,pending);
  const other=unrelated[1];if(other.kind==='assistant-turn')assert.notEqual(assistantTurnKey(other),'pending-turn:request');
});
test('completed native response timestamps keep no-tool turn duration after reopening', () => {
  const response=row('reply',{role:'assistant',timestamp:1000,completedAt:6500,content:[{type:'thinking',thinking:'Reason'},{type:'text',text:'Answer'}]});
  const turn=buildTranscriptEntries([response],{}).entries[0];assert.equal(turn.kind,'assistant-turn');
  if(turn.kind==='assistant-turn'){ const summary=summarizeTurn(turn.parts,()=>({family:'other'}));assert.equal(summary.startedAt,1000);assert.equal(summary.endedAt,6500); }
});

test('turn facts count distinct files, errors but not stops, planned agents, and result time', () => {
  const source = row('a', { role: 'assistant', timestamp: 1000 });
  const tools: Extract<TurnPart, { kind: 'tool' }>[] = [
    { id: 'r1', name: 'read', status: 'complete' as const, args: { path: 'a.ts:1-4' } },
    { id: 'r2', name: 'read', status: 'error' as const, args: { path: 'a.ts:10-20' } },
    { id: 'edit', name: 'edit', status: 'complete' as const, args: { path: 'b.ts' }, result: { details: { perFileResults: [{ path: 'b.ts' }, { path: 'c.ts' }] } } },
    { id: 'command', name: 'command', status: 'interrupted' as const },
    { id: 'task', name: 'task', status: 'complete' as const, args: { tasks: [{ name: 'A' }, { name: 'B' }] }, result: { details: { results: [{ id: 'A' }] } } },
  ].map(tool => ({ kind: 'tool', key: tool.id, row: source, tool, resultRow: row(`r:${tool.id}`, { role: 'toolResult', timestamp: 5000 }) }));
  const summary = summarizeTurn([...tools, tools[0]], tool => ({ family: tool.name === 'read' ? 'read' : tool.name === 'edit' ? 'edit' : tool.name === 'task' ? 'task' : 'command', file: text(record(tool.args).path) ? { path: text(record(tool.args).path) } : undefined }));
  assert.deepEqual(summary, { steps: 5, readFiles: ['a.ts'], editedFiles: ['b.ts', 'c.ts'], commands: 1, searches: 0, agents: 2, messages: 0, failures: 1, startedAt: 1000, endedAt: 5000 });
  assert.equal(summarizeTurn([{ ...tools[4], tool: { id: 'result-only', name: 'task', status: 'complete', result: { details: { results: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] } } } }], () => ({ family: 'task' })).agents, 3);
});


test('thinking titles prefer the latest standalone summary heading', () => {
  assert.equal(thinkingPreview('**First**\n\nDetail\n\n**Latest**\n\nMore detail'), 'Latest');
  assert.equal(thinkingPreview('First paragraph\n\nLatest **paragraph**'), 'Latest paragraph');
  assert.equal(thinkingPreview(' \n '), '');
});
test('thinking paragraph titles stop at forty complete graphemes', () => {
  const glyph = '👩🏽‍💻';
  assert.equal(thinkingPreview('Old\n\n' + glyph.repeat(41)), glyph.repeat(40));
  assert.equal(thinkingPreview('e\u0301'.repeat(41)), 'e\u0301'.repeat(40));
});

test('consecutive thinking is one caption retaining every continuation anchor', () => {
  const first: TurnPart = { kind: 'thinking', key: 'first', row: row('a', { role: 'assistant' }), value: 'First' };
  const second: TurnPart = { kind: 'thinking', key: 'second', row: row('b', { role: 'assistant' }), value: 'Second' };
  const parts = buildTurnTimeline([first, second])[0].steps;
  assert.equal(parts.length, 1);
  if (parts[0].kind !== 'thinking') assert.fail('Expected merged thinking');
  assert.equal(parts[0].value, 'First\n\nSecond');
  assert.deepEqual(parts[0].continuations, [second]);
  assert.equal(first.value, 'First');
});

test('turn outcomes follow the latest assistant and explicit live interruption', () => {
  const failed = row('a', { role: 'assistant', stopReason: 'error' });
  const recovered = row('b', { role: 'assistant', stopReason: 'stop' });
  assert.equal(turnOutcome([failed]), 'error');
  assert.equal(turnOutcome([failed, recovered]), undefined);
  assert.equal(turnOutcome([recovered], 'aborted'), 'aborted');
  assert.equal(turnOutcome([row('c', { role: 'assistant', stopReason: 'aborted' }), row('d', { role: 'toolResult' })]), 'aborted');
});

test('pending submissions match one native user row each within the runtime and session', () => {
  const receipt: SubmissionReceipt = { id: 'one', runtimeId: 'runtime', sessionId: 'session', input: { text: 'Same prompt' }, submittedAt: 1000, status: 'accepted' };
  const old = row('old', { role: 'user', content: 'Same prompt', timestamp: 999 });
  assert.deepEqual(projectSubmissions([receipt], [old], 'runtime', 'session').pending, [receipt]);
  assert.deepEqual(projectSubmissions([receipt], [], 'other', 'session').pending, []);
  assert.deepEqual(projectSubmissions([receipt], [], 'runtime', 'other').pending, []);
  const delivered = row('new', { role: 'user', content: [{ type: 'text', text: 'Same prompt' }], timestamp: 1001 });
  const second = { ...receipt, id: 'two' };
  const result = projectSubmissions([receipt, second], [old, delivered], 'runtime', 'session');
  assert.deepEqual(result.pending, [second]);
  assert.equal(result.matched.get('new')?.id, 'one');
  for (const status of ['error', 'queue-accepted', 'accepted', 'unknown'] as const) assert.equal(projectSubmissions([{ ...receipt, status }], [], 'runtime', 'session').pending[0]?.status, status);
  for (const status of ['submitting', 'completed', 'local', 'aborted'] as const) assert.deepEqual(projectSubmissions([{ ...receipt, status }], [], 'runtime', 'session').pending, []);
});

test('stopped partial output remains visible while diagnostics stay in process details', () => {
  for (const flags of [{ stopReason: 'aborted' }, { errorId: 0x04000000 }, { errorMessage: 'Interrupted by user' }]) {
    const stopped = row('stopped', { role: 'assistant', content: 'Partial report', ...flags });
    assert.equal(isStoppedMessage(stopped.raw), true);
    assert.equal(turnOutcome([stopped]), 'aborted');
    const turn = buildTranscriptEntries([stopped], {}).entries[0];
    assert.equal(turn.kind, 'assistant-turn');
    if (turn.kind !== 'assistant-turn') return;
    const projection = projectTurn(turn);
    assert.deepEqual(projection.answer.map(part => part.kind === 'text' ? part.value : part.kind), ['Partial report']);
    assert.equal(projection.chapters.flatMap(chapter => chapter.steps).filter(part => part.kind === 'error').length, 1);
  }
});

test('terminal child yield exposes report while incremental yields remain work', () => {
  for (const args of [{ data: { result: 'Delivered' } }, { error: 'Blocked by access' }, {}]) {
    const messages = [row('child', { role: 'assistant', content: [{ type: 'text', text: 'Report prose' }, { type: 'toolCall', id: 'yield', name: 'yield', arguments: args }] }), row('result', { role: 'toolResult', toolCallId: 'yield', content: 'Submitted' })];
    const turn = buildTranscriptEntries(messages, {}).entries[0];
    if (turn.kind !== 'assistant-turn') assert.fail('Expected child turn');
    const response = projectTurn(turn).answer;
    assert.equal(response.find(part => part.kind === 'text')?.value, 'Report prose');
    assert.ok(response.every(part => part.row.id === 'child'));
  }
  const turn = buildTranscriptEntries([row('incremental', { role: 'assistant', content: [{ type: 'toolCall', id: 'yield', name: 'yield', arguments: { type: ['section'], data: { partial: true } } }] })], {}).entries[0];
  if (turn.kind !== 'assistant-turn') assert.fail('Expected child turn');
  assert.deepEqual(projectTurn(turn).answer, []);
});

test('structured yield keeps fenced report prose separate from metadata and retains the native report anchor', () => {
  const report = '## Reader report\n\n- Inspected **README.md**.\n\n```text\nReader: verification complete\n```';
  const data = { agent: 'Reader', report, expectedFailure: false };
  assert.deepEqual(projectYieldReport(data), { type: 'yield-report', prose: report, fields: [] });
  for (const name of ['summary', 'result', 'message', 'conclusion']) assert.equal(projectYieldReport({ [name]: report }).prose, report);
  assert.deepEqual(projectYieldReport({ count: 0, enabled: false }).fields, [{ name: 'count', label: 'Count', value: '0' }]);
  assert.deepEqual(projectYieldReport({}).fields, []);
  const turn = buildTranscriptEntries([row('native-final', { role: 'assistant', content: [{ type: 'toolCall', id: 'yield-report', name: 'yield', arguments: { data } }] }), row('receipt', { role: 'toolResult', toolCallId: 'yield-report', content: 'Submitted' })], {}).entries[0];
  if (turn.kind !== 'assistant-turn') assert.fail('Expected child turn');
  const response = projectTurn(turn).answer[0];
  assert.equal(response.kind, 'content');
  if (response.kind !== 'content') return;
  assert.equal(record(response.block).prose, report);
  assert.equal(response.row.id, 'native-final');
  assert.equal(response.key, 'native-final:report');
});

test('terminal yield joins native text on both sides of the call in history and live sequences', () => {
  const report = '## ScanFrontend report\n\n- Inspected **src/frontend.ts**.\n- Search and paced shell verification completed.\n- The deterministic fixture checks passed.\n\n```text\nScanFrontend: verification complete\n```';
  const args = { data: { agent: 'ScanFrontend', report, expectedFailure: false } };
  const final: NativeMessage = { role: 'assistant', content: [{ type: 'text', text: report.slice(0, -3) }, { type: 'toolCall', id: 'yield-call', name: 'yield', arguments: args, partialArgs: JSON.stringify(args), streamIndex: 0 }, { type: 'text', text: '```' }], stopReason: 'toolUse', timestamp: 1000 };
  const result: NativeMessage = { role: 'toolResult', toolCallId: 'yield-call', toolName: 'yield', content: [{ type: 'text', text: 'Result submitted.' }], details: { data: args.data, status: 'success' }, timestamp: 2000 };
  let live = createNativeLiveSequence();
  live = reduceNativeLiveSequence(live, { type: 'message_start', messageId: 'final', message: { role: 'assistant', content: [] } }, 'runtime', 'session');
  live = reduceNativeLiveSequence(live, { type: 'message_update', messageId: 'final', assistantMessageEvent: { partial: { ...final, content: [{ type: 'text', text: report.slice(0, -3) }, { type: 'toolCall', id: 'yield-call', name: 'yield', arguments: {}, partialArgs: '{"data":' }] } } }, 'runtime', 'session');
  const streaming = live.messages;
  live = reduceNativeLiveSequence(live, { type: 'message_end', messageId: 'final', message: final }, 'runtime', 'session');
  live = reduceNativeLiveSequence(live, { type: 'message_end', messageId: 'result', message: result }, 'runtime', 'session');
  for (const messages of [[row('final', final), row('result', result)], live.messages, streaming]) {
    const turn = buildTranscriptEntries(messages, {}).entries[0];
    if (turn.kind !== 'assistant-turn') assert.fail('Expected child turn');
    const projection = projectTurn(turn);
    if (messages === streaming) {
      assert.equal(projection.answer.length, 0);
      assert.equal(projection.epilogue.length, 0);
      assert.ok(projection.chapters.some(chapter => chapter.narration.some(part => part.kind === 'text' && part.value === report.slice(0, -3))));
      continue;
    }
    const prose = projection.answer.filter(part => part.kind === 'text');
    assert.equal(prose.length, 1);
    assert.equal(prose[0].value, report);
    assert.equal(prose[0].row.id, messages[0].id);
    assert.ok(projection.chapters.flatMap(chapter => chapter.steps).some(part => part.kind === 'tool' && part.tool.id === 'yield-call'));
    assert.ok(projection.answer.every(part => part.kind !== 'content' || record(part.block).prose === ''));
    assert.equal(prose[0].continuations?.[0].key, `${messages[0].id}:block:2`);
  }
});

test('yield metadata omits identity echoes and false or empty fields without losing meaningful facts', () => {
  const data = { report: 'Delivered report', agent: 'ScanFrontend', name: 'ScanFrontend', id: 'child', native_id: 'native-child', agentId: 'child', expectedFailure: false, empty: '', absent: null, missing: undefined, files: [], count: 0, durationMs: 16000, verified: true, paths: ['a.ts', 'b.ts'], status: 'passed' };
  assert.deepEqual(projectYieldReport(data).fields, [
    { name: 'count', label: 'Count', value: '0' },
    { name: 'durationms', label: 'Duration ms', value: '16000' },
    { name: 'verified', label: 'Verified', value: true },
    { name: 'paths', label: 'Paths', value: 'a.ts, b.ts' },
    { name: 'status', label: 'Status', value: 'passed' },
  ]);
  assert.deepEqual(projectYieldReport({ report: 'Expected failure observed', expectedFailure: true }).fields, [{ name: 'expectedfailure', label: 'Expected failure', value: true }]);
});

const changePart = (id: string, args: Record<string, unknown>, details: Record<string, unknown>, status: 'complete' | 'error' | 'running' = 'complete', name = 'edit'): TurnPart => ({ kind: 'tool', key: id, row: row(id, { role: 'assistant' }), tool: { id, name, args, status, result: { details } } });

test('turn changes retain create, update, delete and rename operations and producing steps', () => {
  const parts = [
    changePart('create', { path: 'new.ts', content: 'one\ntwo\n' }, { op: 'create', newText: 'one\ntwo\n' }, 'complete', 'write'),
    changePart('edit', { path: 'a.ts' }, { diff: '-2|old\n+2|new\n+3|extra' }),
    changePart('delete', {}, { path: 'gone.ts', op: 'delete', diff: '-1|gone' }),
    changePart('move', {}, { path: 'next.ts', sourcePath: 'old.ts', move: 'next.ts', op: 'update', diff: '' }),
  ];
  assert.deepEqual(turnChangedFiles(parts).map(file => [file.path, file.op, file.added, file.removed, file.steps.map(step => step.toolId)]), [
    ['new.ts', 'create', 2, 0, ['create']], ['a.ts', 'update', 2, 1, ['edit']], ['gone.ts', 'delete', 0, 0, ['delete']], ['next.ts', 'move', 0, 0, ['move']],
  ]);
  assert.equal(turnChangedFiles(parts)[3].sourcePath, 'old.ts');
});

test('multi-file edits aggregate repeated files once and retain the last successful producer', () => {
  const first = changePart('first', {}, { diff: '+1|aggregate must not double count', perFileResults: [
    { path: 'a.ts', op: 'create', newText: 'a\n' }, { path: 'b.ts', diff: '-4|b\n+4|B' },
  ] });
  const parts = [first, first, changePart('second', { input: '[a.ts#AB12]\nPUT >1:\n+x' }, { diff: '+2|x' })];
  const original = structuredClone(parts);
  assert.deepEqual(turnChangedFiles(parts).map(file => [file.path, file.added, file.removed, file.steps.map(step => step.toolId)]), [
    ['a.ts', 2, 0, ['first', 'second']], ['b.ts', 1, 1, ['first']],
  ]);
  assert.deepEqual(parts, original);
});

test('failed attempts do not fabricate changes or replace successful producer; partial success survives', () => {
  const parts = [
    changePart('ok', { path: 'a.ts' }, { diff: '+1|a' }),
    changePart('bad', { path: 'a.ts' }, { diff: '+1|not applied' }, 'error'),
    changePart('partial', {}, { perFileResults: [ { path: 'b.ts', diff: '+1|b' }, { path: 'c.ts', diff: '+1|no', isError: true, errorText: 'Denied' } ] }, 'error'),
    changePart('live', { path: 'live.ts' }, {}, 'running'),
    changePart('message', { path: 'agent://peer', content: 'hello' }, {}, 'complete', 'write'),
    changePart('device', { path: 'xd://lsp', content: '{}' }, {}, 'complete', 'write'),
    changePart('process', { path: 'proc://job', content: 'hello' }, {}, 'complete', 'write'),
    { ...changePart('result-error', { path: 'no.ts' }, {}), tool: { id: 'result-error', name: 'write', args: { path: 'no.ts' }, status: 'complete' as const, result: { isError: true } } },
  ];
  assert.deepEqual(turnChangedFiles(parts).map(file => [file.path, file.toolId, file.added]), [['a.ts', 'ok', 1], ['b.ts', 'partial', 1]]);
});

test('rename chains aggregate into the current file and writes without diffs remain explicitly unknown', () => {
  const files = turnChangedFiles([
    changePart('edit', { path: 'a.ts' }, { diff: '+1|a' }),
    changePart('rename', {}, { path: 'b.ts', sourcePath: 'a.ts', move: 'b.ts', diff: '' }),
    changePart('rename-again', {}, { path: 'c.ts', sourcePath: 'b.ts', move: 'c.ts', diff: '' }),
    changePart('write', { path: 'c.ts', content: 'replacement\n' }, {}, 'complete', 'write'),
  ]);
  assert.equal(files.length, 1);
  assert.deepEqual([files[0].path, files[0].sourcePath, files[0].op, files[0].added, files[0].countsKnown], ['c.ts', 'a.ts', 'move', 0, false]);
  assert.deepEqual(files[0].steps.map(step => step.toolId), ['edit', 'rename', 'rename-again', 'write']);
});

test('write and edit results use their resolved path to aggregate the same file', () => {
  const files = turnChangedFiles([
    changePart('write', { path: 'a.ts', content: 'before\n' }, { resolvedPath: '/project/a.ts' }, 'complete', 'write'),
    changePart('edit', { path: 'a.ts' }, { path: '/project/a.ts', diff: '-1|before\n+1|after' }),
  ], '/project');
  assert.equal(files.length, 1);
  assert.deepEqual([files[0].added, files[0].removed, files[0].countsKnown], [0, 0, false]);
  assert.deepEqual(files[0].steps.map(step => step.toolId), ['write', 'edit']);
});

test('full and partial read displays never stand in for byte-exact write baselines', () => {
  const read = changePart('read', { path: 'a.ts' }, { totalLines: 2, displayContent: { text: 'one\ntwo\n', startLine: 1 } }, 'complete', 'read');
  const write = changePart('write', { path: 'a.ts', content: 'one\nthree\n' }, { newText: 'one\nthree\n' }, 'complete', 'write');
  assert.deepEqual(turnChangedFiles([read, write]).map(file => [file.countsKnown, file.patch]), [[false, '']]);
  const partial = changePart('partial', { path: 'a.ts:2' }, { totalLines: 2, displayContent: { text: 'two', startLine: 2 } }, 'complete', 'read');
  assert.equal(turnChangedFiles([partial, write])[0].steps[0].unknownReason, 'missingBefore');
});
test('write after recorded edits compares with the edited content, not the earlier write', () => {
  const files = turnChangedFiles([
    changePart('create', { path: 'a.ts', content: 'one\ntwo\n' }, { op: 'create', newText: 'one\ntwo\n' }, 'complete', 'write'),
    changePart('edit', { path: 'a.ts' }, { diff: '-2|two\n+2|three' }),
    changePart('write', { path: './a.ts', content: 'one\nfour\n' }, { newText: 'one\nfour\n' }, 'complete', 'write'),
  ]);
  assert.deepEqual(files[0].steps.map(step => [step.added, step.removed, step.countsKnown]), [[2, 0, true], [1, 1, true], [1, 1, true]]);
  assert.deepEqual([files[0].added, files[0].removed, files[0].op], [2, 0, 'create']);
});

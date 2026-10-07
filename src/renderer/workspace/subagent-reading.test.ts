import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childLiveOverlayAllowed, childTranscriptReadingKey, childReadingAnchorAdjustment, rebaseChildReadingAnchors, reconcileChildMessages } from './subagent-reading';
import type { NativeMessage } from '../../shared/contracts';
import { createNativeLiveSequence, reduceNativeLiveSequence, reconcileNativeLiveSequence, type ChatMessage } from '../chat/model';
import { createReadingAnchor } from '../lib/transcript-reading-position';
import { buildTranscriptEntries } from '../chat/presentation';
import { projectTurn } from '../chat/turn-model';

const nativeAnswer = (content: unknown): NativeMessage => ({ role: 'assistant', timestamp: 100, provider: 'native', model: 'model', responseId: 'response-1', stopReason: 'stop', content });
const liveAnswer = (raw: NativeMessage): ChatMessage => ({ id: 'live:child:answer', source: 'live', streaming: false, raw, presentation: { id: 'live:child:answer', sessionId: 'child-source' } });

test('child persistence uses native identity despite signature removal and image references', () => {
  const cases = [
    { live: nativeAnswer([{ type: 'thinking', thinking: 'Plan', thinkingSignature: 'opaque' }, { type: 'text', text: 'Answer' }]), saved: nativeAnswer([{ type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Answer' }]) },
    { live: nativeAnswer([{ type: 'image', data: 'image', mimeType: 'image/png' }]), saved: nativeAnswer([{ type: 'image', data: 'image', mimeType: 'image/png', resourceReference: 'desktop-image:answer' }]) },
  ];
  for (const item of cases) {
    const live = liveAnswer(item.live);
    const saved = { id: 'saved-answer', resourceReference: 'desktop-entry:answer', raw: item.saved };
    const rows = reconcileChildMessages([saved], [live], 'child-source', true);
    assert.deepEqual(rows.map(row => row.id), ['saved-answer']);
    assert.equal(rows[0].raw, item.saved);
    assert.equal(rows[0].resourceReference, 'desktop-entry:answer');
    assert.equal(rows[0].presentation, live.presentation);
    const settled = reconcileChildMessages([saved], [], 'child-source', true, rows);
    assert.equal(settled[0].presentation, live.presentation);
    const replay = reconcileChildMessages([saved], [{ ...live, id: 'live:replay', presentation: { id: 'live:replay', sessionId: 'child-source' } }], 'child-source', true, settled);
    assert.deepEqual(replay.map(row => row.id), ['saved-answer']);
    assert.equal(replay[0].presentation, live.presentation);
    const entries = buildTranscriptEntries(rows, {}).entries;
    assert.equal(entries.length, 1);
    if (entries[0].kind !== 'assistant-turn') assert.fail('Expected one saved assistant turn');
    assert.deepEqual(projectTurn(entries[0]).answer.map(part => part.row.id), ['saved-answer']);
  }
});

test('ambiguous, streaming, incomplete and foreign child identities never suppress a live response', () => {
  const raw = nativeAnswer('Same prose');
  const saved = { id: 'saved-answer', raw };
  const live = liveAnswer(raw);
  assert.deepEqual(reconcileChildMessages([saved, { ...saved, id: 'other-answer' }], [live], 'child-source', true).map(row => row.id), ['saved-answer', 'other-answer', live.id]);
  assert.deepEqual(reconcileChildMessages([saved], [{ ...live, streaming: true }], 'child-source', true).map(row => row.id), ['saved-answer', live.id]);
  const incomplete = { ...raw, provider: undefined };
  assert.deepEqual(reconcileChildMessages([{ ...saved, raw: incomplete }], [liveAnswer(incomplete)], 'child-source', true).map(row => row.id), ['saved-answer', live.id]);
  assert.deepEqual(reconcileChildMessages([{ ...saved, raw: { ...raw, responseId: 'different-response' } }], [live], 'child-source', true).map(row => row.id), ['saved-answer', live.id]);
  assert.deepEqual(reconcileChildMessages([saved], [live], 'other-source', true).map(row => row.id), ['saved-answer']);
  assert.deepEqual(reconcileChildMessages([saved], [live], 'child-source', false).map(row => row.id), ['saved-answer']);
});

test('child answer restoration below expanded process resolves fragments rather than the enclosing turn alias', () => {
  const answer = createReadingAnchor({ presentationKey: 'answer:block:0', messageId: 'answer', turnId: 'turn' }, 20)!;
  const turn = createReadingAnchor({ minimapId: 'turn', messageId: 'answer', turnId: 'turn' }, -484)!;
  assert.equal(childReadingAnchorAdjustment([answer], [turn, answer]), 0);
  assert.equal(childReadingAnchorAdjustment([answer], [{ ...turn, top: -384 }, { ...answer, top: 120 }]), 100);
  assert.equal(childReadingAnchorAdjustment([{ id: 'answer', top: 20 }], [turn, answer]), 0);
  assert.equal(childReadingAnchorAdjustment([answer], [turn]), undefined);
});

test('child native travel survives a concurrent prepend and later text reflow', () => {
  const anchor = createReadingAnchor({ presentationKey: 'answer:block', messageId: 'answer' }, 40)!;
  const reading = { top: 600, follow: false, anchors: [anchor] };
  const text = [{ top: 220 }];
  // A 75px upward gesture and 120px insertion arrive before the scroll callback.
  rebaseChildReadingAnchors(reading, text, -75);
  assert.equal(childReadingAnchorAdjustment(reading.anchors, [{ ...anchor, top: 235 }]), 120);
  assert.equal(text[0].top, 295);
  // The next downward movement is retained; growth below contributes nothing.
  rebaseChildReadingAnchors(reading, text, 30);
  assert.equal(childReadingAnchorAdjustment(reading.anchors, [{ ...anchor, top: 85 }]), 0);
  assert.equal(text[0].top, 265);
});

test('child narration, task calls, results and custom delivery survive until their unique durable rows arrive', () => {
  const source = 'child-source';
  const raws: NativeMessage[] = [
    { ...nativeAnswer([{ type: 'text', text: 'Working' }, { type: 'toolCall', id: 'call', name: 'read', arguments: {} }]), timestamp: 101 },
    { role: 'toolResult', toolCallId: 'call', toolName: 'read', timestamp: 102, content: 'File' },
    { role: 'custom', customType: 'async-result', display: true, attribution: 'agent', timestamp: 103, content: 'Delivery', details: { jobs: [] } },
    { ...nativeAnswer('Answer'), timestamp: 104 },
  ];
  let sequence = createNativeLiveSequence();
  for (let index = 0; index < raws.length; index++) {
    sequence = reduceNativeLiveSequence(sequence, { type: 'message_start', message: raws[index] }, source, source);
    sequence = reduceNativeLiveSequence(sequence, { type: 'message_end', message: raws[index] }, source, source);
  }
  const before = reconcileChildMessages([], sequence.messages, source, true);
  assert.deepEqual(before.map(row => row.raw), raws);
  const saved = raws.slice(0, 3).map((raw, index) => ({ id: `saved-${index}`, resourceReference: `desktop-entry:${index}`, raw }));
  const after = reconcileChildMessages(saved, sequence.messages, source, true, before);
  assert.deepEqual(after.map(row => row.raw), raws);
  assert.deepEqual(after.slice(0, 3).map(row => row.presentation?.id), before.slice(0, 3).map(row => row.id));
  sequence = reconcileNativeLiveSequence(sequence, after.filter(row => row.source === 'history'), source);
  assert.deepEqual(sequence.messages.map(row => row.raw), [raws[3]]);
  assert.deepEqual(reconcileChildMessages(saved, sequence.messages, source, false).map(row => row.id), ['saved-0', 'saved-1', 'saved-2']);
});

test('latest parent leaf advancement retains child streaming while explicit history excludes it', () => {
  const source = { runtimeId: 'runtime', parentSessionPath: '/authorized-parent', parentHistoryFollowing: true, historyLeafId: 'parent-leaf-1', subagentId: 'saved-child', nativeId: 'native-child', parentToolCallId: 'spawn', historical: false };
  const reading = { runtimeId: source.runtimeId, observedLive: true, parentHistoryFollowing: true, historical: false, historyMode: false };
  const key = childTranscriptReadingKey(source);
  const initial: NativeMessage = { role: 'assistant', content: 'HOLD_STARTED', timestamp: 200 };
  let sequence = reduceNativeLiveSequence(createNativeLiveSequence(), { type: 'message_start', messageId: 'child-message', message: initial }, source.runtimeId, key);
  const saved = [{ id: 'saved-assignment', raw: { role: 'user', content: 'Assignment', timestamp: 100 } }];
  const first = reconcileChildMessages(saved, sequence.messages, key, childLiveOverlayAllowed(reading));
  assert.deepEqual(first.map(row => row.raw.content), ['Assignment', 'HOLD_STARTED']);
  const nextSource = { ...source, historyLeafId: 'parent-leaf-2' };
  const nextKey = childTranscriptReadingKey(nextSource);
  assert.equal(nextKey, key);
  const partial: NativeMessage = { ...initial, content: 'HOLD_STARTED stream pulse' };
  sequence = reduceNativeLiveSequence(sequence, { type: 'message_update', messageId: 'child-message', assistantMessageEvent: { type: 'text_delta', partial, contentIndex: 0, delta: ' stream pulse' } }, source.runtimeId, nextKey);
  const live = reconcileChildMessages(saved, sequence.messages, nextKey, childLiveOverlayAllowed(reading), first);
  assert.deepEqual(live.map(row => row.raw.content), ['Assignment', 'HOLD_STARTED stream pulse']);
  assert.equal(live[1]!.streaming, true);
  assert.equal(live[1]!.presentation?.id, first[1]!.presentation?.id);
  const historical = { ...nextSource, parentHistoryFollowing: false };
  const historicalKey = childTranscriptReadingKey(historical);
  assert.notEqual(historicalKey, nextKey);
  assert.notEqual(childTranscriptReadingKey({ ...historical, historyLeafId: 'different-selected-leaf' }), historicalKey);
  for (const excluded of [{ ...reading, parentHistoryFollowing: false }, { ...reading, before: { before: 'child-page-cursor' } }, { ...reading, historyMode: true }, { ...reading, historical: true }, { ...reading, observedLive: false }, { ...reading, runtimeId: null }]) {
    assert.deepEqual(reconcileChildMessages(saved, sequence.messages, nextKey, childLiveOverlayAllowed(excluded)).map(row => row.raw.content), ['Assignment']);
  }
});

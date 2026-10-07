import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdtemp, mkdir, open, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HistoryReader } from './journal';
import { reconcileChildMessages } from '../../renderer/workspace/subagent-reading';
import type { ChatMessage } from '../../renderer/chat/model';

const jsonl = (...rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
const timestamp = '2026-01-01T00:00:00.000Z';
const header = { type: 'session', version: 3, id: 'native', cwd: '/workspace', timestamp };
function message(id: string, parentId: string | null, content: unknown = id) {
  return { type: 'message', id, parentId, timestamp, message: { role: 'user', content } };
}
async function fixture(run: (reader: HistoryReader, path: string, blobs: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'omp-journal-'));
  const reader = new HistoryReader();
  const blobs = join(root, 'blobs');
  await mkdir(blobs);
  try { await run(reader, join(root, 'session.jsonl'), blobs, root); }
  finally { reader.close(); await rm(root, { recursive: true, force: true }); }
}

test('recorded model and thinking come from selected ancestry even outside the transcript page', async () => fixture(async (reader, path, blobs) => {
  const assistant = (id: string, parentId: string, provider: string, model: string) => ({type:'message',id,parentId,timestamp,message:{role:'assistant',provider,model,content:id}});
  await writeFile(path, jsonl(header, message('u',null), {type:'thinking_level_change',id:'t',parentId:'u',timestamp,thinkingLevel:'max'}, assistant('a','t','native','reasoner'), ...Array.from({length:205},(_,i)=>message(`u${i}`,i?`u${i-1}`:'a')), {type:'thinking_level_change',id:'other-t',parentId:'u',timestamp,thinkingLevel:'low'}, assistant('other','other-t','other-provider','other-model')));
  const selected = await reader.read({path,leafId:'u204'},blobs);
  assert.equal(selected.hasMore,true);
  assert.deepEqual(selected.selection,{model:{provider:'native',id:'reasoner'},thinkingLevel:'max'});
  assert.deepEqual((await reader.read({path},blobs)).selection,{model:{provider:'other-provider',id:'other-model'},thinkingLevel:'low'});
  assert.deepEqual((await reader.read({path,leafId:'u'},blobs)).selection,{});
}));

test('append and incomplete tails retain durable identities without changing original bytes', async () => fixture(async (reader, path, blobs) => {
  await writeFile(path, jsonl(header, message('one', null)));
  const first = await reader.read({ path }, blobs);
  const pending = JSON.stringify(message('two', 'one'));
  await appendFile(path, pending.slice(0, -5));
  const partial = await reader.read({ path }, blobs);
  assert.deepEqual(partial.messages.map(item => item.id), first.messages.map(item => item.id));
  assert.match(partial.diagnostics.join(' '), /Incomplete tail/);
  await appendFile(path, `${pending.slice(-5)}\n`);
  const complete = await reader.read({ path }, blobs);
  assert.deepEqual(complete.messages.map(item => item.entryId), ['one', 'two']);
  assert.equal(complete.messages[0]!.id, first.messages[0]!.id);
  const before = await readFile(path);
  assert.equal(await reader.revision(path), complete.revision);
  await reader.read({ path }, blobs);
  await reader.tree(path);
  assert.deepEqual(await readFile(path), before);
}));

test('journal activity follows selected ancestry and consumes tool starts without chat rows', async () => fixture(async (reader, path, blobs) => {
  const owner = { status: 'external' as const, checkedAt: Date.now() };
  const tool = { type: 'message', id: 'call', parentId: 'u', timestamp, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'check' } }] } };
  const start = { type: 'custom', customType: 'tool_execution_start', id: 'start', parentId: 'call', timestamp, data: { toolCallId: 't', toolName: 'bash', startedAt: Date.now(), intent: 'Checking' } };
  await writeFile(path, jsonl(header, message('u', null), tool, start, { type: 'title_change', id: 'title', parentId: 'start', timestamp, title: 'Work' }));
  const page = await reader.read({ path }, blobs);
  assert.deepEqual(page.messages.map(row => row.entryId), ['u', 'call']);
  assert.equal((await reader.activity(path, page.selectedLeafId, owner)).currentTool?.name, 'bash');
  await appendFile(path, jsonl({ type: 'message', id: 'result', parentId: 'title', timestamp, message: { role: 'toolResult', toolCallId: 't', toolName: 'bash', content: 'ok' } }));
  const after = await reader.read({ path }, blobs);
  assert.equal((await reader.activity(path, after.selectedLeafId, owner)).currentTool, undefined);
  await appendFile(path, jsonl({ type: 'custom', customType: 'session_exit', id: 'exit', parentId: 'result', timestamp, data: { reason: 'normal' } }));
  const exited = await reader.read({ path }, blobs);
  assert.equal((await reader.activity(path, exited.selectedLeafId, owner)).state, 'idle');
  assert.equal((await reader.activity(path, 'title', owner)).state, 'running');
}));

test('same-size title overwrite, truncation and atomic replacement invalidate the selected journal', async () => fixture(async (reader, path, blobs, root) => {
  const title = jsonl({ type: 'title', v: 1, title: 'First' });
  await writeFile(path, title + jsonl(header, message('one', null)));
  const first = await reader.read({ path }, blobs);
  const file = await open(path, 'r+');
  try { await file.write(Buffer.from(jsonl({ type: 'title', v: 1, title: 'Other' })), 0, Buffer.byteLength(title), 0); } finally { await file.close(); }
  const renamed = await reader.read({ path }, blobs);
  assert.equal(renamed.session.title, 'Other');
  assert.notEqual(renamed.revision, first.revision);
  await truncate(path, Buffer.byteLength(title + jsonl(header)));
  assert.deepEqual((await reader.read({ path }, blobs)).messages, []);
  const replacement = join(root, 'replacement');
  await writeFile(replacement, title + jsonl(header, message('new', null)));
  await rename(replacement, path);
  assert.deepEqual((await reader.read({ path }, blobs)).messages.map(item => item.entryId), ['new']);
  await assert.rejects(reader.read({ path, leafId: 'one' }, blobs), /no longer exists/);
}));

test('selected ancestry retains pre-clear messages, compaction archives and unresolved signed tool calls', async () => fixture(async (reader, path, blobs) => {
  const tool = { role: 'assistant', provider: 'native-provider', model: 'native-model', content: [{ type: 'thinking', thinking: 'Reason', thinkingSignature: 'signature' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'file' } }] };
  const compaction = { type: 'compaction', id: 'compact', parentId: 'tool', timestamp, method: 'snapcompact', summary: 'Summary', tokensBefore: 42, firstKeptEntryId: 'user', preserveData: { openaiRemoteCompaction: { replacementHistory: [{ secret: 'provider-only' }] }, snapcompact: { frames: [], textHead: 'Older archive', textTail: 'Newer archive', totalChars: 25, truncatedChars: 0 } } };
  await writeFile(path, jsonl(header, message('user', null), { type: 'message', id: 'tool', parentId: 'user', timestamp, message: tool }, compaction, { type: 'reset_boundary', id: 'clear', parentId: 'compact', timestamp }, message('after', 'clear'), { type: 'branch_summary', id: 'branch', parentId: 'user', timestamp, fromId: 'user', summary: 'Branch summary' }, message('other', 'branch'), { type: 'label', id: 'label', parentId: 'other', timestamp, targetId: 'user', label: 'Start' }));
  const active = await reader.read({ path }, blobs);
  assert.deepEqual(active.messages.map(item => item.entryId), ['user', 'branch', 'other']);
  const old = await reader.read({ path, leafId: 'after' }, blobs);
  assert.deepEqual(old.messages.map(item => item.entryId), ['user', 'tool', 'compact', 'clear', 'after']);
  assert.equal(old.messages[1]!.raw.role, 'assistant');
  assert.deepEqual(old.messages[1]!.raw.content, [{ type: 'thinking', thinking: 'Reason' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'file' } }]);
  assert.deepEqual(old.messages[2]!.raw.blocks, [{ type: 'text', text: 'Older archive' }, { type: 'text', text: 'Newer archive' }]);
  assert.equal(JSON.stringify(old).includes('provider-only'), false);
  assert.deepEqual((await reader.read({ path, leafId: null }, blobs)).messages, []);
  const tree = await reader.tree(path);
  assert.equal(tree.nodes.find(node => node.id === 'after')!.parentId, 'clear');
  assert.equal(tree.nodes.find(node => node.id === 'user')!.label, 'Start');
}));

test('every compaction summary remains recoverable without erasing selected messages', async () => fixture(async (reader, path, blobs) => {
  const compact = (id: string, parentId: string, summary: string) => ({ type: 'compaction', id, parentId, timestamp, method: 'snapcompact', firstKeptEntryId: 'one', tokensBefore: 100, summary });
  await writeFile(path, jsonl(header, message('one', null), compact('c1', 'one', 'First'), compact('c2', 'c1', 'Replacement'), message('two', 'c2'), compact('c3', 'two', 'Latest')));
  const snapshot = await reader.read({ path }, blobs);
  assert.deepEqual(snapshot.messages.map(item => item.entryId), ['one', 'c1', 'c2', 'two', 'c3']);
  assert.deepEqual(snapshot.messages.filter(item => item.raw.role === 'compactionSummary').map(item => item.raw.summary), ['First', 'Replacement', 'Latest']);
}));

test('bounded anchored windows retain native ancestry after appends and reject unrelated branches', async () => fixture(async (reader, path, blobs) => {
  const rows = Array.from({ length: 601 }, (_, index) => message(`m${index}`, index ? `m${index - 1}` : null));
  await writeFile(path, jsonl(header, ...rows, message('other', 'm0')));
  assert.deepEqual(await reader.nativeEntriesCursor(path), { sessionId: 'native', since: 'other' });
  const latest = await reader.read({ path, leafId: 'm600' }, blobs);
  assert.equal(latest.messages[0]!.entryId, 'm401');
  const earlier = await reader.read({ path, leafId: 'm600', beforeEntryId: latest.messages[0]!.id }, blobs);
  assert.equal(earlier.messages[0]!.entryId, 'm201');
  assert.equal(earlier.messages.at(-1)!.entryId, 'm400');
  await appendFile(path, jsonl(message('m601', 'm600')));
  assert.deepEqual(await reader.nativeEntriesCursor(path), { sessionId: 'native', since: 'm601' });
  const anchored = await reader.read({ path, leafId: 'm601', anchorId: 'native:m250' }, blobs);
  assert.equal(anchored.messages.length, 200);
  assert.equal(anchored.messages.at(-1)!.entryId, 'm250');
  const earliest = await reader.read({ path, leafId: 'm601', beforeEntryId: 'native:m51' }, blobs);
  assert.equal(earliest.hasMore, false);
  assert.equal(earliest.messages[0]!.entryId, 'm0');
  await assert.rejects(reader.read({ path, leafId: 'other', anchorId: 'native:m250' }, blobs), /selected branch/);
}));

test('hidden custom and metadata payloads never cross the snapshot while v1 IDs survive append', async () => fixture(async (reader, path, blobs) => {
  await writeFile(path, jsonl({ ...header, version: 1 }, { type: 'message', message: { role: 'user', content: 'Legacy' } }, { type: 'custom_message', customType: 'hidden', content: 'hidden-secret', display: false }, { type: 'custom', data: 'metadata-secret' }));
  const first = await reader.read({ path }, blobs);
  assert.equal(first.messages[0]!.entryId, undefined);
  await assert.rejects(reader.nativeEntriesCursor(path), /indexed native journal/);
  await appendFile(path, jsonl({ type: 'message', message: { role: 'hookMessage', content: 'Shown', display: true } }));
  const next = await reader.read({ path }, blobs);
  assert.equal(next.messages[0]!.id, first.messages[0]!.id);
  assert.equal(next.messages[1]!.raw.role, 'custom');
  assert.equal(next.messages[1]!.raw.display, false);
  assert.equal(next.messages[1]!.raw.content, '');
  assert.equal(next.messages[2]!.raw.content, 'Shown');
  assert.equal(JSON.stringify([next, await reader.tree(path)]).includes('-secret'), false);
  await writeFile(path, jsonl({ ...header, version: 2 }, { ...message('v2', null), message: { role: 'hookMessage', content: 'v2 visible', display: true } }));
  assert.equal((await reader.read({ path }, blobs)).messages[0]!.entryId, 'v2');
}));

test('opaque large signatures never replace short visible assistant content or mutate persistence', async () => fixture(async (reader, path, blobs) => {
  const content = [{ type: 'thinking', thinking: 'Readable reasoning', thinkingSignature: 's'.repeat(2 * 1024 * 1024) }, { type: 'text', text: 'Visible answer' }];
  const original = jsonl(header, { type: 'message', id: 'signed', parentId: null, timestamp, message: { role: 'assistant', content, providerPayload: { hidden: 'provider-only' } } }, message('large-user', 'signed', 'u'.repeat(2 * 1024 * 1024)));
  await writeFile(path, original);
  const page = await reader.read({ path }, blobs);
  assert.equal(page.messages[0]!.raw.role, 'assistant');
  assert.deepEqual(page.messages[0]!.raw.content, [{ type: 'thinking', thinking: 'Readable reasoning' }, { type: 'text', text: 'Visible answer' }]);
  assert.equal(page.messages[0]!.raw.historyResourceDeferred, undefined);
  assert.equal(page.messages[1]!.raw.role, 'user');
  assert.equal(page.messages[1]!.raw.historyResourceDeferred, true);
  assert.equal(page.messages[1]!.resourceReference, `desktop-entry:${Buffer.from('large-user').toString('base64url')}`);
  assert.equal(await readFile(path, 'utf8'), original);
}));

test('actual deferred assistant projection reconciles its native live identity and retains full source access', async () => fixture(async (reader, path, blobs) => {
  const raw = { role: 'assistant', timestamp: Date.parse(timestamp), provider: 'native-provider', model: 'native-model', responseId: 'native-response', stopReason: 'stop', content: [{ type: 'text', text: `${'a'.repeat(1024 * 1024)}END_OF_NATIVE_ANSWER` }] };
  const original = jsonl(header, { type: 'message', id: 'large-answer', parentId: null, timestamp, message: raw });
  await writeFile(path, original);
  const snapshot = await reader.read({ path }, blobs);
  const saved = snapshot.messages[0]!;
  assert.deepEqual(saved.raw, { role: 'assistant', historyResourceDeferred: true, content: '', timestamp: raw.timestamp, provider: raw.provider, model: raw.model, responseId: raw.responseId, stopReason: raw.stopReason });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 16 * 1024);
  assert.equal(saved.resourceReference, `desktop-entry:${Buffer.from('large-answer').toString('base64url')}`);
  const live: ChatMessage = { id: 'live:child:answer', source: 'live', streaming: false, raw, presentation: { id: 'live:child:answer', sessionId: 'child-source' } };
  const reconciled = reconcileChildMessages(snapshot.messages, [live], 'child-source', true);
  assert.deepEqual(reconciled.map(row => row.id), ['native:large-answer']);
  assert.equal(reconciled[0]!.raw, saved.raw);
  assert.equal(reconciled[0]!.presentation, live.presentation);
  assert.equal(reconciled[0]!.resourceReference, saved.resourceReference);
  let detail = await reader.entryDetail({ path, entryId: saved.entryId! });
  let complete = detail.content || '';
  while (detail.nextCursor) {
    detail = await reader.entryDetail({ path, entryId: saved.entryId!, cursor: detail.nextCursor });
    complete += detail.content || '';
  }
  assert.deepEqual(JSON.parse(complete), raw);
  assert.equal(await readFile(path, 'utf8'), original);
}));

test('deferred native identity is retained exactly within its byte bound and never partially truncated', async () => fixture(async (reader, path, blobs) => {
  for (const length of [512, 513]) {
    const raw = { role: 'assistant', timestamp: Date.parse(timestamp), provider: 'native-provider', model: 'native-model', responseId: 'r'.repeat(length), stopReason: 'stop', content: 'a'.repeat(1024 * 1024) };
    await writeFile(path, jsonl(header, { type: 'message', id: 'bounded', parentId: null, timestamp, message: raw }));
    const saved = (await reader.read({ path }, blobs)).messages[0]!;
    assert.equal(saved.raw.historyResourceDeferred, true);
    assert.equal(saved.raw.content, '');
    if (length === 512) assert.equal(saved.raw.responseId, raw.responseId);
    else for (const key of ['provider', 'model', 'responseId', 'stopReason']) assert.equal(saved.raw[key], undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(saved.raw)) < 4096);
  }
}));

test('pages expose every selected message once and reject cursors after revision changes', async () => fixture(async (reader, path, blobs) => {
  const rows = Array.from({ length: 451 }, (_, index) => message(`m${index}`, index ? `m${index - 1}` : null));
  await writeFile(path, jsonl(header, ...rows));
  let page = await reader.read({ path }, blobs);
  const cursor = page.nextBefore!;
  let messages = page.messages;
  while (page.hasMore) {
    assert.ok(page.messages.length <= 200);
    page = await reader.read({ path, before: page.nextBefore }, blobs);
    messages = [...page.messages, ...messages];
  }
  assert.deepEqual(messages.map(item => item.entryId), rows.map(row => row.id));
  await appendFile(path, jsonl(message('new', 'm450')));
  await assert.rejects(reader.read({ path, before: cursor }, blobs), /stale/);
}));

test('complete historical EOF loads, malformed lines diagnose, and cycles stay reachable', async () => fixture(async (reader, path, blobs) => {
  await writeFile(path, jsonl(header) + '{malformed}\n' + jsonl(message('cycle-a', 'cycle-b')) + JSON.stringify(message('cycle-b', 'cycle-a')));
  const snapshot = await reader.read({ path }, blobs);
  assert.deepEqual(snapshot.messages.map(item => item.entryId), ['cycle-a', 'cycle-b']);
  assert.match(snapshot.diagnostics.join(' '), /Malformed/);
  assert.match(snapshot.diagnostics.join(' '), /EOF/);
  assert.match(snapshot.diagnostics.join(' '), /cycle/);
  const tree = await reader.tree(path);
  assert.ok(tree.nodes.some(node => node.parentId === null));
}));

test('visible image blobs hydrate only bounded regular files inside the data root', async () => fixture(async (reader, path, blobs, root) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const hashes = ['a', 'b', 'c', 'd', 'e'].map(value => value.repeat(64));
  await writeFile(join(blobs, hashes[0]!), png);
  await writeFile(join(blobs, hashes[1]!), `data:image/png;base64,${png.toString('base64')}`);
  const outside = join(root, 'outside');
  await writeFile(outside, png);
  await symlink(outside, join(blobs, hashes[2]!));
  const oversized = await open(join(blobs, hashes[3]!), 'w');
  try { await oversized.truncate(10 * 1024 * 1024 + 1); } finally { await oversized.close(); }
  const content = [
    { type: 'image', data: `blob:sha256:${hashes[0]}`, mimeType: 'image/png' },
    { type: 'image_url', image_url: `blob:sha256:${hashes[1]}` },
    ...hashes.slice(2).map(hash => ({ type: 'image', data: `blob:sha256:${hash}`, mimeType: 'image/png' })),
    { type: 'image', data: 'blob:sha256:../../outside', mimeType: 'image/png' },
  ];
  await writeFile(path, jsonl(header, message('images', null, content)));
  const snapshot = await reader.read({ path }, blobs);
  const hydrated = snapshot.messages[0]!.raw.content as (typeof content[number] & { resourceReference?: string })[];
  assert.equal(hydrated[0]!.data, png.toString('base64'));
  assert.equal(hydrated[1]!.image_url, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(hydrated.slice(2).map(({ resourceReference: _reference, ...image }) => image), content.slice(2));
  assert.match(snapshot.diagnostics.join(' '), /symbolic link|escapes/);
  assert.match(snapshot.diagnostics.join(' '), /byte limit/);
  assert.match(snapshot.diagnostics.join(' '), /Invalid image blob/);
  assert.deepEqual(await readFile(outside), png);
}));

for (const version of [2, 3]) test(`v${version} oversized records retain a verified tail cursor and bounded source navigation`, async () => fixture(async (reader, path, blobs) => {
  const prefix = jsonl({ ...header, version }, message('first', null), message('huge', 'first', 'x'.repeat(17 * 1024 * 1024)));
  const original = prefix + jsonl(message('last', 'huge'));
  await writeFile(path, prefix);
  assert.deepEqual(await reader.nativeEntriesCursor(path), { sessionId: 'native', since: 'huge' });
  const tailPage = await reader.read({ path }, blobs);
  assert.equal(tailPage.messages.at(-1)!.entryId, 'huge');
  assert.equal(tailPage.messages.at(-1)!.raw.historyResourceDeferred, true);
  assert.match(tailPage.diagnostics.join(' '), /exceeds 16 MiB; bounded source detail/);
  await appendFile(path, jsonl(message('last', 'huge')));
  assert.deepEqual(await reader.nativeEntriesCursor(path), { sessionId: 'native', since: 'last' });
  const selected = await reader.read({ path, leafId: 'first' }, blobs);
  assert.deepEqual(selected.messages.map(item => item.entryId), ['first']);
  assert.equal(selected.selectedLeafId, 'first');
  const page = await reader.read({ path }, blobs);
  assert.deepEqual(page.messages.map(item => item.entryId), ['first', 'huge', 'last']);
  assert.equal(page.messages[0]!.raw.content, 'first');
  assert.equal(page.messages[2]!.raw.content, 'last');
  assert.ok(page.messages[1]!.resourceReference);
  assert.equal(page.messages[1]!.raw.historyResourceDeferred, true);
  assert.ok(page.sourceReference);
  assert.match(page.diagnostics.join(' '), /exceeds 16 MiB; bounded source detail/);
  const detail = await reader.entryDetail({ path, entryId: 'huge' });
  assert.ok(detail.nextCursor);
  assert.ok(Buffer.byteLength(detail.content!) <= 64 * 1024 + 3);
  assert.ok((await reader.entryDetail({ path, entryId: 'huge', cursor: detail.nextCursor })).nextCursor);
  assert.equal(await readFile(path, 'utf8'), original);
}));

test('native cursors reject unverifiable oversized identities but permit empty native journals', async () => fixture(async (reader, path) => {
  await writeFile(path, jsonl(header));
  assert.deepEqual(await reader.nativeEntriesCursor(path), { sessionId: 'native' });
  const oversized = message('huge', null, 'x'.repeat(17 * 1024 * 1024));
  for (const row of [{ ...oversized, id: '' }, { ...oversized, id: 'x'.repeat(513) }, { ...oversized, parentId: 42 }]) {
    await writeFile(path, jsonl(header, row));
    await assert.rejects(reader.nativeEntriesCursor(path), /indexed native journal/);
  }
  await writeFile(path, jsonl(header) + JSON.stringify(oversized).slice(0, -2));
  await assert.rejects(reader.nativeEntriesCursor(path), /indexed native journal/);
}));

test('aggregate image hydration stops before oversized IPC payloads while retaining references', async () => fixture(async (reader, path, blobs) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  // A valid ancillary text chunk makes the tiny image exactly 7 MiB without
  // pretending a PNG signature followed by zeroes is a decodable image.
  const chunk = Buffer.alloc(7 * 1024 * 1024 - png.length, 120);
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write('tEXtComment\0', 4, 'ascii');
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  const bytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  await writeFile(join(blobs, first), bytes);
  await writeFile(join(blobs, second), bytes);
  await writeFile(path, jsonl(header, message('images', null, [
    { type: 'image', data: `blob:sha256:${first}`, mimeType: 'image/png' },
    { type: 'image', data: `blob:sha256:${second}`, mimeType: 'image/png' },
  ])));
  const snapshot = await reader.read({ path }, blobs);
  const content = snapshot.messages[0]!.raw.content as { data: string; resourceReference: string; deferred?: boolean }[];
  assert.equal(content[0]!.data, bytes.toString('base64'));
  assert.equal(content[1]!.data, `blob:sha256:${second}`);
  assert.equal(content[0]!.deferred, undefined);
  assert.equal(content[1]!.deferred, true);
  for (const image of content) {
    const saved = await reader.imageDetail({ path, reference: image.resourceReference }, blobs);
    assert.equal(saved.dataUrl, `data:image/png;base64,${bytes.toString('base64')}`);
  }
  const detail = await reader.entryDetail({ path, entryId: 'images' });
  assert.deepEqual(detail.imageReferences?.map(image => image.reference), content.map(image => image.resourceReference));
}));

test('native inline file mention images survive bounded previews through source-bound detail', async () => fixture(async (reader, path, blobs, root) => {
  // A complete one-pixel GIF, enlarged with a legal comment extension rather
  // than corrupt raster bytes, exceeds the inline message preview budget.
  const gif = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex');
  const comment = Buffer.alloc(4096 * 256, 120);
  for (let offset = 0; offset < comment.length; offset += 256) comment[offset] = 255;
  const data = Buffer.concat([gif.subarray(0, -1), Buffer.from([0x21, 0xfe]), comment, Buffer.from([0, 0x3b])]).toString('base64');
  const image = { type: 'image', mimeType: 'image/gif', data };
  const hidden = { type: 'image', mimeType: 'image/gif', data: gif.toString('base64') };
  const mention = { role: 'fileMention', timestamp: Date.parse(timestamp), files: [{ path: '/workspace/pixel.gif', content: '', image, details: { image: hidden } }], image: hidden, details: { files: [{ image: hidden }] }, providerPayload: { files: [{ image: hidden }] } };
  const original = jsonl(header, { type: 'message', id: 'mention', parentId: null, timestamp, message: mention });
  await writeFile(path, original);
  const snapshot = await reader.read({ path }, blobs);
  assert.equal(snapshot.messages[0]!.raw.historyResourceDeferred, true);
  assert.equal(snapshot.messages[0]!.raw.files, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 1024 * 1024);
  const detail = await reader.entryDetail({ path, entryId: 'mention' });
  assert.ok(detail.nextCursor);
  assert.deepEqual(detail.imageReferences?.map(item => item.name), ['Image 1']);
  const reference = detail.imageReferences![0]!.reference;
  const saved = await reader.imageDetail({ path, reference }, blobs);
  assert.equal(saved.dataUrl, `data:image/gif;base64,${data}`);
  assert.deepEqual(saved.diagnostics, []);
  const handle = JSON.parse(Buffer.from(reference.slice('desktop-image:'.length), 'base64url').toString('utf8'));
  const hiddenReference = `desktop-image:${Buffer.from(JSON.stringify({ ...handle, index: 1 })).toString('base64url')}`;
  await assert.rejects(reader.imageDetail({ path, reference: hiddenReference }, blobs), /does not belong to this visible entry/);
  const unrelated = join(root, 'unrelated.jsonl');
  await writeFile(unrelated, original);
  await assert.rejects(reader.imageDetail({ path: unrelated, reference }, blobs), /another source/);
  assert.equal(await readFile(path, 'utf8'), original);
}));

test('gzip history is readonly and explicit fork staging preserves and verifies artifacts', async () => fixture(async (reader, _path, blobs, root) => {
  const path = join(root, 'saved.jsonl.gz');
  const original = gzipSync(jsonl({ ...header, parentSession: 'ancestor', previousSessionFiles: ['/missing/saved.jsonl'] }, message('one', null)));
  await writeFile(path, original);
  await mkdir(join(root, 'saved'));
  await writeFile(join(root, 'saved', '0.bash.log'), 'original artifact');
  const snapshot = await reader.read({ path }, blobs);
  assert.equal(snapshot.session.sourceKind, 'archive');
  assert.equal(snapshot.session.writable, false);
  assert.equal(snapshot.session.parentSession, 'ancestor');
  assert.deepEqual(snapshot.messages.map(item => item.raw.content), ['one']);
  const fork = await reader.forkSource(path);
  try {
    assert.equal(await readFile(fork.path, 'utf8'), jsonl({ ...header, parentSession: 'ancestor', previousSessionFiles: ['/missing/saved.jsonl'] }, message('one', null)));
    const destination = join(root, 'destination.jsonl');
    await writeFile(destination, jsonl({ ...header, id: 'forked', parentSession: header.id }, message('one', null)));
    await mkdir(join(root, 'destination'));
    await writeFile(join(root, 'destination', '0.bash.log'), 'damaged');
    await assert.rejects(fork.verify!(destination));
    await writeFile(join(root, 'destination', '0.bash.log'), 'original artifact');
    await fork.verify!(destination);
  } finally { await fork.cleanup!(); }
  await assert.rejects(readFile(fork.path));
  assert.deepEqual(await readFile(path), original);
  assert.equal(await readFile(join(root, 'saved', '0.bash.log'), 'utf8'), 'original artifact');
}));

test('fork recovery requires a persisted readable source with the current native identity', async () => fixture(async (reader, path) => {
  assert.equal(await reader.canFork(path, header.id), false);
  await assert.rejects(reader.forkSource(path), /readable persisted source/);
  await writeFile(path, jsonl(header, message('one', null)));
  assert.equal(await reader.canFork(path, header.id), true);
  assert.equal(await reader.canFork(path, 'different-native-session'), false);
  assert.equal((await reader.forkSource(path)).path, path);
  await rm(path);
  assert.equal(await reader.canFork(path, header.id), false);
  await assert.rejects(reader.forkSource(path), /readable persisted source/);
  await writeFile(path, 'invalid source\n');
  assert.equal(await reader.canFork(path, header.id), false);
}));

test('saved tool output exposes literal text and the matching ancestor command without changing raw pages', async () => fixture(async (reader, path) => {
  const call = { type: 'message', id: 'call', parentId: null, timestamp, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'right', name: 'bash', arguments: { command: 'npm test' } }] } };
  const unrelated = { ...call, id: 'other', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'right', name: 'bash', arguments: { command: 'wrong branch' } }] } };
  const raw = { role: 'toolResult', toolName: 'bash', toolCallId: 'right', content: [{ type: 'text', text: 'first\nsecond\n<script>literal</script>' }] };
  await writeFile(path, jsonl(header, call, unrelated, { type: 'message', id: 'result', parentId: 'call', timestamp, message: raw }));
  const detail = await reader.entryDetail({ path, entryId: 'result' });
  assert.deepEqual(detail.display, { title: 'bash · npm test', content: 'first\nsecond\n<script>literal</script>', language: 'bash' });
  assert.deepEqual(JSON.parse(detail.content!), raw);
}));

test('readable output stays bounded and marks truncation while raw cursors retain the complete result', async () => fixture(async (reader, path) => {
  const text = '中文😀\n'.repeat(30000) + 'END_OF_RESULT';
  const raw = { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text }], details: { resolvedPath: '/workspace/README.md' } };
  await writeFile(path, jsonl(header, { type: 'message', id: 'result', parentId: null, timestamp, message: raw }));
  let page = await reader.entryDetail({ path, entryId: 'result' });
  assert.equal(page.display?.truncated, true);
  assert.ok(Buffer.byteLength(page.display!.content) <= 256 * 1024);
  assert.ok(text.startsWith(page.display!.content));
  assert.doesNotMatch(page.display!.content, /[\uD800-\uDBFF]$/);
  let complete = page.content!;
  while (page.nextCursor) { page = await reader.entryDetail({ path, entryId: 'result', cursor: page.nextCursor }); complete += page.content; }
  assert.equal(JSON.parse(complete).content[0].text, text);
}));

test('evidence hydration projects complete oversized native rows without unrelated payloads', async () => fixture(async (reader, path) => {
  const padding = 'x'.repeat(17 * 1024 * 1024);
  const diff = '@@ -1 +1 @@\n-old\n+新😀\n';
  const oldText = 'old\n', newText = '新😀\n';
  await writeFile(path, jsonl(header,
    { type: 'message', id: 'user', parentId: null, timestamp, message: { content: padding, role: 'user', userInitiated: true } },
    { padding, type: 'message', id: 'call', parentId: 'user', timestamp, message: { content: [{ type: 'toolCall', id: 'native-tool', name: 'edit', arguments: { input: '[中文.ts#ABCD]\n' + padding } }], role: 'assistant' }, after: padding },
    { padding, type: 'message', id: 'result', parentId: 'call', timestamp, message: { padding, content: [{ type: 'text', text: diff }], details: { perFileResults: [{ path: '中文.ts', oldText, newText, diff, op: 'update' }] }, toolName: 'edit', role: 'toolResult', toolCallId: 'native-tool' }, after: padding },
    { type: 'message', id: 'next', parentId: 'result', timestamp, message: { content: padding, role: 'user' } }));
  const page = await reader.readEvidence({ path, leafId: 'next' });
  assert.deepEqual(page.messages.map(entry => [entry.entryId, entry.raw.role]), [['user', 'user'], ['call', 'assistant'], ['result', 'toolResult'], ['next', 'user']]);
  assert.equal(page.messages[0]!.raw.userInitiated, true);
  assert.deepEqual(page.messages[1]!.raw.content, [{ type: 'toolCall', id: 'native-tool', name: 'edit', arguments: {} }]);
  const call = await reader.readEvidenceEntry({ path, revision: page.revision, entryId: 'call' });
  assert.deepEqual(call.raw.content, [{ type: 'toolCall', id: 'native-tool', name: 'edit', arguments: { input: '[中文.ts#ABCD]' } }]);
  const result = await reader.readEvidenceEntry({ path, revision: page.revision, entryId: 'result' });
  assert.deepEqual(result.raw.content, [{ type: 'text', text: diff }]);
  assert.deepEqual(result.raw.details, { perFileResults: [{ path: '中文.ts', oldText, newText, diff, op: 'update' }] });
  assert.equal(result.raw.padding, undefined);
}));

test('oversized malformed native rows cannot establish evidence ancestry', async () => fixture(async (reader, path) => {
  const padding = 'x'.repeat(17 * 1024 * 1024);
  await writeFile(path, jsonl(header, message('valid', null)) + '{"padding":"' + padding + '","type":"message","id":"bad","parentId":"valid","message":{"role":"user"},}\n');
  const page = await reader.readEvidence({ path });
  assert.deepEqual(page.messages.map(entry => entry.entryId), ['valid']);
}));

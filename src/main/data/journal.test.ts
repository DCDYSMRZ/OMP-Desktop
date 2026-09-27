import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, mkdtemp, mkdir, open, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HistoryReader } from './journal';

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

test('hidden custom and metadata payloads never cross the snapshot while v1 IDs survive append', async () => fixture(async (reader, path, blobs) => {
  await writeFile(path, jsonl({ ...header, version: 1 }, { type: 'message', message: { role: 'user', content: 'Legacy' } }, { type: 'custom_message', customType: 'hidden', content: 'hidden-secret', display: false }, { type: 'custom', data: 'metadata-secret' }));
  const first = await reader.read({ path }, blobs);
  assert.equal(first.messages[0]!.entryId, undefined);
  await appendFile(path, jsonl({ type: 'message', message: { role: 'hookMessage', content: 'Shown', display: true } }));
  const next = await reader.read({ path }, blobs);
  assert.equal(next.messages[0]!.id, first.messages[0]!.id);
  assert.equal(next.messages[1]!.raw.role, 'custom');
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

test('oversized records retain neighbouring ancestry and bounded source navigation', async () => fixture(async (reader, path, blobs) => {
  const original = jsonl(header, message('first', null), message('huge', 'first', 'x'.repeat(17 * 1024 * 1024)), message('last', 'huge'));
  await writeFile(path, original);
  const page = await reader.read({ path }, blobs);
  assert.deepEqual(page.messages.map(item => item.entryId), ['first', 'huge', 'last']);
  assert.equal(page.messages[0]!.raw.content, 'first');
  assert.equal(page.messages[2]!.raw.content, 'last');
  assert.ok(page.messages[1]!.resourceReference);
  const detail = await reader.entryDetail({ path, entryId: 'huge' });
  assert.ok(detail.nextCursor);
  assert.ok(Buffer.byteLength(detail.content!) <= 64 * 1024 + 3);
  assert.ok((await reader.entryDetail({ path, entryId: 'huge', cursor: detail.nextCursor })).nextCursor);
  assert.equal(await readFile(path, 'utf8'), original);
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

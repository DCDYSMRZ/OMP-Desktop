import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MessageSearch } from './message-search';
import { HistoryReader } from './journal';

const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const message = (id: string, role: string, content: unknown) => ({ type: 'message', id, parentId: null, timestamp: '2025-01-01T00:00:00Z', message: { role, content } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omp-message-search-'));
  const agent = join(root, 'agent');
  const sessions = join(agent, 'sessions', 'bucket');
  const archives = join(agent, 'archive', 'sessions');
  await mkdir(sessions, { recursive: true });
  await mkdir(archives, { recursive: true });
  const context = async () => ({ executable: '', cwd: root, env: { HOME: root, PI_CODING_AGENT_DIR: agent } });
  const approved = new Set<string>();
  const approve = async (path: string) => { if (!approved.has(path)) throw new Error('Unauthorized path'); return path; };
  const header = { type: 'session', version: 3, id: 'fixture', cwd: root, title: 'Earlier conversation' };
  return { root, agent, sessions, archives, context, approve, approved, header };
}

test('JSONL/gzip searches visible text with CJK, all tokens, original offsets and newest source first', async () => {
  const f = await fixture();
  try {
    const old = join(f.archives, 'old.jsonl.gz');
    const recent = join(f.sessions, 'recent.jsonl');
    await writeFile(old, gzipSync(jsonl(f.header,
      message('old-answer', 'assistant', [{ type: 'thinking', thinking: 'private-only' }, { type: 'text', text: 'x'.repeat(90) + '你好 WORLD archive' + 'z'.repeat(90) }]),
      message('tool', 'toolResult', '你好 WORLD'), message('private', 'assistant', [{ type: 'thinking', thinking: '你好 WORLD' }]),
      message('partial', 'user', '你好 only'), message('unicode', 'assistant', 'İ before WORLD'),
    )));
    await writeFile(recent, jsonl(f.header, message('new-request', 'user', 'world 你好')));
    await utimes(old, new Date(0), new Date(0));
    const service = new MessageSearch(f.context, f.approve);
    const result = await service.search({ query: '你好 world' });
    assert.deepEqual(result.results.map(hit => hit.entryId), ['new-request', 'old-answer', 'tool']);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.scannedFiles, 2);
    const hit = result.results[1]!;
    assert.equal(hit.snippet.slice(...hit.match), '你好');
    assert.equal(hit.match[0], 61);
    assert.equal(hit.timestamp, Date.parse('2025-01-01T00:00:00Z'));
    assert.equal(hit.title, 'Earlier conversation');
    const unicode = await service.search({ query: 'world before' });
    assert.equal(unicode.results[0]?.snippet.slice(...unicode.results[0].match), 'before');
    assert.equal((await service.search({ query: 'private-only' })).results.length, 0);
    f.approved.add(old);
    assert.deepEqual((await service.search({ query: '你好 world', path: old })).results.map(hit => hit.entryId), ['old-answer', 'tool']);
    await assert.rejects(service.search({ query: 'world', path: recent }), /Unauthorized/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('result, file and decompressed byte caps report partial coverage', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i++) await writeFile(join(f.sessions, `${i}.jsonl`), jsonl(f.header, message(`id${i}`, 'user', 'needle')));
    const limited = await new MessageSearch(f.context, f.approve).search({ query: 'needle', limit: 2 });
    assert.equal(limited.results.length, 2);
    assert.equal(limited.truncated, true);
    assert.deepEqual(limited.coverage.reasons, ['results']);
    const files = await new MessageSearch(f.context, f.approve, { files: 1, bytes: 8192, timeMs: 1500 }).search({ query: 'needle' });
    assert.equal(files.results.length, 1);
    assert.equal(files.truncated, true);
    assert.ok(files.coverage.reasons.includes('file'));
    const path = join(f.archives, 'large.jsonl.gz');
    await writeFile(path, gzipSync(jsonl(f.header, message('early', 'user', 'needle'), message('large', 'assistant', 'x'.repeat(10000)), message('late', 'user', 'needle'))));
    f.approved.add(path);
    const bytes = await new MessageSearch(f.context, f.approve, { files: 1000, bytes: 1024, timeMs: 1500 }).search({ query: 'needle', path });
    assert.deepEqual(bytes.results.map(hit => hit.entryId), ['early']);
    assert.equal(bytes.truncated, true);
    assert.deepEqual(bytes.coverage.reasons, ['bytes']);
    assert.equal(bytes.coverage.complete, false);
    await assert.rejects(new MessageSearch(f.context, f.approve).search({ query: 'x', limit: 101 }));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('registered unreadable sources and corrupt gzip produce diagnostics without losing readable siblings', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sessions, 'valid.jsonl'), jsonl(f.header, message('valid', 'user', 'needle')));
    await writeFile(join(f.archives, 'corrupt.jsonl.gz'), 'not a gzip');
    await mkdir(join(f.agent, 'custom-session-files'));
    await writeFile(join(f.agent, 'custom-session-files', 'missing'), join(f.root, 'missing.jsonl'));
    const external = join(f.root, 'unregistered.jsonl');
    await writeFile(external, jsonl(f.header, message('external', 'user', 'needle')));
    await symlink(external, join(f.sessions, 'symlink.jsonl'));
    const result = await new MessageSearch(f.context, f.approve).search({ query: 'needle' });
    assert.deepEqual(result.results.map(hit => hit.entryId), ['valid']);
    assert.equal(result.diagnostics.length, 2);
    assert.deepEqual(result.coverage.reasons, ['unreadable']);
    assert.ok(result.diagnostics.some(value => value.includes('missing.jsonl')));
    assert.ok(result.diagnostics.some(value => value.includes('corrupt.jsonl.gz')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('new requests cancel pending discovery and time budget includes discovery', async t => {
  const f = await fixture();
  try {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const service = new MessageSearch(async () => { await gate; return f.context(); }, f.approve);
    const previous = service.search({ query: 'needle' });
    const latest = service.search({ query: '' });
    assert.equal((await previous).truncated, true);
    assert.deepEqual((await latest).results, []);
    release();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { promise: discovery, resolve: finishDiscovery } = Promise.withResolvers<void>();
    const timed = new MessageSearch(async () => { await discovery; return f.context(); }, f.approve, { files: 100, bytes: 1024, timeMs: 10 });
    const pending = timed.search({ query: 'needle' });
    t.mock.timers.tick(10);
    const result = await pending;
    finishDiscovery();
    assert.equal(result.truncated, true);
    assert.ok(result.diagnostics.some(value => value.includes('time budget')));
    assert.deepEqual(result.coverage.reasons, ['time']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('legacy search ids land on the same synthetic entry as the saved reader', async () => {
  const f = await fixture();
  const reader = new HistoryReader();
  try {
    const path = join(f.sessions, 'legacy.jsonl');
    await writeFile(path, jsonl({ ...f.header, version: 1 }, { type: 'model_change', modelId: 'old' }, { type: 'message', message: { role: 'user', content: 'legacy needle' } }));
    const result = await new MessageSearch(f.context, f.approve).search({ query: 'legacy needle' });
    assert.equal(result.results.length, 1);
    const hit = result.results[0]!;
    const page = await reader.read({ path, leafId: hit.entryId, anchorId: hit.entryId }, f.root);
    assert.equal(page.messages.at(-1)?.id, `fixture:${hit.entryId}`);
    assert.equal(page.messages.at(-1)?.raw.content, 'legacy needle');
  } finally { reader.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('tool call arguments and result details are searchable while thinking is explicitly excluded', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sessions, 'tools.jsonl'), jsonl(f.header,
      message('call', 'assistant', [{ type: 'toolCall', name: 'read', arguments: { path: 'proc://worker/output' } }]),
      { ...message('result', 'toolResult', [{ type: 'text', text: 'finished' }]), message: { role: 'toolResult', toolName: 'read', content: 'finished', details: { resource: 'proc://worker/output' } } },
      message('hidden', 'assistant', [{ type: 'thinking', thinking: 'proc://worker/output' }]),
    ));
    const result = await new MessageSearch(f.context, f.approve).search({ query: 'proc://worker' });
    assert.deepEqual(result.results.map(hit => [hit.entryId, hit.role]), [['call', 'assistant'], ['result', 'toolResult']]);
    assert.equal(result.results[0].snippet.slice(...result.results[0].match), 'proc://worker');
    assert.equal(result.results[1].toolName, 'read');
    assert.equal(result.results[1].position, 2);
    assert.equal(result.results[1].timestamp, Date.parse('2025-01-01T00:00:00Z'));
    assert.equal(result.coverage.includesToolContent, true);
    assert.deepEqual(result.coverage.excludes, ['attachments', 'sidecars', 'thinking']);
    assert.equal(result.coverage.complete, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

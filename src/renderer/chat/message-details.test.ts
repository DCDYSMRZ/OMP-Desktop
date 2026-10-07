import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactionBlocks, compactionPreview, literalFileReferences, nativeTaskChild, partitionSourceDiagnostics, sessionResourceReferences, visibleImage } from './message-details';

test('visible native carriers normalize without traversing hidden provider replay', () => {
  const data = 'iVBORw0KGgo=';
  const dataUrl = `data:image/png;base64,${data}`;
  assert.deepEqual(visibleImage({ type: 'image', mimeType: 'image/png', data }), { dataUrl });
  assert.deepEqual(visibleImage({ type: 'image_generation_call', result: data }), { dataUrl });
  assert.deepEqual(visibleImage({ type: 'image_url', image_url: { url: dataUrl } }), { dataUrl });
  assert.deepEqual(visibleImage({ type: 'input_image', image_url: dataUrl }), { dataUrl });
  assert.equal(visibleImage({ providerPayload: { type: 'image_generation_call', result: data } }), undefined);
});

test('blob references, corrupt data and oversized images never become image URLs', () => {
  for (const data of ['blob:sha256:' + 'a'.repeat(64), '', 'invalid!bytes', 'A'.repeat(14 * 1024 * 1024)]) {
    const image = visibleImage({ type: 'image', mimeType: 'image/png', data });
    assert.equal(image?.dataUrl, undefined);
    assert.equal(typeof image?.reason, 'string');
  }
  assert.equal(visibleImage({ type: 'image', data: 'data:image/svg+xml;base64,AAAA' })?.dataUrl, undefined);
});

test('ordered compaction blocks do not duplicate their legacy image mirrors', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
  const blocks = [{ type: 'text', text: 'old region' }, image, { type: 'text', text: 'new region' }];
  const raw = { blocks, images: [image] };
  assert.deepEqual(compactionBlocks(raw), blocks);
  assert.deepEqual(compactionBlocks({ images: [image] }), [image]);
});

test('compaction previews clean multiline Markdown without damaging literal identifiers', () => {
  assert.equal(compactionPreview('# **Saved context**\n- [entry](artifact://1)\n> `FIXTURE_CHILD`', 'fallback'), 'Saved context entry FIXTURE_CHILD');
  assert.equal(compactionPreview(' \n ', '## Continue\n\n1. Open api_client.ts\n2. Keep a*b'), 'Continue Open api_client.ts Keep a*b');
  assert.equal(compactionPreview('', ''), '');
});

test('artifact recovery selectors remain intact and distinct references remain reachable', () => {
  assert.deepEqual(sessionResourceReferences('See [source](artifact://task/region:10-20), then artifact://task/region:10-20 and artifact://other:raw.'), ['artifact://task/region:10-20', 'artifact://other:raw']);
});

test('native output links retain nested identity and structured selectors', () => {
  assert.deepEqual(sessionResourceReferences('[result](agent://Planner.Worker/items/0), again agent://Planner.Worker/items/0. Other agent://Planner and artifact://9:raw.'), ['agent://Planner.Worker/items/0', 'agent://Planner', 'artifact://9:raw']);
});

test('native shake placeholders preserve separate recovery regions and whitespace', () => {
  const source = '[shaken ~100 tokens — recover: artifact://7 (region 1)]\n[shaken ~100 tokens — recover: artifact://7 (region 2)]\nAgain artifact://7 (region 2).';
  assert.deepEqual(sessionResourceReferences(source), ['artifact://7 (region 1)', 'artifact://7 (region 2)']);
  assert.deepEqual(sessionResourceReferences('Read artifact://8\t(region 3), then artifact://9:2-4,8:raw.'), ['artifact://8\t(region 3)', 'artifact://9:2-4,8:raw']);
});

test('intentional image deferral never conceals an actual source error', () => {
  const image = { type: 'image', mimeType: 'image/png', data: 'blob:sha256:' + 'a'.repeat(64), resourceReference: 'desktop-image:saved', deferred: true };
  assert.deepEqual(visibleImage(image), { deferred: true });
  assert.deepEqual(visibleImage({ ...image, unavailableReason: 'Saved image is missing' }), { reason: 'Saved image is missing' });
  assert.equal(visibleImage({ ...image, resourceReference: undefined })?.deferred, undefined);
});

test('source information is deduplicated without hiding unknown or material diagnostics', () => {
  const information = 'Default view follows the last persisted entry, not a verified active native leaf.';
  const material = 'Archive source is missing';
  assert.deepEqual(partitionSourceDiagnostics([information, material, information, material, 'Unrecognized source condition']), { information: [information], material: [material, 'Unrecognized source condition'] });
});

test('literal human file links stay actionable without treating external protocols as files', () => {
  assert.deepEqual(literalFileReferences('[code](src/main.ts) [again](src/main.ts) [readme](./README.md) [unsafe](javascript:alert) [web](https://example.com) [resource](artifact://1) [section](#here)'), ['src/main.ts', './README.md']);
});

test('task links require unique native aliases rather than historical desktop identifiers', () => {
  const saved = { id: 'saved-worker', historical: true };
  assert.equal(nativeTaskChild([saved], 'saved-worker'), undefined);
  const child = { ...saved, nativeId: 'worker' };
  assert.equal(nativeTaskChild([child], 'worker'), child);
  assert.equal(nativeTaskChild([child, { id: 'live-worker', nativeId: 'worker' }], 'worker'), undefined);
  assert.equal(nativeTaskChild([{ id: 'live-worker' }], 'live-worker')?.id, 'live-worker');
});

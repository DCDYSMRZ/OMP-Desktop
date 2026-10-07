import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REVEAL_GLYPHS, REVEAL_DURATION, StreamingReveal, revealPieces } from './streaming-reveal';

const frame = 1000 / 60;

test('steady stream releases each arrival within 250 ms', () => {
  const state = new StreamingReveal('', true, 0);
  const arrivals: number[] = [];
  let previous = 0;
  for (let step = 1; step <= 180; step++) {
    const now = step * frame;
    if (step <= 120 && step % 2 === 0) {
      state.update(state.source + '中'.repeat(60), true, false, now);
      arrivals.push(...Array<number>(60).fill(now));
    }
    state.tick(now);
    for (let index = previous; index < state.released; index++) assert.ok(now - arrivals[index] <= 250 + 0.001);
    previous = state.released;
  }
  assert.equal(state.text, state.source);
});

test('60 grapheme burst follows the exponential release and finishes within 200 ms plus one frame', () => {
  const state = new StreamingReveal('', true, 0);
  state.update('中'.repeat(60), true, false, 0);
  let remaining = 60;
  let elapsed = 0;
  for (let step = 1; remaining; step++) {
    elapsed = step * frame;
    remaining -= Math.max(1, Math.ceil(remaining * (1 - Math.exp(-frame / 60))));
    state.tick(elapsed);
    assert.equal(state.released, 60 - remaining);
  }
  assert.ok(elapsed <= 200 + frame);
});

test('250 ms cap releases old ranges without forcing newly arrived ranges', () => {
  const state = new StreamingReveal('', true, 0);
  state.update('a'.repeat(10000), true, false, 0);
  for (let now = 1; now <= 249; now++) state.tick(now);
  state.update(state.source + 'b'.repeat(10000), true, false, 249);
  state.tick(250);
  assert.ok(state.released >= 10000);
  assert.ok(state.released < state.source.length);
  assert.equal(state.text.slice(0, 10000), 'a'.repeat(10000));
});

test('stream end uses tau 30 and forces remaining backlog at 120 ms', () => {
  const state = new StreamingReveal('', true, 0);
  state.update('中'.repeat(10000), true, false, 0);
  state.update(state.source, false, false, 0);
  state.tick(30);
  assert.equal(state.released, Math.ceil(10000 * (1 - Math.exp(-1))));
  state.update(state.source, false, false, 60);
  state.tick(119);
  assert.ok(state.released < 10000);
  state.tick(120);
  assert.equal(state.released, 10000);
});

test('history, replacements and reduced motion release immediately without fades', () => {
  const history = new StreamingReveal('saved', false, 0);
  history.update('saved answer', false, false, 0);
  assert.equal(history.text, 'saved answer');
  assert.equal(history.pending, false);
  const state = new StreamingReveal('', true, 0);
  state.update('backlog'.repeat(100), true, false, 0);
  state.tick(frame);
  state.update('replacement', true, false, frame);
  assert.equal(state.text, 'replacement');
  assert.equal(state.pending, false);
  state.update(state.source + 'more'.repeat(100), true, false, frame);
  state.tick(frame * 2);
  state.update(state.source, true, true, frame * 2);
  assert.equal(state.text, state.source);
  assert.equal(state.glyphs.size, 0);
  assert.equal(state.pending, false);
});

test('saved append after a completed live drain is immediate and unfaded', () => {
  const state = new StreamingReveal('', true, 0);
  state.update('live', true, false, 0);
  state.update(state.source, false, false, 0);
  state.tick(120);
  state.update('live saved continuation', false, false, 130);
  assert.equal(state.text, 'live saved continuation');
  assert.equal(state.glyphs.size, 0);
  assert.equal(state.pending, false);
});

test('only the newest 128 released graphemes fade, for 220 ms from their own release', () => {
  const state = new StreamingReveal('', true, 0);
  state.update('中'.repeat(1000), true, false, 0);
  state.tick(250);
  assert.equal(state.glyphs.size, 128);
  assert.equal(MAX_REVEAL_GLYPHS, 128);
  assert.equal(state.glyphs.has(871), false);
  assert.equal(state.glyphs.get(872)?.at, 250);
  assert.equal(revealPieces(state.text, state.text, 0, state, 469).filter(piece => piece.at !== undefined).length, 128);
  state.tick(470);
  assert.equal(state.glyphs.size, 0);
  assert.equal(REVEAL_DURATION, 220);
});

test('grapheme clusters are atomic and retained fades never restart on append', () => {
  const clusters = ['中', '👩🏽‍💻', 'é', '🇨🇳', 'क्‍ष'];
  const raw = clusters.join('');
  const boundaries = new Set(clusters.map((_, index) => clusters.slice(0, index + 1).join('').length));
  const state = new StreamingReveal('', true, 0);
  state.update(raw, true, false, 0);
  for (let now = frame; state.text !== raw; now += frame) {
    state.tick(now);
    assert.ok(boundaries.has(state.released));
  }
  const glyph = state.glyphs.get(0)!;
  state.update(raw + ' more', true, false, 100);
  state.tick(110);
  assert.equal(state.glyphs.get(0)?.at, glyph.at);
});

test('transport chunks preserve split surrogate and extending grapheme identity', () => {
  const state = new StreamingReveal('', true, 0);
  state.update('\uD83D', true, false, 0);
  state.tick(20);
  assert.equal(state.text, '');
  state.update('👩🏽‍💻', true, false, 20);
  state.tick(40);
  assert.equal(state.text, '👩🏽‍💻');
  state.update(state.source + 'e', true, false, 40);
  state.tick(60);
  const at = state.glyphs.get('👩🏽‍💻'.length)?.at;
  state.update(state.source + '́', true, false, 60);
  assert.equal(state.text, '👩🏽‍💻é');
  assert.equal(state.glyphs.get('👩🏽‍💻'.length)?.at, at);
  assert.equal(state.glyphs.size, 2);
});

test('Markdown escapes and entities preserve subsequent literal glyph identity', () => {
  const raw = '\\* &amp; 中文';
  const state = new StreamingReveal('', true, 0);
  state.update(raw, true, false, 0);
  state.tick(250);
  const pieces = revealPieces('* & 中文', raw, 0, state, 250);
  assert.equal(pieces.map(piece => piece.text).join(''), '* & 中文');
  assert.equal(pieces.find(piece => piece.text === '中')?.offset, raw.indexOf('中'));
  assert.equal(pieces.find(piece => piece.text === '*')?.offset, 1);
});

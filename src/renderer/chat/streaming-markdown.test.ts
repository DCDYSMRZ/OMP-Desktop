import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { rehypeStreamingText } from './streaming-markdown';
import { MAX_REVEAL_GLYPHS, REVEAL_DURATION, StreamingReveal } from './streaming-reveal';

function animatedOffsets(raw: string, state: StreamingReveal): number[] {
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { children: raw, rehypePlugins: [[rehypeStreamingText, { offset: 0, raw, reveal: state }]] }));
  return Array.from(html.matchAll(/data-reveal-offset="(\d+)"/g), match => Number(match[1]));
}

test('large live Markdown keeps wrappers bounded and settled blocks plain', () => {
  const raw = '# History\n\n' + 'Settled words 中文 '.repeat(400) + '\n\nNew **中文 Latin** text';
  const state = new StreamingReveal(raw.slice(0, -25), true);
  state.update(raw, true, false);
  state.tick(performance.now() + 250);
  const offsets = animatedOffsets(state.text, state);
  assert.equal(state.text, raw);
  assert.ok(offsets.length > 0);
  assert.ok(offsets.length <= MAX_REVEAL_GLYPHS);
  assert.ok(offsets.every(offset => offset >= raw.length - 25));
  state.tick(performance.now() + 250 + REVEAL_DURATION);
  assert.deepEqual(animatedOffsets(state.text, state), []);
});

test('history and replacement Markdown never carry animated wrappers', () => {
  const raw = '# 中文 history\n\n**Latin** and [link](https://example.com)';
  const state = new StreamingReveal(raw, false);
  assert.deepEqual(animatedOffsets(raw, state), []);
  state.update('Replacement **answer**', true, false);
  assert.deepEqual(animatedOffsets(state.text, state), []);
});

test('reparsing closed emphasis preserves settled offsets and source identities', () => {
  const state = new StreamingReveal('Old ', true);
  state.update('Old **中文 Latin', true, false);
  state.tick(performance.now() + 100);
  const firstOffsets = animatedOffsets(state.text, state);
  const times = new Map(state.glyphs);
  state.update('Old **中文 Latin**', true, false);
  state.tick(performance.now() + 140);
  const secondOffsets = animatedOffsets(state.text, state);
  assert.ok(firstOffsets.includes(6));
  assert.ok(secondOffsets.includes(6));
  assert.equal(state.glyphs.get(6)?.at, times.get(6)?.at);
  assert.ok(secondOffsets.every(offset => offset >= 4));
});

test('code, pre, math and table subtrees have no glyph wrappers', () => {
  const raw = 'abcdefghijklmnop';
  const state = new StreamingReveal('', true, 0);
  state.update(raw, true, false, 0);
  state.tick(performance.now());
  for (const tagName of ['code', 'pre', 'math', 'table']) {
    const child = { type: 'element', tagName, children: [{ type: 'text', value: raw, position: { start: { offset: 0 }, end: { offset: raw.length } } }] };
    const tree = { type: 'root', children: [child] };
    const before = structuredClone(tree);
    rehypeStreamingText({ offset: 0, raw, reveal: state })(tree, { data: {} });
    assert.deepEqual(tree, before);
  }
});

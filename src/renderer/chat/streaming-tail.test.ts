import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { markdownRemarkPlugins } from '../lib/markdown-blocks';
import { remarkStreamingTail } from './streaming-tail';
import { rehypeStreamingText } from './streaming-markdown';
import { StreamingReveal } from './streaming-reveal';

function render(raw: string, streaming = true, reveal?: StreamingReveal, offset = 0) {
  return renderToStaticMarkup(createElement(ReactMarkdown, { children: raw, remarkPlugins: [...markdownRemarkPlugins, [remarkStreamingTail, { raw, streaming }]], rehypePlugins: [rehypeRaw, rehypeSanitize, [rehypeStreamingText, { raw, offset, reveal }]] }));
}

/** Advance paced release on 16 ms frames. Times are anchored at the real clock
 * because the rehype pass reads `performance.now()` to decide which fades are live. */
function frames(state: StreamingReveal, from: number, to: number) {
  for (let now = from; now <= to; now += 16) state.tick(now);
}

test('unfinished live emphasis and code lose only their opening markers', () => {
  for (const marker of ['**', '__', '*', '_', '`', '``']) {
    assert.equal(render(`Prefix ${marker}ScanB`), '<p>Prefix ScanB</p>');
    assert.equal(render(`Prefix ${marker}`), '<p>Prefix </p>');
    assert.match(render(`Prefix ${marker}ScanB`, false), /ScanB/);
    assert.equal(render(`Prefix ${marker}ScanB`, false).includes(marker), true);
  }
  assert.equal(render('- **ScanB'), '<ul>\n<li>ScanB</li>\n</ul>');
});

test('completed syntax retains normal formatting and partial links retain their label', () => {
  assert.equal(render('**bold** __strong__ *em* _italic_ `code`'), '<p><strong>bold</strong> <strong>strong</strong> <em>em</em> <em>italic</em> <code>code</code></p>');
  assert.equal(render('Read [docs](https://example.com'), '<p>Read docs</p>');
  assert.equal(render('Read [docs](https://example.com/a(b)'), '<p>Read docs</p>');
  assert.equal(render('Read [docs](https://example.com/a(b))'), '<p>Read <a href="https://example.com/a(b)">docs</a></p>');
  assert.equal(render('Read [docs](https://example.com', false).includes('[docs]('), true);
});

test('history, earlier blocks, literal identifiers, escapes, code and math stay unchanged', () => {
  assert.equal(render('**unfinished\n\nTail *live'), '<p>**unfinished</p>\n<p>Tail live</p>');
  for (const raw of ['snake_case and snake__case', String.raw`Escaped \*star and \_under`, '`**literal**`', '```text\n**literal _code [text](url\n```', '```text\n**unfinished', '$x ** y$', '$x **unfinished', '$$\nx ** y\n$$', '$$\nx **unfinished']) {
    assert.equal(render(raw), render(raw, false), raw);
  }
});

test('closing delimiters preserve original reveal offsets and glyph start times', () => {
  const t0 = performance.now();
  const state = new StreamingReveal('Old ', true, t0);
  state.update('Old **中', true, false, t0);
  frames(state, t0 + 16, t0 + 64);
  const at = state.glyphs.get(6)?.at;
  assert.equal(typeof at, 'number');
  assert.match(render(state.text, true, state), /data-reveal-offset="6"/);
  assert.doesNotMatch(render(state.text, true, state), /\*\*/);
  state.update('Old **中文**', true, false, t0 + 80);
  frames(state, t0 + 96, t0 + 160);
  const closed = render(state.text, true, state);
  assert.match(closed, /<strong>/);
  assert.match(closed, /data-reveal-offset="6"/);
  assert.equal(state.glyphs.get(6)?.at, at);
  state.tick(t0 + 1000);
  assert.equal(render(state.text, true, state), '<p>Old <strong>中文</strong></p>');
});

test('omitted markers do not shift offsets across escapes, entities or block origins', () => {
  const raw = 'Old **&amp;中';
  const prefix = 'Earlier block\n\n';
  const t0 = performance.now();
  const state = new StreamingReveal(prefix + 'Old ', true, t0);
  state.update(prefix + raw, true, false, t0);
  frames(state, t0 + 16, t0 + 160);
  const offset = prefix.length + raw.indexOf('中');
  const html = render(raw, true, state, prefix.length);
  assert.match(html, new RegExp(`data-reveal-offset="${offset}"`));
  assert.doesNotMatch(html, /\*\*/);
  assert.match(html, /&amp;/);
});

test('a completed link retains the label glyph identity without revealing its destination', () => {
  const raw = 'Old [文](https://example.com';
  const t0 = performance.now();
  const state = new StreamingReveal('Old ', true, t0);
  state.update(raw, true, false, t0);
  frames(state, t0 + 16, t0 + 64);
  const at = state.glyphs.get(5)?.at;
  assert.equal(typeof at, 'number');
  const partial = render(raw, true, state);
  assert.match(partial, /data-reveal-offset="5"/);
  assert.doesNotMatch(partial, /https:|<a /);
  state.update(raw + ')', true, false, t0 + 80);
  frames(state, t0 + 96, t0 + 144);
  const complete = render(raw + ')', true, state);
  assert.ok(complete.includes('href="https://example.com"'));
  assert.match(complete, /data-reveal-offset="5"/);
  assert.equal(state.glyphs.get(5)?.at, at);
});

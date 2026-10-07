import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { imageMarkers, referencedImageIndices, rehypeInlineImageMarkers } from './inline-image-markers';

test('only valid attachment indices become markers and original spelling is retained', () => {
  const source = 'A [Image #2, 1252x200] B [Image #1,1568×923] [Image #3, 1x1] [Image #0, 1x1]';
  assert.deepEqual(imageMarkers(source, 2).map(({ index, literal }) => ({ index, literal })), [{ index: 1, literal: '[Image #2, 1252x200]' }, { index: 0, literal: '[Image #1,1568×923]' }]);
  assert.deepEqual(imageMarkers(source, 0), []);
});

test('normal prose markers map in order without consuming code or link examples', () => {
  const source = '[Image #1, 2x2] **[Image #2, 3x3]** ` [Image #3, 4x4] `\n\n```text\n[Image #4, 5x5]\n```\n\n[[Image #5, 6x6]](https://example.com)';
  assert.deepEqual([...referencedImageIndices([source], 5)], [0, 1]);
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { children: source, rehypePlugins: [[rehypeInlineImageMarkers, { count: 5 }]] }));
  assert.deepEqual([...html.matchAll(/data-image-marker="(\d+)"/g)].map(match => Number(match[1])), [0, 1]);
  assert.ok(html.includes('[Image #3, 4x4]'));
  assert.ok(html.includes('[Image #4, 5x5]'));
});

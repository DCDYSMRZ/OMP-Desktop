import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceReadScope } from './source-read-scope';

test('obsolete source generations cannot overwrite a newer hierarchy even after returning to the same source', () => {
  const first = new SourceReadScope('source-A:leaf-1:revision-1');
  const pending = first.begin();
  first.invalidate();
  const second = new SourceReadScope('source-B:leaf-2:revision-2');
  const current = second.begin();
  assert.equal(pending(), false);
  assert.equal(current(), true);
  second.invalidate();
  const returned = new SourceReadScope(first.key);
  assert.equal(pending(), false);
  assert.equal(returned.begin()(), true);
});

test('superseded page reads cannot publish a mismatched transcript or resource context', async () => {
  const scope = new SourceReadScope('child:leaf-1:revision-1');
  let resolveOld!: (value: { transcript: string; context: string }) => void;
  const old = new Promise<{ transcript: string; context: string }>(resolve => { resolveOld = resolve; });
  let displayed = { transcript: 'initial', context: 'initial' };
  const acceptsOld = scope.begin();
  const completion = old.then(result => { if (acceptsOld()) displayed = result; });
  const acceptsNew = scope.begin();
  if (acceptsNew()) displayed = { transcript: 'earlier-page', context: 'earlier-source' };
  resolveOld({ transcript: 'latest-page', context: 'obsolete-source' });
  await completion;
  assert.deepEqual(displayed, { transcript: 'earlier-page', context: 'earlier-source' });
  scope.invalidate();
  assert.equal(acceptsNew(), false);
});

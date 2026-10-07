import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionResourceContext } from '../../shared/contracts';
import { retainPanelSourceTabs } from './panel-source-removal';
import { SourceReadScope } from './source-read-scope';

test('removal revokes pending resource navigation without clearing an unrelated tab or blocking restored sources', async () => {
  const removed = { id: 'removed', scope: new SourceReadScope('removed'), context: { kind: 'saved', parentPath: '/removed.jsonl' } as SessionResourceContext };
  const kept = { id: 'kept', scope: new SourceReadScope('kept'), context: { kind: 'runtime', runtimeId: 'kept' } as SessionResourceContext };
  let tabs = [removed, kept];
  const { promise, resolve } = Promise.withResolvers<void>();
  const late = promise.then(() => { if (removed.scope.active) tabs.push(removed); });
  tabs = retainPanelSourceTabs(tabs, { runtimeIds: [], sourcePath: '/removed.jsonl' });
  resolve(); await late;
  assert.deepEqual(tabs.map(tab => tab.id), ['kept']);
  assert.equal(kept.scope.active, true);
  const restored = { ...removed, scope: new SourceReadScope('restored') };
  tabs.push(restored);
  assert.equal(restored.scope.active, true);
  assert.equal(removed.scope.active, false);
});

test('resolved child source and complete owner removal revoke exact outstanding tab reads', () => {
  const child = { id: 'child', scope: new SourceReadScope('child') };
  const kept = { id: 'kept', scope: new SourceReadScope('kept') };
  const acceptsChild = child.scope.begin();
  const tabs = retainPanelSourceTabs([child, kept], { runtimeIds: ['removed'] }, false, { child: { kind: 'runtime', runtimeId: 'removed' } });
  assert.deepEqual(tabs.map(tab => tab.id), ['kept']);
  assert.equal(acceptsChild(), false);
  const acceptsKept = kept.scope.begin();
  assert.deepEqual(retainPanelSourceTabs(tabs, { runtimeIds: [] }, true), []);
  assert.equal(acceptsKept(), false);
});

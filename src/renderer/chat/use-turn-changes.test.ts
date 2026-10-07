import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopApi, HistoryEvent, HistorySnapshot } from '../../shared/contracts';
import type { TurnChangeEvent, TurnChangeQuery, TurnChangeResult } from '../../shared/turn-change-types';
import { observeTurnChanges } from './use-turn-changes';

function fixture(query: TurnChangeQuery, enabled = true) {
  const changes = new Set<(event: TurnChangeEvent) => void>();
  const history = new Set<(event: HistoryEvent) => void>();
  const requests: { query: TurnChangeQuery; resolve: (result: TurnChangeResult) => void }[] = [];
  const received: TurnChangeResult[] = [];
  const errors: unknown[] = [];
  const api: Pick<DesktopApi, 'getTurnChanges' | 'onTurnChanges' | 'onHistoryEvent'> = {
    getTurnChanges: bound => { const { promise, resolve } = Promise.withResolvers<TurnChangeResult>(); requests.push({ query: bound, resolve }); return promise; },
    onTurnChanges: listener => { changes.add(listener); return () => { changes.delete(listener); }; },
    onHistoryEvent: listener => { history.add(listener); return () => { history.delete(listener); }; },
  };
  let close = observeTurnChanges(api, query, result => received.push(result), cause => errors.push(cause), enabled);
  return { changes, history, requests, received, errors, close: () => close(),
    admit: (nextQuery: TurnChangeQuery, nextEnabled?: boolean) => {
      close();
      close = observeTurnChanges(api, nextQuery, result => received.push(result), cause => errors.push(cause), nextEnabled);
    },
    change: (event: TurnChangeEvent) => { for (const listener of changes) listener(event); },
    snapshot: (path: string, revision: string, childrenRevision?: string) => {
      const snapshot = { revision, selectedLeafId: 'leaf', activity: childrenRevision ? { childrenRevision } : undefined } as HistorySnapshot;
      for (const listener of history) listener({ kind: 'snapshot', path, snapshot });
    },
  };
}
const result = (revision: string, state: TurnChangeResult['state'] = 'complete'): TurnChangeResult => ({
  id: 'same-turn', revision, state, files: [],
  coverage: { snapshot: 'unavailable', evidence: state === 'complete' ? 'complete' : 'partial', reasons: state === 'complete' ? [] : ['Child evidence pending'], excluded: [] },
});
async function settled() { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }

test('same saved turn follows source and child revisions without stale completion or unrelated source refresh', async () => {
  const query: TurnChangeQuery = { context: { kind: 'saved', parentPath: '/saved.jsonl', leafId: 'leaf' }, anchorId: 'session:answer', toolCallIds: ['unchanged-parent-tool'] };
  const f = fixture(query);
  try {
    f.requests[0].resolve(result('initial'));
    await settled();
    assert.equal(f.received.at(-1)?.revision, 'initial');
    f.snapshot('/unrelated.jsonl', 'other-parent', 'other-child');
    f.change({ sourcePath: '/unrelated.jsonl' });
    assert.equal(f.requests.length, 1, 'unrelated sources must not read the selected turn');

    f.snapshot('/saved.jsonl', 'parent-r2', 'child-r1');
    f.requests[1].resolve(result('parent-r2'));
    await settled();
    assert.equal(f.received.at(-1)?.revision, 'parent-r2');
    f.snapshot('/saved.jsonl', 'parent-r2', 'child-r1');
    assert.equal(f.requests.length, 2, 'repeated activity snapshots must not reread unchanged evidence');

    f.snapshot('/saved.jsonl', 'parent-r2', 'child-r2');
    f.snapshot('/saved.jsonl', 'parent-r2', 'child-r3');
    // The main watcher also notifies when pinned/presence activity has no child revision.
    f.change({ sourcePath: '/saved.jsonl' });
    f.change({ sourcePath: '/saved.jsonl' });
    assert.equal(f.requests.length, 3, 'pending invalidations coalesce rather than flood the evidence queue');
    f.requests[2].resolve(result('child-r2'));
    await settled();
    assert.equal(f.received.at(-1)?.revision, 'parent-r2', 'invalidated pending evidence cannot replace the visible result');
    assert.equal(f.requests.length, 4, 'one read after settlement must observe the latest child revision');
    f.requests[3].resolve(result('child-r3', 'partial'));
    await settled();
    assert.equal(f.received.at(-1)?.revision, 'child-r3');
    assert.equal(f.received.at(-1)?.state, 'partial');

    f.change({ sourcePath: '/saved.jsonl' });
    f.requests[4].resolve(result('child-r4'));
    await settled();
    assert.equal(f.received.at(-1)?.revision, 'child-r4');
    assert.deepEqual(f.received.at(-1)?.coverage.reasons, [], 'new evidence replaces rather than merges old partial coverage');
    assert.ok(f.requests.every(request => request.query === query), 'invalidation preserves the authorized branch and anchor');

    f.change({ sourcePath: '/saved.jsonl' });
    f.change({ sourcePath: '/saved.jsonl' });
    f.close();
    assert.equal(f.changes.size, 0);
    assert.equal(f.history.size, 0);
    f.requests[5].resolve(result('after-unmount'));
    await settled();
    assert.equal(f.received.at(-1)?.revision, 'child-r4', 'cleanup rejects an in-flight completion');
    f.snapshot('/saved.jsonl', 'parent-r3');
    f.change({ sourcePath: '/saved.jsonl' });
    assert.equal(f.requests.length, 6, 'cleanup detaches both listeners and cancels a queued refresh');
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('runtime turn invalidations remain scoped to their runtime', async () => {
  const f = fixture({ context: { kind: 'runtime', runtimeId: 'owned' }, anchorId: 'answer' });
  try {
    f.snapshot('/saved.jsonl', 'parent-r2', 'child-r2');
    f.change({ runtimeId: 'other' });
    f.change({ sourcePath: '/saved.jsonl' });
    assert.equal(f.requests.length, 1);
    f.change({ runtimeId: 'owned' });
    f.requests[0].resolve(result('owned-r1'));
    await settled();
    assert.equal(f.received.length, 0);
    f.requests[1].resolve(result('owned-r2'));
    await settled();
    assert.deepEqual(f.received.map(value => value.revision), ['owned-r2']);
  } finally { f.close(); }
  assert.equal(f.changes.size, 0);
  assert.equal(f.history.size, 0);
});

test('offscreen admission waits for visibility and resumes current authorized evidence without clearing received results', async () => {
  const query: TurnChangeQuery = { context: { kind: 'saved', parentPath: '/saved.jsonl', leafId: 'leaf' }, anchorId: 'answer' };
  const f = fixture(query, false);
  try {
    f.snapshot('/saved.jsonl', 'offscreen-r1');
    f.change({ sourcePath: '/saved.jsonl' });
    assert.equal(f.requests.length, 0, 'unmeasured/offscreen turns must not enter the main evidence queue');
    assert.equal(f.changes.size, 0);
    assert.equal(f.history.size, 0);

    f.admit(query, true);
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve(result('visible-r1'));
    await settled();
    const retained = f.received.at(-1);
    f.change({ sourcePath: '/saved.jsonl' });
    f.admit(query, false);
    f.requests[1].resolve(result('stale-inflight'));
    await settled();
    f.snapshot('/saved.jsonl', 'offscreen-r2');
    f.change({ sourcePath: '/saved.jsonl' });
    assert.equal(f.requests.length, 2, 'pausing detaches invalidations and rejects pending completion');
    assert.equal(f.received.at(-1), retained, 'pausing must leave the consumer’s known result intact');

    const latestQuery: TurnChangeQuery = { ...query, toolCallIds: ['latest-child-task'] };
    f.admit(latestQuery, true);
    assert.equal(f.requests.length, 3, 're-entry reads even when offscreen invalidations were not observed');
    assert.deepEqual(f.requests[2].query, latestQuery);
    f.requests[2].resolve(result('visible-r2'));
    await settled();
    assert.deepEqual(f.received.map(value => value.revision), ['visible-r1', 'visible-r2']);
  } finally { f.close(); }
});

test('explicit review is admitted by default and source replacement rejects old pending results', async () => {
  const query: TurnChangeQuery = { context: { kind: 'saved', parentPath: '/old.jsonl', leafId: 'old-leaf' }, anchorId: 'answer' };
  const f = fixture(query);
  try {
    assert.equal(f.requests.length, 1, 'explicit review needs no viewport measurement');
    const replacement: TurnChangeQuery = { context: { kind: 'saved', parentPath: '/new.jsonl', leafId: 'new-leaf' }, anchorId: 'answer' };
    f.admit(replacement, false);
    f.requests[0].resolve(result('old-source'));
    await settled();
    assert.equal(f.received.length, 0);
    f.admit(replacement);
    assert.deepEqual(f.requests[1].query, replacement);
    f.change({ sourcePath: '/old.jsonl' });
    f.requests[1].resolve(result('new-source'));
    await settled();
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.received.map(value => value.revision), ['new-source']);
    assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

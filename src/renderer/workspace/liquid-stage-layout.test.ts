import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liquidCapsuleMetrics, liquidFloorHeight, liquidReasonHeight, liquidStageLayout } from './liquid-stage-layout';

test('roots preserve native ordering, capsule width, gap and the field bottom', () => {
  const layout = liquidStageLayout([{ id: 'third' }, { id: 'first' }, { id: 'second' }], 720);
  assert.deepEqual(layout.nodes.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })), [
    { id: 'third', x: 34, y: 4, width: 686, height: 64 },
    { id: 'first', x: 34, y: 78, width: 686, height: 64 },
    { id: 'second', x: 34, y: 152, width: 686, height: 64 },
  ]);
  assert.equal(layout.height, 222);
  assert.equal(liquidStageLayout([], 720).height, 0);
});

test('root cracks join the trunk to the text-block center through exact waypoints', () => {
  const layout = liquidStageLayout([{ id: 'one' }, { id: 'two' }], 640, 'tool');
  const [first, second] = layout.nodes;
  assert.equal(layout.trunks.length, 1);
  assert.deepEqual(layout.trunks[0].waypoints, [{ x: 20, y: 0 }, { x: 20, y: 96 }]);
  assert.equal(layout.trunks[0].seed, 'tool:trunk');
  assert.deepEqual(first.branch.waypoints, [{ x: 20, y: 22 }, { x: 26, y: 29 }, { x: 34, y: 32 }]);
  assert.deepEqual(second.branch.to, { x: 34, y: second.y + 28 });
  assert.equal(first.branch.seed, 'tool:one');
  assert.equal(first.branch.spurs, undefined);
});

test('descendants follow preorder and start their sub-trunk inside the parent bottom', () => {
  const layout = liquidStageLayout([{ id: 'parent', children: [{ id: 'child', children: [{ id: 'deep' }] }, { id: 'sibling' }] }, { id: 'root' }], 640);
  const [parent, child, deep, sibling, root] = layout.nodes;
  assert.deepEqual(layout.nodes.map(node => node.id), ['parent', 'child', 'deep', 'sibling', 'root']);
  assert.deepEqual(layout.nodes.map(node => [node.x, node.y, node.height]), [[34, 4, 64], [58, 78, 56], [58, 142, 56], [58, 206, 56], [34, 270, 64]]);
  assert.equal(child.parentId, parent.id);
  assert.equal(deep.parentId, child.id);
  assert.equal(sibling.parentId, parent.id);
  assert.equal(root.parentId, undefined);
  const childTrunk = layout.trunks.find(trunk => trunk.parentId === parent.id)!;
  const deepTrunk = layout.trunks.find(trunk => trunk.parentId === child.id)!;
  assert.deepEqual(childTrunk.from, { x: 46, y: 68 });
  assert.deepEqual(child.branch.waypoints, [{ x: 46, y: 93 }, { x: 51, y: 99 }, { x: 58, y: 101 }]);
  assert.deepEqual(deepTrunk.from, { x: 46, y: child.y + child.height });
  assert.deepEqual(childTrunk.to, sibling.branch.from);
  assert.equal(layout.trunks.filter(trunk => trunk.parentId === parent.id).length, 1);
  assert.equal(layout.height, 340);
});

test('only failed and aborted phases reserve reason height even without reason text', () => {
  for (const phase of ['pending', 'running', 'completed', 'unknown', 'failed', 'aborted'] as const) {
    const reason = phase === 'failed' || phase === 'aborted';
    const layout = liquidStageLayout([{ id: 'parent', phase, children: [{ id: 'child', phase }] }], 640);
    const [parent, child] = layout.nodes;
    assert.equal(parent.height, 64 + (reason ? 18 : 0));
    assert.equal(child.height, 56 + (reason ? 18 : 0));
    assert.equal(child.y, parent.y + parent.height + 10);
    assert.deepEqual(parent.branch.to, { x: 34, y: parent.y + 28 + (reason ? 9 : 0) });
    assert.deepEqual(child.branch.to, { x: 58, y: child.y + 23 + (reason ? 9 : 0) });
    assert.equal(layout.height, child.y + child.height + 6);
  }
});

test('bundles use a 40px capsule at either level and leave room for following slots', () => {
  const layout = liquidStageLayout([{ id: 'bundle', kind: 'bundle', children: [{ id: 'nested', kind: 'bundle' }, { id: 'ghost', kind: 'ghost' }] }, { id: 'last' }], 320);
  const [bundle, nested, ghost, last] = layout.nodes;
  assert.equal(bundle.height, 40);
  assert.equal(nested.height, 40);
  assert.equal(nested.parentId, bundle.id);
  assert.equal(ghost.kind, 'ghost');
  assert.deepEqual(layout.nodes.map(node => node.y), [4, 54, 102, 166]);
  assert.equal(last.width, 286);
  assert.equal(layout.height, 236);
});

test('trunks aggregate descendants while failures remain on individual branches', () => {
  const running = liquidStageLayout([{ id: 'failed', phase: 'failed' }, { id: 'parent', phase: 'completed', children: [{ id: 'child', phase: 'running' }] }], 640);
  assert.ok(running.trunks.every(trunk => trunk.phase === 'running'));
  const pending = liquidStageLayout([{ id: 'planned', kind: 'ghost' }, { id: 'parent', phase: 'pending', children: [{ id: 'child', phase: 'pending' }] }], 640);
  assert.ok(pending.trunks.every(trunk => trunk.phase === 'pending'));
  const settled = liquidStageLayout([{ id: 'parent', phase: 'failed', children: [{ id: 'child', phase: 'aborted' }] }, { id: 'waiting', phase: 'pending' }], 640);
  assert.ok(settled.trunks.every(trunk => trunk.phase === 'completed'));
  assert.deepEqual(liquidStageLayout([], 640).trunks, []);
});

test('text and reason lines retain at least four pixels above the liquid floor', () => {
  for (const phase of ['running', 'completed', 'failed', 'aborted'] as const) {
    const reasonHeight = phase === 'failed' || phase === 'aborted' ? liquidReasonHeight : 0;
    const layout = liquidStageLayout([{ id: 'root', phase, children: [{ id: 'nested', phase }, { id: 'bundle', kind: 'bundle', phase: 'completed' }] }], 640);
    for (const capsule of layout.nodes) {
      const metrics = liquidCapsuleMetrics[capsule.kind === 'bundle' ? 'bundle' : capsule.depth ? 'nested' : 'root'];
      const textBottom = metrics.paddingTop + metrics.titleHeight + metrics.detailGap + metrics.detailHeight + (capsule.kind === 'bundle' ? 0 : reasonHeight);
      assert.ok(capsule.height - liquidFloorHeight - textBottom >= 4, `${capsule.id} ${phase} must clear the floor`);
    }
  }
});

test('cracks preserve their geometry seed across renders without leaking between calls', () => {
  const roots = [{ id: 'parent', children: [{ id: 'child' }] }, { id: 'other' }];
  const first = liquidStageLayout(roots, 640, 'call-one');
  assert.deepEqual(liquidStageLayout(roots, 640, 'call-one'), first);
  const other = liquidStageLayout(roots, 640, 'call-two');
  assert.notEqual(first.trunks.find(trunk => !trunk.parentId)!.d, other.trunks.find(trunk => !trunk.parentId)!.d);
  assert.equal(first.trunks.find(trunk => trunk.parentId === 'parent')!.seed, 'call-one:parent');
  assert.deepEqual(other.nodes.map(node => node.branch.waypoints), first.nodes.map(node => node.branch.waypoints));
});

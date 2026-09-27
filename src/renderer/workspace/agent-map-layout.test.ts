import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutAgentMap } from './agent-map-layout';
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≠ ${b}`);

test('one through forty leaves preserve sheet radii and crowding geometry at every field size', () => {
  for (const size of [280, 420, 640]) for (let count = 1; count <= 40; count++) {
    const ids = Array.from({ length: count }, (_, i) => `agent-${i}`);
    const map = layoutAgentMap([{ id: 'call', leafIds: ids }], size);
    assert.deepEqual(map.core, { x: size / 2, y: size / 2 });
    const branch = map.branches[0];
    near(Math.hypot(branch.knot.x - map.core.x, branch.knot.y - map.core.y), .26 * size);
    near(branch.labelAnchor.x - branch.knot.x, -Math.sin(branch.angle) * 10);
    near(branch.labelAnchor.y - branch.knot.y, Math.cos(branch.angle) * 10);
    assert.deepEqual(branch.leaves.map(leaf => leaf.id), ids);
    for (const [index, leaf] of branch.leaves.entries()) {
      near(Math.hypot(leaf.x - map.core.x, leaf.y - map.core.y), .42 * size - (branch.staggered && index % 2 ? 30 : 0));
      assert.ok(leaf.size === 24 || leaf.size === 18);
      assert.ok(Math.abs(leaf.angle - branch.angle) <= branch.span / 2 - 4 * Math.PI / 180 + 1e-8);
    }
  }
});
test('chronological sectors start at top and allocate proportionally above the angular floor', () => {
  const batches = [{ id: 'small', leafIds: ['a'] }, { id: 'large', leafIds: Array.from({ length: 39 }, (_, i) => String(i)) }];
  const original = structuredClone(batches);
  const map = layoutAgentMap(batches, 640);
  assert.deepEqual(batches, original);
  near(map.branches[0].angle, -Math.PI / 2);
  near(map.branches[0].span, (28 + 304 / 40) * Math.PI / 180);
  near(map.branches[1].span, (28 + 304 * 39 / 40) * Math.PI / 180);
  assert.ok(map.branches[1].angle > map.branches[0].angle);
  assert.equal(map.branches[0].newest, false);
  assert.equal(map.branches[1].newest, true);
  const proportional = layoutAgentMap([{ id: 'a', leafIds: ['1', '2'] }, { id: 'b', leafIds: ['3', '4', '5', '6'] }], 420);
  near((proportional.branches[1].span - 28 * Math.PI / 180) / (proportional.branches[0].span - 28 * Math.PI / 180), 2);
});
test('more than twelve branches retain every identity in a normalized full circle', () => {
  const batches = Array.from({ length: 40 }, (_, i) => ({ id: `call-${i}`, leafIds: [`agent-${i}`] }));
  const map = layoutAgentMap(batches, 640);
  assert.deepEqual(map.branches.map(branch => branch.id), batches.map(batch => batch.id));
  near(map.branches.reduce((sum, branch) => sum + branch.span, 0), Math.PI * 2);
  assert.ok(map.branches.every(branch => branch.span > 0));
});
test('thirteen branches have equal 360/13 sectors even with unequal leaf counts', () => {
  const batches = Array.from({ length: 13 }, (_, index) => ({ id: String(index), leafIds: Array.from({ length: index + 1 }, (_, leaf) => `${index}-${leaf}`) }));
  const map = layoutAgentMap(batches, 640);
  for (const branch of map.branches) near(branch.span, Math.PI * 2 / 13);
});
test('forty crowded leaves stagger into two rings and shrink only below the same-ring threshold', () => {
  for (const [size, orbSize] of [[320, 24], [240, 18]]) {
    const map = layoutAgentMap([{ id: 'dense', leafIds: Array.from({ length: 40 }, (_, index) => String(index)) }], size);
    const branch = map.branches[0];
    assert.equal(branch.staggered, true);
    for (const [index, leaf] of branch.leaves.entries()) {
      assert.equal(leaf.size, orbSize);
      assert.equal(leaf.label.show, false);
      near(Math.hypot(leaf.x - map.core.x, leaf.y - map.core.y), .42 * size - (index % 2 ? 30 : 0));
      for (const other of branch.leaves) if (other !== leaf) assert.ok(Math.hypot(leaf.x - other.x, leaf.y - other.y) >= orbSize + 2);
    }
  }
});
test('small batches show outward labels at panel width rather than reserving 120px', () => {
  for (let count = 1; count <= 4; count++) for (let split = 0; split < count; split++) {
    const ids = Array.from({ length: count }, (_, index) => String(index));
    const batches = split ? [{ id: 'first', leafIds: ids.slice(0, split) }, { id: 'second', leafIds: ids.slice(split) }] : [{ id: 'first', leafIds: ids }];
    const map = layoutAgentMap(batches, 456);
    for (const branch of map.branches) assert.ok(branch.leaves.every(leaf => leaf.label.show), `Missing outward label for ${count} leaves, split=${split}, branch=${branch.id}`);
    const shown = map.branches.flatMap(branch => branch.leaves).filter(leaf => leaf.label.show).map(leaf => leaf.label);
    for (const box of shown) {
      assert.ok(box.x >= 0 && box.x + box.width <= 456 && box.width <= 120);
      for (const other of shown) if (box !== other) assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y);
    }
  }
});
test('outward labels never collide and hidden labels have in-bounds floating chips', () => {
  const size = 640;
  const map = layoutAgentMap([{ id: 'batch', leafIds: Array.from({ length: 8 }, (_, i) => String(i)) }], size);
  const leaves = map.branches[0].leaves;
  const shown = leaves.filter(leaf => leaf.label.show).map(leaf => leaf.label);
  assert.ok(shown.length > 1);
  for (const box of shown) for (const other of shown) if (box !== other) assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y);
  for (const { label } of leaves) { assert.ok(label.floating.x >= 0 && label.floating.x + label.width <= size); assert.ok(label.floating.y >= 0 && label.floating.y + label.height <= size); }
  assert.deepEqual(layoutAgentMap([{ id: 'empty', leafIds: [] }], size).branches, []);
});
test('a four-leaf batch fits to content while retaining exact radii from the rendered width', () => {
  for (const size of [456, 640]) {
    const map = layoutAgentMap([{ id: 'call', leafIds: ['a', 'b', 'c', 'd'] }], size);
    assert.ok(map.height < map.width * .75);
    near(map.knotRadius / map.width, .26);
    near(map.leafRadius / map.width, .42);
    near(map.height, Math.min(size, Math.max(200, size * map.bbox.height / map.bbox.width)));
    near(map.viewBox.x, map.bbox.x - 24);
    near(map.viewBox.y, map.bbox.y - 24);
    near(map.viewBox.width, map.bbox.width + 48);
    near(map.viewBox.height, map.bbox.height + 48);
  }
});
test('fit bounds contain the Core glow, knot pills, leaves and every visible or floating label', () => {
  for (const count of [1, 4, 40]) {
    const map = layoutAgentMap([{ id: 'call', leafIds: Array.from({ length: count }, (_, i) => String(i)), label: 'Batch 1 · 40' }], 456);
    const inside = (x: number, y: number, width: number, height: number) => { assert.ok(x >= map.bbox.x - 1e-8 && y >= map.bbox.y - 1e-8); assert.ok(x + width <= map.bbox.x + map.bbox.width + 1e-8 && y + height <= map.bbox.y + map.bbox.height + 1e-8); };
    const r = 30 * 44 / 36;
    inside(map.core.x - r, map.core.y - r, r * 2, r * 2);
    for (const branch of map.branches) {
      inside(branch.label.x, branch.label.y, branch.label.width, branch.label.height);
      for (const leaf of branch.leaves) {
        inside(leaf.x - leaf.size / 2, leaf.y - leaf.size / 2, leaf.size, leaf.size);
        const box = leaf.label.show ? leaf.label : leaf.label.floating;
        inside(box.x, box.y, leaf.label.width, leaf.label.height);
        if (leaf.label.show) assert.ok(leaf.label.x + leaf.label.width + 4 <= branch.label.x || branch.label.x + branch.label.width + 4 <= leaf.label.x || leaf.label.y + leaf.label.height + 4 <= branch.label.y || branch.label.y + branch.label.height + 4 <= leaf.label.y);
      }
    }
  }
});

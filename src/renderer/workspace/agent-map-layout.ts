export interface MapPoint { x: number; y: number }
export interface MapBatch { id: string; leafIds: readonly string[]; label?: string }
export interface MapBounds extends MapPoint { width: number; height: number }
export interface MapLabel extends MapPoint { width: number; height: number; show: boolean; align: 'left' | 'center' | 'right'; floating: MapPoint }
export interface MapLeaf extends MapPoint { id: string; angle: number; size: number; label: MapLabel }
export interface MapBranch { id: string; angle: number; span: number; newest: boolean; staggered: boolean; knot: MapPoint; label: MapBounds; labelAnchor: MapPoint; leaves: MapLeaf[] }
export interface AgentMapLayout { width: number; height: number; core: MapPoint; knotRadius: number; leafRadius: number; bbox: MapBounds; viewBox: MapBounds; branches: MapBranch[] }
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Reserve the angular floor, then distribute the remainder by child count. */
function branchSpans(batches: readonly MapBatch[]): number[] {
  const floor = Math.min(28 * DEG, TAU / Math.max(1, batches.length));
  const available = TAU - floor * batches.length;
  const count = batches.reduce((sum, batch) => sum + batch.leafIds.length, 0);
  return batches.map(batch => floor + available * batch.leafIds.length / count);
}

/** Input is chronological. S is the already-constrained square field size. */
export function layoutAgentMap(batches: readonly MapBatch[], size: number): AgentMapLayout {
  const core = { x: size / 2, y: size / 2 };
  const populated = batches.filter(batch => batch.leafIds.length);
  const spans = branchSpans(populated);
  const knotRadius = .26 * size, leafRadius = .42 * size;
  const polar = (angle: number, radius: number): MapPoint => ({ x: core.x + Math.cos(angle) * radius, y: core.y + Math.sin(angle) * radius });
  let cursor = -Math.PI / 2 - (spans[0] ?? 0) / 2;
  const branches = populated.map((batch, index): MapBranch => {
    const span = spans[index], angle = cursor + span / 2;
    const fan = Math.max(0, Math.min(span / 2 - 4 * DEG, (batch.leafIds.length - 1) * 11 * DEG));
    const step = batch.leafIds.length > 1 ? 2 * fan / (batch.leafIds.length - 1) : TAU;
    const staggered = step * leafRadius < 26;
    const orbSize = staggered && step * 2 * (leafRadius - 30) < 26 ? 18 : 24;
    const leaves = batch.leafIds.map((id, leafIndex): MapLeaf => {
      const leafAngle = angle + (batch.leafIds.length === 1 ? 0 : -fan + 2 * fan * leafIndex / (batch.leafIds.length - 1));
      const radius = staggered && leafIndex % 2 ? leafRadius - 30 : leafRadius;
      const point = polar(leafAngle, radius);
      const outward = polar(leafAngle, radius + orbSize / 2 + 12);
      const side = Math.cos(leafAngle);
      const align = side > .26 ? 'left' : side < -.26 ? 'right' : 'center';
      // 120px is a maximum, not a reservation: side labels use the room
      // between their outward anchor and the field edge before ellipsizing.
      const available = align === 'left' ? size - outward.x - 4 : align === 'right' ? outward.x - 4 : 2 * Math.min(outward.x - 4, size - outward.x - 4);
      const labelWidth = Math.max(0, Math.min(120, available));
      const x = outward.x - (align === 'right' ? labelWidth : align === 'center' ? labelWidth / 2 : 0);
      const y = align === 'center' ? point.y + (Math.sin(leafAngle) < 0 ? -orbSize / 2 - 20 : orbSize / 2 + 4) : outward.y - 8;
      return { id, ...point, angle: leafAngle, size: orbSize, label: { x, y, width: labelWidth, height: 16, align, show: !staggered, floating: { x: Math.max(4, Math.min(size - 124, point.x - 60)), y: Math.max(4, Math.min(size - 20, point.y + 19)) } } };
    });
    cursor += span;
    const knot = polar(angle, knotRadius);
    const perpendicular = { x: -Math.sin(angle), y: Math.cos(angle) };
    const labelAnchor = { x: knot.x + perpendicular.x * 10, y: knot.y + perpendicular.y * 10 };
    const labelText = batch.label ?? `Batch ${index + 1} · ${leaves.length}`;
    const labelWidth = 12 + Array.from(labelText).reduce((sum, character) => sum + (character.charCodeAt(0) > 255 ? 10.5 : 6.3), 0);
    const label = { x: labelAnchor.x - (perpendicular.x < -.26 ? labelWidth : perpendicular.x > .26 ? 0 : labelWidth / 2), y: labelAnchor.y - (Math.abs(perpendicular.x) > .26 ? 8 : perpendicular.y < 0 ? 16 : 0), width: labelWidth, height: 16 };
    return { id: batch.id, angle, span, newest: index === populated.length - 1, staggered, knot, label, labelAnchor, leaves };
  });
  const accepted: MapBounds[] = branches.map(branch => branch.label);
  const leaves = branches.flatMap(branch => branch.leaves);
  const anchorX = (box: MapLabel) => box.x + (box.align === 'right' ? box.width : box.align === 'center' ? box.width / 2 : 0);
  const fitWidth = (box: MapLabel, maximum: number) => {
    const next = Math.max(0, Math.min(box.width, maximum));
    box.x += (box.width - next) * (box.align === 'right' ? 1 : box.align === 'center' ? .5 : 0);
    box.width = next;
  };
  // Share a horizontal lane at the midpoint of outward anchors. This retains
  // both small-batch labels instead of arbitrarily suppressing the later one.
  for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
    const a = leaves[i].label, b = leaves[j].label;
    if (!a.show || !b.show || a.y >= b.y + b.height + 4 || b.y >= a.y + a.height + 4 || a.x >= b.x + b.width + 4 || b.x >= a.x + a.width + 4) continue;
    const [left, right] = anchorX(a) <= anchorX(b) ? [a, b] : [b, a];
    const leftAnchor = anchorX(left), rightAnchor = anchorX(right), middle = (leftAnchor + rightAnchor) / 2;
    if (left.align !== 'right') fitWidth(left, (middle - 2 - leftAnchor) * (left.align === 'center' ? 2 : 1));
    if (right.align !== 'left') fitWidth(right, (rightAnchor - middle - 2) * (right.align === 'center' ? 2 : 1));
  }
  for (const branch of [...branches].reverse()) for (const leaf of branch.leaves) {
    const box = leaf.label;
    box.show = !branch.staggered && box.width >= 24 && box.x >= 0 && box.x + box.width <= size && box.y >= 0 && box.y + box.height <= size
      && !accepted.some(other => box.x < other.x + other.width + 4 && box.x + box.width + 4 > other.x && box.y < other.y + other.height + 4 && box.y + box.height + 4 > other.y)
      && !leaves.some(other => Math.hypot(other.x - Math.max(box.x, Math.min(other.x, box.x + box.width)), other.y - Math.max(box.y, Math.min(other.y, box.y + box.height))) < other.size / 2 + 3);
    if (box.show) accepted.push(box);
    else box.width = 120;
  }
  const glowRadius = 30 * 44 / 36;
  let left = core.x - glowRadius, top = core.y - glowRadius, right = core.x + glowRadius, bottom = core.y + glowRadius;
  const include = (box: MapBounds) => { left = Math.min(left, box.x); top = Math.min(top, box.y); right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height); };
  include({ x: core.x - 80, y: core.y + 28, width: 160, height: 32 });
  for (const branch of branches) {
    include({ x: branch.knot.x - 5, y: branch.knot.y - 5, width: 10, height: 10 });
    include(branch.label);
    for (const leaf of branch.leaves) {
      const radius = leaf.size / 2 + 4;
      include({ x: leaf.x - radius, y: leaf.y - radius, width: radius * 2, height: radius * 2 });
      include(leaf.label.show ? leaf.label : { ...leaf.label.floating, width: leaf.label.width, height: leaf.label.height });
    }
  }
  const bbox = { x: left, y: top, width: right - left, height: bottom - top };
  const viewBox = { x: left - 24, y: top - 24, width: bbox.width + 48, height: bbox.height + 48 };
  return { width: size, height: Math.min(size, Math.max(200, size * bbox.height / bbox.width)), core, knotRadius, leafRadius, bbox, viewBox, branches };
}

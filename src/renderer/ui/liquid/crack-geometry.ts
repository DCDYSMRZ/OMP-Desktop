import { seededNoise } from '../../lib/agent-motion/noise';

export interface Pt { x: number; y: number }

/** Exact waypoint anchors joined by bounded, seeded perpendicular fissures. */
export function crackPoints(waypoints: Pt[], seed: string, opts?: { amplitude?: number; segment?: number }): Pt[] {
  if (!waypoints.length) return [];
  const amplitude = Math.abs(opts?.amplitude ?? 1.6), segment = Math.max(.1, opts?.segment ?? 6);
  const noise = seededNoise(seed);
  let sample = 0, distance = 0, nextKink = 22 + noise(sample++) * 6;
  const points: Pt[] = [{ ...waypoints[0] }];
  for (let index = 1; index < waypoints.length; index++) {
    const from = waypoints[index - 1], to = waypoints[index];
    const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
    const steps = Math.ceil(length / segment);
    for (let step = 1; step < steps; step++) {
      const t = step / steps, along = distance + length * t;
      const kink = along >= nextKink;
      if (kink) nextKink = along + 22 + noise(sample++) * 6;
      const offset = noise(sample++) * amplitude * (kink ? 2 : 1);
      points.push({ x: from.x + dx * t - dy / length * offset, y: from.y + dy * t + dx / length * offset });
    }
    points.push({ ...to });
    distance += length;
  }
  return points;
}

export function crackPath(points: Pt[]): string {
  return points.map((point, index) => `${index ? 'L' : 'M'} ${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10}`).join(' ');
}

/** Spur spacing is measured along the entire polyline, not reset at each vertex. */
export function crackSpurs(points: Pt[], seed: string, opts?: { every?: [number, number]; length?: [number, number]; angle?: [number, number] }): string[] {
  const every = opts?.every ?? [26, 40], lengths = opts?.length ?? [3, 7], angles = opts?.angle ?? [35, 60];
  const noise = seededNoise(seed + ':spurs');
  let sample = 0, traversed = 0, next = every[0] + (noise(sample++) + 1) / 2 * (every[1] - every[0]);
  const paths: string[] = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1], to = points[index], dx = to.x - from.x, dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (!distance) continue;
    while (next <= traversed + distance) {
      const t = (next - traversed) / distance, base = { x: from.x + dx * t, y: from.y + dy * t };
      const length = lengths[0] + (noise(sample++) + 1) / 2 * (lengths[1] - lengths[0]);
      const side = noise(sample++) < 0 ? -1 : 1;
      const angle = (angles[0] + (noise(sample++) + 1) / 2 * (angles[1] - angles[0])) * Math.PI / 180 * side;
      const vx = (dx * Math.cos(angle) - dy * Math.sin(angle)) / distance * length;
      const vy = (dx * Math.sin(angle) + dy * Math.cos(angle)) / distance * length;
      const bend = noise(sample++) * .12;
      paths.push(crackPath([base, { x: base.x + vx * .5 - vy * bend, y: base.y + vy * .5 + vx * bend }, { x: base.x + vx, y: base.y + vy }]));
      next += Math.max(.1, every[0] + (noise(sample++) + 1) / 2 * (every[1] - every[0]));
    }
    traversed += distance;
  }
  return paths;
}

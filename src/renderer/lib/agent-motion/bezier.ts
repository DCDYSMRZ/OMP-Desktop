export interface Pt { x: number; y: number }
export interface Tendril { p0: Pt; c1: Pt; c2: Pt; p1: Pt }
export function tendrilBetween(from: Pt, to: Pt, sway?: { dx1: number; dy1: number; dx2: number; dy2: number }): Tendril {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return { p0: from, c1: { x: from.x + dx * .46 + (sway?.dx1 ?? 0), y: from.y + dy * .08 + (sway?.dy1 ?? 0) }, c2: { x: to.x - dx * .36 + (sway?.dx2 ?? 0), y: to.y - dy * .12 + (sway?.dy2 ?? 0) }, p1: to };
}
export function tendrilPath(t: Tendril): string {
  return 'M' + t.p0.x + ',' + t.p0.y + ' C' + t.c1.x + ',' + t.c1.y + ' ' + t.c2.x + ',' + t.c2.y + ' ' + t.p1.x + ',' + t.p1.y;
}
export function pointAt(t: Tendril, u: number): Pt {
  u = Math.max(0, Math.min(1, u));
  const v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
  return { x: a * t.p0.x + b * t.c1.x + c * t.c2.x + d * t.p1.x, y: a * t.p0.y + b * t.c1.y + c * t.c2.y + d * t.p1.y };
}
export function approxLength(t: Tendril): number {
  let length = 0, previous = t.p0;
  for (let i = 1; i <= 32; i++) { const next = pointAt(t, i / 32); length += Math.hypot(next.x - previous.x, next.y - previous.y); previous = next; }
  return length;
}

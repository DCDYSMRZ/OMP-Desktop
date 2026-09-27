/** Velocity is in pixels/second; perpendicular compression is half the stretch. */
export function liquidIndicatorScale(velocity: number, perpendicular = false): number {
  const stretch = Math.min(Math.abs(velocity) / 2400, .18);
  return 1 + stretch * (perpendicular ? -.5 : 1);
}

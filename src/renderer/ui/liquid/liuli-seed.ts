import { seededNoise } from '../../lib/agent-motion/noise';

/** Stable bubbles remain above the vein and agree between stage, map and detail. */
export function liuliInclusions(id: string): Record<string, string> {
  const noise = seededNoise(id);
  const positions: Record<string, string> = {};
  for (let index = 0; index < 3; index++) {
    positions[`--b${index + 1}x`] = `${10 + (noise(index * 2) + 1) * 41}%`;
    positions[`--b${index + 1}y`] = `${18 + (noise(index * 2 + 1) + 1) * 21}%`;
  }
  return positions;
}

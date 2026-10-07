export type MotionVariant = 'fade' | 'scale' | 'rise' | 'drop' | 'slide-left' | 'slide-right';
export const motion = { fast: 120, base: 180, expand: 240, gentle: 320, exit: 180, reduced: 80, enter: 'cubic-bezier(0.2, 0, 0, 1)', leave: 'cubic-bezier(0.4, 0, 1, 1)', spring: 'linear(0, 0.32 12%, 0.64 26%, 0.86 43%, 0.97 65%, 1)' } as const;
export function hiddenTransform(variant: MotionVariant): string {
  switch (variant) {
    case 'scale': return 'scale(0.98)';
    case 'rise': return 'translateY(8px)';
    case 'drop': return 'translateY(-6px)';
    case 'slide-left': return 'translateX(10px)';
    case 'slide-right': return 'translateX(-10px)';
    default: return 'none';
  }
}
export interface MotionRect { left: number; top: number; width: number; height: number }
export function flipDelta(before: MotionRect, after: MotionRect) {
  return { x: before.left - after.left, y: before.top - after.top, scaleX: after.width > 0 ? before.width / after.width : 1, scaleY: after.height > 0 ? before.height / after.height : 1 };
}
/** Right-align digits so carry/borrow preserves the identity of each place. */
export function numberColumns(value: string) {
  return Array.from(value, (character, index) => ({ character, key: value.length - index - 1 }));
}

/** A new or unchanged/offscreen label is content, not a visual transition. */
export function swapMotionMode(changed: boolean, enabled: boolean, visible: boolean, paused: boolean, reduced: boolean): 'none' | 'fade' | 'spatial' {
  if (!changed || !enabled || !visible || paused) return 'none';
  return reduced ? 'fade' : 'spatial';
}

/** Disabled lists retain no geometry; reenabling starts from a quiet baseline. */
export function flipSnapshotMode(enabled: boolean, initialized: boolean): 'skip' | 'baseline' | 'animate' {
  return !enabled ? 'skip' : initialized ? 'animate' : 'baseline';
}

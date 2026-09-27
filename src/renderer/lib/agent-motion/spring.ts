export interface SpringConfig { stiffness: number; damping: number; mass?: number }
export const springs: { gentle: SpringConfig; snappy: SpringConfig; bloom: SpringConfig } = {
  gentle: { stiffness: 170, damping: 26 }, snappy: { stiffness: 300, damping: 30 }, bloom: { stiffness: 260, damping: 17 },
};
export interface Spring { value: number; velocity: number; target: number; setTarget(t: number): void; jump(v: number): void; step(dtSeconds: number): void; readonly settled: boolean }
/** Visual rest threshold shared by all spring-driven ticker consumers. */
export function isSpringSettled(s: Spring): boolean { return Math.abs(s.velocity) < .01 && Math.abs(s.value - s.target) < .1; }
export function createSpring(config: SpringConfig, initial: number): Spring {
  const mass = config.mass ?? 1;
  return {
    value: initial, velocity: 0, target: initial,
    setTarget(t) { this.target = t; },
    jump(v) { this.value = this.target = v; this.velocity = 0; },
    get settled() { return isSpringSettled(this); },
    step(dtSeconds) {
      if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
      // Small semi-implicit steps remain stable after a delayed frame.
      const duration = Math.min(dtSeconds, .05);
      const steps = Math.ceil(duration / (1 / 240));
      const dt = duration / steps;
      for (let i = 0; i < steps; i++) {
        this.velocity += ((this.target - this.value) * config.stiffness - this.velocity * config.damping) / mass * dt;
        this.value += this.velocity * dt;
      }
      if (this.settled) { this.value = this.target; this.velocity = 0; }
    },
  };
}

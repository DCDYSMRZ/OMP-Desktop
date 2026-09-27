export function seededNoise(seed: string): (t: number) => number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  const sample = (n: number): number => {
    let value = Math.imul((n | 0) ^ hash, 1597334677);
    value = Math.imul(value ^ (value >>> 16), 2246822507);
    return ((value ^ (value >>> 13)) >>> 0) / 4294967295 * 2 - 1;
  };
  return t => {
    const n = Math.floor(t), u = t - n, smooth = u * u * (3 - 2 * u);
    return sample(n) * (1 - smooth) + sample(n + 1) * smooth;
  };
}

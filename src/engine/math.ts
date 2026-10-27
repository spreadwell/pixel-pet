export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (t: number) => t * t * (3 - 2 * t);
export const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
export const chance = (p: number) => Math.random() < p;
export const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

/** Signed shortest difference between two angles, in (-PI, PI]. */
export function angleDiff(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Frame-rate independent exponential approach. `rate` is roughly 1/seconds. */
export const approach = (cur: number, target: number, rate: number, dt: number) =>
  target + (cur - target) * Math.exp(-rate * dt);

export const approachAngle = (cur: number, target: number, rate: number, dt: number) =>
  cur + angleDiff(cur, target) * (1 - Math.exp(-rate * dt));

/** Stable per-integer hash in [0, 1). */
export function hash(n: number): number {
  let x = Math.imul(n | 0, 0x27d4eb2d) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export const hash2 = (a: number, b: number) => hash(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663));

/** Smooth 1D value noise in [-1, 1]. */
export function noise1(t: number, seed = 0): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash(i + seed * 1013) * 2 - 1;
  const b = hash(i + 1 + seed * 1013) * 2 - 1;
  return lerp(a, b, smoothstep(f));
}

export interface Rect { x: number; y: number; w: number; h: number; }

export const inRect = (r: Rect, x: number, y: number, pad = 0) =>
  x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;

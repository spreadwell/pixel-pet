import type { Rect } from './math';

/*
 * Finding a way across the workspace's terrain. The height map is searched on a coarse
 * grid (A*) where flat ground is cheap, climbing up costs a lot, climbing down a little,
 * and walking along the top of a line of text costs extra. So the gecko threads along
 * the margins and the gaps between paragraphs, goes around a heading rather than over
 * it, and climbs only when climbing is the short way. All units are art px.
 */

const CELL = 2;
const MAX_EXPANSIONS = 60000;
const CLIMB_UP = 2.5;
const CLIMB_DOWN = 1.2;
/** Extra cost per art px of walking on top of text (heights in this range). */
const ON_TEXT = 0.6;
const TEXT_MIN = 4;
const TEXT_MAX = 5;

export interface Terrain {
  bounds: Rect;
  groundAt(x: number, y: number): number;
}

export interface Waypoint { x: number; y: number; }

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/** A route from (x0, y0) to (x1, y1) as waypoints (excluding the start), or null. */
export function findRoute(t: Terrain, x0: number, y0: number, x1: number, y1: number): Waypoint[] | null {
  const b = t.bounds;
  const gx0 = Math.floor(b.x / CELL), gy0 = Math.floor(b.y / CELL);
  const gw = Math.ceil(b.w / CELL), gh = Math.ceil(b.h / CELL);
  if (gw <= 0 || gh <= 0) return null;
  const n = gw * gh;
  const cell = (x: number, y: number) => {
    const cx = Math.min(gw - 1, Math.max(0, Math.floor(x / CELL) - gx0));
    const cy = Math.min(gh - 1, Math.max(0, Math.floor(y / CELL) - gy0));
    return cy * gw + cx;
  };
  const centre = (k: number) => ({ x: ((k % gw) + gx0 + 0.5) * CELL, y: (Math.floor(k / gw) + gy0 + 0.5) * CELL });
  const height = new Float32Array(n);
  for (let k = 0; k < n; k++) { const c = centre(k); height[k] = t.groundAt(c.x, c.y); }

  const start = cell(x0, y0), goal = cell(x1, y1);
  if (start === goal) return [{ x: x1, y: y1 }];
  const g = new Float32Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap(n);
  const gc = centre(goal);
  const h = (k: number) => { const c = centre(k); return Math.hypot(c.x - gc.x, c.y - gc.y); };
  g[start] = 0;
  heap.push(start, h(start));
  let expanded = 0;
  while (heap.size) {
    const k = heap.pop();
    if (k === goal) break;
    if (closed[k]) continue;
    closed[k] = 1;
    if (++expanded > MAX_EXPANSIONS) return null;
    const kx = k % gw, ky = Math.floor(k / gw);
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = kx + dx, ny = ky + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const m = ny * gw + nx;
      if (closed[m]) continue;
      const len = (dx && dy ? Math.SQRT2 : 1) * CELL;
      const dz = height[m] - height[k];
      const onText = height[m] >= TEXT_MIN && height[m] <= TEXT_MAX ? ON_TEXT * len : 0;
      const cost = g[k] + len + (dz > 0 ? dz * CLIMB_UP : -dz * CLIMB_DOWN) + onText;
      if (cost < g[m]) { g[m] = cost; from[m] = k; heap.push(m, cost + h(m)); }
    }
  }
  if (from[goal] < 0) return null;

  const cells: number[] = [];
  for (let k = goal; k !== start && k >= 0; k = from[k]) cells.push(k);
  cells.reverse();
  // Pull the route straight across flat ground; keep every point where the height changes.
  const flat = (a: Waypoint, c: Waypoint, z: number) => {
    const steps = Math.ceil(Math.hypot(c.x - a.x, c.y - a.y));
    for (let s = 1; s < steps; s++) {
      const u = s / steps;
      if (t.groundAt(a.x + (c.x - a.x) * u, a.y + (c.y - a.y) * u) !== z) return false;
    }
    return true;
  };
  const out: Waypoint[] = [];
  let anchor = { x: x0, y: y0 }, az = t.groundAt(x0, y0), i = 0;
  while (i < cells.length) {
    let j = i;
    while (j + 1 < cells.length && height[cells[j + 1]] === az && flat(anchor, centre(cells[j + 1]), az)) j++;
    const p = j === cells.length - 1 ? { x: x1, y: y1 } : centre(cells[j]);
    out.push(p);
    anchor = p;
    az = height[cells[j]];
    i = j + 1;
  }
  return out;
}

/** Binary min-heap of grid indices keyed by priority. */
class MinHeap {
  private keys: Int32Array;
  private pri: Float32Array;
  size = 0;
  constructor(cap: number) { this.keys = new Int32Array(cap * 4); this.pri = new Float32Array(cap * 4); }
  push(k: number, p: number) {
    if (this.size >= this.keys.length) return;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.pri[parent] <= p) break;
      this.keys[i] = this.keys[parent]; this.pri[i] = this.pri[parent];
      i = parent;
    }
    this.keys[i] = k; this.pri[i] = p;
  }
  pop(): number {
    const top = this.keys[0];
    const k = this.keys[--this.size], p = this.pri[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.pri[c + 1] < this.pri[c]) c++;
      if (this.pri[c] >= p) break;
      this.keys[i] = this.keys[c]; this.pri[i] = this.pri[c];
      i = c;
    }
    this.keys[i] = k; this.pri[i] = p;
    return top;
  }
}

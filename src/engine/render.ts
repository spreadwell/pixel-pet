import { Body, Leg, NEARER, SPINE, TAIL_FIRST } from './body';
import type { Palette } from './palette';

/*
 * Pixel renderer for the gecko, in the flat two-tone style of classic lizard sprites:
 * no outline, no texture, one side of the body lit and the other in shade, one-pixel
 * limbs ending in little claw feet. The body is rasterised from the spine at sub-pixel
 * precision into a small depth buffer (one disc per spine point, nearest disc wins), so
 * the silhouette changes pixel-by-pixel as the animal moves instead of jumping as a
 * whole. Each covered pixel remembers which side of the spine it lies on.
 *
 * The animal lives in art px, but can be drawn on a finer grid: `res` canvas pixels per
 * art px (1.5 draws it with half as many pixels again each way, at the same size).
 *
 * Height shows four ways, as it would to a camera looking down at a slight angle:
 *   - Lift. Whatever is higher is drawn higher up the screen, the way "up" reads in an
 *     isometric view, so climbing onto something visibly raises it.
 *   - Size. Higher is also nearer the camera and drawn bigger, point by point, so up on
 *     a sidebar the whole gecko is larger, rearing up a ledge its front half swells
 *     before its back, and held in the hand it looms.
 *   - Shadow. The shadow falls down and to the right by how high each part is above the
 *     ground, and lies on whatever surface it lands on, lifted and scaled with it — so
 *     on a panel it stays tucked under the gecko, and from the top of a ledge the part
 *     that falls past the edge drops to the floor below.
 *   - Light. Where the spine crests over a ridge or lip its lit side catches a little
 *     more light; in the dip below one its shaded side goes a little deeper.
 */

interface LegPixel { x: number; y: number; c: string; lift: number; z: number; }
/** A leg's joints last drawn, in whole pixels: hip, knee, foot. */
type Snapped = [number, number, number, number, number, number];
type Project = (x: number, y: number, z: number) => { x: number; y: number };


/** Shadow offset (art px) for a pixel `h` above the ground. */
const shadowOffset = (h: number) => 1 + Math.round(Math.min(6, Math.max(0, h * 0.6)));

/** Where the shadow of a point at height `z` lands, measured against the ground where it falls. */
function castShadow(b: Body, z: number, x: number, y: number) {
  const o = shadowOffset(z - b.ground(x + 0.5, y + 0.5));
  return shadowOffset(z - b.ground(x + o + 0.5, y + o + 0.5));
}

/** Visit every pixel of a disc. */
function disc(cx: number, cy: number, r: number, fn: (x: number, y: number, dx: number, dy: number, d2: number) => void) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    const dy = y + 0.5 - cy;
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x + 0.5 - cx, d2 = dx * dx + dy * dy;
      if (d2 <= r2) fn(x, y, dx, dy, d2);
    }
  }
}

/**
 * How far round the light reaches: a pixel is lit when (its lateral position × how much
 * that side faces the light) is above minus this. Small, so side-on the body splits in
 * half, while nearly end-on the shaded side thins away to nothing.
 */
const SHADE_EDGE = 0.04;

// Light falls from the upper left of the screen, whichever way the animal faces.
const LIGHT = { x: -0.6, y: -0.8 };

export class GeckoRenderer {
  private depth = new Float32Array(0);
  private seg = new Int16Array(0);
  private lat = new Float32Array(0);
  private shadow = new Uint8Array(0);
  private bw = 0;
  private bh = 0;
  private bx = 0;
  private by = 0;
  /**
   * How much the animal's left side faces the light, -1..1, eased over a few frames so the
   * wiggle of the gait doesn't flicker it.
   */
  private light = 1;
  private bend = new Float32Array(SPINE);
  /**
   * Draw each leg from whole-pixel joints that only move once the real joint has clearly
   * moved, with clean one-pixel lines between them. Otherwise a one-pixel line between
   * joints moving by fractions of a pixel re-rasterises every frame and its pixels
   * shimmer, which makes the legs look like they wriggle even when the motion is smooth.
   */
  stableLegs = true;
  /** Keep a planted foot's toes where they were set down, instead of turning with the body. */
  lockToes = true;
  /**
   * Drawn the way a careful pixel artist would: a cleaned-up silhouette (no single-pixel
   * bumps or notches), three tones — highlight on the side toward the light, mid, and
   * shadow only on the far edge and underside — and a pale accent on the toes and snout.
   */
  refined = false;
  private mask = new Uint8Array(0);
  /** How the eyes are drawn: one pixel, a 2×2 block, a block with a glint, or bulging past the head. */
  eyeStyle: 'dot' | 'big' | 'glint' | 'bulge' = 'dot';
  private snapped = new Map<Leg, Snapped>();
  private snappedShadow = new Map<Leg, Snapped>();

  draw(ctx: CanvasRenderingContext2D, b: Body, pal: Palette, res = 1) {
    // The left-hand normal of the body against the light. As the animal turns, the line
    // between its lit and shaded halves sweeps across it: the shaded side narrows to its
    // edge and the light comes round, rather than the two sides swapping at once.
    const toLight = -Math.sin(b.heading) * LIGHT.x + Math.cos(b.heading) * LIGHT.y;
    this.light += (toLight - this.light) * 0.2;

    // Art px in, canvas pixels out.
    const project: Project = (x, y, z) => { const p = b.project(x, y, z); return { x: p.x * res, y: p.y * res }; };
    const flat: Project = (x, y) => ({ x: x * res, y: y * res });

    this.frame(b, project, res);
    this.rasteriseBody(b, project, res);
    const legs = this.legPixels(b, pal, project, this.snapped, res);

    // The shadow: the body at its true size on the ground, each part offset by its height.
    const { bw, bh, bx, by } = this;
    const sw = bw, sh = bh;
    if (this.shadow.length < sw * sh) this.shadow = new Uint8Array(sw * sh);
    const shadow = this.shadow;
    shadow.fill(0, 0, sw * sh);
    const mark = (x: number, y: number) => {
      const sx = x - bx, sy = y - by;
      if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) shadow[sy * sw + sx] = 1;
    };
    for (let i = 0; i < SPINE; i++) {
      const p = this.spinePoint(b, i);
      // Each part of the shadow lies on the surface it lands on, drawn lifted and scaled
      // with that surface: on a panel it rides up with the panel's floor and stays
      // tucked under the gecko; past the edge it drops to the note below.
      const o = castShadow(b, b.z[i], p.x, p.y);
      const g = b.ground(p.x + o + 0.5, p.y + o + 0.5);
      const q = project(p.x + o, p.y + o, g);
      disc(q.x, q.y, b.width(i) * b.breathScale(i) * b.squeeze[i] * (1 + NEARER * g) * res, (x, y) => mark(x, y));
    }
    for (const p of this.legPixels(b, pal, flat, this.snappedShadow, res)) {
      const ax = (p.x + 0.5) / res, ay = (p.y + 0.5) / res;
      const o = castShadow(b, p.z, ax, ay);
      const q = project(ax + o, ay + o, b.ground(ax + o, ay + o));
      mark(Math.floor(q.x), Math.floor(q.y));
    }
    ctx.fillStyle = pal.shadow;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      if (shadow[y * sw + x] && !(this.depth[y * bw + x] > 0)) ctx.fillRect(bx + x, by + y, 1, 1);
    }

    for (const p of legs) { ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, 1, 1); }
    this.paintBody(ctx, b, pal);
    this.paintHead(ctx, b, pal, project, res);
  }

  /** A spine point with the tail twitch applied (before any projection). */
  private spinePoint(b: Body, i: number) {
    const p = b.pts[i], f = b.forward(i), tw = b.tailOffset(i);
    return { x: p.x - f.y * tw, y: p.y + f.x * tw };
  }

  /** Size the work area to cover the drawn body, its feet and its shadow. */
  private frame(b: Body, project: Project, res: number) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const take = (x: number, y: number) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    for (let i = 0; i < SPINE; i++) {
      const p = b.pts[i];
      take(p.x * res, p.y * res);
      const q = project(p.x, p.y, b.z[i]);
      take(q.x, q.y);
    }
    const pad = Math.ceil(10 * res);
    this.bx = Math.floor(minX) - pad;
    this.by = Math.floor(minY) - pad;
    this.bw = Math.ceil(maxX) + 2 * pad - this.bx;
    this.bh = Math.ceil(maxY) + 2 * pad - this.by;
    const size = this.bw * this.bh;
    if (this.depth.length < size) {
      this.depth = new Float32Array(size);
      this.seg = new Int16Array(size);
      this.lat = new Float32Array(size);
    }
    this.depth.fill(0, 0, size);
  }

  private rasteriseBody(b: Body, project: Project, res: number) {
    for (let i = SPINE - 1; i >= 0; i--) {
      const sp = this.spinePoint(b, i);
      const f = b.forward(i);
      const z = b.z[i];
      const { x: cx, y: cy } = project(sp.x, sp.y, z);
      let r = b.width(i) * b.breathScale(i) * b.squeeze[i] * (1 + NEARER * Math.max(0, z)) * res;
      // A tail that never breaks up into dots at its thin end.
      if (this.refined) r = Math.max(r, 0.75 * res);
      disc(cx, cy, r, (x, y, dx, dy, d2) => {
        const lx = x - this.bx, ly = y - this.by;
        if (lx < 0 || ly < 0 || lx >= this.bw || ly >= this.bh) return;
        const depth = 1 - Math.sqrt(d2) / (r + 0.001);
        const k = ly * this.bw + lx;
        if (depth > this.depth[k]) {
          this.depth[k] = depth;
          this.seg[k] = i;
          // Signed lateral offset: + is the animal's left.
          this.lat[k] = (f.x * dy - f.y * dx) / (r + 0.001);
        }
      });
    }
  }

  private paintBody(ctx: CanvasRenderingContext2D, b: Body, pal: Palette) {
    if (this.refined) { this.paintRefined(ctx, pal); return; }
    const { bw, bh, bx, by, depth, lat, seg } = this;
    // How the spine bends over the terrain at each point: positive where it crests over
    // a ridge or the lip of a ledge, negative in the dip or crease below one.
    const bend = this.bend;
    for (let i = 0; i < SPINE; i++) {
      const a = b.z[Math.max(0, i - 2)], c = b.z[Math.min(SPINE - 1, i + 2)];
      bend[i] = b.z[i] - (a + c) / 2;
    }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      if (depth[k] <= 0) continue;
      const lit = lat[k] * this.light + SHADE_EDGE > 0, d = bend[seg[k]];
      ctx.fillStyle = lit ? (d > 0.5 ? pal.crest : pal.base) : d < -0.5 ? pal.crease : pal.shade;
      ctx.fillRect(bx + x, by + y, 1, 1);
    }
  }

  /** The refined look: clean silhouette and three-tone shading. */
  private paintRefined(ctx: CanvasRenderingContext2D, pal: Palette) {
    const { bw, bh, bx, by, depth, lat, seg } = this;
    const n = bw * bh;
    if (this.mask.length < n) this.mask = new Uint8Array(n);
    const m = this.mask;
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < bw && y < bh && depth[y * bw + x] > 0;
    const n4 = (x: number, y: number) => (on(x - 1, y) ? 1 : 0) + (on(x + 1, y) ? 1 : 0) + (on(x, y - 1) ? 1 : 0) + (on(x, y + 1) ? 1 : 0);
    // Clean the silhouette: fill one-pixel notches, shave one-pixel bumps off the head and
    // trunk (the tail is thin enough that its single pixels are the line itself).
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x, c = n4(x, y);
      if (depth[k] > 0) m[k] = seg[k] < TAIL_FIRST && c <= 1 ? 0 : 1;
      else if (c >= 3) {
        m[k] = 2;
        const src = on(x - 1, y) ? k - 1 : on(x + 1, y) ? k + 1 : on(x, y - 1) ? k - bw : k + bw;
        seg[k] = seg[src]; lat[k] = lat[src];
      } else m[k] = 0;
    }
    const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < bw && y < bh && m[y * bw + x] > 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      if (!m[k]) continue;
      const f = lat[k] * this.light;
      const edge = !filled(x - 1, y) || !filled(x + 1, y) || !filled(x, y - 1) || !filled(x, y + 1);
      // Shadow is the far side's edge and the mass of the underside; the near side
      // carries a highlight band inside its edge; the rest is mid tone.
      ctx.fillStyle = f < -0.55 || (edge && f < -0.1) ? pal.shade : f > 0.25 && !edge ? pal.light : pal.base;
      ctx.fillRect(bx + x, by + y, 1, 1);
    }
  }

  private paintHead(ctx: CanvasRenderingContext2D, b: Body, pal: Palette, project: Project, res: number) {
    const a = b.headAngle;
    const fx = Math.cos(a), fy = Math.sin(a);
    const lx = fy, ly = -fx; // animal's left
    const at = (k: number, side: number) => {
      const p = b.pts[k];
      const q = project(p.x + lx * side, p.y + ly * side, b.z[k]);
      return { x: Math.floor(q.x), y: Math.floor(q.y) };
    };
    const px = (p: { x: number; y: number }, c: string) => { ctx.fillStyle = c; ctx.fillRect(p.x, p.y, 1, 1); };
    const s0 = (1 + NEARER * Math.max(0, b.z[0])) * res;

    // One dark pixel per eye, on the sides of the skull; closed, it reads as shade. Each is
    // kept on the head's own pixels — rounding can put an edge pixel just off it, where
    // the eye would vanish against the page — and the two never share a pixel.
    const onHead = (p: { x: number; y: number }) => {
      const ix = p.x - this.bx, iy = p.y - this.by;
      return ix >= 0 && iy >= 0 && ix < this.bw && iy < this.bh && this.depth[iy * this.bw + ix] > 0;
    };
    const eyeAt = (k: number, side: number) => {
      let off = b.width(k) - 0.5, e = at(k, side * off);
      while (!onHead(e) && off > 0.3) { off -= 0.35; e = at(k, side * off); }
      return e;
    };
    const left = eyeAt(3, 1);
    let right = eyeAt(3, -1);
    for (const k of [4, 2]) if (right.x === left.x && right.y === left.y) right = eyeAt(k, -1);
    const closed = b.lid > 0.55, col = closed ? pal.shade : pal.eye;
    for (const [e, side] of [[left, 1], [right, -1]] as const) {
      if (this.eyeStyle === 'dot') { px(e, col); continue; }
      if (this.eyeStyle === 'bulge') {
        // On the edge of the skull, and a pixel standing proud of it.
        px(e, col);
        const out = at(3, side * (b.width(3) + 0.6));
        if (!onHead(out)) px(out, col);
        continue;
      }
      // A 2×2 eye: of the four blocks that include this pixel, the one most on the head.
      let best = e, bestOn = -1;
      for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
        let on = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (onHead({ x: e.x + ox + dx, y: e.y + oy + dy })) on++;
        if (on > bestOn) { bestOn = on; best = { x: e.x + ox, y: e.y + oy }; }
      }
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) px({ x: best.x + dx, y: best.y + dy }, col);
      // The glint sits on the corner nearest the light (upper left).
      if (this.eyeStyle === 'glint' && !closed) px(best, pal.glint);
    }

    // Mouth: when open, the snout tip splits.
    const tip = project(b.pts[0].x + fx * 0.9, b.pts[0].y + fy * 0.9, b.z[0]);
    // The refined look picks out the tip of the snout in the pale accent.
    if (this.refined && b.mouth <= 0.35) {
      const nose = project(b.pts[0].x + fx * 0.3, b.pts[0].y + fy * 0.3, b.z[0]);
      const p = { x: Math.floor(nose.x), y: Math.floor(nose.y) };
      if (onHead(p)) px(p, pal.toe);
    }
    if (b.mouth > 0.35) {
      px({ x: Math.floor(tip.x), y: Math.floor(tip.y) }, pal.tongue);
      px({ x: Math.floor(tip.x + lx * 1.1 * s0), y: Math.floor(tip.y + ly * 1.1 * s0) }, pal.shade);
      px({ x: Math.floor(tip.x - lx * 1.1 * s0), y: Math.floor(tip.y - ly * 1.1 * s0) }, pal.shade);
    }

    const t = b.tongue;
    if (t) {
      const ext = Math.sin(t.t * Math.PI);
      if (t.kind === 'flick') {
        const len = (1 + ext * 2.4) * s0;
        for (let s = 0.6; s <= len; s += 0.6) px({ x: Math.floor(tip.x + fx * s), y: Math.floor(tip.y + fy * s) }, pal.tongue);
      } else {
        // Eye lick: the tongue sweeps from the snout up over one eye.
        const eye = project(b.pts[3].x + lx * t.side * b.width(3), b.pts[3].y + ly * t.side * b.width(3), b.z[3]);
        const u = ext;
        const mx = tip.x + (eye.x - tip.x) * u + fx * 1.2 * s0 * Math.sin(u * Math.PI);
        const my = tip.y + (eye.y - tip.y) * u + fy * 1.2 * s0 * Math.sin(u * Math.PI);
        px({ x: Math.floor(tip.x + fx * 0.8 * s0), y: Math.floor(tip.y + fy * 0.8 * s0) }, pal.tongue);
        px({ x: Math.floor(mx), y: Math.floor(my) }, pal.tongue);
        px({ x: Math.floor((mx + tip.x) / 2 + fx * s0), y: Math.floor((my + tip.y) / 2 + fy * s0) }, pal.tongue);
      }
    }
  }

  private legPixels(b: Body, pal: Palette, project: Project, snaps: Map<Leg, Snapped>, res: number): LegPixel[] {
    const out: LegPixel[] = [];
    for (const leg of b.legs) this.legToPixels(b, leg, pal, out, project, snaps, res);
    return out;
  }

  private legToPixels(b: Body, leg: Leg, pal: Palette, out: LegPixel[], project: Project, snaps: Map<Leg, Snapped>, res: number) {
    const lift = leg.lift;
    const f = b.forward(leg.def.seg);
    const side = leg.def.side;
    const ox = -f.y * side, oy = f.x * side;
    const c = side * this.light + SHADE_EDGE > 0 ? pal.base : pal.shade;
    const seen = new Set<number>();
    // Heights: the hip rides with the body, the foot stands on the terrain (or lifts off it).
    const zh = b.z[leg.def.seg], zf = b.footZ(leg), zk = (zh + zf) / 2;
    let hip = project(leg.hip.x, leg.hip.y, zh), knee = project(leg.knee.x, leg.knee.y, zk), foot = project(leg.foot.x, leg.foot.y, zf);
    if (this.stableLegs) {
      // Hold each joint's pixel until the real joint is clearly over the next one.
      const prev = snaps.get(leg);
      const hold = (v: number, k: number) => (prev && Math.abs(v - (prev[k] + 0.5)) < 0.9 ? prev[k] : Math.floor(v));
      const s: Snapped = [hold(hip.x, 0), hold(hip.y, 1), hold(knee.x, 2), hold(knee.y, 3), hold(foot.x, 4), hold(foot.y, 5)];
      snaps.set(leg, s);
      hip = { x: s[0] + 0.5, y: s[1] + 0.5 }; knee = { x: s[2] + 0.5, y: s[3] + 0.5 }; foot = { x: s[4] + 0.5, y: s[5] + 0.5 };
    }
    const put = (x: number, y: number, l: number, z: number, col = c) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const key = iy * 100003 + ix;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ x: ix, y: iy, c: col, lift: l, z });
    };
    const line = (ax: number, ay: number, cx: number, cy: number, l0: number, l1: number, z0: number, z1: number, col = c) => {
      if (this.stableLegs) {
        // A clean one-pixel step line between whole-pixel joints (Bresenham).
        let x = Math.floor(ax), y = Math.floor(ay);
        const x1 = Math.floor(cx), y1 = Math.floor(cy);
        const dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
        const n = Math.max(dx, -dy) || 1;
        let err = dx + dy, i = 0;
        for (;;) {
          const u = i++ / n;
          put(x, y, l0 + (l1 - l0) * u, z0 + (z1 - z0) * u, col);
          if (x === x1 && y === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x += sx; }
          if (e2 <= dx) { err += dx; y += sy; }
        }
        return;
      }
      const n = Math.max(1, Math.ceil(Math.hypot(cx - ax, cy - ay) * 2));
      for (let s = 0; s <= n; s++) {
        const u = s / n;
        put(ax + (cx - ax) * u, ay + (cy - ay) * u, l0 + (l1 - l0) * u, z0 + (z1 - z0) * u, col);
      }
    };
    line(hip.x, hip.y, knee.x, knee.y, 0, lift * 0.5, zh, zk);
    line(knee.x, knee.y, foot.x, foot.y, lift * 0.5, lift, zk, zf);
    if (lift > 0.25) return;
    // A planted foot spreads two claws: forefeet point forward-out, hind feet out-back.
    const fwdBias = leg.def.front ? Math.atan2(f.y, f.x) : Math.atan2(-f.y, -f.x);
    const dir = this.lockToes ? leg.toe : blendAngle(Math.atan2(oy, ox), fwdBias, leg.def.front ? 0.5 : 0.35);
    for (const spread of [-0.75, 0.75]) {
      // A short claw line from the foot, so it stays attached however fine the grid.
      line(foot.x, foot.y, foot.x + Math.cos(dir + spread) * 1.2 * res, foot.y + Math.sin(dir + spread) * 1.2 * res, 0, 0, zf, zf, this.refined ? pal.toe : c);
    }
  }
}

function blendAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

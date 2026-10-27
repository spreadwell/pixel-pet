import { Body, Leg, SPINE, halfWidth } from './body';
import type { Palette } from './palette';

/*
 * Pixel renderer for the gecko, in the flat two-tone style of classic lizard sprites:
 * no outline, no texture, one side of the body lit and the other in shade, one-pixel
 * limbs ending in little claw feet. The body is rasterised from the spine at sub-pixel
 * precision into a small depth buffer (one disc per spine point, nearest disc wins), so
 * the silhouette changes pixel-by-pixel as the animal moves instead of jumping as a
 * whole. Each covered pixel remembers which side of the spine it lies on.
 *
 * Height shows through the shadow: each pixel casts its shadow down and to the right by
 * how far it is above the ground beneath it, so where the body bridges a step its
 * shadow falls away, and a lifted foot's shadow parts from it.
 */

interface LegPixel { x: number; y: number; c: string; lift: number; z: number; }

/** Shadow offset (art px) for a pixel `h` above the ground. */
const shadowOffset = (h: number) => 1 + Math.round(Math.min(8, Math.max(0, h * 0.9)));

/**
 * Where the shadow of a pixel at height `z` lands: measured against the ground where it
 * falls, not under the pixel, so from the top of a ledge the shadow drops off the edge.
 */
function castShadow(b: Body, z: number, x: number, y: number) {
  const o = shadowOffset(z - b.ground(x + 0.5, y + 0.5));
  return shadowOffset(z - b.ground(x + o + 0.5, y + o + 0.5));
}

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
  /** Which side of the spine (+1 = animal's left) faces the light. Switches with hysteresis. */
  private lit: 1 | -1 = 1;
  private bend = new Float32Array(SPINE);

  draw(ctx: CanvasRenderingContext2D, b: Body, pal: Palette) {
    // The left-hand normal of the body; flip which side is lit only once it clearly
    // faces away, so the shading never flickers with the gait.
    const toLight = -Math.sin(b.heading) * LIGHT.x + Math.cos(b.heading) * LIGHT.y;
    if (toLight > 0.25) this.lit = 1;
    else if (toLight < -0.25) this.lit = -1;

    this.rasteriseBody(b);
    const legs = this.legPixels(b, pal);

    // Shadow first (deduplicated so overlaps don't darken).
    const { bw, bh, bx, by } = this;
    const sw = bw + 10, sh = bh + 10;
    if (this.shadow.length < sw * sh) this.shadow = new Uint8Array(sw * sh);
    const shadow = this.shadow;
    shadow.fill(0, 0, sw * sh);
    const mark = (x: number, y: number) => {
      const sx = x - bx, sy = y - by;
      if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) shadow[sy * sw + sx] = 1;
    };
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      if (this.depth[k] <= 0) continue;
      const o = castShadow(b, b.z[this.seg[k]], bx + x, by + y);
      mark(bx + x + o, by + y + o);
    }
    for (const p of legs) {
      const o = castShadow(b, p.z, p.x, p.y);
      mark(p.x + o, p.y + o);
    }
    ctx.fillStyle = pal.shadow;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      if (shadow[y * sw + x] && !(x < bw && y < bh && this.depth[y * bw + x] > 0)) {
        ctx.fillRect(bx + x, by + y, 1, 1);
      }
    }

    for (const p of legs) { ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, 1, 1); }
    this.paintBody(ctx, b, pal);
    this.paintHead(ctx, b, pal);
  }

  private rasteriseBody(b: Body) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of b.pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const pad = 6;
    this.bx = Math.floor(minX) - pad;
    this.by = Math.floor(minY) - pad;
    this.bw = Math.ceil(maxX) + pad - this.bx;
    this.bh = Math.ceil(maxY) + pad - this.by;
    const size = this.bw * this.bh;
    if (this.depth.length < size) {
      this.depth = new Float32Array(size);
      this.seg = new Int16Array(size);
      this.lat = new Float32Array(size);
    }
    this.depth.fill(0, 0, size);

    for (let i = SPINE - 1; i >= 0; i--) {
      const p = b.pts[i];
      const f = b.forward(i);
      const tw = b.tailOffset(i);
      const cx = p.x - f.y * tw, cy = p.y + f.x * tw;
      const r = halfWidth(i) * b.breathScale(i) * b.squeeze[i];
      const r2 = r * r;
      const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
      const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
      for (let y = y0; y <= y1; y++) {
        const ly = y - this.by;
        if (ly < 0 || ly >= this.bh) continue;
        const dy = y + 0.5 - cy;
        for (let x = x0; x <= x1; x++) {
          const lx = x - this.bx;
          if (lx < 0 || lx >= this.bw) continue;
          const dx = x + 0.5 - cx;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const depth = 1 - Math.sqrt(d2) / (r + 0.001);
          const k = ly * this.bw + lx;
          if (depth > this.depth[k]) {
            this.depth[k] = depth;
            this.seg[k] = i;
            // Signed lateral offset: + is the animal's left.
            this.lat[k] = (f.x * dy - f.y * dx) / (r + 0.001);
          }
        }
      }
    }
  }

  private paintBody(ctx: CanvasRenderingContext2D, b: Body, pal: Palette) {
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
      const lit = (lat[k] >= 0 ? 1 : -1) === this.lit, d = bend[seg[k]];
      ctx.fillStyle = d > 0.3 ? (lit ? pal.crest : pal.base) : d < -0.3 ? (lit ? pal.shade : pal.crease) : lit ? pal.base : pal.shade;
      ctx.fillRect(bx + x, by + y, 1, 1);
    }
  }

  private paintHead(ctx: CanvasRenderingContext2D, b: Body, pal: Palette) {
    const a = b.headAngle;
    const fx = Math.cos(a), fy = Math.sin(a);
    const lx = fy, ly = -fx; // animal's left
    const at = (k: number, side: number) => {
      const p = b.pts[k];
      return { x: Math.floor(p.x + lx * side), y: Math.floor(p.y + ly * side) };
    };
    const px = (p: { x: number; y: number }, c: string) => { ctx.fillStyle = c; ctx.fillRect(p.x, p.y, 1, 1); };

    // One dark pixel per eye, on the sides of the skull; closed, it reads as shade.
    for (const side of [1, -1]) {
      px(at(3, side * (halfWidth(3) - 0.5)), b.lid > 0.55 ? pal.shade : pal.eye);
    }

    // Mouth: when open, the snout tip splits.
    const tip = { x: b.pts[0].x + fx * 0.9, y: b.pts[0].y + fy * 0.9 };
    if (b.mouth > 0.35) {
      px({ x: Math.floor(tip.x), y: Math.floor(tip.y) }, pal.tongue);
      px({ x: Math.floor(tip.x + lx * 1.1), y: Math.floor(tip.y + ly * 1.1) }, pal.shade);
      px({ x: Math.floor(tip.x - lx * 1.1), y: Math.floor(tip.y - ly * 1.1) }, pal.shade);
    }

    const t = b.tongue;
    if (t) {
      const ext = Math.sin(t.t * Math.PI);
      if (t.kind === 'flick') {
        const len = 1 + ext * 2.4;
        for (let s = 0.6; s <= len; s += 0.6) px({ x: Math.floor(tip.x + fx * s), y: Math.floor(tip.y + fy * s) }, pal.tongue);
      } else {
        // Eye lick: the tongue sweeps from the snout up over one eye.
        const eye = { x: b.pts[3].x + lx * t.side * halfWidth(3), y: b.pts[3].y + ly * t.side * halfWidth(3) };
        const u = ext;
        const mx = tip.x + (eye.x - tip.x) * u + fx * 1.2 * Math.sin(u * Math.PI);
        const my = tip.y + (eye.y - tip.y) * u + fy * 1.2 * Math.sin(u * Math.PI);
        px({ x: Math.floor(tip.x + fx * 0.8), y: Math.floor(tip.y + fy * 0.8) }, pal.tongue);
        px({ x: Math.floor(mx), y: Math.floor(my) }, pal.tongue);
        px({ x: Math.floor((mx + tip.x) / 2 + fx), y: Math.floor((my + tip.y) / 2 + fy) }, pal.tongue);
      }
    }
  }

  private legPixels(b: Body, pal: Palette): LegPixel[] {
    const out: LegPixel[] = [];
    for (const leg of b.legs) this.legToPixels(b, leg, pal, out);
    return out;
  }

  private legToPixels(b: Body, leg: Leg, pal: Palette, out: LegPixel[]) {
    const { hip, knee, foot } = leg;
    const lift = leg.lift;
    const f = b.forward(leg.def.seg);
    const side = leg.def.side;
    const ox = -f.y * side, oy = f.x * side;
    const c = side === this.lit ? pal.base : pal.shade;
    const seen = new Set<number>();
    // Heights: the hip rides with the body, the foot stands on the terrain (or lifts off it).
    const zh = b.z[leg.def.seg], zf = b.footZ(leg), zk = (zh + zf) / 2;
    const put = (x: number, y: number, l: number, z: number) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const key = iy * 100003 + ix;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ x: ix, y: iy, c, lift: l, z });
    };
    const line = (ax: number, ay: number, cx: number, cy: number, l0: number, l1: number, z0: number, z1: number) => {
      const n = Math.max(1, Math.ceil(Math.hypot(cx - ax, cy - ay) * 2));
      for (let s = 0; s <= n; s++) {
        const u = s / n;
        put(ax + (cx - ax) * u, ay + (cy - ay) * u, l0 + (l1 - l0) * u, z0 + (z1 - z0) * u);
      }
    };
    line(hip.x, hip.y, knee.x, knee.y, 0, lift * 0.5, zh, zk);
    line(knee.x, knee.y, foot.x, foot.y, lift * 0.5, lift, zk, zf);
    if (lift > 0.25) return;
    // A planted foot spreads two claws: forefeet point forward-out, hind feet out-back.
    const fwdBias = leg.def.front ? Math.atan2(f.y, f.x) : Math.atan2(-f.y, -f.x);
    const dir = blendAngle(Math.atan2(oy, ox), fwdBias, leg.def.front ? 0.5 : 0.35);
    for (const spread of [-0.75, 0.75]) {
      put(foot.x + Math.cos(dir + spread) * 1.2, foot.y + Math.sin(dir + spread) * 1.2, 0, zf);
    }
  }
}

function blendAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

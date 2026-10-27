import { Body, Leg, NECK, SPINE, TAIL_FIRST, halfWidth } from './body';
import type { Palette } from './palette';
import { hash2 } from './math';

/*
 * Pixel renderer for the gecko. The body is rasterised from the spine at sub-pixel
 * precision into a small depth buffer (one disc per spine point, nearest disc wins), so
 * the silhouette changes pixel-by-pixel as the animal moves instead of jumping as a
 * whole. Each covered pixel remembers which spine point owns it and its signed lateral
 * position, which lets spots and tail bands stay attached to the body as it bends.
 */

interface LegPixel { x: number; y: number; c: string; lift: number; }

export class GeckoRenderer {
  private depth = new Float32Array(0);
  private seg = new Int16Array(0);
  private lat = new Float32Array(0);
  private shadow = new Uint8Array(0);
  private bw = 0;
  private bh = 0;
  private bx = 0;
  private by = 0;
  private seed = Math.floor(Math.random() * 1e6);

  draw(ctx: CanvasRenderingContext2D, b: Body, pal: Palette) {
    this.rasteriseBody(b);
    const legs = this.legPixels(b, pal);

    // Shadow first (deduplicated so overlaps don't darken).
    const { bw, bh, bx, by } = this;
    const sw = bw + 4, sh = bh + 4;
    if (this.shadow.length < sw * sh) this.shadow = new Uint8Array(sw * sh);
    const shadow = this.shadow;
    shadow.fill(0, 0, sw * sh);
    const mark = (x: number, y: number) => {
      const sx = x - bx, sy = y - by;
      if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) shadow[sy * sw + sx] = 1;
    };
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (this.depth[y * bw + x] > 0) mark(bx + x + 1, by + y + 1);
    }
    for (const p of legs) {
      const o = 1 + Math.round(p.lift * 1.6);
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
      const r = halfWidth(i) * b.breathScale(i);
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
    const { bw, bh, bx, by, depth, seg, lat } = this;
    const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < bw && y < bh && depth[y * bw + x] > 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      if (depth[k] <= 0) continue;
      const i = seg[k];
      const l = lat[k];
      const edge = !filled(x - 1, y) || !filled(x + 1, y) || !filled(x, y - 1) || !filled(x, y + 1);
      let c: string;
      if (edge) c = pal.outline;
      else {
        const al = Math.abs(l);
        // Lit from above: a soft lighter crown along the back, darker flanks.
        c = al > 0.62 ? pal.flank : al < 0.3 && i >= 2 && i < TAIL_FIRST + 4 && (i + Math.round(l * 3)) % 3 !== 0 ? pal.dorsal : pal.base;
        // Body-space coordinates in pixels: u along the spine, v across it.
        const v = Math.round(l * halfWidth(i) + 8);
        if (i >= TAIL_FIRST) {
          // Broad soft bands across the tail, speckled at the edges.
          const band = Math.floor((i - TAIL_FIRST + 1) / 3) % 2 === 1;
          if (band && al < 0.8) c = pal.band;
          else if (hash2(i * 29 + v, this.seed + 3) < 0.12) c = pal.spot;
        } else if (i >= 4 && al < 0.85) {
          // Leopard speckles fixed to the body: single pixels that sometimes pair up.
          const h = hash2(i * 31 + v, this.seed);
          const pair = hash2((i - 1) * 31 + v, this.seed) < 0.09;
          if (h < (i < NECK + 1 ? 0.14 : 0.2) || (pair && i > NECK)) c = pal.spot;
        }
      }
      ctx.fillStyle = c;
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

    // Eyes sit on the sides of the skull and bulge past the outline.
    for (const s of [1, -1]) {
      const closed = b.lid > 0.55;
      // Leopard geckos have big dark eyes set into the side of the skull, inside the
      // outline, with a bright rim of skin above them.
      const eye = at(3, s * (halfWidth(3) - 1.25));
      const front = at(2, s * (halfWidth(2) - 1.05));
      px(eye, closed ? pal.outline : pal.eye);
      px(front, closed ? pal.flank : pal.eye);
      if (!closed) px(at(3, s * (halfWidth(3) - 2.2)), pal.dorsal);
    }

    // Mouth: when open, the snout tip splits.
    const tip = { x: b.pts[0].x + fx * 0.9, y: b.pts[0].y + fy * 0.9 };
    if (b.mouth > 0.35) {
      px({ x: Math.floor(tip.x), y: Math.floor(tip.y) }, pal.tongue);
      px({ x: Math.floor(tip.x + lx * 1.1), y: Math.floor(tip.y + ly * 1.1) }, pal.outline);
      px({ x: Math.floor(tip.x - lx * 1.1), y: Math.floor(tip.y - ly * 1.1) }, pal.outline);
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
    const seen = new Set<number>();
    const put = (x: number, y: number, c: string, l: number) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const key = iy * 100003 + ix;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ x: ix, y: iy, c, lift: l });
    };
    const line = (ax: number, ay: number, cx: number, cy: number, c: string, l0: number, l1: number) => {
      const n = Math.max(1, Math.ceil(Math.hypot(cx - ax, cy - ay) * 2));
      for (let s = 0; s <= n; s++) {
        const u = s / n;
        put(ax + (cx - ax) * u, ay + (cy - ay) * u, c, l0 + (l1 - l0) * u);
      }
    };
    // A chunky upper limb (two pixels, lit on top, shaded behind) and a slimmer forearm.
    const bx = leg.def.front ? -f.x : f.x, by = leg.def.front ? -f.y : f.y;
    line(hip.x, hip.y, knee.x, knee.y, pal.base, 0, lift * 0.5);
    line(hip.x + bx * 0.9, hip.y + by * 0.9, knee.x + bx * 0.6, knee.y + by * 0.6, pal.flank, 0, lift * 0.5);
    put(knee.x, knee.y, pal.flank, lift * 0.5);
    line(knee.x, knee.y, foot.x, foot.y, pal.flank, lift * 0.5, lift);

    if (lift > 0.25) { put(foot.x, foot.y, pal.flank, lift); return; }
    // Splayed toes when planted. Forefeet point forward-out, hind feet out-back.
    const fwdBias = leg.def.front ? Math.atan2(f.y, f.x) : Math.atan2(-f.y, -f.x);
    const dir = blendAngle(Math.atan2(oy, ox), fwdBias, leg.def.front ? 0.45 : 0.3);
    for (const spread of [-0.85, -0.28, 0.28, 0.85]) {
      const a = dir + spread;
      put(foot.x + Math.cos(a) * 1.5, foot.y + Math.sin(a) * 1.5, pal.outline, 0);
    }
    put(foot.x, foot.y, pal.flank, 0);
  }
}

function blendAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

import { Body, HIP, Leg, NEARER, SPINE } from './body';
import type { Palette } from './palette';
import { clamp, lerp } from './math';

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

interface LegPixel { x: number; y: number; c: string; lift: number; z: number; near: boolean; /** Brush size, canvas px. */ w: number; }
/** A leg's joints last drawn, in whole pixels: hip, knee, foot. */
type Snapped = [number, number, number, number, number, number];
/** Art px in (and, for the tilted view, how high above the ground the point is), canvas px out. */
type Project = (x: number, y: number, z: number, h?: number, hang?: boolean) => { x: number; y: number };


/** Shadow offset (art px) for a pixel `h` above the ground. */
const shadowOffset = (h: number) => 1 + Math.round(Math.min(6, Math.max(0, h * 0.6)));

/** Where the shadow of a point at height `z` lands, measured against the ground where it falls. */
function castShadow(b: Body, z: number, x: number, y: number) {
  const o = shadowOffset(z - b.ground(x + 0.5, y + 0.5));
  return shadowOffset(z - b.ground(x + o + 0.5, y + o + 0.5));
}

/** Visit every pixel of a disc. */
/** An ellipse; the callback's d2 is the normalised distance² from the centre (1 at the rim). */
function ellipse(cx: number, cy: number, rx: number, ry: number, fn: (x: number, y: number, dx: number, dy: number, d2: number) => void) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    const dy = y + 0.5 - cy;
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = x + 0.5 - cx, d2 = (dx / rx) ** 2 + (dy / ry) ** 2;
      if (d2 <= 1) fn(x, y, dx, dy, d2);
    }
  }
}

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
/** Side-on, how far its legs hold its body up off the ground when it's standing, art px. */
const STAND = 1.6;
/** Napping on a block: how quickly the tail turns down over the block's end (art px to turn most of the way). */
const DROOP = 3;

/** Where a point `s` art px along a drooping tail (past the edge) is, relative to the edge. */
function droop(s: number) {
  let dx = 0, dy = 0;
  const step = 0.25;
  for (let t = 0; t < s; t += step) {
    const d = Math.min(step, s - t), a = (Math.PI / 2) * (1 - Math.exp(-(t + d / 2) / DROOP));
    dx += Math.cos(a) * d; dy += Math.sin(a) * d;
  }
  return { dx, dy };
}
/** Side-on, how much thinner the tail gets towards its tip. */
const TAIL_TAPER = 0.6;
/** Side-on, how many pixels wide the top of the head's dome is. */
const DOME = 3;
/** How far over the view tips for a nap: most of the way to side-on, keeping a little depth. */
const TILT = (66 * Math.PI) / 180;
/**
 * A lizard is flat: its body is less tall than it is wide, its head flatter still. From
 * above that doesn't show; tipped side-on it's what keeps the head from looking tall.
 */
const FLAT_BODY = 0.9, FLAT_HEAD = 0.65;
const flatness = (i: number) => (i <= 4 ? FLAT_HEAD : i <= 7 ? (FLAT_HEAD + FLAT_BODY) / 2 : FLAT_BODY);
/** Half-width of the pinched neck, art px: about two pixels across. */
const NECK_HALF = 1.05;

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
  /** How the eyes are drawn: one pixel, a 2×2 block, a block with a glint, or bulging past the head. */
  eyeStyle: 'dot' | 'big' | 'glint' | 'bulge' = 'dot';
  private snapped = new Map<Leg, Snapped>();
  private snappedShadow = new Map<Leg, Snapped>();
  /** A pointed snout, no stray pixels on the head's outline, and eyes held steady. */
  steadyHead = true;
  /**
   * Tipping the view over towards side-on, for a nap on a block: the line on the ground the
   * view turns about (the block's top edge, art px y), and how far over (0 from above → 1
   * side-on, with a little depth left). Everything is drawn as the body really is in 3-D —
   * spheres along the spine, resting on the ground, legs reaching down to it — so turning
   * the view moves smoothly from one to the other. Past the edge, it hangs down the front.
   */
  tilt: { pivot: number; amount: number; end?: number; face?: 1 | -1; stand?: number; droop?: number } | null = null;
  /** Where the head was drawn last (canvas px), for the Z's. */
  headAt = { x: 0, y: 0 };
  private up = new Float32Array(0);
  private tiltA = 0;
  private tiltCos = 1;
  /**
   * Brushes for the fine features, canvas px: limbs and eyes at an art pixel (rounded),
   * claws and the lines of the face a touch finer (rounded down), so that at in-between
   * resolutions the limbs keep their weight and taper to delicate feet.
   */
  private brush = 1;
  private fine = 1;
  private tiltSin = 0;
  /** Carve the neck narrower than the head and shoulders, whichever way it faces. */
  pinchNeck = true;
  /** The eye pixels last drawn (left, right), held like the leg joints so they don't flicker. */
  private eyes: ({ x: number; y: number } | null)[] = [null, null];

  draw(ctx: CanvasRenderingContext2D, b: Body, pal: Palette, res = 1) {
    // The left-hand normal of the body against the light. As the animal turns, the line
    // between its lit and shaded halves sweeps across it: the shaded side narrows to its
    // edge and the light comes round, rather than the two sides swapping at once.
    const toLight = -Math.sin(b.heading) * LIGHT.x + Math.cos(b.heading) * LIGHT.y;
    this.light += (toLight - this.light) * 0.2;

    // Art px in, canvas pixels out.
    const tilt = this.tilt && this.tilt.amount > 0 ? this.tilt : null;
    this.tiltA = tilt ? tilt.amount : 0;
    const phi = this.tiltA * TILT, cos = Math.cos(phi), sin = Math.sin(phi);
    this.tiltCos = cos; this.tiltSin = sin;
    this.brush = Math.max(1, Math.round(res));
    this.fine = Math.max(1, Math.floor(res));
    const a0 = b.pts[2], a1 = b.pts[HIP], axisX = b.pts[12].x;
    const axis = tilt ? clamp((a1.y - a0.y) / (a1.x - a0.x || 1), -0.5, 0.5) : 0;
    const project: Project = (x, y, z, h0 = 0, hang = false) => {
      const p = b.project(x, y, z), px = p.x * res;
      if (!tilt) return { x: px, y: p.y * res };
      // Standing, the body is held up on its legs; lying, it rests on the ground.
      const h = h0 > 0 ? h0 + (tilt.stand ?? 0) * STAND : 0;
      // The view turns about the line the body lies along (so a body lying a little askew
      // doesn't come out arched or crooked), and as it turns that line settles, level, onto
      // the block's edge, so the belly rests right on it.
      const line = (b.pts[12].y + axis * (p.x - axisX)) * res, edge = tilt.pivot * res;
      const anchor = lerp(line, edge, this.tiltA), py = p.y * res;
      // On top: depth foreshortens and height rises. The head and trunk stay up there.
      if (!hang) return { x: px, y: anchor + (Math.min(py, edge) - line) * cos - h * res * sin };
      // The tail and limbs hang: past the front edge, down the front of the block...
      let sy: number;
      if (py > edge) {
        const over = py - edge;
        sy = anchor + (edge - line) * cos + over - h * res * sin * Math.max(0, 1 - over / (3 * res));
      } else sy = anchor + (py - line) * cos - h * res * sin;
      // ...and past the end of the block, down beside it.
      if (tilt.end !== undefined && tilt.face) {
        const end = tilt.end * res, out = (end - px) * tilt.face;
        if (out > 0) {
          // Over the corner it droops: turning steadily further down the further it goes,
          // one continuous curve rather than a run, a bend and a drop.
          const { dx, dy } = droop(out / res);
          // Until it's let it slide over, the tail sticks out straight past the end.
          const a = this.tiltA * (tilt.droop ?? 1);
          return { x: lerp(px, end - tilt.face * dx * res, a), y: sy + dy * res * a };
        }
      }
      return { x: px, y: sy };
    };
    const shadowRows = cos;
    const flat: Project = (x, y) => ({ x: x * res, y: y * res });

    this.frame(b, project, res);
    this.rasteriseBody(b, project, res);
    if (this.pinchNeck) this.carveNeck(b, project, res);
    // (The snout taper is for the view from above; side-on the profile makes its own.)
    if (this.steadyHead && this.tiltA <= 0.6) this.taperSnout(b, project, res);
    if (this.tiltA > 0.6) this.narrowDome(b, project, res);
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
      // Side-on, only the trunk lying on the edge casts a shadow there; what hangs doesn't.
      if (this.tiltA > 0.6 && i > HIP) continue;
      const p = this.spinePoint(b, i);
      // Each part of the shadow lies on the surface it lands on, drawn lifted and scaled
      // with that surface: on a panel it rides up with the panel's floor and stays
      // tucked under the gecko; past the edge it drops to the note below.
      // Side-on, the shadow is straight underneath: a thin line along the ground.
      const o = this.tiltA > 0.6 ? 0 : castShadow(b, b.z[i], p.x, p.y);
      const g = b.ground(p.x + o + 0.5, p.y + o + 0.5);
      const q = project(p.x + o, p.y + o, g, 0, i > HIP);
      const rr = b.width(i) * b.breathScale(i) * b.squeeze[i] * (1 + NEARER * g) * res;
      // Tipped over, the shadow on the ground foreshortens into a narrow band.
      if (shadowRows < 0.999) { const sr = this.tiltA > 0.6 ? 0 : Math.round(rr * shadowRows); for (let dy = -sr; dy <= sr; dy++) for (let dx = -Math.round(rr); dx <= Math.round(rr); dx++) mark(Math.floor(q.x + dx), Math.floor(q.y + dy)); }
      else disc(q.x, q.y, rr, (x, y) => mark(x, y));
    }
    if (this.tiltA <= 0.6) for (const p of this.legPixels(b, pal, flat, this.snappedShadow, res)) {
      const ax = (p.x + 0.5) / res, ay = (p.y + 0.5) / res;
      const o = this.tiltA > 0.6 ? 0 : castShadow(b, p.z, ax, ay);
      const q = project(ax + o, ay + o, b.ground(ax + o, ay + o));
      for (let by = 0; by < this.brush; by++) for (let bx = 0; bx < this.brush; bx++) mark(Math.floor(q.x) + bx, Math.floor(q.y) + by);
    }
    ctx.fillStyle = pal.shadow;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      if (shadow[y * sw + x] && !(this.depth[y * bw + x] > 0)) ctx.fillRect(bx + x, by + y, 1, 1);
    }

    // Side-on, the far legs are hidden behind the body and the near ones drawn over it,
    // a shade darker so elbow and knee stand out against the flank.
    const sideOn = this.tiltA > 0.6;
    // Fine features are drawn with a brush the size of an art pixel, so at a finer
    // resolution a leg stays as thick, relative to the body, as it is at 1×.
    for (const p of legs) if (!sideOn || !p.near) { if (sideOn) continue; ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, p.w, p.w); }
    this.paintBody(ctx, b, pal);
    if (sideOn) for (const p of legs) if (p.near) { ctx.fillStyle = pal.crease; ctx.fillRect(p.x, p.y, p.w, p.w); }
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
      const q = project(p.x, p.y, b.z[i], b.width(i) * flatness(i), i > HIP);
      take(q.x, q.y);
    }
    const pad = Math.ceil((this.tiltA > 0 ? 18 : 10) * res);
    this.bx = Math.floor(minX) - pad;
    this.by = Math.floor(minY) - pad;
    this.bw = Math.ceil(maxX) + 2 * pad - this.bx;
    this.bh = Math.ceil(maxY) + 2 * pad - this.by;
    const size = this.bw * this.bh;
    if (this.depth.length < size) {
      this.depth = new Float32Array(size);
      this.seg = new Int16Array(size);
      this.lat = new Float32Array(size);
      this.up = new Float32Array(size);
    }
    this.depth.fill(0, 0, size);
  }

  private rasteriseBody(b: Body, project: Project, res: number) {
    for (let i = SPINE - 1; i >= 0; i--) {
      const sp = this.spinePoint(b, i);
      const f = b.forward(i);
      const z = b.z[i];
      const ra = b.width(i) * b.breathScale(i) * b.squeeze[i], fl = flatness(i);
      // Resting on the ground: its middle is as high as it is flat. The head is one solid
      // wedge, so all of it is centred at the height of its widest part — the snout points
      // forward rather than drooping to the ground.
      const mid = i <= 4 ? b.width(2) * b.breathScale(2) * FLAT_HEAD : ra * fl;
      const { x: cx, y: cy } = project(sp.x, sp.y, z, mid, i > HIP);
      // Side-on the tail tapers right down to a fine tip.
      const taper = i > HIP ? 1 - TAIL_TAPER * this.tiltA * ((i - HIP) / (SPINE - 1 - HIP)) : 1;
      // (Never so thin that its slices stop joining up into one line.)
      const r = Math.max(ra * taper * (1 + NEARER * Math.max(0, z)), i > HIP && this.tiltA > 0 ? 0.6 : 0) * res;
      // Tipped over, each round section is seen more from the side, so less tall.
      const ry = r * Math.sqrt(this.tiltCos ** 2 + (fl * this.tiltSin) ** 2);
      ellipse(cx, cy, r, ry, (x, y, dx, dy, d2) => {
        const lx = x - this.bx, ly = y - this.by;
        if (lx < 0 || ly < 0 || lx >= this.bw || ly >= this.bh) return;
        const depth = 1 - Math.sqrt(d2);
        const k = ly * this.bw + lx;
        if (depth > this.depth[k]) {
          this.depth[k] = depth;
          this.seg[k] = i;
          // Signed lateral offset: + is the animal's left.
          this.lat[k] = (f.x * dy - f.y * dx) / (r + 0.001);
          // How far up the curve of the body this is, for the tipped view's light from above.
          this.up[k] = -dy / (ry + 0.001);
        }
      });
    }
  }

  /**
   * A neck. The back of the head and the front of the shoulders are discs wide enough to
   * meet across it, so at most angles the head ran straight into the body. Whatever drew
   * them, pixels in the neck that lie further from the spine than a neck's half-width go.
   */
  private carveNeck(b: Body, project: Project, res: number) {
    const { bw, bh, bx, by, depth } = this;
    const FIRST = 3, LAST = 9;
    const q: { x: number; y: number }[] = [];
    for (let i = FIRST; i <= LAST; i++) q.push(project(b.pts[i].x, b.pts[i].y, b.z[i], b.width(i) * flatness(i)));
    // Allowed half-width along the spine (index units): pinched to about two pixels
    // across from just behind the skull to just before the shoulders.
    const half = (s: number) => (s < 4.4 || s > 7.6 ? Infinity : s < 5 ? lerp(2, NECK_HALF, (s - 4.4) / 0.6) : s > 7 ? lerp(NECK_HALF, 1.9, (s - 7) / 0.6) : NECK_HALF);
    const c = q[6 - FIRST], reach = 5 * res;
    for (let y = Math.max(0, Math.floor(c.y - reach) - by); y <= Math.min(bh - 1, Math.ceil(c.y + reach) - by); y++) {
      for (let x = Math.max(0, Math.floor(c.x - reach) - bx); x <= Math.min(bw - 1, Math.ceil(c.x + reach) - bx); x++) {
        const k = y * bw + x;
        if (depth[k] <= 0) continue;
        const px = bx + x + 0.5, py = by + y + 0.5;
        // Nearest point on the spine between the skull and the shoulders.
        let best = Infinity, s = 0;
        for (let j = 0; j < q.length - 1; j++) {
          const ax = q[j].x, ay = q[j].y, ex = q[j + 1].x - ax, ey = q[j + 1].y - ay;
          const len2 = ex * ex + ey * ey || 1;
          const u = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2));
          const d2 = (px - ax - ex * u) ** 2 + (py - ay - ey * u) ** 2;
          if (d2 < best) { best = d2; s = FIRST + j + u; }
        }
        if (Math.sqrt(best) / res > half(s)) depth[k] = 0;
      }
    }
  }

  /**
   * Side-on, the top of the head is a small dome: its top row is trimmed to a few pixels
   * over the crown, so the head rounds off rather than running flat to the snout.
   */
  private narrowDome(b: Body, project: Project, res: number) {
    const { bw, bh, bx, depth, seg } = this;
    const crown = project(b.pts[2].x, b.pts[2].y, b.z[2], b.width(2) * FLAT_HEAD).x - bx;
    const keep = DOME * res;
    for (let y = 0; y < bh; y++) {
      let any = false;
      for (let x = 0; x < bw; x++) {
        const k = y * bw + x;
        // The topmost row of the head (where nothing of the body is above it).
        if (depth[k] <= 0 || seg[k] > 4 || (y > 0 && depth[k - bw] > 0)) continue;
        any = true;
        if (Math.abs(x + 0.5 - crown) > keep / 2) depth[k] = 0;
      }
      if (any) break;
    }
    // And a nose: a column two pixels tall in front of the tip of the snout, low down.
    const s = Math.sign(Math.cos(b.headAngle)) || 1;
    let front = -1;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      if (depth[k] > 0 && seg[k] <= 1 && (front < 0 || x * s > front * s)) front = x;
    }
    if (front < 0 || front + s < 0 || front + s >= bw) return;
    let rows = 0;
    for (let y = bh - 1; y >= 0 && rows < 2; y--) {
      const k = y * bw + front;
      if (depth[k] <= 0 || seg[k] > 1) continue;
      const n = k + s;
      this.depth[n] = depth[k] * 0.5; this.seg[n] = 0; this.lat[n] = this.lat[k]; this.up[n] = this.up[k];
      rows++;
    }
  }

  /**
   * A pointed snout. The discs of the head end in a flat front a few pixels wide, which at
   * this size reads as a square muzzle; trimming the corners off the front two rows keeps
   * the tip to a pixel or two with a slope back to the jaw.
   */
  private taperSnout(b: Body, project: Project, res: number) {
    const { bw, bh, bx, by, depth, seg } = this;
    const fx = Math.cos(b.headAngle), fy = Math.sin(b.headAngle);
    const c = project(b.pts[0].x, b.pts[0].y, b.z[0], b.width(2) * FLAT_HEAD);
    const head: number[] = [];
    let tmax = -Infinity;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      if (depth[k] <= 0 || seg[k] > 2) continue;
      head.push(k);
      tmax = Math.max(tmax, (bx + x + 0.5 - c.x) * fx + (by + y + 0.5 - c.y) * fy);
    }
    for (const k of head) {
      const dx = bx + (k % bw) + 0.5 - c.x, dy = by + Math.floor(k / bw) + 0.5 - c.y;
      const back = (tmax - (dx * fx + dy * fy)) / res, side = Math.abs(dx * fy - dy * fx) / res;
      if ((back < 0.9 && side > 0.7) || (back < 1.9 && side > 1.4)) depth[k] = 0;
    }
    // A disc's rim can add a lone pixel to the head's outline for a frame or two; on a head
    // this small that is a bump that comes and goes (and the eye lands on it), so shave it.
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < bw && y < bh && depth[y * bw + x] > 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      if (depth[k] <= 0 || seg[k] > 5) continue;
      if ((on(x - 1, y) ? 1 : 0) + (on(x + 1, y) ? 1 : 0) + (on(x, y - 1) ? 1 : 0) + (on(x, y + 1) ? 1 : 0) <= 1) depth[k] = 0;
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
      const side = lat[k] * this.light, l = this.tiltA > 0 ? lerp(side, this.up[k] + 0.25, this.tiltA) : side;
      const lit = l + SHADE_EDGE > 0, d = bend[seg[k]];
      // Side-on, the line of the back catches the light.
      const rim = this.tiltA > 0.6 && lit && (y === 0 || depth[k - bw] <= 0);
      ctx.fillStyle = lit ? (d > 0.5 || rim ? pal.crest : pal.base) : d < -0.5 ? pal.crease : pal.shade;
      ctx.fillRect(bx + x, by + y, 1, 1);
    }
  }

  private paintHead(ctx: CanvasRenderingContext2D, b: Body, pal: Palette, project: Project, res: number) {
    const a = b.headAngle;
    const fx = Math.cos(a), fy = Math.sin(a);
    const lx = fy, ly = -fx; // animal's left
    const at = (k: number, side: number) => {
      const p = b.pts[k];
      const q = project(p.x + lx * side, p.y + ly * side, b.z[k], b.width(k) * FLAT_HEAD * 1.5);
      return { x: Math.floor(q.x), y: Math.floor(q.y) };
    };
    const px = (p: { x: number; y: number }, c: string, w = this.fine) => { ctx.fillStyle = c; ctx.fillRect(p.x, p.y, w, w); };
    const s0 = (1 + NEARER * Math.max(0, b.z[0])) * res;
    const hc = project(b.pts[2].x, b.pts[2].y, b.z[2], b.width(2) * FLAT_HEAD);
    this.headAt = { x: hc.x, y: hc.y };

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
    // An eye keeps its pixel until where it should be is clearly over the next one, as
    // long as that pixel is still on the head: one pixel hopping back and forth with the
    // sway of the walk reads as a flickering eye.
    const held = (slot: number, k: number, side: number) => {
      const p = b.pts[k], off = b.width(k) - 0.5;
      const want = project(p.x + lx * side * off, p.y + ly * side * off, b.z[k], b.width(k) * FLAT_HEAD * 1.5);
      const prev = this.eyes[slot];
      if (this.steadyHead && prev && Math.abs(want.x - (prev.x + 0.5)) < 0.9 && Math.abs(want.y - (prev.y + 0.5)) < 0.9 && onHead(prev)) return prev;
      return eyeAt(k, side);
    };
    const left = held(0, 3, 1);
    let right = held(1, 3, -1);
    for (const k of [4, 2]) if (right.x === left.x && right.y === left.y) right = eyeAt(k, -1);
    this.eyes = [left, right];
    const closed = b.lid > 0.55, col = closed ? pal.shade : pal.eye;
    // Tipped towards side-on, only the near eye (lower on screen) shows.
    const near = left.y >= right.y ? left : right;
    const sideOn = this.tiltA > 0.6;
    if (sideOn) {
      // Side-on, the mouth shows: a short dark line back from the snout along the jaw.
      for (const k of [0.6, 1.4, 2.2]) {
        const j = project(b.pts[0].x - fx * k, b.pts[0].y - fy * k, b.z[0], b.width(2) * FLAT_HEAD * 0.75);
        const q = { x: Math.floor(j.x), y: Math.floor(j.y) };
        if (onHead(q)) px(q, pal.crease);
      }
    }
    for (const [e, side] of [[left, 1], [right, -1]] as const) {
      if (sideOn && e !== near) continue;
      // Side-on and shut, the classic sleepy eye: a short lid line slanting down toward the snout.
      if (sideOn) {
        // Side-on: a dash of an eye set into the side of the head, a row above its middle,
        // well inside the outline so it doesn't dent it.
        const s = Math.sign(fx) || 1, w = this.brush;
        let ex = Math.floor(this.headAt.x - s * 0.5 * res), ey = Math.floor(this.headAt.y) - w;
        for (let k = 0; k < 3 && !(onHead({ x: ex, y: ey }) && onHead({ x: ex - s * w, y: ey }) && onHead({ x: ex, y: ey - w })); k++) ey += 1;
        // Open (or drowsy), a single square; shut, a two-square line.
        px({ x: ex, y: ey }, pal.eye, w);
        if (b.lid > 0.9) px({ x: ex - s * w, y: ey }, pal.eye, w);
        continue;
      }
      if (this.eyeStyle === 'dot') { px(e, col, this.brush); continue; }
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
    const tip = project(b.pts[0].x + fx * 0.9, b.pts[0].y + fy * 0.9, b.z[0], b.width(2) * FLAT_HEAD);
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
        const eye = project(b.pts[3].x + lx * t.side * b.width(3), b.pts[3].y + ly * t.side * b.width(3), b.z[3], b.width(3) * FLAT_HEAD);
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
    // Tipped over, the hip is up at the body's side, the elbow or knee higher, the foot down.
    const wh = b.width(leg.def.seg);
    let hip = project(leg.hip.x, leg.hip.y, zh, wh * FLAT_BODY * 0.6), knee = project(leg.knee.x, leg.knee.y, zk, wh * FLAT_BODY * 1.2, true), foot = project(leg.foot.x, leg.foot.y, zf, 0, true);
    // Side-on, the legs on this side are in front of the body.
    const near = oy > 0;
    if (this.stableLegs) {
      // Hold each joint's pixel until the real joint is clearly over the next one.
      const prev = snaps.get(leg);
      const hold = (v: number, k: number) => (prev && Math.abs(v - (prev[k] + 0.5)) < 0.9 ? prev[k] : Math.floor(v));
      const s: Snapped = [hold(hip.x, 0), hold(hip.y, 1), hold(knee.x, 2), hold(knee.y, 3), hold(foot.x, 4), hold(foot.y, 5)];
      snaps.set(leg, s);
      hip = { x: s[0] + 0.5, y: s[1] + 0.5 }; knee = { x: s[2] + 0.5, y: s[3] + 0.5 }; foot = { x: s[4] + 0.5, y: s[5] + 0.5 };
    }
    const put = (x: number, y: number, l: number, z: number, w: number) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      const key = iy * 100003 + ix;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ x: ix, y: iy, c, lift: l, z, near, w });
    };
    const line = (ax: number, ay: number, cx: number, cy: number, l0: number, l1: number, z0: number, z1: number, w = this.brush) => {
      if (this.stableLegs) {
        // A clean one-pixel step line between whole-pixel joints (Bresenham).
        let x = Math.floor(ax), y = Math.floor(ay);
        const x1 = Math.floor(cx), y1 = Math.floor(cy);
        const dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
        const n = Math.max(dx, -dy) || 1;
        let err = dx + dy, i = 0;
        for (;;) {
          const u = i++ / n;
          put(x, y, l0 + (l1 - l0) * u, z0 + (z1 - z0) * u, w);
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
        put(ax + (cx - ax) * u, ay + (cy - ay) * u, l0 + (l1 - l0) * u, z0 + (z1 - z0) * u, w);
      }
    };
    line(hip.x, hip.y, knee.x, knee.y, 0, lift * 0.5, zh, zk);
    line(knee.x, knee.y, foot.x, foot.y, lift * 0.5, lift, zk, zf);
    // Side-on, a limb hanging over the edge ends in a little hand: fingers splayed below.
    if (this.tiltA > 0.6 && near && foot.y - hip.y > res) {
      put(foot.x - this.fine, foot.y + this.fine, 0, zf, this.fine);
      put(foot.x + this.fine, foot.y + this.fine, 0, zf, this.fine);
      return;
    }
    if (lift > 0.25) return;
    // A planted foot spreads two claws: forefeet point forward-out, hind feet out-back.
    const fwdBias = leg.def.front ? Math.atan2(f.y, f.x) : Math.atan2(-f.y, -f.x);
    const dir = this.lockToes ? leg.toe : blendAngle(Math.atan2(oy, ox), fwdBias, leg.def.front ? 0.5 : 0.35);
    for (const spread of [-0.75, 0.75]) {
      // A short claw line from the foot, so it stays attached however fine the grid.
      line(foot.x, foot.y, foot.x + Math.cos(dir + spread) * 1.2 * res, foot.y + Math.sin(dir + spread) * 1.2 * res, 0, 0, zf, zf, this.fine);
    }
  }
}

function blendAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

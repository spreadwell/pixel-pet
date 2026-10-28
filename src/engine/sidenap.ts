import type { Palette } from './palette';

/*
 * Napping on a code block or callout, seen from the side: the block's top edge is a shelf
 * and the gecko lies stretched out along it, legs tucked, eyes shut, flank rising and
 * falling, tail hanging down over the corner and swaying a little. A few Z's drift up.
 *
 * Drawn in art px. `x` is the shelf's corner, `y` its top edge, `face` which way the head
 * points (+1 right, into the block, from its left corner; -1 from its right corner).
 */

export interface SideNap { x: number; y: number; face: 1 | -1; }

/** Height of the body above the shelf at each point, tail base (0) to snout (21). */
const PROFILE = [2, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 2, 2, 3, 3, 3, 3, 3, 2, 1];
/** Where the body starts, in from the corner, so the tail can go over the edge. */
const IN = 3;
const BREATH = 3.4, Z_EVERY = 1.5, Z_LIFE = 2.8;
const Z_SMALL = ['####', '..#.', '.#..', '####'];
const Z_BIG = ['#####', '...#.', '..#..', '.#...', '#####'];

/** The box the napping gecko covers, art px, for hit tests. */
export function napBox(n: SideNap) {
  const x0 = n.face > 0 ? n.x - 2 : n.x - IN - PROFILE.length;
  return { x: x0, y: n.y - 5, w: IN + PROFILE.length + 2, h: 16 };
}

export class SideNapRenderer {
  private zs: { born: number; x: number; y: number }[] = [];
  private lastZ = 0;

  draw(ctx: CanvasRenderingContext2D, pal: Palette, n: SideNap, now: number, res: number) {
    const t = now / 1000, f = n.face;
    const cx = Math.round(n.x), ly = Math.round(n.y);
    const put = (x: number, y: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x * res), Math.round(y * res), Math.ceil(res), Math.ceil(res)); };
    const at = (u: number) => cx + f * (IN + u) - (f < 0 ? 1 : 0);

    // Lying on the shelf: a soft shadow along it.
    for (let u = 0; u < PROFILE.length; u++) put(at(u), ly, pal.shadow);

    // The body, column by column: lit along the top, shaded along the belly.
    const heave = Math.sin((t / BREATH) * Math.PI * 2) > 0.2;
    for (let u = 0; u < PROFILE.length; u++) {
      const h = PROFILE[u] + (heave && u >= 4 && u <= 8 ? 1 : 0);
      for (let r = 1; r <= h; r++) put(at(u), ly - r, h === 1 ? pal.base : r === h ? pal.crest : r === 1 ? pal.shade : pal.base);
    }
    // Legs folded against the flank, front and hind: the thigh or upper arm in shade, and
    // the foot poking out beneath.
    for (const [u, toe] of [[2, 1], [11, 12]]) {
      put(at(u), ly - 2, pal.crease);
      put(at(u + 1), ly - 2, pal.crease);
      put(at(toe), ly - 1, pal.crease);
      put(at(toe + 2), ly - 1, pal.crease);
    }
    // Eye shut: a short dark line across the side of the head.
    put(at(17), ly - 2, pal.eye);
    put(at(18), ly - 2, pal.eye);

    // The tail: back along the shelf to the corner, then hanging down over the edge, its
    // lower part swaying slowly.
    for (let u = -1; u >= -IN; u--) put(at(u), ly - 1, pal.base);
    const sway = Math.sin(t * 1.1);
    const tx = cx - f * 1 - (f < 0 ? 1 : 0);
    for (let k = 0; k < 9; k++) {
      const off = k > 4 ? Math.round(sway * (k - 4) * 0.25) * -f : 0;
      put(tx + off, ly + k - 1, k < 3 ? pal.base : pal.shade);
    }
    put(tx + Math.round(sway * 1.2) * -f - f, ly + 8, pal.shade);

    // Z's rising from the head, growing and fading.
    if (t - this.lastZ > Z_EVERY) { this.lastZ = t; this.zs.push({ born: t, x: at(19), y: ly - 5 }); }
    this.zs = this.zs.filter((z) => t - z.born < Z_LIFE);
    const alpha = ctx.globalAlpha;
    for (const z of this.zs) {
      const a = (t - z.born) / Z_LIFE, glyph = a < 0.4 ? Z_SMALL : Z_BIG;
      const zx = z.x + f * (2 + a * 7) + Math.sin(a * 6) * 1.2, zy = z.y - a * 12 - glyph.length;
      ctx.globalAlpha = alpha * (a < 0.15 ? a / 0.15 : 1 - (a - 0.15) / 0.85) * 0.8;
      glyph.forEach((row, gy) => { for (let gx = 0; gx < row.length; gx++) if (row[gx] === '#') put(Math.round(zx) + gx, Math.round(zy) + gy, pal.ink); });
    }
    ctx.globalAlpha = alpha;
  }

  reset() { this.zs = []; this.lastZ = 0; }
}

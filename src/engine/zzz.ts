import type { Palette } from './palette';

/** The Z's of a sleeping gecko, rising from its head, growing and fading. */

const Z_EVERY = 1.6, Z_LIFE = 2.8;
const Z_SMALL = ['####', '..#.', '.#..', '####'];
const Z_BIG = ['#####', '...#.', '..#..', '.#...', '#####'];

export class Zzz {
  private zs: { born: number; x: number; y: number }[] = [];
  private lastZ = 0;

  /** Draw (and, while `asleep`, keep sending up) Z's from `head` (art px). */
  draw(ctx: CanvasRenderingContext2D, pal: Palette, head: { x: number; y: number } | null, now: number, res: number) {
    const t = now / 1000;
    if (head && t - this.lastZ > Z_EVERY) { this.lastZ = t; this.zs.push({ born: t, x: head.x + 2, y: head.y - 4 }); }
    this.zs = this.zs.filter((z) => t - z.born < Z_LIFE);
    if (!this.zs.length) return;
    const alpha = ctx.globalAlpha;
    ctx.fillStyle = pal.ink;
    for (const z of this.zs) {
      const a = (t - z.born) / Z_LIFE, glyph = a < 0.45 ? Z_SMALL : Z_BIG;
      const zx = Math.round(z.x + a * 6 + Math.sin(a * 5) * 1.2), zy = Math.round(z.y - a * 11 - glyph.length);
      ctx.globalAlpha = alpha * (a < 0.15 ? a / 0.15 : 1 - (a - 0.15) / 0.85) * 0.7;
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) if (row[gx] === '#') ctx.fillRect(Math.round((zx + gx) * res), Math.round((zy + gy) * res), Math.ceil(res), Math.ceil(res));
      });
    }
    ctx.globalAlpha = alpha;
  }
}

import type { Palette } from './palette';

/*
 * The Z's of a sleeping gecko, rising from its head, growing and fading. They're drawn on
 * their own canvas on a somewhat finer grid than the gecko — each square two-thirds the
 * size of one of its pixels — so they can be small and still legible, and still pixel art.
 */

const Z_EVERY = 1.6, Z_LIFE = 2.8;
/** Smallest to largest, as each one rises. */
const GLYPHS = [
  ['####', '..#.', '.#..', '####'],
  ['#####', '...#.', '..#..', '.#...', '#####'],
  ['######', '....#.', '...#..', '..#...', '.#....', '######'],
];
/** A square of a Z, as a share of one of the gecko's pixels. */
const CELL = 2 / 3;

export class Zzz {
  private zs: { born: number; x: number; y: number }[] = [];
  private lastZ = 0;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private drawn = false;

  constructor(private win: Window) {
    this.canvas = win.document.createElement('canvas');
    this.canvas.className = 'pixel-pet-zzz';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d')!;
  }

  attach() { this.win.document.body.appendChild(this.canvas); this.resize(); }
  destroy() { this.canvas.remove(); }

  resize() {
    const dpr = this.win.devicePixelRatio || 1, w = this.win.innerWidth, h = this.win.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  /**
   * Draw (and, while asleep, keep sending up) Z's from `head` (CSS px), or let them fade
   * out. `px` is the size of one of the gecko's pixels, CSS px.
   */
  draw(pal: Palette, head: { x: number; y: number } | null, now: number, px: number) {
    const t = now / 1000;
    if (head && t - this.lastZ > Z_EVERY) { this.lastZ = t; this.zs.push({ born: t, x: head.x + 4, y: head.y - 8 }); }
    this.zs = this.zs.filter((z) => t - z.born < Z_LIFE);
    const g = this.ctx;
    if (!this.zs.length) {
      if (this.drawn) { g.clearRect(0, 0, this.canvas.width, this.canvas.height); this.drawn = false; }
      return;
    }
    // Squares of a whole number of device pixels.
    const dpr = this.win.devicePixelRatio || 1, cell = Math.max(1, Math.round(px * CELL * dpr));
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.fillStyle = pal.ink;
    for (const z of this.zs) {
      const a = (t - z.born) / Z_LIFE, glyph = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(a * GLYPHS.length))];
      const zx = Math.round((z.x + a * 14 + Math.sin(a * 5) * 3) * dpr / cell), zy = Math.round((z.y - a * 26 - glyph.length) * dpr / cell);
      g.globalAlpha = (a < 0.15 ? a / 0.15 : 1 - (a - 0.15) / 0.85) * 0.75;
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) if (row[gx] === '#') g.fillRect((zx + gx) * cell, (zy + gy) * cell, cell, cell);
      });
    }
    g.globalAlpha = 1;
    this.drawn = true;
  }
}

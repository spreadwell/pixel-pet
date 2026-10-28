import type { Palette } from './palette';

/*
 * The Z's of a sleeping gecko, rising from its head, growing and fading; and, while it's
 * being petted, a single heart over its head, gently beating. They're drawn on
 * their own canvas on a somewhat finer grid than the gecko — each square two-thirds the
 * size of one of its pixels — so they can be small and still legible, and still pixel art.
 */

const Z_EVERY = 1.6, Z_LIFE = 2.8;
/** The heart, at rest and on the beat (seconds between beats): on the beat it fills out by a row. */
const HEART = [['.#.#.', '#####', '.###.', '..#..'], ['.#.#.', '#####', '#####', '.###.', '..#..']];
const BEAT = 1.1;
/** A fright: a "!" that pops up over its head. */
const BANG = ['##', '##', '##', '##', '..', '##'];
/** Smallest to largest, as each one rises. */
const GLYPHS = [
  ['####', '..#.', '.#..', '####'],
  ['#####', '...#.', '..#..', '.#...', '#####'],
  ['######', '....#.', '...#..', '..#...', '.#....', '######'],
];
/** A square of a Z, as a share of one of the gecko's pixels. */
const CELL = 2 / 3;

export class Zzz {
  private zs: { born: number; x: number; y: number; side: number }[] = [];
  private lastZ = 0;
  /** The heart: where it is (CSS px), and how far it has faded in, 0..1. */
  private heart = { x: 0, y: 0, shown: 0 };
  /** The "!": where, since when (s), and how far it has faded in. */
  private bang = { x: 0, y: 0, since: 0, shown: 0 };
  private last = 0;
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
   * Draw (and, while asleep, keep sending up) Z's from `asleep` — or, while it's being
   * petted, the heart over `petted` — the head, CSS px; or let them fade out. `px` is the
   * size of one of the gecko's pixels, CSS px.
   */
  draw(pal: Palette, asleep: { x: number; y: number; side?: number } | null, petted: { x: number; y: number } | null, now: number, px: number, startled: { x: number; y: number } | null = null) {
    const t = now / 1000;
    if (asleep && t - this.lastZ > Z_EVERY) { this.lastZ = t; this.zs.push({ born: t, x: asleep.x - 3, y: asleep.y, side: asleep.side ?? 1 }); }
    // The heart fades in over its head while it's petted, follows it, and fades away after.
    const h = this.heart, dt = Math.min(0.1, Math.max(0, t - this.last));
    this.last = t;
    if (petted) { h.x = petted.x; h.y = petted.y; }
    h.shown = Math.max(0, Math.min(1, h.shown + (petted ? dt / 0.3 : -dt / 0.5)));
    // The "!" pops up at once, and fades when the fright is over.
    const k = this.bang;
    if (startled) { if (!k.shown) k.since = t; k.x = startled.x; k.y = startled.y; k.shown = 1; }
    else k.shown = Math.max(0, k.shown - dt / 0.25);
    this.zs = this.zs.filter((z) => t - z.born < Z_LIFE);
    const g = this.ctx;
    if (!this.zs.length && !h.shown && !k.shown) {
      if (this.drawn) { g.clearRect(0, 0, this.canvas.width, this.canvas.height); this.drawn = false; }
      return;
    }
    // Squares of a whole number of device pixels.
    const dpr = this.win.devicePixelRatio || 1, cell = Math.max(1, Math.round(px * CELL * dpr));
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.fillStyle = pal.ink;
    for (const z of this.zs) {
      const a = (t - z.born) / Z_LIFE, glyph = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(a * GLYPHS.length))];
      const zx = Math.round((z.x + (a * 14 + Math.sin(a * 5) * 3) * z.side) * dpr / cell), zy = Math.round((z.y - a * 26 - glyph.length) * dpr / cell);
      g.globalAlpha = (a < 0.15 ? a / 0.15 : 1 - (a - 0.15) / 0.85) * 0.75;
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) if (row[gx] === '#') g.fillRect((zx + gx) * cell, (zy + gy) * cell, cell, cell);
      });
    }
    // The heart beats, gently: a little fuller for a moment, once a beat, growing up from where it sits.
    if (h.shown > 0) {
      const beat = (t % BEAT) / BEAT < 0.22, glyph = HEART[beat ? 1 : 0];
      const hx = Math.round(h.x * dpr / cell - glyph[0].length / 2), hy = Math.round(h.y * dpr / cell) - glyph.length;
      // Fainter than the Z's, a touch less faint on the beat.
      g.globalAlpha = h.shown * (beat ? 0.5 : 0.4);
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) if (row[gx] === '#') g.fillRect((hx + gx) * cell, (hy + gy) * cell, cell, cell);
      });
    }
    // The "!" jumps up a square as it appears, then sits.
    if (k.shown > 0) {
      const jump = t - k.since < 0.08 ? 2 : t - k.since < 0.16 ? 1 : 0;
      const bx = Math.round(k.x * dpr / cell) - 1, by = Math.round(k.y * dpr / cell) - BANG.length - jump;
      g.globalAlpha = k.shown * 0.75;
      BANG.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) if (row[gx] === '#') g.fillRect((bx + gx) * cell, (by + gy) * cell, cell, cell);
      });
    }
    g.globalAlpha = 1;
    this.drawn = true;
  }
}

/*
 * The workspace reacting to the gecko, so it feels like something it touches.
 *
 * Letters: when a foot comes down on a letter, the letter is pressed down a touch and
 * settles back, as type would under a small weight. The note itself is never touched:
 * the real letter is painted transparent for a moment with a CSS highlight while a copy,
 * drawn in the same font and colour on a full-resolution canvas just under the gecko,
 * does the moving. A letter the gecko has stolen is drawn in its mouth on a second
 * layer just above it.
 *
 * Interface: tabs, ribbon icons, file and folder names, status bar items and toolbar
 * icons give a little jiggle when stepped on — a Web Animation that adds to whatever
 * transform they already have and leaves layout alone.
 *
 * Coordinates are CSS pixels.
 */

import type { Ghost } from './nibble';

const HIGHLIGHT = 'pixel-pet-jostle';
/** The nibbler's highlight: letters that have been eaten and are not there to press. */
const EATEN = 'pixel-pet-nibble';
const LETTER_ROOTS = '.cm-content, .markdown-preview-view';
const JIGGLE = [
  '.workspace-tab-header', '.side-dock-ribbon-action', '.nav-file-title', '.nav-folder-title',
  '.tree-item-self', '.status-bar-item', '.view-action', '.clickable-icon', '.mobile-navbar-action',
].join(', ');
const LETTER_LIFE = 0.35;
const MAX_LETTERS = 48;

interface Glyph { ch: string; font: string; color: string; }

interface Letter {
  range: Range; node: Text; offset: number;
  ch: string; font: string; color: string;
  x: number; baseline: number;
  t: number; strength: number;
}

export class Reactions {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Above the gecko: the letter in its mouth. */
  private top: HTMLCanvasElement;
  private topCtx: CanvasRenderingContext2D;
  private letters: Letter[] = [];
  private highlight: Highlight | null = null;
  private jiggled = new WeakMap<Element, number>();
  private dirty = false;
  private hadGhosts = false;
  /** A stolen letter in the gecko's mouth: where it is (CSS px), how much is left of it. */
  private carried: (Glyph & {
    x: number; y: number; angle: number; left: number; drop: number;
    /** Where it came from, how far it has come out (0 in its slot, 1 in the jaws), and the strain on it. */
    sx: number; sy: number; pull: number; tension: number; stuck: boolean;
  }) | null = null;

  constructor(private win: Window) {
    const doc = win.document;
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'pixel-pet-letters';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d')!;
    this.top = doc.createElement('canvas');
    this.top.className = 'pixel-pet-carried';
    this.top.setAttribute('aria-hidden', 'true');
    this.topCtx = this.top.getContext('2d')!;
    const reg = (win as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
    const H = (win as unknown as { Highlight?: typeof Highlight }).Highlight;
    if (reg && H) { this.highlight = new H(); reg.set(HIGHLIGHT, this.highlight); }
  }

  /** The letters layer goes in before the gecko's canvas, the carried-letter layer after it. */
  attach() { this.win.document.body.appendChild(this.canvas); this.resize(); }
  attachTop() { this.win.document.body.appendChild(this.top); this.resize(); }

  destroy() {
    this.letters = [];
    this.highlight?.clear();
    (this.win as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights?.delete(HIGHLIGHT);
    this.canvas.remove();
    this.top.remove();
  }

  resize() {
    const dpr = this.win.devicePixelRatio || 1;
    for (const c of [this.canvas, this.top]) {
      c.width = Math.ceil(this.win.innerWidth * dpr);
      c.height = Math.ceil(this.win.innerHeight * dpr);
      c.style.width = `${this.win.innerWidth}px`;
      c.style.height = `${this.win.innerHeight}px`;
    }
    this.dirty = true;
  }

  /**
   * A foot came down at (x, y), travelling along (dx, dy). Press the letter under it,
   * or jiggle the piece of interface under it. Returns true if anything reacted.
   */
  step(x: number, y: number, dx: number, dy: number, strength = 1) {
    return this.pressLetter(x, y, dx, dy, strength) || this.jiggle(x, y, dx, dy, strength);
  }

  /** Dropped from a height around (x, y): letters scatter out from under it. */
  splash(points: { x: number; y: number }[], cx: number, cy: number) {
    for (const p of points) {
      const dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1;
      this.pressLetter(p.x, p.y, dx / l, dy / l, 2.2) || this.jiggle(p.x, p.y, dx / l, dy / l, 1.6);
    }
  }

  get active() { return this.letters.length > 0 || !!this.carried; }

  /**
   * Take a letter in the mouth (its real one is hidden by the nibbler). A stuck letter
   * stays in its slot, straining toward the jaws, until it is `free`d.
   */
  carry(range: Range, ch: string, stuck = false) {
    const el = range.startContainer.parentElement;
    if (!el) return;
    const cs = this.win.getComputedStyle(el);
    const r = range.getBoundingClientRect();
    this.carried = {
      ch, font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, color: cs.color,
      x: r.left + r.width / 2, y: r.top + r.height / 2, angle: 0, left: 1, drop: 0,
      sx: r.left + r.width / 2, sy: r.top + r.height / 2, pull: 0, tension: 0, stuck,
    };
    this.dirty = true;
  }

  /** How hard a stuck letter is being pulled, 0..1. */
  tug(tension: number) { if (this.carried) { this.carried.tension = tension; this.dirty = true; } }

  /** A stuck letter pops free and flies into the jaws. */
  free() { if (this.carried) { this.carried.stuck = false; this.carried.tension = 0; this.dirty = true; } }

  /** Keep the carried letter at the snout (CSS px), pointing the way the head does. */
  hold(x: number, y: number, angle: number) {
    const c = this.carried;
    if (!c || c.drop > 0) return;
    c.x = x; c.y = y; c.angle = angle;
    this.dirty = true;
  }

  /** How much of the carried letter is left, 1 → 0 as it is eaten. */
  chew(left: number) { if (this.carried) { this.carried.left = Math.max(0, left); this.dirty = true; } }

  /** Swallowed, or let fall: it falls a little and fades. */
  finish(eaten: boolean) {
    if (!this.carried) return;
    if (eaten) this.carried = null;
    else this.carried.drop = 0.001;
    this.dirty = true;
  }

  update(dt: number) {
    const c = this.carried;
    if (c && c.drop > 0) { c.drop += dt; if (c.drop > 0.35) this.carried = null; this.dirty = true; }
    if (c && !c.stuck && c.pull < 1) { c.pull = Math.min(1, c.pull + dt * 9); this.dirty = true; }
    if (!this.letters.length) return;
    for (const l of this.letters) l.t += dt;
    const done = this.letters.filter((l) => l.t >= LETTER_LIFE || l.range.collapsed);
    for (const l of done) this.highlight?.delete(l.range);
    if (done.length) this.letters = this.letters.filter((l) => !done.includes(l));
    this.dirty = true;
  }

  /** Draw everything; `ghosts` are eaten letters to show faintly in their places. */
  draw(ghosts: Ghost[] = []) {
    if (!this.dirty && !ghosts.length && !this.hadGhosts) return;
    this.hadGhosts = ghosts.length > 0;
    this.dirty = this.letters.length > 0 || !!this.carried;
    const g = this.ctx, dpr = this.win.devicePixelRatio || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    for (const gh of ghosts) {
      const r = gh.range.getBoundingClientRect();
      if (r.width < 1) continue;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.font = gh.font;
      g.globalAlpha = gh.alpha;
      g.fillStyle = gh.color;
      g.fillText(gh.ch, r.left, r.top + (g.measureText(gh.ch).fontBoundingBoxAscent || r.height * 0.8));
    }
    g.globalAlpha = 1;
    for (const l of this.letters) {
      // Pressed straight down into the page a touch, slightly flattened, then settling.
      const press = Math.min(1.3, l.strength) * Math.exp(-11 * l.t) * Math.sin(Math.min(1, l.t / 0.06) * Math.PI / 2);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.translate(l.x, l.baseline + press * 1.1);
      g.scale(1 + press * 0.04, 1 - press * 0.07);
      g.font = l.font;
      g.fillStyle = l.color;
      g.fillText(l.ch, 0, 0);
    }
    const t = this.topCtx;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.clearRect(0, 0, this.top.width, this.top.height);
    const c = this.carried;
    if (c) {
      const g = t;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalAlpha = c.drop > 0 ? Math.max(0, 1 - c.drop / 0.35) : 1;
      g.font = c.font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = c.color;
      if (c.stuck) {
        // Still lodged in the word: upright in its slot, stretched toward the jaws by the strain.
        const dx = c.x - c.sx, dy = c.y - c.sy, a = Math.atan2(dy, dx);
        const out = 0.06 + 0.1 * c.tension;
        g.translate(c.sx + dx * out, c.sy + dy * out);
        g.rotate(a);
        g.scale(1 + 0.35 * c.tension, 1 - 0.12 * c.tension);
        g.rotate(-a);
      } else {
        // Flying into the jaws, then gripped crosswise there, shrinking as it is eaten.
        const p = c.pull * c.pull * (3 - 2 * c.pull);
        g.translate(c.sx + (c.x - c.sx) * p, c.sy + (c.y - c.sy) * p + c.drop * 14);
        g.rotate((c.angle + Math.PI / 2) * p);
        const s = (1 - 0.2 * p) * (0.35 + 0.65 * c.left);
        g.scale(s, s);
      }
      g.fillText(c.ch, 0, 0);
      g.globalAlpha = 1;
    }
  }

  private pressLetter(x: number, y: number, dx: number, dy: number, strength: number) {
    if (!this.highlight || this.letters.length >= MAX_LETTERS) return false;
    const doc = this.win.document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null };
    const at = doc.caretRangeFromPoint?.(x, y);
    if (!at || at.startContainer.nodeType !== Node.TEXT_NODE) return false;
    const node = at.startContainer as Text;
    const parent = node.parentElement;
    if (!parent || !parent.closest(LETTER_ROOTS)) return false;
    // The caret lands either side of the letter under the point; take whichever contains it.
    const text = node.data;
    let hit: Range | null = null, offset = -1;
    for (const o of [at.startOffset, at.startOffset - 1]) {
      if (o < 0 || o >= text.length || !text[o].trim()) continue;
      const r = doc.createRange();
      r.setStart(node, o); r.setEnd(node, o + 1);
      const b = r.getBoundingClientRect();
      if (x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2) { hit = r; offset = o; break; }
    }
    if (!hit) return false;
    // A letter that has been eaten isn't there to be pressed.
    if (this.eaten(node, offset)) return true;
    const live = this.letters.find((l) => l.node === node && l.offset === offset);
    if (live) { live.t = Math.min(live.t, 0.08); live.strength = Math.max(live.strength, strength); return true; }
    const cs = this.win.getComputedStyle(parent);
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    this.ctx.font = font;
    const m = this.ctx.measureText(text[offset]);
    const box = hit.getBoundingClientRect();
    this.letters.push({
      range: hit, node, offset, ch: text[offset], font, color: cs.color,
      x: box.left, baseline: box.top + (m.fontBoundingBoxAscent || box.height * 0.8),
      t: 0, strength,
    });
    this.highlight.add(hit);
    this.dirty = true;
    return true;
  }

  private eaten(node: Text, offset: number) {
    const reg = (this.win as unknown as { CSS?: { highlights?: Map<string, Iterable<Range>> } }).CSS?.highlights;
    const hl = reg?.get(EATEN);
    if (!hl) return false;
    for (const r of hl) if (r.startContainer === node && r.startOffset === offset) return true;
    return false;
  }

  private jiggle(x: number, y: number, dx: number, dy: number, strength: number) {
    const el = this.win.document.elementFromPoint(x, y)?.closest(JIGGLE) as HTMLElement | null;
    if (!el || typeof el.animate !== 'function') return false;
    const now = performance.now();
    if ((this.jiggled.get(el) ?? 0) > now) return true;
    this.jiggled.set(el, now + 450);
    const px = dx * 1.6 * strength, py = (dy * 1.6 + 1) * strength, r = (Math.random() < 0.5 ? -1 : 1) * 2.5 * strength;
    el.animate([
      { transform: 'translate(0, 0) rotate(0deg)' },
      { transform: `translate(${px}px, ${py}px) rotate(${r}deg)`, offset: 0.2 },
      { transform: `translate(${-px * 0.4}px, ${-py * 0.4}px) rotate(${-r * 0.5}deg)`, offset: 0.55 },
      { transform: `translate(${px * 0.15}px, ${py * 0.15}px) rotate(${r * 0.15}deg)`, offset: 0.8 },
      { transform: 'translate(0, 0) rotate(0deg)' },
    ], { duration: 420, easing: 'ease-out', composite: 'add' });
    return true;
  }
}

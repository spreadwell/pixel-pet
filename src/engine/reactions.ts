/*
 * The workspace reacting to the gecko, so it feels like something it touches.
 *
 * Letters: when a foot comes down on a letter, the letter dips and springs back. The
 * note itself is never touched. The real letter is painted transparent for a moment with
 * a CSS highlight while a copy, drawn in the same font and colour on a full-resolution
 * canvas just under the gecko, does the moving.
 *
 * Interface: tabs, ribbon icons, file and folder names, status bar items and toolbar
 * icons give a little jiggle when stepped on — a Web Animation that adds to whatever
 * transform they already have and leaves layout alone.
 *
 * Coordinates are CSS pixels.
 */

const HIGHLIGHT = 'pixel-pet-jostle';
const LETTER_ROOTS = '.cm-content, .markdown-preview-view';
const JIGGLE = [
  '.workspace-tab-header', '.side-dock-ribbon-action', '.nav-file-title', '.nav-folder-title',
  '.tree-item-self', '.status-bar-item', '.view-action', '.clickable-icon', '.mobile-navbar-action',
].join(', ');
const LETTER_LIFE = 0.6;
const MAX_LETTERS = 48;

interface Letter {
  range: Range; node: Text; offset: number;
  ch: string; font: string; color: string;
  x: number; baseline: number;
  t: number; strength: number; dx: number; dy: number; spin: number;
}

export class Reactions {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private letters: Letter[] = [];
  private highlight: Highlight | null = null;
  private jiggled = new WeakMap<Element, number>();
  private dirty = false;

  constructor(private win: Window) {
    const doc = win.document;
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'pixel-pet-letters';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d')!;
    const reg = (win as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
    const H = (win as unknown as { Highlight?: typeof Highlight }).Highlight;
    if (reg && H) { this.highlight = new H(); reg.set(HIGHLIGHT, this.highlight); }
  }

  attach() { this.win.document.body.appendChild(this.canvas); this.resize(); }

  destroy() {
    this.letters = [];
    this.highlight?.clear();
    (this.win as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights?.delete(HIGHLIGHT);
    this.canvas.remove();
  }

  resize() {
    const dpr = this.win.devicePixelRatio || 1;
    this.canvas.width = Math.ceil(this.win.innerWidth * dpr);
    this.canvas.height = Math.ceil(this.win.innerHeight * dpr);
    this.canvas.style.width = `${this.win.innerWidth}px`;
    this.canvas.style.height = `${this.win.innerHeight}px`;
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

  get active() { return this.letters.length > 0; }

  update(dt: number) {
    if (!this.letters.length) return;
    for (const l of this.letters) l.t += dt;
    const done = this.letters.filter((l) => l.t >= LETTER_LIFE || l.range.collapsed);
    for (const l of done) this.highlight?.delete(l.range);
    if (done.length) this.letters = this.letters.filter((l) => !done.includes(l));
    this.dirty = true;
  }

  draw() {
    if (!this.dirty) return;
    this.dirty = this.letters.length > 0;
    const g = this.ctx, dpr = this.win.devicePixelRatio || 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.textBaseline = 'alphabetic';
    for (const l of this.letters) {
      // A damped spring: pushed along the step and down into the page, then back.
      const e = Math.exp(-7 * l.t), w = Math.cos(l.t * 24);
      const push = l.strength * e;
      const ox = l.dx * push * 2.2, oy = (l.dy * 2 + 2.6) * push * w;
      const squash = 1 - 0.26 * l.strength * Math.exp(-10 * l.t) * w;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.translate(l.x + ox, l.baseline + oy);
      g.rotate(l.spin * push * w);
      g.scale(1 + (1 - squash) * 0.6, squash);
      g.font = l.font;
      g.fillStyle = l.color;
      g.fillText(l.ch, 0, 0);
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
      t: 0, strength, dx, dy, spin: (Math.random() < 0.5 ? -1 : 1) * 0.12,
    });
    this.highlight.add(hit);
    this.dirty = true;
    return true;
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

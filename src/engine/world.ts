import { Rect, clamp } from './math';

/*
 * What the gecko knows about the workspace: the window, the panels and their seams,
 * the reading column of open notes, the text on screen, and the caret. Lizards are
 * thigmotactic — they keep to edges and crevices — so most wandering goals are chosen
 * along panel seams, the margins of the text column and the gaps between paragraphs.
 *
 * The workspace is terrain. Every part of it has a height: the note is the ground,
 * lines of text are low ridges on it, headings a little taller, the sidebars a ledge,
 * the tab bar higher still with the tabs as bumps on top. The gecko climbs over all of
 * it. Side panels are also cover: it can slip underneath one (the renderer clips it)
 * and peek back out. All public geometry is in art px, heights included.
 */

const SURFACE_SELECTORS = [
  '.workspace-ribbon',
  '.workspace-split.mod-left-split',
  '.workspace-split.mod-right-split',
  '.workspace-leaf',
  '.workspace-tab-header-container',
  '.status-bar',
  '.titlebar',
  // Mobile: slide-out drawers, the bottom navigation bar and the editing toolbar.
  '.workspace-drawer',
  '.mobile-navbar',
  '.mobile-toolbar',
  '.view-header',
];
const COLUMN_SELECTORS = ['.cm-sizer', '.markdown-preview-sizer', '.ProseMirror'];
/** Panels that lie over the note, with the smallest width (art px) that counts. */
const COVER_SELECTORS: [string, number][] = [
  ['.workspace-ribbon', 8],
  ['.workspace-split.mod-left-split', 40],
  ['.workspace-split.mod-right-split', 40],
  ['.workspace-drawer', 40],
];
/** How high each part of the interface stands above the note, in art px. */
const HEIGHT_SELECTORS: [string, number][] = [
  ['.view-header', 4],
  ['.status-bar', 5],
  ['.workspace-split.mod-left-split', 6],
  ['.workspace-split.mod-right-split', 6],
  ['.workspace-drawer', 6],
  ['.workspace-tab-header-container', 7],
  ['.mobile-navbar', 7],
  ['.mobile-toolbar', 7],
  ['.workspace-ribbon', 8],
  ['.titlebar', 8],
  ['.workspace-tab-header', 10],
];
/**
 * Each paragraph (a block of lines with no blank line between them) is a mesa standing
 * on the note: one flat top to climb up onto and walk across, with the gaps between
 * paragraphs as the valleys. A heading stands a little taller.
 */
const TEXT_Z = 4;
const HEADING_Z = 5;
/** Where the words are: the editor and reading view. */
const TEXT_ROOTS = '.cm-content, .markdown-preview-view';
/** Bounds on the text scan, which runs twice a second. */
const MAX_TEXT_NODES = 1500;
const MAX_TEXT_RECTS = 800;

export interface Edge { x1: number; y1: number; x2: number; y2: number; len: number; inX: number; inY: number; }
/** A way under a panel: a point on its exposed edge, the inward normal, and how deep it goes. */
export interface CoverEntry { x: number; y: number; nx: number; ny: number; depth: number; }

/** A code block or callout, for napping on (art px). */
export interface Rock extends Rect { kind: 'code block' | 'callout'; }

export class World {
  px = 3;
  bounds: Rect = { x: 0, y: 0, w: 100, h: 100 };
  surfaces: Rect[] = [];
  columns: Rect[] = [];
  /** Panels the gecko can hide under. */
  covers: Rect[] = [];
  /** Code blocks and callouts in the note: flat stones it can nap on. */
  rocks: Rock[] = [];
  /** Pictures in notes on screen: warm spots to bask on (art px). */
  warm: Rect[] = [];
  /** Find-in-note matches on screen, in reading order, and which one is current (art px). */
  matches: (Rect & { current: boolean })[] = [];
  /** The open side panels: safe high ground to run to. */
  sidebars: Rect[] = [];
  /** Blocks of text on screen (paragraphs, headings, list runs). */
  text: Rect[] = [];
  /** High spots worth climbing up to and sitting on: tabs and headings. */
  perches: Rect[] = [];
  /** Height of the terrain at each art pixel of the window. */
  private heights = new Uint8Array(0);
  private hw = 0;
  private hh = 0;
  edges: Edge[] = [];
  caret: { x: number; y: number } | null = null;
  /** Where the caret was last seen, even after the editor lost focus. */
  lastCaret: { x: number; y: number } | null = null;
  /** Regions where the layout changed since the last scan (art px). */
  shifts: Rect[] = [];

  private prevSignature = new Map<string, Rect>();

  constructor(private win: Window) {}

  private toArt(r: DOMRect | Rect): Rect {
    const p = this.px;
    const x = 'left' in r ? r.left : r.x, y = 'top' in r ? r.top : r.y;
    const w = 'width' in r ? r.width : (r as Rect).w, h = 'height' in r ? r.height : (r as Rect).h;
    return { x: x / p, y: y / p, w: w / p, h: h / p };
  }

  /** Safe-area insets (notch, home indicator), CSS px. */
  private insets() {
    const doc = this.win.document;
    const probe = doc.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    doc.body.appendChild(probe);
    const s = getComputedStyle(probe);
    const out = { t: parseFloat(s.paddingTop) || 0, r: parseFloat(s.paddingRight) || 0, b: parseFloat(s.paddingBottom) || 0, l: parseFloat(s.paddingLeft) || 0 };
    probe.remove();
    return out;
  }

  scan() {
    const doc = this.win.document;
    const p = this.px;
    // The visible viewport shrinks under an on-screen keyboard; treat that as the floor.
    const vv = this.win.visualViewport;
    const vh = vv ? Math.min(this.win.innerHeight, vv.height + vv.offsetTop) : this.win.innerHeight;
    const ins = this.insets();
    this.bounds = { x: ins.l / p, y: ins.t / p, w: (this.win.innerWidth - ins.l - ins.r) / p, h: (vh - ins.t - ins.b) / p };

    const surfaces: Rect[] = [];
    const sig = new Map<string, Rect>();
    SURFACE_SELECTORS.forEach((sel, si) => {
      doc.querySelectorAll<HTMLElement>(sel).forEach((el, ei) => {
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) return;
        const a = this.toArt(r);
        surfaces.push(a);
        sig.set(`${si}:${ei}`, a);
      });
    });
    this.surfaces = surfaces;

    const columns: Rect[] = [];
    for (const sel of COLUMN_SELECTORS) {
      doc.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) return;
        // Only the visible part of a long column matters.
        const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, this.win.innerHeight);
        if (bottom - top < 20) return;
        columns.push(this.toArt({ x: r.left, y: top, w: r.width, h: bottom - top }));
      });
    }
    this.columns = columns;

    const vw = this.win.innerWidth, wh = this.win.innerHeight;
    const covers: Rect[] = [];
    for (const [sel, minW] of COVER_SELECTORS) {
      doc.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        // Collapsed or slid off screen (a closed mobile drawer) doesn't count.
        const visible = (Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, wh) - Math.max(r.top, 0));
        if (r.width / p < minW || r.height / p < 60 || visible < r.width * r.height * 0.8) return;
        covers.push(this.toArt(r));
      });
    }
    this.covers = covers;
    this.sidebars = covers.filter((r) => r.w >= 30 && r.h >= 60);
    this.rocks = this.scanRocks();
    this.warm = this.scanWarm();
    this.scanMatches();
    const mesas = this.scanText();
    this.buildHeights(mesas);

    this.detectShifts(sig);
    this.buildEdges();
    this.scanCaret();
  }

  /** Cheap per-frame caret refresh (only while typing). */
  scanCaret() {
    const doc = this.win.document;
    const cur = doc.querySelector<HTMLElement>('.cm-focused .cm-cursor-primary, .cm-focused .cm-cursor');
    let r: DOMRect | null = null;
    if (cur) r = cur.getBoundingClientRect();
    else {
      const sel = doc.getSelection();
      const active = doc.activeElement as HTMLElement | null;
      if (sel && sel.rangeCount && active && (active.isContentEditable || active.tagName === 'TEXTAREA')) {
        const rr = sel.getRangeAt(0).getBoundingClientRect();
        if (rr.height > 0) r = rr;
      }
    }
    this.caret = r && r.height > 0 ? { x: (r.left + 1) / this.px, y: (r.top + r.height / 2) / this.px } : null;
    if (this.caret) this.lastCaret = { ...this.caret };
  }

  private detectShifts(sig: Map<string, Rect>) {
    const shifts: Rect[] = [];
    const prev = this.prevSignature;
    if (prev.size) {
      const tol = 30 / this.px;
      for (const [k, r] of sig) {
        const o = prev.get(k);
        if (!o) { shifts.push(r); continue; }
        // A resized panel only disturbs the strip its moving edge swept across.
        const sweep = (a: number, b: number, horizontal: boolean) => {
          if (Math.abs(a - b) <= tol) return;
          const lo = Math.min(a, b), span = Math.abs(a - b);
          shifts.push(horizontal ? { x: lo, y: Math.min(o.y, r.y), w: span, h: Math.max(o.h, r.h) } : { x: Math.min(o.x, r.x), y: lo, w: Math.max(o.w, r.w), h: span });
        };
        sweep(o.x, r.x, true);
        sweep(o.x + o.w, r.x + r.w, true);
        sweep(o.y, r.y, false);
        sweep(o.y + o.h, r.y + r.h, false);
      }
      for (const [k, o] of prev) if (!sig.has(k)) shifts.push(o);
    }
    // A wholesale window resize is not something to be startled by.
    const big = shifts.filter((s) => s.w * s.h < this.bounds.w * this.bounds.h * 0.6);
    this.shifts.push(...big);
    this.prevSignature = sig;
  }

  /** Merge the line boxes of visible text into paragraph-sized blocks. Returns the blocks with their heights, in art px. */
  private scanText(): (Rect & { z: number })[] {
    const doc = this.win.document, vh = this.win.innerHeight;
    const roots = Array.from(doc.querySelectorAll<HTMLElement>(TEXT_ROOTS)).filter((r) => !r.parentElement?.closest(TEXT_ROOTS));
    const range = doc.createRange();
    const lines: Rect[] = [];
    let nodes = 0;
    for (const root of roots) {
      const rr = root.getBoundingClientRect();
      if (rr.bottom < 0 || rr.top > vh || rr.width < 20) continue;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n && nodes < MAX_TEXT_NODES && lines.length < MAX_TEXT_RECTS; n = walker.nextNode()) {
        nodes++;
        if (!n.nodeValue?.trim()) continue;
        range.selectNodeContents(n);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width < 2 || r.bottom < 0 || r.top > vh) continue;
          lines.push({ x: r.left, y: r.top, w: r.width, h: r.height });
        }
      }
    }
    lines.sort((a, b) => a.y - b.y);
    const blocks: Rect[] = [];
    for (const r of lines) {
      const b = blocks.find((b) => r.y <= b.y + b.h + 6 && r.y + r.h >= b.y - 6 && r.x <= b.x + b.w + 12 && r.x + r.w >= b.x - 12);
      if (!b) { blocks.push({ ...r }); continue; }
      const x2 = Math.max(b.x + b.w, r.x + r.w), y2 = Math.max(b.y + b.h, r.y + r.h);
      b.x = Math.min(b.x, r.x); b.y = Math.min(b.y, r.y); b.w = x2 - b.x; b.h = y2 - b.y;
    }
    this.text = blocks.map((b) => this.toArt(b)).filter((b) => !this.coverAt(b.x + b.w / 2, b.y + b.h / 2));
    // A block whose lines are much taller than most is a heading.
    const sorted = lines.map((l) => l.h).sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return blocks.map((b) => {
      const tall = lines.some((l) => l.h > typical * 1.3 && l.y >= b.y - 1 && l.y + l.h <= b.y + b.h + 1 && l.x < b.x + b.w && l.x + l.w > b.x);
      return { ...this.toArt(b), z: tall ? HEADING_Z : TEXT_Z };
    });
  }

  /** Rasterise the terrain: interface parts by selector, then the paragraph mesas. */
  private buildHeights(mesas: (Rect & { z: number })[]) {
    const doc = this.win.document;
    const w = Math.ceil(this.win.innerWidth / this.px), h = Math.ceil(this.win.innerHeight / this.px);
    if (w * h !== this.heights.length) this.heights = new Uint8Array(w * h);
    else this.heights.fill(0);
    this.hw = w; this.hh = h;
    const fill = (r: Rect, z: number) => {
      const x0 = Math.max(0, Math.round(r.x)), x1 = Math.min(w, Math.round(r.x + r.w));
      const y0 = Math.max(0, Math.round(r.y)), y1 = Math.min(h, Math.round(r.y + r.h));
      for (let y = y0; y < y1; y++) for (let x = x0, k = y * w + x0; x < x1; x++, k++) if (this.heights[k] < z) this.heights[k] = z;
    };
    const perches: Rect[] = [];
    for (const [sel, z] of HEIGHT_SELECTORS) {
      doc.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 2 || r.height <= 2) return;
        const a = this.toArt(r);
        fill(a, z);
        if (sel === '.workspace-tab-header' && a.w > 12) perches.push(a);
      });
    }
    for (const m of mesas) {
      fill(m, m.z);
      if (m.z === HEADING_Z && m.w > 12) perches.push(m);
    }
    this.perches = perches;
  }

  /** Terrain height at (x, y). */
  groundAt(x: number, y: number) {
    const ix = Math.floor(x), iy = Math.floor(y);
    return ix < 0 || iy < 0 || ix >= this.hw || iy >= this.hh ? 0 : this.heights[iy * this.hw + ix];
  }

  private buildEdges() {
    const edges: Edge[] = [];
    const add = (x1: number, y1: number, x2: number, y2: number, inX: number, inY: number) => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 12) return;
      edges.push({ x1, y1, x2, y2, len, inX, inY });
    };
    const inset = 3.5;
    for (const r of this.surfaces) {
      add(r.x + inset, r.y + inset, r.x + r.w - inset, r.y + inset, 0, 1);
      add(r.x + inset, r.y + r.h - inset, r.x + r.w - inset, r.y + r.h - inset, 0, -1);
      add(r.x + inset, r.y + inset, r.x + inset, r.y + r.h - inset, 1, 0);
      add(r.x + r.w - inset, r.y + inset, r.x + r.w - inset, r.y + r.h - inset, -1, 0);
    }
    // The margins either side of a note's reading column.
    const gap = 7;
    for (const c of this.columns) {
      add(c.x - gap, c.y + 4, c.x - gap, c.y + c.h - 4, -1, 0);
      add(c.x + c.w + gap, c.y + 4, c.x + c.w + gap, c.y + c.h - 4, 1, 0);
    }
    // The gaps between paragraphs are crevices too.
    for (const t of this.text) {
      if (t.w < 30) continue;
      add(t.x, t.y - 2.5, t.x + t.w, t.y - 2.5, 0, 1);
      add(t.x, t.y + t.h + 2.5, t.x + t.w, t.y + t.h + 2.5, 0, -1);
    }
    const b = this.bounds;
    const x0 = b.x + 5, y0 = b.y + 5, x1 = b.x + b.w - 5, y1 = b.y + b.h - 5;
    add(x0, y0, x1, y0, 0, 1);
    add(x0, y1, x1, y1, 0, -1);
    add(x0, y0, x0, y1, 1, 0);
    add(x1, y0, x1, y1, -1, 0);
    this.edges = edges.filter((e) => this.inBounds((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, 2));
  }

  inBounds(x: number, y: number, pad = 0) {
    const b = this.bounds;
    return x >= b.x + pad && y >= b.y + pad && x <= b.x + b.w - pad && y <= b.y + b.h - pad;
  }

  clampToBounds(x: number, y: number, pad = 6) {
    const b = this.bounds;
    return { x: clamp(x, b.x + pad, b.x + b.w - pad), y: clamp(y, b.y + pad, b.y + b.h - pad) };
  }

  /** The panel covering (x, y), if any. */
  coverAt(x: number, y: number): Rect | null {
    for (const r of this.covers) if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return r;
    return null;
  }

  /** The code block or callout over (x, y), if any. */
  rockAt(x: number, y: number): Rock | null {
    for (const r of this.rocks) if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return r;
    return null;
  }

  /**
   * Code blocks and callouts on screen, in reading view and live preview (where a code
   * block is a run of line elements, merged here into one stone).
   */
  private scanWarm(): Rect[] {
    const vw = this.win.innerWidth, vh = this.win.innerHeight, out: Rect[] = [];
    this.win.document.querySelectorAll<HTMLElement>('.workspace-leaf .markdown-rendered img, .workspace-leaf .cm-content img, .workspace-leaf .ProseMirror img').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 40 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return;
      const a = this.toArt(r);
      if (!this.coverAt(a.x + a.w / 2, a.y + a.h / 2)) out.push(a);
    });
    return out;
  }

  /** The search matches only: cheap enough to keep up with while you step through them. */
  scanMatches() {
    const vh = this.win.innerHeight, out: (Rect & { current: boolean })[] = [];
    // Obsidian's own find-in-note highlights just the match you're on; CodeMirror's search
    // marks them all, the one you're on as selected.
    this.win.document.querySelectorAll<HTMLElement>('.workspace-leaf .obsidian-search-match-highlight, .workspace-leaf .cm-searchMatch').forEach((el) => {
      if (out.length >= 40) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.bottom < 0 || r.top > vh) return;
      out.push({ ...this.toArt(r), current: el.matches('.obsidian-search-match-highlight, .cm-searchMatch-selected') });
    });
    this.matches = out.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  private scanRocks(): Rock[] {
    const doc = this.win.document, vh = this.win.innerHeight;
    const rects: { r: DOMRect; kind: Rock['kind'] }[] = [];
    // In any note on screen, not just the one in focus (clicking a side panel moves the focus).
    doc.querySelectorAll<HTMLElement>('.workspace-leaf .markdown-rendered pre, .workspace-leaf .callout, .workspace-leaf .HyperMD-codeblock').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.bottom > 0 && r.top < vh) rects.push({ r, kind: el.matches('.callout') ? 'callout' : 'code block' });
    });
    const out: Rock[] = [];
    for (const { r, kind } of rects.sort((a, b) => a.r.top - b.r.top)) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.x - r.left) < 2 && r.top <= prev.y + prev.h + 2) { prev.h = Math.max(prev.h, r.bottom - prev.y); prev.w = Math.max(prev.w, r.width); continue; }
      out.push({ x: r.left, y: r.top, w: r.width, h: r.height, kind });
    }
    return out.map((r) => ({ ...this.toArt(r), kind: r.kind })).filter((r) => r.w >= 16 && r.h >= 6 && !this.coverAt(r.x + r.w / 2, r.y + r.h / 2));
  }

  onText(x: number, y: number, pad = 0) {
    for (const r of this.text) if (x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad) return true;
    return false;
  }

  /** Nearest point of any text block within `within`, or null. */
  nearestText(x: number, y: number, within: number) {
    let best: { x: number; y: number } | null = null, bd = within;
    for (const r of this.text) {
      const px = clamp(x, r.x, r.x + r.w), py = clamp(y, r.y, r.y + r.h);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = { x: px, y: py }; }
    }
    return best;
  }

  /**
   * The closest way under a panel from (x, y): a point on an edge of the panel that
   * faces the workspace (not the window border), within `range`. With a threat, only
   * entries leading away from it count.
   */
  coverEntry(x: number, y: number, range: number, threat?: { x: number; y: number }): CoverEntry | null {
    const b = this.bounds;
    let best: CoverEntry | null = null, bd = range;
    for (const r of this.covers) {
      const sides = [
        { ex: r.x, nx: 1, ny: 0, open: r.x > b.x + 4, size: r.w },
        { ex: r.x + r.w, nx: -1, ny: 0, open: r.x + r.w < b.x + b.w - 4, size: r.w },
      ];
      for (const s of sides) {
        if (!s.open || s.size < 30) continue;
        const ey = clamp(y, r.y + 20, r.y + r.h - 20);
        // The way in must face open ground, not another panel.
        if (this.coverAt(s.ex - s.nx * 6, ey)) continue;
        const d = Math.hypot(s.ex - x, ey - y);
        if (d > bd) continue;
        if (threat && ((s.ex - x) * (x - threat.x) + (ey - y) * (y - threat.y)) < 0) continue;
        bd = d;
        best = { x: s.ex, y: ey, nx: s.nx, ny: s.ny, depth: Math.min(s.size - 6, 40) };
      }
    }
    return best;
  }
}

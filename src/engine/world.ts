import { Rect, chance, clamp, rand } from './math';

/*
 * What the gecko knows about the workspace: the window, the panels and their seams,
 * the reading column of open notes, and the text caret. Lizards are thigmotactic —
 * they keep to edges and crevices — so most wandering goals are chosen along panel
 * seams and the margins of the text column. All public geometry is in art pixels.
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
const COLUMN_SELECTORS = ['.cm-sizer', '.markdown-preview-sizer'];

export interface Edge { x1: number; y1: number; x2: number; y2: number; len: number; inX: number; inY: number; }
export interface Goal { x: number; y: number; edge?: Edge; dir?: 1 | -1; }

export class World {
  px = 3;
  bounds: Rect = { x: 0, y: 0, w: 100, h: 100 };
  surfaces: Rect[] = [];
  columns: Rect[] = [];
  edges: Edge[] = [];
  caret: { x: number; y: number } | null = null;
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

  /** Is (x, y) inside the space the gecko should leave alone (around the caret)? */
  nearCaret(x: number, y: number, r: number) {
    return !!this.caret && Math.hypot(x - this.caret.x, y - this.caret.y) < r;
  }

  private pointOnEdge(e: Edge, u: number): { x: number; y: number } {
    return { x: e.x1 + (e.x2 - e.x1) * u, y: e.y1 + (e.y2 - e.y1) * u };
  }

  /**
   * Choose the next place to wander to. Usually continues along the current seam,
   * otherwise picks another seam weighted by length and closeness, or open ground.
   */
  pickGoal(x: number, y: number, prev: Goal | null, avoidCaretR: number): Goal {
    for (let attempt = 0; attempt < 24; attempt++) {
      let g: Goal | null = null;
      if (prev?.edge && chance(0.62) && attempt < 8) {
        const e = prev.edge;
        const here = clamp(((x - e.x1) * (e.x2 - e.x1) + (y - e.y1) * (e.y2 - e.y1)) / (e.len * e.len), 0, 1);
        const dir = prev.dir ?? 1;
        const u = here + (dir * rand(25, 70)) / e.len;
        if (u > 0.02 && u < 0.98) g = { ...this.pointOnEdge(e, u), edge: e, dir };
        else g = { ...this.pointOnEdge(e, clamp(u, 0, 1)), edge: e, dir: (dir * -1) as 1 | -1 };
      } else if (this.edges.length && chance(0.8)) {
        const weights = this.edges.map((e) => e.len / (1 + Math.hypot((e.x1 + e.x2) / 2 - x, (e.y1 + e.y2) / 2 - y) / 90));
        let r = Math.random() * weights.reduce((a, w) => a + w, 0);
        let e = this.edges[0];
        for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { e = this.edges[i]; break; } }
        g = { ...this.pointOnEdge(e, rand(0.08, 0.92)), edge: e, dir: chance(0.5) ? 1 : -1 };
      } else {
        g = { x: x + rand(-90, 90), y: y + rand(-60, 60) };
      }
      const d = Math.hypot(g.x - x, g.y - y);
      if (d < 14 || !this.inBounds(g.x, g.y, 6) || this.nearCaret(g.x, g.y, avoidCaretR)) continue;
      return g;
    }
    return { ...this.clampToBounds(x + rand(-40, 40), y + rand(-40, 40)) };
  }

  /** Somewhere to dash to, away from a threat, preferably tucked against a seam. */
  pickEscape(x: number, y: number, tx: number, ty: number): Goal {
    let best: Goal | null = null;
    let bestScore = -Infinity;
    const awayX = x - tx, awayY = y - ty;
    const al = Math.hypot(awayX, awayY) || 1;
    for (let i = 0; i < 30; i++) {
      const e = this.edges.length ? this.edges[Math.floor(Math.random() * this.edges.length)] : null;
      const p = e ? this.pointOnEdge(e, Math.random()) : this.clampToBounds(x + rand(-120, 120), y + rand(-120, 120));
      const dx = p.x - x, dy = p.y - y;
      const d = Math.hypot(dx, dy);
      if (d < 25 || d > 160 || !this.inBounds(p.x, p.y, 6)) continue;
      const align = (dx * awayX + dy * awayY) / (d * al);
      const fromThreat = Math.hypot(p.x - tx, p.y - ty);
      const score = align * 2 + fromThreat / 60 - d / 140;
      if (score > bestScore) { bestScore = score; best = { ...p, edge: e ?? undefined }; }
    }
    return best ?? this.clampToBounds(x + (awayX / al) * 50, y + (awayY / al) * 50);
  }

  /** A quiet corner: where two seams meet, close by. */
  pickSleepSpot(x: number, y: number): Goal {
    const corners: { x: number; y: number }[] = [];
    for (const r of this.surfaces) {
      if (r.w < 30 || r.h < 30) continue;
      corners.push({ x: r.x + 9, y: r.y + r.h - 9 }, { x: r.x + r.w - 9, y: r.y + r.h - 9 });
    }
    let best = { x, y }, bd = Infinity;
    for (const c of corners) {
      if (!this.inBounds(c.x, c.y, 6)) continue;
      const d = Math.hypot(c.x - x, c.y - y) * rand(0.8, 1.2);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
}

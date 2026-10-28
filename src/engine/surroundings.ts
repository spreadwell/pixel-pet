import type { Leg } from './body';

/*
 * The gecko's surroundings reacting to it, and it to them.
 *
 * Footprints: stepping on the text inks a foot in the colour of that text, and its next
 * few steps off it leave little three-toed prints, fainter each step, fading in seconds.
 *
 * Hover: whatever interface element is under its body or feet shows its hover effect.
 * Scripts cannot switch on :hover itself, so every :hover rule in the loaded styles is
 * copied under a marker class, which is put on the elements it touches.
 *
 * Happenings: modals opening and closing, notices popping up, things being dragged, the
 * note scrolling — reported to the engine as they happen.
 *
 * Coordinates are art px for prints, CSS px for everything that touches the DOM.
 */

type Rgb = [number, number, number];
interface Print { x: number; y: number; angle: number; rgb: Rgb; alpha: number; born: number; }

const PRINT_LIFE = 5000;
const PRINT_ALPHA = 0.55;
/** How much ink a step uses up: a foot leaves this many prints and is clean again. */
const INK_PER_STEP = 0.22;
const TEXT_ROOTS = '.cm-content, .markdown-preview-view';

export class Footprints {
  private prints: Print[] = [];
  private ink = new Map<Leg, { rgb: Rgb; left: number }>();

  constructor(private win: Window) {}

  /** The colour of the note text at a CSS point, or null if there is none there. */
  textColourAt(x: number, y: number): Rgb | null {
    const el = this.win.document.elementFromPoint(x, y);
    if (!el || !el.closest(TEXT_ROOTS)) return null;
    const m = this.win.getComputedStyle(el).color.match(/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  /** The foot stepped in the text: it is inked. */
  dip(leg: Leg, rgb: Rgb) { this.ink.set(leg, { rgb, left: 1 }); }

  /** The foot came down off the text at (x, y) art px: leave a print if it is inked. */
  step(leg: Leg, x: number, y: number, angle: number, now: number) {
    const ink = this.ink.get(leg);
    if (!ink || ink.left <= 0.05) return;
    this.prints.push({ x, y, angle, rgb: ink.rgb, alpha: PRINT_ALPHA * ink.left, born: now });
    ink.left -= INK_PER_STEP;
  }

  /** The page scrolled under these prints (art px). */
  shift(dx: number, dy: number, inside: (x: number, y: number) => boolean) {
    for (const p of this.prints) if (inside(p.x, p.y)) { p.x += dx; p.y += dy; }
  }

  get active() { return this.prints.length > 0; }

  draw(g: CanvasRenderingContext2D, res: number, now: number) {
    this.prints = this.prints.filter((p) => now - p.born < PRINT_LIFE);
    const s = Math.ceil(res);
    for (const p of this.prints) {
      const a = p.alpha * (1 - (now - p.born) / PRINT_LIFE);
      g.fillStyle = `rgba(${p.rgb[0]}, ${p.rgb[1]}, ${p.rgb[2]}, ${a.toFixed(3)})`;
      // A pad and two toes, as a planted foot is drawn.
      for (const [d, da] of [[0, 0], [1.2, -0.75], [1.2, 0.75]] as const) {
        g.fillRect(Math.floor((p.x + Math.cos(p.angle + da) * d) * res), Math.floor((p.y + Math.sin(p.angle + da) * d) * res), s, s);
      }
    }
  }
}

const TOUCH = 'pixel-pet-touch';
/** How far up the tree hover reaches from the element touched (as :hover reaches ancestors). */
const TOUCH_DEPTH = 6;

export class HoverSim {
  private style: HTMLStyleElement;
  private touched = new Set<Element>();

  constructor(private win: Window) {
    this.style = win.document.createElement('style');
    this.style.id = 'pixel-pet-hover-sim';
  }

  attach() { this.win.document.head.appendChild(this.style); this.rebuild(); }

  destroy() { this.clear(); this.style.remove(); }

  /** Copy every :hover rule in the loaded styles so that the marker class triggers it too. */
  rebuild() {
    const out: string[] = [];
    const walk = (rules: CSSRuleList, wrap: (s: string) => string) => {
      for (const r of Array.from(rules)) {
        if (r.type === CSSRule.STYLE_RULE) {
          const sr = r as CSSStyleRule;
          if (sr.selectorText.includes(':hover') && !sr.selectorText.includes('pixel-pet')) {
            out.push(wrap(`${sr.selectorText.replace(/:hover/g, `.${TOUCH}`)} { ${sr.style.cssText} }`));
          }
        } else if (r.type === CSSRule.MEDIA_RULE) {
          const mr = r as CSSMediaRule;
          walk(mr.cssRules, (s) => wrap(`@media ${mr.conditionText} { ${s} }`));
        } else if (r.type === CSSRule.SUPPORTS_RULE) {
          const su = r as CSSSupportsRule;
          walk(su.cssRules, (s) => wrap(`@supports ${su.conditionText} { ${s} }`));
        } else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) {
          walk((r as CSSGroupingRule).cssRules, wrap);
        }
      }
    };
    for (const sheet of Array.from(this.win.document.styleSheets)) {
      if (sheet.ownerNode === this.style) continue;
      try { walk(sheet.cssRules, (s) => s); } catch { /* a sheet we may not read */ }
    }
    this.style.textContent = out.join('\n');
  }

  /** The elements under these CSS points (and a few of their ancestors) are hovered; others not. */
  touch(points: { x: number; y: number }[]) {
    const doc = this.win.document, now = new Set<Element>();
    for (const p of points) {
      let el = doc.elementFromPoint(p.x, p.y);
      for (let d = 0; el && el !== doc.body && d < TOUCH_DEPTH; d++, el = el.parentElement) now.add(el);
    }
    for (const el of this.touched) if (!now.has(el)) el.classList.remove(TOUCH);
    for (const el of now) if (!this.touched.has(el)) el.classList.add(TOUCH);
    this.touched = now;
  }

  clear() { this.touch([]); }
}

export interface HappeningHandlers {
  /** A modal (or the command palette) opened, with its box; or closed (null). */
  modal(box: DOMRect | null): void;
  /** A notice popped up; `el` is it, to tell when it has gone. */
  notice(box: DOMRect, el: Element): void;
  /** Something is being dragged, here (CSS px); null when it is dropped. */
  drag(at: { x: number; y: number } | null): void;
  /** A scrolling element scrolled by (dx, dy) CSS px; its box. */
  scroll(box: DOMRect, dx: number, dy: number): void;
}

export class Happenings {
  private off: (() => void)[] = [];
  private scrollPos = new WeakMap<Element, [number, number]>();
  private modalOpen = false;

  constructor(private win: Window, private h: HappeningHandlers) {}

  attach() {
    const doc = this.win.document;
    const checkModal = () => {
      const m = doc.querySelector('.modal-container .modal, .modal-container .prompt');
      if (!!m !== this.modalOpen) { this.modalOpen = !!m; this.h.modal(m ? m.getBoundingClientRect() : null); }
    };
    // Notices live in a container appended to the body when the first one shows.
    let noticeObs: MutationObserver | null = null, watched: Element | null = null;
    const watchNotices = () => {
      const box = doc.querySelector('.notice-container');
      if (!box || box === watched) return;
      noticeObs?.disconnect();
      watched = box;
      noticeObs = new MutationObserver((muts) => {
        for (const m of muts) m.addedNodes.forEach((n) => {
          if (n.nodeType === Node.ELEMENT_NODE) this.win.setTimeout(() => this.h.notice((n as Element).getBoundingClientRect(), n as Element), 50);
        });
      });
      noticeObs.observe(box, { childList: true });
      // The container arrives with its first notice already in it.
      for (const n of Array.from(box.children)) this.win.setTimeout(() => this.h.notice(n.getBoundingClientRect(), n), 50);
    };
    const bodyObs = new MutationObserver(() => { checkModal(); watchNotices(); });
    bodyObs.observe(doc.body, { childList: true });
    watchNotices();
    this.off.push(() => { bodyObs.disconnect(); noticeObs?.disconnect(); });

    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      this.win.addEventListener(type, fn as EventListener, { capture: true, passive: true });
      this.off.push(() => this.win.removeEventListener(type, fn as EventListener, { capture: true }));
    };
    on('dragstart', (e) => this.h.drag({ x: e.clientX, y: e.clientY }));
    on('drag', (e) => { if (e.clientX || e.clientY) this.h.drag({ x: e.clientX, y: e.clientY }); });
    on('dragend', () => this.h.drag(null));
    on('drop', () => this.h.drag(null));
    on('scroll', (e) => {
      const el = e.target as Element | null;
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      const prev = this.scrollPos.get(el), now: [number, number] = [el.scrollLeft, el.scrollTop];
      this.scrollPos.set(el, now);
      if (prev && (prev[0] !== now[0] || prev[1] !== now[1])) this.h.scroll(el.getBoundingClientRect(), now[0] - prev[0], now[1] - prev[1]);
    });
    // Remember where scrollers start, so the first scroll has something to compare with.
    on('wheel', (e) => {
      for (let el = e.target as Element | null; el; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight && !this.scrollPos.has(el)) this.scrollPos.set(el, [el.scrollLeft, el.scrollTop]);
      }
    });
  }

  detach() { for (const f of this.off) f(); this.off = []; }
}

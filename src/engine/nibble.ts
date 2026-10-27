/*
 * Letter eating is purely visual. An eaten character is added to a CSS custom highlight
 * that paints it transparent, and a ghost of it is drawn in its place (by Reactions) at
 * 20% opacity, so the text stays readable, coming back to full over half a minute; then
 * the real letter shows again. The note's text is never touched, and any bite whose DOM
 * text changes underneath it (editing, re-render) is dropped at once so the wrong glyph
 * is never hidden.
 */

/** How long an eaten letter takes to grow back, ms. */
const REGROW_MS = 30000;
/** How faint it is just after being eaten. */
const EATEN_ALPHA = 0.2;

const HIGHLIGHT = 'pixel-pet-nibble';
const ROOTS = '.workspace-leaf .cm-content, .workspace-leaf .markdown-preview-sizer';

export interface NibbleTarget { range: Range; ch: string; x: number; y: number; }

/** An eaten letter as it should be drawn in its place. */
export interface Ghost { range: Range; ch: string; font: string; color: string; alpha: number; }

interface Bite { range: Range; ch: string; node: Text; since: number; font: string; color: string; }

type HighlightRegistry = Map<string, { add(r: Range): void; delete(r: Range): boolean; clear(): void }>;

export class Nibbler {
  private bites: Bite[] = [];
  private highlight: { add(r: Range): void; delete(r: Range): boolean; clear(): void } | null = null;
  private registry: HighlightRegistry | null = null;

  constructor(private win: Window) {
    const css = (win as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
    const Ctor = (win as unknown as { Highlight?: new () => { add(r: Range): void; delete(r: Range): boolean; clear(): void } }).Highlight;
    if (css?.highlights && Ctor) {
      this.registry = css.highlights;
      this.highlight = new Ctor();
      this.registry.set(HIGHLIGHT, this.highlight);
    }
  }

  get supported() { return !!this.highlight; }
  get count() { return this.bites.length; }

  /** Pick a visible letter in an open note, away from the caret (CSS px). */
  pickTarget(avoid: { x: number; y: number } | null, avoidR: number): NibbleTarget | null {
    if (!this.highlight) return null;
    const doc = this.win.document;
    const vw = this.win.innerWidth, vh = this.win.innerHeight;
    const roots = Array.from(doc.querySelectorAll<HTMLElement>(ROOTS)).filter((r) => {
      const b = r.getBoundingClientRect();
      return b.width > 40 && b.bottom > 0 && b.top < vh;
    });
    if (!roots.length) return null;

    const nodes: Text[] = [];
    for (const root of roots) {
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n && nodes.length < 600; n = walker.nextNode()) {
        const t = n as Text;
        if (t.data.trim().length < 2) continue;
        const el = t.parentElement;
        if (!el || el.closest('.cm-widgetBuffer, .cm-fold-indicator, .collapse-indicator, input, code, .frontmatter-container, .metadata-container')) continue;
        nodes.push(t);
      }
    }
    for (let attempt = 0; attempt < 40 && nodes.length; attempt++) {
      const node = nodes[Math.floor(Math.random() * nodes.length)];
      const i = Math.floor(Math.random() * node.data.length);
      const ch = node.data[i];
      if (!/[\p{L}\p{N}]/u.test(ch)) continue;
      if (this.bites.some((b) => b.node === node && b.range.startOffset === i)) continue;
      const range = doc.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 4) continue;
      if (r.top < 30 || r.bottom > vh - 30 || r.left < 0 || r.right > vw) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (avoid && Math.hypot(x - avoid.x, y - avoid.y) < avoidR) continue;
      // Must actually be what's painted there (not covered by a panel or modal).
      const hit = doc.elementFromPoint(x, y);
      if (!hit || !node.parentElement || !(hit === node.parentElement || hit.contains(node) || node.parentElement.contains(hit))) continue;
      return { range, ch, x, y };
    }
    return null;
  }

  /** Is the target still the same visible letter? Returns its current centre. */
  locate(t: NibbleTarget): { x: number; y: number } | null {
    if (!t.range.startContainer.isConnected || t.range.toString() !== t.ch) return null;
    const r = t.range.getBoundingClientRect();
    if (r.width < 1) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  bite(t: NibbleTarget): boolean {
    if (!this.highlight || !this.locate(t)) return false;
    const node = t.range.startContainer as Text;
    const cs = this.win.getComputedStyle(node.parentElement!);
    this.highlight.add(t.range);
    this.bites.push({
      range: t.range, ch: t.ch, node, since: performance.now(),
      font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, color: cs.color,
    });
    return true;
  }

  /** Eaten letters to draw in their places, faint at first and filling back in. */
  ghosts(now: number): Ghost[] {
    return this.bites.map((b) => ({
      range: b.range, ch: b.ch, font: b.font, color: b.color,
      alpha: Math.min(1, EATEN_ALPHA + (1 - EATEN_ALPHA) * ((now - b.since) / REGROW_MS)),
    }));
  }

  /** Drop stale bites and regrow old ones. Call a few times a second. */
  maintain(now: number) {
    if (!this.highlight) return;
    this.bites = this.bites.filter((b) => {
      const ok = now - b.since < REGROW_MS && b.node.isConnected && b.range.toString() === b.ch;
      if (!ok) this.highlight!.delete(b.range);
      return ok;
    });
  }

  clear() {
    this.highlight?.clear();
    this.bites = [];
  }

  destroy() {
    this.clear();
    this.registry?.delete(HIGHLIGHT);
  }
}

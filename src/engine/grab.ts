/**
 * Picking the pet up. A press that lands on it is claimed — the note underneath never
 * sees it, so no text gets selected and nothing is clicked — and once the pointer moves
 * a few pixels it becomes a carry. A press that doesn't move is left to the brain as a
 * poke (InputTracker reports it). Over the pet, the mouse cursor turns into a hand.
 * All coordinates are CSS pixels.
 */
export interface GrabHandlers {
  /** Is (x, y) on the pet? (A finger gets a more forgiving hit than a mouse.) */
  hit(x: number, y: number, finger?: boolean): boolean;
  start(x: number, y: number): void;
  move(x: number, y: number): void;
  end(x: number, y: number): void;
}

const DRAG_SLOP = 5;
const HOVER_CLASS = 'pixel-pet-hover';
const HOLD_CLASS = 'pixel-pet-holding';

export class Grabber {
  private press: { id: number; x: number; y: number; carrying: boolean } | null = null;
  private off: (() => void)[] = [];

  constructor(private win: Window, private h: GrabHandlers) {}

  attach() {
    const doc = this.win.document;
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      this.win.addEventListener(type, fn as EventListener, { capture: true, passive: false });
      this.off.push(() => this.win.removeEventListener(type, fn as EventListener, { capture: true }));
    };
    const claim = (e: Event) => { e.preventDefault(); e.stopPropagation(); };

    on('pointerdown', (e) => {
      if (this.press || (e.pointerType === 'mouse' && e.button !== 0) || !this.h.hit(e.clientX, e.clientY, e.pointerType === 'touch')) return;
      this.press = { id: e.pointerId, x: e.clientX, y: e.clientY, carrying: false };
      claim(e);
    });
    on('pointermove', (e) => {
      const p = this.press;
      if (!p) {
        if (e.pointerType === 'mouse') doc.body.classList.toggle(HOVER_CLASS, this.h.hit(e.clientX, e.clientY));
        return;
      }
      if (e.pointerId !== p.id) return;
      if (!p.carrying && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_SLOP) {
        p.carrying = true;
        doc.body.classList.add(HOLD_CLASS);
        this.h.start(e.clientX, e.clientY);
      }
      if (p.carrying) { this.h.move(e.clientX, e.clientY); claim(e); }
    });
    const finish = (e: PointerEvent) => {
      const p = this.press;
      if (!p || e.pointerId !== p.id) return;
      this.press = null;
      if (!p.carrying) return;
      doc.body.classList.remove(HOLD_CLASS);
      this.h.end(e.clientX, e.clientY);
      claim(e);
      // The click that follows a carry belongs to the carry, not to whatever is underneath.
      const swallow = (c: Event) => { claim(c); this.win.removeEventListener('click', swallow, true); };
      this.win.addEventListener('click', swallow, true);
      this.win.setTimeout(() => this.win.removeEventListener('click', swallow, true), 400);
    };
    on('pointerup', finish);
    on('pointercancel', finish);
    // On touch screens, a finger that starts on the pet must not scroll the note.
    on('touchstart', (e) => { const t = e.touches[0]; if (t && this.h.hit(t.clientX, t.clientY, true)) e.preventDefault(); });
    on('touchmove', (e) => { if (this.press?.carrying) e.preventDefault(); });
  }

  detach() {
    for (const f of this.off) f();
    this.off = [];
    this.press = null;
    this.win.document.body.classList.remove(HOVER_CLASS, HOLD_CLASS);
  }
}

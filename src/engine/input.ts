/**
 * Tracks the user's pointer and activity. All coordinates are CSS pixels.
 *
 * Touch has no hover, so it is translated into the same vocabulary the brain uses for
 * a mouse: a finger that is down behaves like a hovering pointer (holding it still on
 * the gecko is petting), and a quick tap leaves a "lure" — a still pointer at the tap
 * point for a few seconds — that the gecko can come over and investigate. A tap is
 * reported as a press only when the finger lifts, so press-and-hold never startles.
 */
export interface Press { x: number; y: number; tap: boolean; }

const LURE_MS = 7000;
const TAP_MS = 280;
const TAP_SLOP = 12;

export class InputTracker {
  pointer: { x: number; y: number } | null = null;
  vx = 0;
  vy = 0;
  lastMove = -Infinity;
  lastKey = -Infinity;
  lastActivity = performance.now();
  /** Presses since the engine last drained them. */
  presses: Press[] = [];
  /** True once any touch input has been seen. */
  touch = false;

  private lastT = 0;
  private fingerDown = false;
  private down = { x: 0, y: 0, t: 0 };
  private lureUntil = 0;
  private off: (() => void)[] = [];

  constructor(private win: Window) {}

  attach() {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      this.win.addEventListener(type, fn as EventListener, { capture: true, passive: true });
      this.off.push(() => this.win.removeEventListener(type, fn as EventListener, { capture: true }));
    };
    on('pointermove', (e) => {
      if (e.pointerType === 'touch' && !this.fingerDown) return;
      this.track(e.clientX, e.clientY);
    });
    on('pointerdown', (e) => {
      const now = performance.now();
      this.lastActivity = now;
      if (e.pointerType === 'touch') {
        this.touch = true;
        this.fingerDown = true;
        this.down = { x: e.clientX, y: e.clientY, t: now };
        this.pointer = { x: e.clientX, y: e.clientY };
        this.vx = this.vy = 0;
        this.lastT = now;
        this.lastMove = now;
        return;
      }
      this.presses.push({ x: e.clientX, y: e.clientY, tap: false });
    });
    const lift = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerType !== 'touch' || !this.fingerDown) return;
      const now = performance.now();
      this.fingerDown = false;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      if (!cancelled && now - this.down.t < TAP_MS && moved < TAP_SLOP) {
        this.presses.push({ x: e.clientX, y: e.clientY, tap: true });
        this.pointer = { x: e.clientX, y: e.clientY };
        this.vx = this.vy = 0;
        this.lureUntil = now + LURE_MS;
      } else {
        this.pointer = null;
      }
    };
    on('pointerup', (e) => lift(e, false));
    on('pointercancel', (e) => lift(e, true));
    on('keydown', () => {
      const now = performance.now();
      this.lastKey = now;
      this.lastActivity = now;
    });
    on('wheel', () => { this.lastActivity = performance.now(); });
    on('scroll', () => { this.lastActivity = performance.now(); });
    on('blur', () => { this.pointer = null; this.fingerDown = false; });
    const leave = (e: MouseEvent) => { if (!e.relatedTarget && !this.fingerDown) this.pointer = null; };
    this.win.document.addEventListener('mouseout', leave, true);
    this.off.push(() => this.win.document.removeEventListener('mouseout', leave, true));
  }

  private track(x: number, y: number) {
    const now = performance.now();
    if (this.pointer && this.lastT) {
      const dt = Math.max(1, now - this.lastT) / 1000;
      const k = Math.min(1, dt * 18);
      this.vx += ((x - this.pointer.x) / dt - this.vx) * k;
      this.vy += ((y - this.pointer.y) / dt - this.vy) * k;
    }
    this.pointer = { x, y };
    this.lastT = now;
    this.lastMove = now;
    this.lastActivity = now;
  }

  detach() {
    for (const f of this.off) f();
    this.off = [];
  }

  /** The pointer as the gecko perceives it: a lifted finger only lingers as a lure. */
  pointerAt(now: number): { x: number; y: number } | null {
    if (this.touch && !this.fingerDown && now > this.lureUntil) this.pointer = null;
    return this.pointer;
  }

  /** Pointer speed in CSS px / s, decayed if the pointer has been still. */
  speed(now: number): number {
    const still = (now - this.lastMove) / 1000;
    const decay = still > 0.06 ? Math.exp(-(still - 0.06) * 12) : 1;
    return Math.hypot(this.vx, this.vy) * decay;
  }

  velocity(now: number): { x: number; y: number } {
    const s = this.speed(now);
    const raw = Math.hypot(this.vx, this.vy) || 1;
    return { x: (this.vx / raw) * s, y: (this.vy / raw) * s };
  }

  typedWithin(now: number, ms: number) { return now - this.lastKey < ms; }
  idleFor(now: number) { return now - this.lastActivity; }
}

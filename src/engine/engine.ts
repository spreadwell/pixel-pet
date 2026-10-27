import { Body } from './body';
import { Brain, BrainOptions, Ctx } from './brain';
import { BugKind, Particles, Swarm } from './bugs';
import { InputTracker } from './input';
import { clamp, rand } from './math';
import { Nibbler } from './nibble';
import { Palette, buildPalette } from './palette';
import { GeckoRenderer } from './render';
import { World } from './world';

export interface PetOptions extends BrainOptions {
  /** CSS pixels per art pixel. */
  px: number;
  /** Any CSS colour expression, e.g. 'var(--interactive-accent)'. */
  color: string;
  /** Frame-rate cap (0 = display rate). */
  maxFps?: number;
  debug?: boolean;
}

const STEP = 1 / 60;

/** Owns the overlay canvas and runs the simulation. Has no Obsidian API dependency. */
export class PetEngine {
  readonly canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private world: World;
  private input: InputTracker;
  private swarm = new Swarm();
  private particles = new Particles();
  private nibbler: Nibbler;
  private renderer = new GeckoRenderer();
  private body!: Body;
  private brain!: Brain;
  private pal: Palette;
  private c!: Ctx;
  private raf = 0;
  private last = 0;
  private frame = 0;
  private frameAcc = 0;
  private scanIn = 0;
  private caretIn = 0;
  private maintainIn = 0;
  private onResize = () => { this.resize(); this.world.scan(); };
  private onVisibility = () => { this.last = performance.now(); };

  constructor(private win: Window, private opts: PetOptions) {
    const doc = win.document;
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'butter-pet-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx2d = this.canvas.getContext('2d')!;
    this.world = new World(win);
    this.input = new InputTracker(win);
    this.nibbler = new Nibbler(win);
    this.pal = buildPalette(doc, opts.color);
  }

  /** Start, optionally placing the gecko at a CSS position instead of walking in. */
  start(at?: { x: number; y: number; heading: number }) {
    const doc = this.win.document;
    doc.body.appendChild(this.canvas);
    this.world.px = this.opts.px;
    this.resize();
    this.world.scan();
    this.input.attach();
    this.win.addEventListener('resize', this.onResize);
    this.win.visualViewport?.addEventListener('resize', this.onResize);
    doc.addEventListener('visibilitychange', this.onVisibility);

    const b = this.world.bounds;
    if (at) this.body = new Body(at.x / this.opts.px, at.y / this.opts.px, at.heading);
    else this.body = new Body(-14, b.y + clamp(rand(0.35, 0.7) * b.h, 20, b.h - 20), 0);
    this.c = {
      body: this.body, world: this.world, input: this.input, swarm: this.swarm, nibbler: this.nibbler,
      particles: this.particles, pal: this.pal, opts: this.opts, now: performance.now(), pointer: null, pointerSpeed: 0,
    };
    this.brain = new Brain(this.c, !at);
    this.last = performance.now();
    this.raf = this.win.requestAnimationFrame(this.tick);
  }

  destroy() {
    this.win.cancelAnimationFrame(this.raf);
    this.input.detach();
    this.win.removeEventListener('resize', this.onResize);
    this.win.visualViewport?.removeEventListener('resize', this.onResize);
    this.win.document.removeEventListener('visibilitychange', this.onVisibility);
    this.nibbler.destroy();
    this.canvas.remove();
  }

  /** Where the gecko is, in CSS px, so a rebuilt engine can carry on from there. */
  pose() {
    const n = this.body.neck;
    return { x: n.x * this.opts.px, y: n.y * this.opts.px, heading: this.body.heading };
  }

  get state() { return this.brain?.state ?? 'off'; }
  get px() { return this.opts.px; }

  setOptions(o: Partial<PetOptions>) {
    Object.assign(this.opts, o);
    if (o.color !== undefined) this.refreshPalette();
    if (!o.nibble && o.nibble !== undefined) this.nibbler.clear();
  }

  refreshPalette() {
    this.pal = buildPalette(this.win.document, this.opts.color);
    if (this.c) this.c.pal = this.pal;
  }

  /** Text was written or a task completed: attract a bug, preferably near the caret. */
  spawnBug(kind: BugKind) {
    const near = this.world.caret ?? undefined;
    this.swarm.spawn(kind, this.world, near);
  }

  /** Come over to the pointer (or the middle of the window). */
  summon() {
    const p = this.input.pointer;
    const b = this.world.bounds;
    this.brain.summon(p ? { x: p.x / this.opts.px, y: p.y / this.opts.px } : { x: b.w / 2, y: b.h / 2 });
  }

  /** Advance the simulation without waiting for animation frames (testing, previews). */
  simulate(seconds: number) {
    for (let i = 0; i < Math.ceil(seconds / STEP); i++) this.step(STEP);
    this.render();
  }

  private resize() {
    const px = this.opts.px;
    const w = Math.ceil(this.win.innerWidth / px), h = Math.ceil(this.win.innerHeight / px);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w * px}px`;
    this.canvas.style.height = `${h * px}px`;
    this.ctx2d.imageSmoothingEnabled = false;
  }

  private tick = (t: number) => {
    this.raf = this.win.requestAnimationFrame(this.tick);
    if (this.win.document.hidden) { this.last = t; return; }
    let dt = Math.min(0.1, Math.max(0, (t - this.last) / 1000));
    this.last = t;

    // A sleeping gecko with nothing around only needs a few frames a second, and on
    // battery-powered devices the frame rate is capped.
    const quiet = this.brain.state === 'sleep' && !this.swarm.bugs.length && !this.particles.active;
    const minFrame = quiet ? 1 / 12 : this.opts.maxFps ? 1 / this.opts.maxFps : 0;
    this.frameAcc += dt;
    if (this.frameAcc < minFrame - 0.002) return;
    dt = Math.min(0.1, this.frameAcc);
    this.frameAcc = 0;

    const steps = Math.max(1, Math.ceil(dt / STEP - 0.01));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h);
    this.render();
  };

  private step(dt: number) {
    const now = performance.now();
    const c = this.c;
    c.now = now;

    this.scanIn -= dt;
    if (this.scanIn <= 0) { this.world.scan(); this.scanIn = 0.5; }
    this.caretIn -= dt;
    if (this.caretIn <= 0 && this.input.typedWithin(now, 3000)) { this.world.scanCaret(); this.caretIn = 0.1; }
    this.maintainIn -= dt;
    if (this.maintainIn <= 0) { this.nibbler.maintain(now); this.maintainIn = 0.5; }

    const p = this.input.pointerAt(now);
    c.pointer = p ? { x: p.x / this.opts.px, y: p.y / this.opts.px } : null;
    c.pointerSpeed = this.input.speed(now) / this.opts.px;

    const drive = this.brain.update(dt);
    this.body.update(dt, drive);

    if (this.brain.current.name !== 'enter') {
      const n = this.body.neck;
      const k = this.world.clampToBounds(n.x, n.y, 3);
      n.x = k.x; n.y = k.y;
    }

    this.swarm.update(dt, this.world, this.body.head);
    this.particles.update(dt);
  }

  private render() {
    const g = this.ctx2d;
    this.frame++;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const b of this.swarm.bugs) if (b.z < 1) b.draw(g, this.pal, this.frame);
    this.renderer.draw(g, this.body, this.pal);
    for (const b of this.swarm.bugs) if (b.z >= 1) b.draw(g, this.pal, this.frame);
    this.particles.draw(g);

    if (this.opts.debug) {
      g.fillStyle = 'rgba(255,0,80,0.8)';
      const cur = this.brain.current as unknown as { goal?: { x: number; y: number } };
      if (cur.goal) g.fillRect(Math.floor(cur.goal.x), Math.floor(cur.goal.y), 2, 2);
      if (this.world.caret) { g.fillStyle = 'rgba(0,140,255,0.8)'; g.fillRect(Math.floor(this.world.caret.x), Math.floor(this.world.caret.y), 2, 2); }
      g.fillStyle = 'rgba(0,160,90,0.25)';
      for (const e of this.world.edges) {
        const n = Math.ceil(e.len / 4);
        for (let i = 0; i <= n; i++) g.fillRect(Math.floor(e.x1 + ((e.x2 - e.x1) * i) / n), Math.floor(e.y1 + ((e.y2 - e.y1) * i) / n), 1, 1);
      }
    }
  }
}

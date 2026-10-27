import { Body } from './body';
import { BugKind, Particles, Swarm } from './bugs';
import { InputTracker } from './input';
import { clamp, rand } from './math';
import { Nibbler } from './nibble';
import { Palette, buildPalette } from './palette';
import { BrainOptions, Ctx, Personality, STATE } from './personality';
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

/** The personality is tuned per 60 Hz tick, so the whole simulation runs on a fixed step. */
const TICK = 1 / 60;

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
  private brain!: Personality;
  /** Palettes from cool to sun-warmed; the gecko warms while basking or sleeping. */
  private pals: Palette[] = [];
  private c!: Ctx;
  private raf = 0;
  private last = 0;
  private acc = 0;
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
    this.canvas.className = 'pixel-pet-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx2d = this.canvas.getContext('2d')!;
    this.world = new World(win);
    this.input = new InputTracker(win);
    this.nibbler = new Nibbler(win);
    this.buildPalettes();
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
    else this.body = new Body(b.x - 14, b.y + clamp(rand(0.35, 0.7) * b.h, 20, b.h - 20), 0);
    this.c = {
      body: this.body, world: this.world, input: this.input, swarm: this.swarm, nibbler: this.nibbler,
      particles: this.particles, pal: this.pals[0], opts: this.opts, now: performance.now(), pointer: null, pointerSpeed: 0,
    };
    this.brain = new Personality(this.c, !at);
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

  get state() { return this.brain?.stateName ?? 'off'; }
  get px() { return this.opts.px; }

  setOptions(o: Partial<PetOptions>) {
    Object.assign(this.opts, o);
    if (o.color !== undefined) this.refreshPalette();
    if (o.nibble === false) { this.nibbler.clear(); this.brain?.dropLetter(); }
  }

  refreshPalette() {
    this.buildPalettes();
    if (this.c) this.c.pal = this.pals[0];
  }

  private buildPalettes() {
    this.pals = [0, 0.5, 1].map((w) => buildPalette(this.win.document, this.opts.color, w));
  }

  /** Text was written or a task completed: attract a bug, preferably near the caret. */
  spawnBug(kind: BugKind) {
    this.swarm.spawn(kind, this.world, this.world.caret ?? undefined);
  }

  /** Come over to the pointer (or the middle of the window). */
  summon() {
    const p = this.input.pointer;
    const b = this.world.bounds;
    this.brain.summon(p ? { x: p.x / this.opts.px, y: p.y / this.opts.px } : { x: b.x + b.w / 2, y: b.y + b.h / 2 });
  }

  /** Advance the simulation without waiting for animation frames (testing, previews). */
  simulate(seconds: number) {
    for (let i = 0; i < Math.round(seconds / TICK); i++) this.step();
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
    const dt = Math.min(0.1, Math.max(0, (t - this.last) / 1000));
    this.last = t;

    // A sleeping gecko with nothing around only needs a few frames a second, and on
    // battery-powered devices the frame rate is capped.
    const quiet = this.brain.state === STATE.SLEEP && !this.swarm.bugs.length && !this.particles.active;
    const minFrame = quiet ? 1 / 12 : this.opts.maxFps ? 1 / this.opts.maxFps : 0;
    this.frameAcc += dt;
    if (this.frameAcc < minFrame - 0.002) return;
    this.acc += Math.min(0.25, this.frameAcc);
    this.frameAcc = 0;

    let n = 0;
    while (this.acc >= TICK && n < 15) { this.step(); this.acc -= TICK; n++; }
    if (n === 15) this.acc = 0;
    if (n) this.render();
  };

  private step() {
    const now = performance.now();
    const c = this.c;
    c.now = now;

    this.scanIn -= TICK;
    if (this.scanIn <= 0) { this.world.scan(); this.scanIn = 0.5; }
    this.caretIn -= TICK;
    if (this.caretIn <= 0 && this.input.typedWithin(now, 3000)) { this.world.scanCaret(); this.caretIn = 0.1; }
    this.maintainIn -= TICK;
    if (this.maintainIn <= 0) { this.nibbler.maintain(now); this.maintainIn = 0.5; }

    const p = this.input.pointerAt(now);
    c.pointer = p ? { x: p.x / this.opts.px, y: p.y / this.opts.px } : null;
    c.pointerSpeed = this.input.speed(now) / this.opts.px;
    c.pal = this.pals[0];

    const drive = this.brain.update();
    this.body.update(TICK, drive);

    if (!this.brain.entering) {
      const n = this.body.neck;
      const k = this.world.clampToBounds(n.x, n.y, 3);
      n.x = k.x; n.y = k.y;
    }

    this.swarm.update(TICK, this.world, this.body.head);
    this.particles.update(TICK);
  }

  private render() {
    const g = this.ctx2d;
    this.frame++;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const pal = this.pals[Math.round(this.brain.color.warmth * 2)];
    for (const b of this.swarm.bugs) if (b.z < 1) b.draw(g, pal, this.frame);
    // Side panels lie over the note: whatever part of the gecko has crept under one is hidden.
    const covers = this.world.covers;
    if (covers.length) {
      g.save();
      g.beginPath();
      g.rect(0, 0, this.canvas.width, this.canvas.height);
      for (const c of covers) g.rect(Math.round(c.x), Math.round(c.y), Math.round(c.w), Math.round(c.h));
      g.clip('evenodd');
    }
    this.renderer.draw(g, this.body, pal);
    if (covers.length) g.restore();
    for (const b of this.swarm.bugs) if (b.z >= 1) b.draw(g, pal, this.frame);
    this.particles.draw(g);

    if (this.opts.debug) {
      const br = this.brain;
      g.fillStyle = 'rgba(255,0,80,0.8)';
      g.fillRect(Math.floor(br.destX), Math.floor(br.destY), 2, 2);
      g.fillStyle = 'rgba(0,140,255,0.8)';
      g.fillRect(Math.floor(br.homeX) - 1, Math.floor(br.homeY) - 1, 3, 3);
      g.fillStyle = 'rgba(0,160,90,0.25)';
      for (const e of this.world.edges) {
        const n = Math.ceil(e.len / 4);
        for (let i = 0; i <= n; i++) g.fillRect(Math.floor(e.x1 + ((e.x2 - e.x1) * i) / n), Math.floor(e.y1 + ((e.y2 - e.y1) * i) / n), 1, 1);
      }
    }
  }
}

import { Body } from './body';
import { BugKind, Particles, Swarm } from './bugs';
import { Grabber } from './grab';
import { InputTracker } from './input';
import { clamp, rand } from './math';
import { Nibbler } from './nibble';
import { Palette, buildPalette } from './palette';
import { BrainOptions, Ctx, Personality, Playground, STATE } from './personality';
import { Reactions } from './reactions';
import { GeckoRenderer } from './render';
import { Zzz } from './zzz';
import { Footprints, Happenings, HoverSim } from './surroundings';
import { World } from './world';

export interface PetOptions extends BrainOptions {
  /** CSS pixels per art pixel. */
  px: number;
  /** Any CSS colour expression, e.g. 'var(--interactive-accent)'. */
  color: string;
  /** How much finer than art px the gecko is drawn (1 = one canvas pixel per art px; 1.5 is finer). */
  detail?: number;
  /** Frame-rate cap (0 = display rate). */
  maxFps?: number;
  debug?: boolean;
  /** The nodes of open graph views, in CSS px, for it to play with. */
  graph?: Playground;
}

/** The personality is tuned per 60 Hz tick, so the whole simulation runs on a fixed step. */
const TICK = 1 / 60;
/** Showing hover effects on what it walks over: switched off for now (see HoverSim). */
const HOVER = false;

/** Owns the overlay canvas and runs the simulation. Has no Obsidian API dependency. */
export class PetEngine {
  readonly canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private world: World;
  private input: InputTracker;
  private grabber: Grabber;
  private reactions: Reactions;
  private prints: Footprints;
  private hover: HoverSim;
  private happenings: Happenings;
  private hoverIn = 0;
  private swarm = new Swarm();
  private particles = new Particles();
  private nibbler: Nibbler;
  private renderer = new GeckoRenderer();
  private zzz: Zzz;
  private body!: Body;
  private brain!: Personality;
  private pal!: Palette;
  private c!: Ctx;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private frame = 0;
  private frameAcc = 0;
  private scanIn = 0;
  private caretIn = 0;
  private maintainIn = 0;
  private onResize = () => { this.resize(); this.reactions.resize(); this.zzz.resize(); this.world.scan(); };
  private onVisibility = () => { this.last = performance.now(); };

  constructor(private win: Window, private opts: PetOptions) {
    const doc = win.document;
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'pixel-pet-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx2d = this.canvas.getContext('2d')!;
    this.world = new World(win);
    this.input = new InputTracker(win);
    this.grabber = new Grabber(win, {
      hit: (x, y) => this.hitsPet(x, y),
      start: (x, y) => { this.body.grab(x / this.opts.px, y / this.opts.px); this.brain.pickUp(); },
      move: (x, y) => this.body.holdAt(x / this.opts.px, y / this.opts.px),
      end: () => { this.splash(); this.body.release(); this.brain.putDown(); },
    });
    this.reactions = new Reactions(win);
    this.prints = new Footprints(win);
    this.hover = new HoverSim(win);
    this.happenings = new Happenings(win, {
      modal: (box) => this.brain?.modalChanged(box ? { x: (box.left + box.width / 2) / this.opts.px, y: (box.top + box.height / 2) / this.opts.px } : null),
      notice: (box, el) => this.brain?.noticed({ x: (box.left + box.width / 2) / this.opts.px, y: (box.bottom + 18) / this.opts.px }, () => el.isConnected),
      drag: (at) => this.brain?.dragged(at ? { x: at.x / this.opts.px, y: at.y / this.opts.px } : null),
      scroll: (box, dx, dy) => this.scrolled(box, dx, dy),
    });
    this.zzz = new Zzz(win);
    this.nibbler = new Nibbler(win);
    this.buildPalettes();
  }

  /** Start, optionally placing the gecko at a CSS position instead of walking in. */
  start(at?: { x: number; y: number; heading: number }) {
    const doc = this.win.document;
    this.reactions.attach();
    doc.body.appendChild(this.canvas);
    this.reactions.attachTop();
    this.zzz.attach();
    this.world.px = this.opts.px;
    this.resize();
    this.world.scan();
    this.input.attach();
    this.grabber.attach();
    if (HOVER) this.hover.attach();
    this.happenings.attach();
    this.win.addEventListener('resize', this.onResize);
    this.win.visualViewport?.addEventListener('resize', this.onResize);
    doc.addEventListener('visibilitychange', this.onVisibility);

    const b = this.world.bounds;
    if (at) this.body = new Body(at.x / this.opts.px, at.y / this.opts.px, at.heading);
    else this.body = new Body(b.x - 14, b.y + clamp(rand(0.35, 0.7) * b.h, 20, b.h - 20), 0);
    // Over the terrain, unless it has crept under a panel: under there it is on the note.
    const body = this.body, world = this.world;
    body.ground = (x, y) => (body.under && world.coverAt(x, y) ? 0 : world.groundAt(x, y));
    this.c = {
      body: this.body, world: this.world, input: this.input, swarm: this.swarm, nibbler: this.nibbler, reactions: this.reactions,
      particles: this.particles, pal: this.pal, opts: this.opts, now: performance.now(), pointer: null, pointerSpeed: 0,
      graph: this.playground(),
    };
    this.brain = new Personality(this.c, !at);
    this.last = performance.now();
    this.raf = this.win.requestAnimationFrame(this.tick);
  }

  destroy() {
    this.win.cancelAnimationFrame(this.raf);
    this.input.detach();
    this.grabber.detach();
    this.hover.destroy();
    this.happenings.detach();
    this.win.removeEventListener('resize', this.onResize);
    this.win.visualViewport?.removeEventListener('resize', this.onResize);
    this.win.document.removeEventListener('visibilitychange', this.onVisibility);
    this.nibbler.destroy();
    this.reactions.destroy();
    this.zzz.destroy();
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

  /** The theme or styles changed: new colours, and new hover styles to copy. */
  refreshPalette() {
    this.buildPalettes();
    if (this.c) this.c.pal = this.pal;
    if (HOVER) this.hover.rebuild();
  }

  /** A different note or tab was opened (both events can fire for one change). */
  noteChanged(asked = false) {
    const now = performance.now();
    if (!asked && now - this.lastNoteChange < 300) return;
    this.lastNoteChange = now;
    this.world.scan();
    // The note in focus — or, asked from the pet panel (which has the focus then), the
    // note showing in the main area.
    const doc = this.win.document;
    const shown = [...doc.querySelectorAll<HTMLElement>('.mod-root .workspace-leaf-content:is([data-type="markdown"], [data-type="butter-editor"]) .view-content')].find((e) => e.offsetParent !== null);
    const el = asked ? shown : doc.querySelector('.workspace-leaf.mod-active .view-content');
    const r = el?.getBoundingClientRect(), px = this.opts.px;
    this.brain?.newSurroundings(r && r.width > 0 ? { x: r.left / px, y: r.top / px, w: r.width / px, h: r.height / px } : null, asked);
  }
  private lastNoteChange = 0;

  /** The graph's nodes as balls, in art px. */
  private playground(): Playground | null {
    const g = this.opts.graph, px = this.opts.px;
    if (!g) return null;
    return {
      balls: () => g.balls().map((b) => ({ id: b.id, x: b.x / px, y: b.y / px, r: b.r / px })),
      push: (id, x, y) => g.push(id, x * px, y * px),
      letGo: (id) => g.letGo(id),
    };
  }

  /**
   * Something scrolled. If the gecko is on it — the note, the file list — it rides along
   * with the page, as do its footprints and any bugs on the page. Carried past the edge
   * it goes out of view, clipped like the page's own content (never more than a body
   * length past it), and once the scrolling stops it hurries back in.
   */
  private scrolled(box: DOMRect, dx: number, dy: number) {
    const b = this.body, px = this.opts.px;
    const inside = (x: number, y: number) => x * px > box.left && x * px < box.right && y * px > box.top && y * px < box.bottom;
    const ax = -dx / px, ay = -dy / px;
    // Bugs on the page ride along too (scrolled off it, they are gone); flies in the air don't.
    for (const bug of this.swarm.bugs) {
      if (!bug.onPage || !inside(bug.x, bug.y)) continue;
      bug.shift(ax, ay);
      if (!inside(bug.x, bug.y)) bug.alive = false;
    }
    if (!b || b.isHeld || b.under) return;
    const same = (r: DOMRect | null) => !!r && Math.abs(r.left - box.left) < 2 && Math.abs(r.top - box.top) < 2 && Math.abs(r.width - box.width) < 2;
    if (!inside(b.neck.x, b.neck.y) && !same(this.offPage)) return;
    b.translate(ax, ay);
    this.brain.shifted(ax, ay);
    this.prints.shift(ax, ay, inside);
    // The layout under it moved: look again soon.
    this.scanIn = Math.min(this.scanIn, 0.08);
    this.lastScroll = performance.now();
    const n = b.neck;
    if (!inside(n.x, n.y)) {
      // Out of view past the edge, but no further than it takes to hide.
      const out = 40;
      const cx = Math.min(Math.max(n.x, box.left / px - out), box.right / px + out), cy = Math.min(Math.max(n.y, box.top / px - out), box.bottom / px + out);
      if (cx !== n.x || cy !== n.y) b.translate(cx - n.x, cy - n.y);
    }
    // Any of it carried past the edge — a snout, a foot, long before the neck — is clipped
    // like the page's content, never drawn over the header above it.
    if (!this.onPage(box)) { this.offPage = box; this.returning = false; }
  }

  /** All of it — body, snout and feet — well inside `box` (CSS px). */
  private onPage(box: DOMRect) {
    const b = this.body, px = this.opts.px, m = 3 * px;
    const ok = (p: { x: number; y: number }) => p.x * px > box.left + m && p.x * px < box.right - m && p.y * px > box.top + m && p.y * px < box.bottom - m;
    return b.pts.every(ok) && b.legs.every((l) => ok(l.foot)) && ok(this.brain.snout());
  }

  /** Off the edge of a scrolled page: the page's box (CSS px) it is clipped to, until it is back. */
  private offPage: DOMRect | null = null;
  private returning = false;
  private returnedAt = 0;
  private lastScroll = 0;

  /** After a scroll carried it out of view: once the scrolling stops, come back in. */
  private comeBack() {
    const box = this.offPage, b = this.body, px = this.opts.px;
    if (!box) return;
    if (b.isHeld) { this.offPage = null; return; }
    if (this.onPage(box)) { this.offPage = null; this.returning = false; return; }
    const now = performance.now();
    // Something else caught its attention on the way back: send it again.
    if (this.returning && now - this.returnedAt > 2500) this.returning = false;
    if (!this.returning && now - this.lastScroll > 250) {
      this.returning = true;
      this.returnedAt = now;
      // Far enough in that the whole animal, tail and all, is back on the page.
      const n = b.neck, inset = 44;
      this.brain.comeBackTo({
        x: Math.min(Math.max(n.x, box.left / px + inset), box.right / px - inset),
        y: Math.min(Math.max(n.y, box.top / px + inset), box.bottom / px - inset),
      });
    }
  }

  private buildPalettes() {
    this.pal = buildPalette(this.win.document, this.opts.color);
  }

  /** Text was written or a task completed: attract a bug, preferably near the caret. */
  spawnBug(kind: BugKind) {
    this.swarm.spawn(kind, this.world, this.world.caret ?? undefined);
  }

  /** What the pet is up to, in a few words. */
  get activity() { return this.brain?.activity ?? 'Away'; }

  /**
   * A command from the pet panel: sleep, wake, explore, scout, eat, play, pushups, bask,
   * nibble, come. Returns a few words to show if it can't, or null.
   */
  command(cmd: string): string | null {
    if (!this.brain) return null;
    if (cmd === 'come') { this.summon(); return null; }
    if (cmd === 'scout') { this.noteChanged(true); return null; }
    const said = this.brain.command(cmd);
    if (cmd === 'eat') {
      // Something to eat turns up near it.
      const h = this.body.head;
      this.swarm.spawn(Math.random() < 0.5 ? 'cricket' : 'fly', this.world, { x: h.x, y: h.y });
    }
    return said;
  }

  /** Come over to the pointer (or the middle of the window). */
  summon() {
    const p = this.input.pointer;
    const b = this.world.bounds;
    this.brain.summon(p ? { x: p.x / this.opts.px, y: p.y / this.opts.px } : { x: b.x + b.w / 2, y: b.y + b.h / 2 });
  }

  /**
   * Footfalls make the workspace react: letters dip under its feet, small icons press
   * down. Not while it is under a panel, nor right where you are typing.
   */
  private react() {
    const b = this.body, px = this.opts.px;
    if (b.under || this.opts.reducedMotion) { b.footfalls.length = 0; return; }
    const k = this.world.caret, typing = this.input.typedWithin(performance.now(), 2000);
    for (const f of b.footfalls) {
      if (typing && k && Math.hypot(f.x - k.x, f.y - k.y) < 25) continue;
      // Hauling itself up onto something, or running, it lands harder.
      const climbing = this.world.groundAt(f.x, f.y) > b.z[f.leg.def.seg] + 1.5;
      const strength = climbing ? 1.5 : b.speed > 50 ? 1.3 : 1;
      // The letter under the foot as it is drawn (lifted with the surface it stands on).
      const z = this.world.groundAt(f.x, f.y);
      const q = b.project(f.x, f.y, z);
      this.reactions.step(q.x * px, q.y * px, Math.cos(b.heading), Math.sin(b.heading), strength);
      // Stepping in the text inks the foot; off it, an inked foot leaves a print.
      const ink = z === 4 || z === 5 ? this.prints.textColourAt(q.x * px, q.y * px) : null;
      if (ink) this.prints.dip(f.leg, ink);
      else if (z < 4) this.prints.step(f.leg, q.x, q.y, f.leg.toe, performance.now());
    }
    b.footfalls.length = 0;
  }

  /** Dropped from a height: everything under it bounces. */
  private splash() {
    const b = this.body, px = this.opts.px;
    if (this.opts.reducedMotion) return;
    const pts = [...[4, 8, 11, 14, 17, 20].map((i) => b.pts[i]), ...b.legs.map((l) => l.foot)];
    this.reactions.splash(pts.map((p) => ({ x: p.x * px, y: p.y * px })), b.pts[12].x * px, b.pts[12].y * px);
  }

  /** Is the CSS point (x, y) on the pet — and not on a panel it is hiding under? */
  private hitsPet(x: number, y: number) {
    if (!this.brain) return false;
    const ax = x / this.opts.px, ay = y / this.opts.px;
    if (this.body.under && this.world.coverAt(ax, ay)) return false;
    return this.brain.bodyDistance(ax, ay) < 1.5;
  }

  /** Advance the simulation without waiting for animation frames (testing, previews). */
  simulate(seconds: number) {
    for (let i = 0; i < Math.round(seconds / TICK); i++) this.step();
    this.render();
  }

  /** Canvas pixels per art px: the gecko is drawn this much finer than it is simulated. */
  private res = 1;

  private resize() {
    const px = this.opts.px, dpr = this.win.devicePixelRatio || 1;
    // Each canvas pixel is a whole number of device pixels, so the art stays crisp.
    const cpx = Math.max(1, Math.round((px / (this.opts.detail ?? 1)) * dpr)) / dpr;
    this.res = px / cpx;
    const w = Math.ceil(this.win.innerWidth / cpx), h = Math.ceil(this.win.innerHeight / cpx);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w * cpx}px`;
    this.canvas.style.height = `${h * cpx}px`;
    this.ctx2d.imageSmoothingEnabled = false;
  }

  private tick = (t: number) => {
    this.raf = this.win.requestAnimationFrame(this.tick);
    if (this.win.document.hidden) { this.last = t; return; }
    const dt = Math.min(0.1, Math.max(0, (t - this.last) / 1000));
    this.last = t;

    // A sleeping gecko with nothing around only needs a few frames a second, and on
    // battery-powered devices the frame rate is capped.
    const quiet = this.brain.state === STATE.SLEEP && !this.swarm.bugs.length && !this.particles.active && !this.prints.active;
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
    c.pal = this.pal;

    const drive = this.brain.update();
    this.body.update(TICK, drive);
    // Once it is all the way out from under a panel, it is back on top of things.
    if (this.body.under && this.brain.state !== STATE.HIDE && !this.body.pts.some((p) => this.world.coverAt(p.x, p.y))) this.body.under = false;

    this.comeBack();
    if (!this.brain.entering && !this.offPage) {
      const n = this.body.neck;
      const k = this.world.clampToBounds(n.x, n.y, 3);
      n.x = k.x; n.y = k.y;
    }

    this.swarm.update(TICK, this.world, this.body.head);
    this.particles.update(TICK);
    this.react();
    this.reactions.update(TICK);
    // Whatever it is touching shows its hover effect.
    if (HOVER && --this.hoverIn <= 0) {
      this.hoverIn = 4;
      const b = this.body, px = this.opts.px;
      if (b.under || b.isHeld || this.opts.reducedMotion) this.hover.clear();
      else {
        const pts = [b.pts[2], b.pts[10], b.pts[17]].map((p, i) => b.project(p.x, p.y, b.z[[2, 10, 17][i]]));
        for (const l of b.legs) pts.push(b.project(l.foot.x, l.foot.y, b.footZ(l)));
        this.hover.touch(pts.map((p) => ({ x: p.x * px, y: p.y * px })));
      }
    }
  }

  private render() {
    const g = this.ctx2d;
    this.frame++;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const pal = this.pal;
    const res = this.res;
    this.prints.draw(g, res, performance.now());
    for (const b of this.swarm.bugs) if (b.z < 1) b.draw(g, pal, this.frame, res);
    // Side panels lie over the note: whatever part of the gecko has crept under one is hidden.
    const covers = this.body.under ? this.world.covers : [];
    // Scrolled off the edge of the page: only what is still on it shows.
    const page = this.offPage;
    if (page) {
      g.save();
      g.beginPath();
      g.rect(Math.round((page.left / this.opts.px) * res), Math.round((page.top / this.opts.px) * res), Math.round((page.width / this.opts.px) * res), Math.round((page.height / this.opts.px) * res));
      g.clip();
    }
    if (covers.length) {
      g.save();
      g.beginPath();
      g.rect(0, 0, this.canvas.width, this.canvas.height);
      for (const c of covers) g.rect(Math.round(c.x * res), Math.round(c.y * res), Math.round(c.w * res), Math.round(c.h * res));
      g.clip('evenodd');
    }
    this.renderer.tilt = this.brain.napTilt;
    this.renderer.draw(g, this.body, pal, res);
    const zFrom = { x: this.renderer.headAt.x / res, y: this.renderer.headAt.y / res };
    // Fast asleep: Z's.
    this.zzz.draw(pal, this.brain.dozing ? { x: zFrom.x * this.opts.px, y: zFrom.y * this.opts.px } : null, performance.now());
    if (this.brain.carrying) {
      const s = this.brain.snout(), px = this.opts.px;
      this.reactions.hold((s.x + 0.5) * px, (s.y + 0.5) * px, this.body.headAngle);
    }
    this.reactions.draw(this.nibbler.ghosts(performance.now()));
    if (covers.length) g.restore();
    if (page) g.restore();
    for (const b of this.swarm.bugs) if (b.z >= 1) b.draw(g, pal, this.frame, res);
    this.particles.draw(g, res);

    if (this.opts.debug) {
      g.save();
      g.scale(res, res);
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
      g.restore();
    }
  }
}

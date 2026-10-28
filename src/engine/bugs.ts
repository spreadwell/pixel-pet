import type { World } from './world';
import type { Palette } from './palette';
import { TAU, angleDiff, chance, clamp, noise1, rand } from './math';

export type BugKind = 'fly' | 'cricket';
type BugState = 'flying' | 'landed' | 'hopping' | 'resting' | 'leaving';

export class Bug {
  x: number; y: number;
  z = 0;               // height above the page, drives the shadow
  heading: number;
  speed = 0;
  state: BugState;
  timer = 0;
  age = 0;
  life = rand(50, 100);
  alive = true;
  seed = Math.floor(rand(0, 1e5));
  /** Hop endpoints (crickets). */
  private hop = { x0: 0, y0: 0, x1: 0, y1: 0, t: 0, dur: 0.3 };
  private aim: { x: number; y: number };

  constructor(readonly kind: BugKind, x: number, y: number, aim: { x: number; y: number }) {
    this.x = x; this.y = y;
    this.aim = aim;
    this.heading = Math.atan2(aim.y - y, aim.x - x);
    this.state = kind === 'fly' ? 'flying' : 'resting';
    this.z = kind === 'fly' ? 8 : 0;
    this.timer = kind === 'fly' ? rand(2, 4) : 0.2;
  }

  /** On the page (a cricket, or a fly that has landed): it scrolls with the page. */
  get onPage() { return this.kind === 'cricket' || this.state === 'landed'; }

  /** The page under it moved by (dx, dy) art px: it, and where it is headed, move too. */
  shift(dx: number, dy: number) {
    this.x += dx; this.y += dy;
    this.aim.x += dx; this.aim.y += dy;
    const h = this.hop;
    h.x0 += dx; h.y0 += dy; h.x1 += dx; h.y1 += dy;
  }

  /** Grounded and still: the only time a gecko commits to a strike. */
  get catchable() { return this.alive && this.z < 0.5 && (this.state === 'landed' || this.state === 'resting'); }

  startle(fromX: number, fromY: number) {
    if (!this.alive) return;
    const away = Math.atan2(this.y - fromY, this.x - fromX);
    if (this.kind === 'fly') {
      this.state = 'flying';
      this.heading = away + rand(-0.4, 0.4);
      this.speed = 95;
      this.timer = rand(2.5, 5);
      this.aim = { x: this.x + Math.cos(this.heading) * 120, y: this.y + Math.sin(this.heading) * 120 };
    } else {
      this.beginHop(away + rand(-0.5, 0.5), rand(22, 34));
    }
  }

  private beginHop(dir: number, dist: number) {
    this.state = 'hopping';
    this.heading = dir;
    this.hop = { x0: this.x, y0: this.y, x1: this.x + Math.cos(dir) * dist, y1: this.y + Math.sin(dir) * dist, t: 0, dur: 0.22 + dist * 0.006 };
  }

  /** Set by the swarm each frame: how close the nearest predator is. */
  threat = Infinity;
  /** Has flown into the window; from then on it stays inside until it leaves for good. */
  private inside = false;

  update(dt: number, world: World) {
    this.age += dt;
    // Crickets freeze when something is stalking them close by.
    this.timer -= this.kind === 'cricket' && this.threat < 45 && this.state === 'resting' ? dt * 0.25 : dt;
    const b = world.bounds;
    if (this.age > this.life && this.state !== 'leaving') {
      this.state = 'leaving';
      const cx = this.x < b.w / 2 ? -30 : b.w + 30;
      this.aim = { x: cx, y: this.y + rand(-60, 60) };
      if (this.kind === 'cricket') this.beginHop(Math.atan2(this.aim.y - this.y, this.aim.x - this.x), 26);
    }

    if (this.kind === 'fly') this.updateFly(dt, world);
    else this.updateCricket(dt, world);

    if (this.x < -40 || this.y < -40 || this.x > b.w + 40 || this.y > b.h + 40) this.alive = false;
  }

  private updateFly(dt: number, world: World) {
    const b = world.bounds;
    if (this.state === 'landed') {
      this.z = Math.max(0, this.z - dt * 30);
      if (this.timer <= 0) {
        this.state = 'flying';
        this.timer = rand(2, 5);
        this.aim = world.clampToBounds(this.x + rand(-140, 140), this.y + rand(-90, 90), 10);
      }
      return;
    }
    // Erratic flight: smooth noise on heading, a pull toward the aim point.
    const toAim = Math.atan2(this.aim.y - this.y, this.aim.x - this.x);
    const wobble = noise1(this.age * 2.3, this.seed) * 2.4;
    this.heading += angleDiff(this.heading, toAim + wobble) * clamp(dt * 3.2, 0, 1);
    const cruise = this.state === 'leaving' ? 70 : 42 + noise1(this.age * 1.1, this.seed + 3) * 14;
    this.speed += (cruise - this.speed) * clamp(dt * 2, 0, 1);
    this.x += Math.cos(this.heading) * this.speed * dt;
    this.y += Math.sin(this.heading) * this.speed * dt;
    const targetZ = this.timer < 0.6 && this.state !== 'leaving' ? 0 : 7 + noise1(this.age * 3, this.seed + 9) * 2;
    this.z += (targetZ - this.z) * clamp(dt * 4, 0, 1);

    if (this.state === 'flying') {
      if (world.inBounds(this.x, this.y, 4)) this.inside = true;
      if (Math.hypot(this.aim.x - this.x, this.aim.y - this.y) < 12) this.aim = world.clampToBounds(this.x + rand(-120, 120), this.y + rand(-80, 80), 10);
      // Once in, it bounces off the window's edges and can't leave; flying in, it heads
      // straight for its aim (bouncing then would keep it stuck outside).
      if (this.inside) {
        if (this.x < b.x + 4 || this.x > b.x + b.w - 4) this.heading = Math.PI - this.heading;
        if (this.y < b.y + 4 || this.y > b.y + b.h - 4) this.heading = -this.heading;
        const q = world.clampToBounds(this.x, this.y, 3); this.x = q.x; this.y = q.y;
      } else this.heading = Math.atan2(this.aim.y - this.y, this.aim.x - this.x);
      if (this.timer <= 0 && this.z < 0.8) {
        this.state = 'landed';
        this.timer = rand(1.5, 5.5);
        this.speed = 0;
      }
    }
  }

  private updateCricket(dt: number, world: World) {
    if (this.state === 'hopping') {
      const h = this.hop;
      h.t = Math.min(1, h.t + dt / h.dur);
      this.x = h.x0 + (h.x1 - h.x0) * h.t;
      this.y = h.y0 + (h.y1 - h.y0) * h.t;
      this.z = Math.sin(h.t * Math.PI) * (4 + Math.hypot(h.x1 - h.x0, h.y1 - h.y0) * 0.12);
      if (h.t >= 1) {
        this.z = 0;
        if (this.state === 'hopping') {
          this.state = this.age > this.life ? 'leaving' : 'resting';
          this.timer = rand(1.5, 5);
        }
      }
      return;
    }
    if (this.state === 'leaving') {
      if (this.timer <= 0) { this.beginHop(Math.atan2(this.aim.y - this.y, this.aim.x - this.x), 28); this.state = 'hopping'; this.life = 0; }
      return;
    }
    // Resting: antennae work, then a hop, usually toward where it was heading.
    if (this.timer <= 0) {
      const toAim = Math.atan2(this.aim.y - this.y, this.aim.x - this.x);
      const dist = Math.hypot(this.aim.x - this.x, this.aim.y - this.y);
      if (dist < 20) this.aim = world.clampToBounds(this.x + rand(-100, 100), this.y + rand(-70, 70), 10);
      const dir = toAim + rand(-0.9, 0.9);
      const p = world.clampToBounds(this.x + Math.cos(dir) * 20, this.y + Math.sin(dir) * 20, 8);
      this.beginHop(Math.atan2(p.y - this.y, p.x - this.x), rand(10, 22));
    }
  }

  /** Draw in grid cells: `k` converts world units to cells (ctx is scaled to cells). */
  draw(ctx: CanvasRenderingContext2D, pal: Palette, frame: number, k = 1) {
    const x = this.x, y = this.y;
    const fx = Math.cos(this.heading), fy = Math.sin(this.heading);
    // On a finer canvas (k > 1) each art pixel still covers its full scaled size, so the bug looks the same.
    const s = Math.ceil(k);
    const px = (ax: number, ay: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(Math.floor(ax * k), Math.floor(ay * k), s, s); };
    const so = 1 + this.z * 0.7;
    ctx.globalAlpha = clamp(1 - this.z / 14, 0.35, 1);
    px(this.x + so, this.y + so, pal.shadow);
    if (this.kind === 'cricket') px(this.x - fx * 2 + so, this.y - fy * 2 + so, pal.shadow);
    ctx.globalAlpha = 1;

    if (this.kind === 'fly') {
      px(x, y, pal.ink);
      px(this.x - fx * 1.2, this.y - fy * 1.2, pal.ink);
      const flying = this.z > 0.5;
      if (!flying || frame % 2 === 0) {
        const spread = flying ? 1.4 : 0.7;
        px(this.x - fx * 1.4 - fy * spread, this.y - fy * 1.4 + fx * spread, pal.wing);
        px(this.x - fx * 1.4 + fy * spread, this.y - fy * 1.4 - fx * spread, pal.wing);
      }
    } else {
      for (let k = 0; k < 3; k++) px(this.x - fx * k, this.y - fy * k, k === 0 ? pal.cricketDark : pal.cricket);
      // Big hind legs folded along the abdomen.
      px(this.x - fx * 2 - fy * 1.2, this.y - fy * 2 + fx * 1.2, pal.cricketDark);
      px(this.x - fx * 2 + fy * 1.2, this.y - fy * 2 - fx * 1.2, pal.cricketDark);
      // Antennae sweep.
      const w = Math.sin(this.age * 9 + this.seed) * 0.5;
      for (const s of [1, -1]) {
        const a = this.heading + s * (0.45 + w * s);
        px(this.x + Math.cos(a) * 2.2, this.y + Math.sin(a) * 2.2, pal.cricketDark);
      }
    }
  }
}

export class Swarm {
  bugs: Bug[] = [];
  max = 4;

  spawn(kind: BugKind, world: World, near?: { x: number; y: number }) {
    if (this.bugs.filter((b) => b.alive).length >= this.max) return null;
    const b = world.bounds;
    const aim = near ? world.clampToBounds(near.x + rand(-60, 60), near.y + rand(-40, 40), 12) : world.clampToBounds(b.x + rand(0.2, 0.8) * b.w, b.y + rand(0.2, 0.8) * b.h);
    let x: number, y: number;
    if (kind === 'fly') {
      // Flies drift in from a window edge, the one nearest where they are headed.
      const gaps = [aim.x - b.x, b.x + b.w - aim.x, aim.y - b.y, b.y + b.h - aim.y];
      const side = chance(0.7) ? gaps.indexOf(Math.min(...gaps)) : Math.floor(rand(0, 4));
      x = side === 0 ? b.x - 6 : side === 1 ? b.x + b.w + 6 : b.x + rand(0.1, 0.9) * b.w;
      y = side === 2 ? b.y - 6 : side === 3 ? b.y + b.h + 6 : b.y + rand(0.1, 0.9) * b.h;
    } else {
      // Crickets come out from a seam close to where they are headed.
      let best: { x: number; y: number } | null = null, bd = Infinity;
      for (let i = 0; i < 40 && world.edges.length; i++) {
        const e = world.edges[Math.floor(Math.random() * world.edges.length)], u = Math.random();
        const p = { x: e.x1 + (e.x2 - e.x1) * u, y: e.y1 + (e.y2 - e.y1) * u };
        const d = Math.hypot(p.x - aim.x, p.y - aim.y);
        if (d < bd && world.inBounds(p.x, p.y, 6)) { bd = d; best = p; }
      }
      x = best && bd < 120 ? best.x : aim.x;
      y = best && bd < 120 ? best.y : aim.y;
    }
    const bug = new Bug(kind, x, y, aim);
    this.bugs.push(bug);
    return bug;
  }

  update(dt: number, world: World, predator?: { x: number; y: number }) {
    for (const b of this.bugs) {
      b.threat = predator ? Math.hypot(b.x - predator.x, b.y - predator.y) : Infinity;
      b.update(dt, world);
    }
    this.bugs = this.bugs.filter((b) => b.alive);
  }

  draw(ctx: CanvasRenderingContext2D, pal: Palette, frame: number, k = 1) {
    for (const b of this.bugs) b.draw(ctx, pal, frame, k);
  }

  nearest(x: number, y: number, maxDist: number): Bug | null {
    let best: Bug | null = null, bd = maxDist;
    for (const b of this.bugs) {
      if (!b.alive || b.state === 'leaving') continue;
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
}

export class Particles {
  private ps: { x: number; y: number; vx: number; vy: number; life: number; max: number; c: string }[] = [];

  burst(x: number, y: number, c: string, n: number, speed = 18) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), s = rand(0.3, 1) * speed;
      this.ps.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: rand(0.8, 2.2), c });
    }
  }

  get active() { return this.ps.length > 0; }

  update(dt: number) {
    for (const p of this.ps) {
      p.life += dt;
      const drag = Math.exp(-dt * 7);
      p.vx *= drag; p.vy *= drag;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    this.ps = this.ps.filter((p) => p.life < p.max);
  }

  draw(ctx: CanvasRenderingContext2D, k = 1) {
    for (const p of this.ps) {
      ctx.globalAlpha = clamp(1 - p.life / p.max, 0, 1) * (chance(0.97) ? 1 : 0.5);
      ctx.fillStyle = p.c;
      ctx.fillRect(Math.floor(p.x * k), Math.floor(p.y * k), Math.ceil(k), Math.ceil(k));
    }
    ctx.globalAlpha = 1;
  }
}

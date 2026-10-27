import { Body, Drive, TORSO_LAST, halfWidth } from './body';
import type { Bug, Particles, Swarm } from './bugs';
import type { InputTracker } from './input';
import { angleDiff, chance, clamp, rand } from './math';
import type { NibbleTarget, Nibbler } from './nibble';
import type { Palette } from './palette';
import type { Goal, World } from './world';

/*
 * Behaviour. Each behaviour is a small state machine that turns what the gecko senses
 * into a Drive for the body. The Brain arbitrates: interrupts (startle, sleep, prey,
 * curiosity) pre-empt lower-priority behaviours, and an idle behaviour (explore or rest)
 * is chosen whenever one finishes. Movement is deliberately intermittent — short bursts
 * separated by still, watchful pauses — because that is how lizards actually move.
 */

export interface BrainOptions {
  nibble: boolean;
  sleepAfterMs: number;
  reducedMotion: boolean;
}

export interface Ctx {
  body: Body;
  world: World;
  input: InputTracker;
  swarm: Swarm;
  nibbler: Nibbler;
  particles: Particles;
  pal: Palette;
  opts: BrainOptions;
  now: number;
  /** Pointer in art px, or null. */
  pointer: { x: number; y: number } | null;
  /** Pointer speed in art px / s. */
  pointerSpeed: number;
}

const still = (b: Body, look: number | null = null): Drive => ({ heading: b.heading, speed: 0, accel: 160, turnRate: 3, look });

function toward(b: Body, x: number, y: number, speed: number, opts: { accel?: number; turnRate?: number; arrive?: number; look?: number | null } = {}): Drive & { dist: number } {
  const n = b.neck, h = b.head;
  const dist = Math.hypot(x - h.x, y - h.y);
  const arrive = opts.arrive ?? 10;
  return {
    heading: Math.atan2(y - n.y, x - n.x),
    speed: speed * clamp(dist / arrive, 0.3, 1),
    accel: opts.accel ?? 140,
    turnRate: opts.turnRate ?? 4.2,
    look: opts.look === undefined ? null : opts.look,
    dist,
  };
}

const angleTo = (b: Body, x: number, y: number) => Math.atan2(y - b.neck.y, x - b.neck.x);

abstract class Behaviour {
  abstract readonly name: string;
  t = 0;
  /** Return a Drive, or null when finished. */
  abstract step(dt: number, c: Ctx): Drive | null;
  exit(b: Body) {
    b.tailTwitch = 0;
    b.mouthTarget = 0;
    b.lidTarget = 0;
    b.curlTarget = 0;
    b.breathRate = 0.55;
    b.breathDepth = 0.05;
  }
}

/** Bursty locomotion toward a goal, with look-around pauses. */
class Mover {
  private running = true;
  private timer = rand(0.5, 1.4);
  private cruise = rand(18, 34);
  private lookAt: number | null = null;
  private lookTimer = 0;

  constructor(private reduced: boolean, private speedRange: [number, number] = [18, 34], private runRange: [number, number] = [0.45, 1.5], private pauseRange: [number, number] = [0.25, 1.6]) {
    this.cruise = rand(...speedRange);
    this.timer = rand(...runRange);
  }

  step(dt: number, c: Ctx, x: number, y: number, arrive = 10): (Drive & { dist: number }) {
    const b = c.body;
    this.timer -= dt;
    if (this.running) {
      if (this.timer <= 0) {
        this.running = false;
        this.timer = rand(...this.pauseRange) * (this.reduced ? 1.4 : 1);
        this.lookTimer = 0;
        if (chance(0.18)) b.flickTongue();
      }
      const d = toward(b, x, y, this.cruise * (this.reduced ? 0.7 : 1), { arrive });
      return d;
    }
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = rand(0.35, 1.1);
      this.lookAt = chance(0.45) ? angleTo(b, x, y) : b.heading + rand(-0.9, 0.9);
    }
    if (this.timer <= 0) {
      this.running = true;
      this.timer = rand(...this.runRange);
      this.cruise = rand(...this.speedRange);
    }
    return { ...still(b, this.lookAt), dist: Math.hypot(x - b.head.x, y - b.head.y) };
  }
}

class Explore extends Behaviour {
  readonly name: string = 'explore';
  goal: Goal;
  private mover: Mover;
  constructor(c: Ctx, prev: Goal | null) {
    super();
    const typing = c.input.typedWithin(c.now, 5000);
    this.goal = c.world.pickGoal(c.body.neck.x, c.body.neck.y, prev, typing ? 45 : 0);
    this.mover = new Mover(c.opts.reducedMotion);
  }
  step(dt: number, c: Ctx) {
    this.t += dt;
    const d = this.mover.step(dt, c, this.goal.x, this.goal.y, 8);
    if (d.dist < 5 || this.t > 25) return null;
    return d;
  }
}

class Enter extends Explore {
  readonly name = 'enter';
  constructor(c: Ctx) {
    super(c, null);
    this.goal = { x: rand(30, 60), y: c.body.neck.y };
  }
}

class Rest extends Behaviour {
  readonly name = 'rest';
  private dur = rand(3, 11);
  private look: number | null = null;
  private lookTimer = rand(0.5, 2);
  step(dt: number, c: Ctx) {
    this.t += dt;
    const b = c.body;
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = rand(0.8, 3);
      this.look = chance(0.3) ? null : b.heading + rand(-1, 1);
      if (chance(0.12)) b.flickTongue(chance(0.5) ? 'lick' : 'flick');
    }
    return this.t > this.dur ? null : still(b, this.look);
  }
}

class Startle extends Behaviour {
  readonly name = 'startle';
  private goal: Goal;
  private phase: 'dash' | 'freeze' = 'dash';
  private freeze = rand(0.9, 2.6);
  constructor(c: Ctx, private threat: { x: number; y: number }, private mild: boolean) {
    super();
    const n = c.body.neck;
    if (mild) {
      const a = Math.atan2(n.y - threat.y, n.x - threat.x) + rand(-0.5, 0.5);
      this.goal = c.world.clampToBounds(n.x + Math.cos(a) * rand(28, 45), n.y + Math.sin(a) * rand(28, 45));
    } else {
      this.goal = c.world.pickEscape(n.x, n.y, threat.x, threat.y);
    }
  }
  step(dt: number, c: Ctx) {
    this.t += dt;
    const b = c.body;
    if (this.phase === 'dash') {
      const fast = this.mild || c.opts.reducedMotion ? 42 : rand(88, 104);
      const d = toward(b, this.goal.x, this.goal.y, fast, { accel: this.mild ? 260 : 900, turnRate: 11, arrive: 6 });
      if (d.dist < 5 || this.t > 1.6) { this.phase = 'freeze'; this.t = 0; b.tailTwitch = 0.35; }
      return d;
    }
    if (this.t > 0.5) b.tailTwitch = 0;
    if (this.t > this.freeze) return null;
    return still(b, angleTo(b, this.threat.x, this.threat.y));
  }
}

class Hunt extends Behaviour {
  readonly name = 'hunt';
  private phase: 'notice' | 'stalk' | 'fixate' | 'lunge' | 'chew' | 'miss' = 'notice';
  private phaseT = 0;
  private hold = rand(0.25, 0.6);
  private mover: Mover;
  private closer: Mover;
  private chewFlip = 0;
  constructor(c: Ctx, private bug: Bug) {
    super();
    // Close the distance briskly, then creep for the last stretch.
    this.closer = new Mover(c.opts.reducedMotion, [26, 38], [0.6, 1.3], [0.12, 0.35]);
    this.mover = new Mover(c.opts.reducedMotion, [10, 15], [0.3, 0.7], [0.2, 0.55]);
  }
  private go(p: Hunt['phase']) { this.phase = p; this.phaseT = 0; }
  step(dt: number, c: Ctx) {
    this.t += dt;
    this.phaseT += dt;
    const b = c.body, bug = this.bug;
    const look = angleTo(b, bug.x, bug.y);
    const dist = Math.hypot(bug.x - b.head.x, bug.y - b.head.y);

    if (this.phase !== 'chew' && (!bug.alive || bug.state === 'leaving' || dist > 220 || this.t > 40)) return null;

    switch (this.phase) {
      case 'notice':
        if (this.phaseT > this.hold) this.go('stalk');
        return still(b, look);
      case 'stalk': {
        if (!bug.catchable) {
          // Track a flying insect with the head; only reposition if it drifts far.
          return dist > 70 ? this.closer.step(dt, c, bug.x, bug.y, 20) : still(b, look);
        }
        if (dist < 15) { this.go('fixate'); this.hold = rand(0.5, 1.5); b.tailTwitch = 1; return still(b, look); }
        const d = dist > 40 ? this.closer.step(dt, c, bug.x, bug.y, 30) : this.mover.step(dt, c, bug.x, bug.y, 14);
        return { ...d, look };
      }
      case 'fixate':
        if (!bug.catchable) { b.tailTwitch = 0; this.go('stalk'); return still(b, look); }
        if (this.phaseT > this.hold) { b.tailTwitch = 0; this.go('lunge'); }
        return still(b, look);
      case 'lunge': {
        const d = toward(b, bug.x, bug.y, c.opts.reducedMotion ? 40 : 140, { accel: c.opts.reducedMotion ? 300 : 1800, turnRate: 14, arrive: 2, look });
        if (dist < 7) b.mouthTarget = 1;
        if (dist < 3.2) {
          if (bug.catchable && chance(0.8)) {
            bug.alive = false;
            c.particles.burst(bug.x, bug.y, c.pal.wing, 2, 8);
            this.go('chew');
            this.chewFlip = 0;
          } else {
            bug.startle(b.head.x, b.head.y);
            b.mouthTarget = 0;
            this.go('miss');
          }
          return still(b, look);
        }
        if (this.phaseT > 0.35) { bug.startle(b.head.x, b.head.y); b.mouthTarget = 0; this.go('miss'); }
        return d;
      }
      case 'miss':
        if (this.phaseT > rand(0.8, 1.6)) { this.go('notice'); this.hold = 0.3; }
        return still(b, look);
      case 'chew':
        this.chewFlip += dt;
        b.mouthTarget = this.phaseT < 1.3 && Math.floor(this.chewFlip * 5) % 2 === 0 ? 0.6 : 0;
        if (this.phaseT > 1.4 && this.phaseT < 1.45 && chance(0.7)) b.flickTongue('lick');
        if (this.phaseT > 2.2) return null;
        return still(b, b.heading + Math.sin(this.phaseT * 14) * 0.08);
    }
  }
}

class Curious extends Behaviour {
  readonly name = 'curious';
  private mover: Mover;
  private gone = 0;
  private dur = rand(6, 14);
  private flick = rand(1, 3);
  constructor(c: Ctx) {
    super();
    this.mover = new Mover(c.opts.reducedMotion, [12, 20], [0.3, 0.8], [0.4, 1.2]);
  }
  step(dt: number, c: Ctx) {
    this.t += dt;
    const b = c.body, p = c.pointer;
    if (!p) { this.gone += dt; return this.gone > 1 ? null : still(b); }
    this.gone = 0;
    const look = angleTo(b, p.x, p.y);
    const dist = Math.hypot(p.x - b.head.x, p.y - b.head.y);
    if (this.t > this.dur || dist > 110) return null;
    this.flick -= dt;
    if (this.flick <= 0) { this.flick = rand(1.5, 4); b.flickTongue(); }
    if (dist > 22) return { ...this.mover.step(dt, c, p.x, p.y, 16), look };
    // Close enough: turn the body if the pointer is out of the neck's reach.
    if (Math.abs(angleDiff(b.heading, look)) > 1.1) return { ...still(b, look), heading: look, speed: 5 };
    return still(b, look);
  }
}

class Nibble extends Behaviour {
  readonly name = 'nibble';
  private phase: 'approach' | 'taste' | 'bite' | 'chew' | 'back' = 'approach';
  private phaseT = 0;
  private mover: Mover;
  private target: { x: number; y: number };
  private relocate = 0;
  constructor(c: Ctx, private letter: NibbleTarget) {
    super();
    this.mover = new Mover(c.opts.reducedMotion, [16, 26], [0.5, 1.3], [0.3, 1.0]);
    this.target = { x: letter.x / c.world.px, y: letter.y / c.world.px };
  }
  private go(p: Nibble['phase']) { this.phase = p; this.phaseT = 0; }
  step(dt: number, c: Ctx) {
    this.t += dt;
    this.phaseT += dt;
    const b = c.body;
    if (this.phase === 'approach' || this.phase === 'taste') {
      if (c.input.typedWithin(c.now, 900) || this.t > 30) return null;
      this.relocate -= dt;
      if (this.relocate <= 0) {
        this.relocate = 0.4;
        const at = c.nibbler.locate(this.letter);
        if (!at) return null;
        this.target = { x: at.x / c.world.px, y: at.y / c.world.px };
      }
    }
    const { x, y } = this.target;
    const look = angleTo(b, x, y);
    switch (this.phase) {
      case 'approach': {
        const d = this.mover.step(dt, c, x, y, 10);
        if (d.dist < 2.6) this.go('taste');
        return d;
      }
      case 'taste':
        if (this.phaseT > 0.15 && this.phaseT < 0.2) b.flickTongue();
        if (this.phaseT > 0.75 && this.phaseT < 0.8 && chance(0.6)) b.flickTongue();
        if (this.phaseT > 1.3) { this.go('bite'); b.mouthTarget = 1; }
        return still(b, look);
      case 'bite':
        if (this.phaseT > 0.12) {
          b.mouthTarget = 0;
          if (c.nibbler.bite(this.letter)) c.particles.burst(x, y, c.pal.ink, 4, 14);
          this.go('chew');
        }
        return still(b, look);
      case 'chew':
        b.mouthTarget = Math.floor(this.phaseT * 5) % 2 === 0 ? 0.5 : 0;
        if (this.phaseT > 1.1) { b.mouthTarget = 0; this.go('back'); }
        return still(b, b.heading + Math.sin(this.phaseT * 13) * 0.07);
      case 'back': {
        if (this.phaseT > 0.7) return null;
        const a = b.heading + Math.PI * 0.8;
        return { heading: a, speed: 10, accel: 80, turnRate: 3, look: null };
      }
    }
  }
}

class Sleep extends Behaviour {
  readonly name = 'sleep';
  private phase: 'settle' | 'doze' | 'wake' = 'settle';
  private phaseT = 0;
  private spot: { x: number; y: number };
  private mover: Mover;
  constructor(c: Ctx) {
    super();
    const n = c.body.neck;
    const s = c.world.pickSleepSpot(n.x, n.y);
    this.spot = Math.hypot(s.x - n.x, s.y - n.y) < 160 ? s : { x: n.x, y: n.y };
    this.mover = new Mover(c.opts.reducedMotion, [10, 16], [0.6, 1.4], [0.6, 1.5]);
    c.body.curlDir = chance(0.5) ? 1 : -1;
  }
  get awake() { return this.phase === 'wake'; }
  step(dt: number, c: Ctx) {
    this.phaseT += dt;
    const b = c.body;
    const active = c.input.idleFor(c.now) < 1500;
    if (active && this.phase !== 'wake') { this.phase = 'wake'; this.phaseT = 0; }
    switch (this.phase) {
      case 'settle': {
        const d = this.mover.step(dt, c, this.spot.x, this.spot.y, 8);
        if (d.dist < 6 || this.phaseT > 20) { this.phase = 'doze'; this.phaseT = 0; }
        return d;
      }
      case 'doze':
        b.curlTarget = 1;
        b.lidTarget = this.phaseT < 2.5 ? 0.6 : 1;
        b.breathRate = 0.22;
        b.breathDepth = 0.085;
        return still(b);
      case 'wake':
        b.lidTarget = 0;
        b.curlTarget = this.phaseT > 0.5 ? 0 : b.curlTarget;
        b.breathRate = 0.55;
        b.breathDepth = 0.05;
        if (this.phaseT > 2.2) return null;
        return still(b, this.phaseT > 0.8 ? b.heading + Math.sin(this.phaseT * 2) * 0.8 : null);
    }
  }
}

export class Brain {
  current: Behaviour;
  private lastGoal: Goal | null = null;
  private huntCooldown = 0;
  private curiousCooldown = rand(3, 8);
  private nextNibble = 0;
  private petT = 0;
  petted = false;

  constructor(private c: Ctx, entering: boolean) {
    this.current = entering ? new Enter(c) : new Rest();
    this.nextNibble = c.now + rand(60, 120) * 1000;
  }

  get state() { return this.current.name + (this.petted ? '+petted' : ''); }

  private set(b: Behaviour) {
    this.current.exit(this.c.body);
    if (this.current instanceof Explore) this.lastGoal = this.current.goal;
    this.current = b;
  }

  /** Nearest distance from (x, y) to the torso/head spine, minus the body width. */
  private bodyDist(x: number, y: number) {
    const b = this.c.body;
    let best = Infinity;
    for (let i = 0; i <= TORSO_LAST + 4; i += 2) {
      const p = b.pts[i];
      best = Math.min(best, Math.hypot(p.x - x, p.y - y) - halfWidth(i));
    }
    return best;
  }

  startle(threat: { x: number; y: number }, mild = false) {
    if (this.current instanceof Startle && !mild) return;
    this.petT = 0;
    this.petted = false;
    this.set(new Startle(this.c, threat, mild));
  }

  summon(target: { x: number; y: number }) {
    this.set(new Explore(this.c, null));
    (this.current as Explore).goal = { x: target.x, y: target.y };
  }

  hunt(bug: Bug) { this.set(new Hunt(this.c, bug)); }

  update(dt: number): Drive {
    const c = this.c;
    const b = c.body;
    const cur = this.current;
    const name = cur.name;
    const asleep = cur instanceof Sleep && !cur.awake;
    this.huntCooldown -= dt;
    this.curiousCooldown -= dt;

    // ── Interrupts ───────────────────────────────────────────
    const presses = c.input.presses.splice(0);
    for (const p of presses) {
      const pa = { x: p.x / c.world.px, y: p.y / c.world.px };
      const d = this.bodyDist(pa.x, pa.y);
      for (const bug of c.swarm.bugs) if (Math.hypot(bug.x - pa.x, bug.y - pa.y) < 6) bug.startle(pa.x, pa.y);
      if (d < 5) { this.startle(pa); break; }
      // A tap nearby is an invitation: come and investigate the spot.
      const calmNow = this.current instanceof Explore || this.current instanceof Rest || this.current instanceof Curious;
      if (p.tap && d < 90 && calmNow && !asleep) { this.curiousCooldown = rand(4, 8); this.set(new Curious(c)); }
    }

    if (c.pointer && name !== 'startle') {
      const v = c.input.velocity(c.now);
      const dx = b.neck.x - c.pointer.x, dy = b.neck.y - c.pointer.y;
      const d = Math.hypot(dx, dy) || 1;
      const closing = (v.x * dx + v.y * dy) / d / c.world.px;
      if (d < 38 && closing > (asleep ? 320 : 230)) this.startle(c.pointer);
    }

    if (c.world.shifts.length) {
      const n = b.neck;
      for (const s of c.world.shifts) {
        if (n.x > s.x - 10 && n.x < s.x + s.w + 10 && n.y > s.y - 10 && n.y < s.y + s.h + 10) {
          // Startle away from the moving edge closest to us.
          const ex = n.x - s.x < s.x + s.w - n.x ? s.x : s.x + s.w;
          this.startle({ x: ex, y: n.y }, !!c.opts.reducedMotion);
          break;
        }
      }
      c.world.shifts.length = 0;
    }

    if (this.current.name !== 'startle' && c.input.typedWithin(c.now, 1200) && c.world.caret) {
      const k = c.world.caret;
      if (this.bodyDist(k.x, k.y) < 14) this.startle(k, true);
    }

    const now = this.current;
    const idle = now instanceof Explore || now instanceof Rest;
    if (!(now instanceof Sleep) && !(now instanceof Startle) && c.input.idleFor(c.now) > c.opts.sleepAfterMs) {
      this.set(new Sleep(c));
    } else if ((idle || now instanceof Curious || now instanceof Nibble) && this.huntCooldown <= 0) {
      const bug = c.swarm.nearest(b.head.x, b.head.y, 150);
      if (bug) { this.hunt(bug); this.huntCooldown = 2; }
    }

    if (this.current instanceof Explore || this.current instanceof Rest) {
      if (c.pointer && this.curiousCooldown <= 0 && c.pointerSpeed < 110) {
        const d = Math.hypot(c.pointer.x - b.head.x, c.pointer.y - b.head.y);
        if (d < 70 && d > 8) {
          this.curiousCooldown = rand(12, 30);
          if (chance(0.75)) this.set(new Curious(c));
        }
      }
    }

    if (c.opts.nibble && (this.current instanceof Explore || this.current instanceof Rest) && c.now > this.nextNibble && !c.input.typedWithin(c.now, 12000)) {
      this.nextNibble = c.now + rand(120, 300) * 1000;
      const avoid = c.world.caret ? { x: c.world.caret.x * c.world.px, y: c.world.caret.y * c.world.px } : null;
      const t = c.nibbler.count < 3 ? c.nibbler.pickTarget(avoid, 160) : null;
      if (t) this.set(new Nibble(c, t));
    }

    // ── Petting (layered over calm behaviours) ────────────────
    const calm = this.current instanceof Rest || this.current instanceof Curious || this.current instanceof Explore || this.current instanceof Sleep;
    const over = c.pointer && c.pointerSpeed < 140 && this.bodyDist(c.pointer.x, c.pointer.y) < 1.5;
    this.petT = calm ? clamp(this.petT + (over ? dt : -dt * 1.5), 0, 1.2) : 0;
    const wasPetted = this.petted;
    this.petted = calm && this.petT > 0.35;
    if (this.petted && !(this.current instanceof Sleep)) {
      if (!(this.current instanceof Rest)) this.set(new Rest());
      b.lidTarget = 0.5;
      b.breathRate = 0.35;
    } else if (wasPetted && !this.petted && this.current instanceof Rest) {
      b.lidTarget = 0;
      b.breathRate = 0.55;
      if (chance(0.5)) b.flickTongue('lick');
    }

    // ── Run the behaviour ─────────────────────────────────────
    let drive = this.current.step(dt, c);
    if (!drive) {
      const prev = this.current;
      const next = prev instanceof Explore && chance(0.35) ? new Rest() : new Explore(c, this.lastGoal);
      this.set(next);
      drive = this.current.step(dt, c) ?? still(b);
    }
    if (this.petted && !(this.current instanceof Sleep)) drive = { ...drive, speed: 0 };
    return this.avoid(drive);
  }

  /** Bend the travel heading away from the caret and the window edges. */
  private avoid(d: Drive): Drive {
    const c = this.c;
    if (d.speed <= 0 || this.current instanceof Startle || this.current instanceof Hunt || this.current instanceof Nibble) return d;
    let vx = Math.cos(d.heading), vy = Math.sin(d.heading);
    const n = c.body.neck;
    if (c.world.caret && c.input.typedWithin(c.now, 4000)) {
      const dx = n.x - c.world.caret.x, dy = n.y - c.world.caret.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist < 42) { const k = ((42 - dist) / 42) * 2; vx += (dx / dist) * k; vy += (dy / dist) * k; }
    }
    const bd = c.world.bounds, m = 14;
    const l = bd.x + m, r = bd.x + bd.w - m, t = bd.y + m, btm = bd.y + bd.h - m;
    if (n.x < l) vx += (l - n.x) / m;
    if (n.x > r) vx -= (n.x - r) / m;
    if (n.y < t) vy += (t - n.y) / m;
    if (n.y > btm) vy -= (n.y - btm) / m;
    return { ...d, heading: Math.atan2(vy, vx) };
  }
}

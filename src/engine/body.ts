import { TAU, angleDiff, approach, approachAngle, clamp, lerp, noise1, rand } from './math';

/*
 * The physical gecko. Everything here is in art pixels (1 art px = `px` CSS px).
 *
 * The spine is a chain of points with a fixed spacing. The neck point is driven by
 * locomotion; the head is a rigid lever in front of it that can yaw independently, and
 * the body and tail trail behind with a per-joint bend limit (stiffness). A lateral
 * wave is injected at the neck in step with the gait so the trunk undulates the way a
 * sprawling lizard's does, while the head stays stabilised.
 *
 * Gait phase advances with distance travelled, never with time, so planted feet never
 * slide. Diagonal pairs (trot) swing together; a leg that is over-stretched or badly
 * placed after a turn takes a quick corrective step.
 */

export const SPINE = 36;
export const NECK = 4;
/** Spine indices of the shoulder and hip girdles. */
export const SHOULDER = 8;
export const HIP = 17;
const SEG = 1;

const SWING_FRACTION = 0.4;

// Half-width profile, snout → tail tip. Drawn in the style of classic lizard sprites: a
// small blunt head, a pinched neck, a slim trunk a few pixels wide, and a whip tail
// longer than the body that tapers to a single pixel.
const PROFILE = [
  0.8, 1.45, 1.95, 2.05, 1.75,          // head (0-4), widest across the eyes
  1.2, 1.25, 1.45,                      // neck
  1.75, 1.85, 1.9, 1.9, 1.9, 1.85, 1.8, 1.7, 1.6, 1.5,  // shoulders → pelvis
  ...Array.from({ length: SPINE - 18 }, (_, k) => 0.62 + 0.75 * Math.pow(1 - k / (SPINE - 19), 1.1)),
];

/** Standing-wave shape of trunk flexion: girdles out of phase with mid-trunk. */
function flexShape(i: number): number {
  const mid = (SHOULDER + HIP) / 2;
  if (i <= NECK) return 0;
  if (i < SHOULDER) return (-0.5 * (i - NECK)) / (SHOULDER - NECK);
  if (i <= mid) return lerp(-0.5, 1, (i - SHOULDER) / (mid - SHOULDER));
  if (i <= HIP) return lerp(1, -0.8, (i - mid) / (HIP - mid));
  return lerp(-0.8, 0, clamp((i - HIP) / 4, 0, 1));
}

const BEND = (i: number) => (i <= NECK + 1 ? 0.42 : i <= HIP ? 0.22 : i < 26 ? 0.28 : 0.36);

export const halfWidth = (i: number) => PROFILE[Math.min(i, PROFILE.length - 1)];
export const TORSO_FIRST = SHOULDER;
export const TORSO_LAST = HIP - 1;
export const TAIL_FIRST = HIP + 1;

export interface Pt { x: number; y: number; }

interface LegDef {
  seg: number; side: 1 | -1; front: boolean;
  l1: number; l2: number; restFwd: number; restOut: number; phase: number;
}

// Rest spots sit well inside each leg's reach, so a full stride either side of rest
// (±0.3 stride) never over-extends the limb. Strides are long — a lizard covers most
// of its trunk length per cycle — so each foot sweeps visibly from ahead of its girdle
// to well behind it.
const LEGS: LegDef[] = [
  { seg: SHOULDER, side: -1, front: true, l1: 2.6, l2: 2.6, restFwd: 1.0, restOut: 2.5, phase: 0 },
  { seg: SHOULDER, side: 1, front: true, l1: 2.6, l2: 2.6, restFwd: 1.0, restOut: 2.5, phase: 0.5 },
  { seg: HIP, side: -1, front: false, l1: 2.8, l2: 2.8, restFwd: -1.5, restOut: 2.7, phase: 0.5 },
  { seg: HIP, side: 1, front: false, l1: 2.8, l2: 2.8, restFwd: -1.5, restOut: 2.7, phase: 0 },
];
const STRIDE_MIN = 6.5;
const STRIDE_MAX = 8.5;
/** A limb stretched past this fraction of its length looks locked straight. */
const COMFORT = 0.9;
const MAX_STEP_HZ = 8;

export class Leg {
  foot: Pt = { x: 0, y: 0 };
  hip: Pt = { x: 0, y: 0 };
  knee: Pt = { x: 0, y: 0 };
  swinging = false;
  t = 0;
  dur = 0.1;
  from: Pt = { x: 0, y: 0 };
  private cycle = 0;
  /** 0..1 height of a lifted foot, for shadows. */
  lift = 0;

  constructor(readonly def: LegDef) {}

  startSwing(dur: number) {
    this.swinging = true;
    this.t = 0;
    this.dur = dur;
    this.from = { ...this.foot };
  }

  /** Returns true if the gait cycle for this leg rolled over. */
  rolled(gaitPhase: number): boolean {
    const c = Math.floor(gaitPhase + this.def.phase);
    if (c === this.cycle) return false;
    this.cycle = c;
    return true;
  }

  syncCycle(gaitPhase: number) { this.cycle = Math.floor(gaitPhase + this.def.phase); }

  /** `out` is the sideways direction away from the body: the foot swings in an arc. */
  advance(dt: number, target: Pt, out: Pt) {
    if (!this.swinging) { this.lift = 0; return; }
    this.t = Math.min(1, this.t + dt / this.dur);
    const e = this.t < 0.5 ? 2 * this.t * this.t : 1 - 2 * (1 - this.t) * (1 - this.t);
    const arc = Math.sin(this.t * Math.PI) * 0.5;
    this.foot.x = lerp(this.from.x, target.x, e) + out.x * arc;
    this.foot.y = lerp(this.from.y, target.y, e) + out.y * arc;
    this.lift = Math.sin(this.t * Math.PI);
    if (this.t >= 1) { this.swinging = false; this.lift = 0; }
  }
}

export interface Drive {
  heading: number;      // desired travel heading (rad)
  speed: number;        // desired speed (art px / s)
  accel: number;        // art px / s²
  turnRate: number;     // rad / s at low speed
  look: number | null;  // absolute world angle for the head, or null to face forward
}

export type TongueKind = 'flick' | 'lick';

export class Body {
  pts: Pt[] = [];
  heading: number;
  speed = 0;
  headYaw = 0;
  gaitPhase = 0;
  stride = STRIDE_MIN;
  /** Moving faster than the legs can visibly step: planted feet slide instead. */
  private skitter = false;
  legs = LEGS.map((d) => new Leg(d));
  time = rand(0, 100);

  /** 0 open → 1 closed. `lidTarget` is the resting value requested by behaviour. */
  lid = 0;
  lidTarget = 0;
  private blinkTimer = rand(1.5, 4);
  private blinkT = -1;

  mouth = 0;
  mouthTarget = 0;
  tongue: { kind: TongueKind; t: number; side: 1 | -1 } | null = null;

  breath = 0;
  breathRate = 0.55;     // Hz
  breathDepth = 0.05;

  curl = 0;              // 0 straight → 1 coiled (sleep)
  curlTarget = 0;
  curlDir: 1 | -1 = 1;

  tailTwitch = 0;        // amplitude target 0..1
  private twitch = 0;
  private flexAmp = 0;
  /** Path-following spine (without flexion); `pts` is what is drawn. */
  private path: Pt[] = [];

  /** Lateral wiggle of head yaw while idle, for life. */
  private idleSeed = Math.floor(rand(0, 1000));

  constructor(x: number, y: number, heading: number) {
    this.heading = heading;
    const bx = -Math.cos(heading), by = -Math.sin(heading);
    for (let i = 0; i < SPINE; i++) {
      const k = i - NECK;
      this.pts.push({ x: x + bx * k * SEG, y: y + by * k * SEG });
      this.path.push({ x: x + bx * k * SEG, y: y + by * k * SEG });
    }
    this.placeLegs(true);
    for (const leg of this.legs) leg.syncCycle(this.gaitPhase);
  }

  get neck(): Pt { return this.pts[NECK]; }
  get head(): Pt { return this.pts[0]; }
  get headAngle(): number { return this.heading + this.headYaw; }

  /** Forward unit vector of the body at spine index i. */
  forward(i: number): Pt {
    const a = this.pts[Math.max(0, i - 1)];
    const b = this.pts[Math.min(SPINE - 1, i + 1)];
    const dx = a.x - b.x, dy = a.y - b.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  }

  blink() { if (this.blinkT < 0) this.blinkT = 0; }

  flickTongue(kind: TongueKind = 'flick') {
    if (this.tongue) return;
    this.tongue = { kind, t: 0, side: Math.random() < 0.5 ? 1 : -1 };
  }

  update(dt: number, drive: Drive) {
    this.time += dt;

    // ── Locomotion ──────────────────────────────────────────
    const want = Math.max(0, drive.speed);
    const turnErr = angleDiff(this.heading, drive.heading);
    // Lizards pivot with a few short steps rather than spinning on the spot.
    const pivot = want > 0 && Math.abs(turnErr) > 0.9 ? Math.max(want * 0.35, 7) : want;
    const accel = pivot > this.speed ? drive.accel : drive.accel * 1.8;
    this.speed += clamp(pivot - this.speed, -accel * dt, accel * dt);

    const sNorm = clamp(this.speed / 90, 0, 1);
    const maxTurn = drive.turnRate * (1 - 0.55 * sNorm) * (this.speed > 1 ? 1 : 0.35);
    this.heading += clamp(turnErr, -maxTurn * dt, maxTurn * dt);

    const ds = this.speed * dt;
    // Faster means longer strides first (up to what the legs can reach), then quicker ones.
    this.stride = approach(this.stride, clamp(STRIDE_MIN + this.speed * 0.05, STRIDE_MIN, STRIDE_MAX), 5, dt);
    // Above ~8 steps a second legs only flicker on screen, so a sprint skitters instead.
    this.skitter = ds / this.stride > MAX_STEP_HZ * dt;
    this.gaitPhase += Math.min(ds / this.stride, MAX_STEP_HZ * dt);
    const walking = clamp(this.speed / 10, 0, 1);
    const waveAmp = (0.12 + 0.08 * sNorm) * walking;
    const wave = Math.sin(this.gaitPhase * TAU) * waveAmp;

    const n = this.pts[NECK];
    n.x += Math.cos(this.heading + wave) * ds;
    n.y += Math.sin(this.heading + wave) * ds;

    // ── Head: stabilised against the wave, free to look around ──
    let yawTarget = 0;
    if (drive.look !== null) yawTarget = clamp(angleDiff(this.heading, drive.look), -1.05, 1.05);
    else if (this.speed < 3) yawTarget = noise1(this.time * 0.35, this.idleSeed) * 0.25;
    this.headYaw = approachAngle(this.headYaw, yawTarget - wave * 0.6, this.speed > 20 ? 14 : 9, dt);

    const ha = this.headAngle;
    for (let k = 1; k <= NECK; k++) {
      const p = this.pts[NECK - k];
      p.x = n.x + Math.cos(ha) * k * SEG;
      p.y = n.y + Math.sin(ha) * k * SEG;
    }

    // ── Trunk and tail follow with stiffness ────────────────
    this.curl = approach(this.curl, this.curlTarget, this.curlTarget > this.curl ? 0.9 : 2.2, dt);
    const path = this.path;
    for (let i = 0; i <= NECK; i++) { path[i].x = this.pts[i].x; path[i].y = this.pts[i].y; }
    let prevAng = this.heading + Math.PI;
    for (let i = NECK + 1; i < SPINE; i++) {
      const a = path[i - 1], p = path[i];
      let ang = Math.atan2(p.y - a.y, p.x - a.x);
      const maxB = BEND(i);
      let d = angleDiff(prevAng, ang);
      if (this.curl > 0.001) {
        const bias = this.curlDir * (i < TAIL_FIRST ? 0.07 : 0.18) * this.curl;
        d = lerp(d, bias, Math.min(1, dt * 3 * this.curl));
      }
      d = clamp(d, -maxB, maxB);
      ang = prevAng + d;
      p.x = a.x + Math.cos(ang) * SEG;
      p.y = a.y + Math.sin(ang) * SEG;
      prevAng = ang;
    }

    // Trunk flexion. The path chain above only remembers where the neck has been; the
    // visible spine adds a lateral standing wave on top — mid-trunk to one side, both
    // girdles to the other, flipping every step — plus a travelling wave down the tail.
    // Positive offsets are toward the animal's left; mid-trunk goes left (concave right)
    // while the left fore- and right hind-foot swing.
    this.flexAmp = approach(this.flexAmp, 1.25 * walking * (1 + 0.3 * sNorm), 5, dt);
    const s = Math.sin(this.gaitPhase * TAU) * this.flexAmp;
    for (let i = NECK + 1; i < SPINE; i++) {
      const p = path[i];
      const a = path[i - 1], c = path[Math.min(SPINE - 1, i + 1)];
      const fx = a.x - c.x, fy = a.y - c.y, fl = Math.hypot(fx, fy) || 1;
      let off = s * flexShape(i);
      if (i > HIP) off += Math.sin(this.gaitPhase * TAU - (i - HIP) * 0.4) * this.flexAmp * 0.8 * Math.min(1, (i - HIP) / 4);
      this.pts[i].x = p.x + (fy / fl) * off;
      this.pts[i].y = p.y - (fx / fl) * off;
    }

    // ── Legs ────────────────────────────────────────────────
    this.placeLegs(false, dt);

    // ── Small life signals ──────────────────────────────────
    this.breath += dt * TAU * this.breathRate;
    this.twitch = approach(this.twitch, this.tailTwitch, 6, dt);
    this.updateLids(dt);
    this.mouth = approach(this.mouth, this.mouthTarget, 28, dt);
    if (this.tongue) {
      this.tongue.t += dt / (this.tongue.kind === 'flick' ? 0.22 : 0.42);
      if (this.tongue.t >= 1) this.tongue = null;
    }
  }

  private updateLids(dt: number) {
    if (this.blinkT >= 0) {
      this.blinkT += dt / 0.17;
      const b = Math.sin(Math.min(1, this.blinkT) * Math.PI);
      this.lid = Math.max(this.lidTarget, b);
      if (this.blinkT >= 1) this.blinkT = -1;
      return;
    }
    this.lid = approach(this.lid, this.lidTarget, this.lidTarget > this.lid ? 2.5 : 8, dt);
    if (this.lidTarget < 0.9) {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        this.blinkT = 0;
        this.blinkTimer = Math.random() < 0.18 ? 0.25 : rand(2.5, 7);
      }
    }
  }

  /** Twitch offset applied to tail points at render time (lateral, art px). */
  tailOffset(i: number): number {
    if (i < SPINE - 10 || this.twitch < 0.01) return 0;
    const k = (i - (SPINE - 10)) / 10;
    return Math.sin(this.time * 17 + k * 2.2) * this.twitch * k * k * 2.2;
  }

  hipOf(leg: Leg): Pt {
    const { seg, side } = leg.def;
    const s = this.pts[seg];
    const f = this.forward(seg);
    const w = halfWidth(seg) * 0.7;
    return { x: s.x - f.y * side * w, y: s.y + f.x * side * w };
  }

  restOf(leg: Leg, hip: Pt): Pt {
    const { seg, side, restFwd, restOut } = leg.def;
    const f = this.forward(seg);
    const ox = -f.y * side, oy = f.x * side;
    return { x: hip.x + ox * restOut + f.x * restFwd, y: hip.y + oy * restOut + f.y * restFwd };
  }

  private placeLegs(init: boolean, dt = 0) {
    const moving = this.speed > 1.5;
    const vx = Math.cos(this.heading) * this.speed, vy = Math.sin(this.heading) * this.speed;
    let swingingCount = this.legs.filter((l) => l.swinging).length;

    for (const leg of this.legs) {
      const hip = this.hipOf(leg);
      leg.hip = hip;
      const rest = this.restOf(leg, hip);
      if (init) { leg.foot = { ...rest }; continue; }

      const reach = leg.def.l1 + leg.def.l2;
      const off = Math.hypot(leg.foot.x - rest.x, leg.foot.y - rest.y);
      const stretch = Math.hypot(leg.foot.x - hip.x, leg.foot.y - hip.y);

      if (!leg.swinging) {
        if (moving && leg.rolled(this.gaitPhase)) {
          const dur = clamp((this.stride * SWING_FRACTION) / Math.max(this.speed, 1), 0.04, 0.28);
          leg.startSwing(dur);
          swingingCount++;
        } else if ((stretch > reach * COMFORT && swingingCount < 2 && !this.skitter) || stretch > reach || (!moving && off > 2 && swingingCount < 2)) {
          leg.startSwing(stretch > reach * COMFORT ? 0.08 : 0.13);
          swingingCount++;
        }
        if (!moving) leg.syncCycle(this.gaitPhase);
      }

      if (leg.swinging) {
        const remaining = (1 - leg.t) * leg.dur;
        // Land 30% of a stride ahead of rest; the stance then sweeps to 30% behind it.
        const lead = moving ? this.stride * 0.3 : 0;
        const f = moving ? { x: Math.cos(this.heading), y: Math.sin(this.heading) } : { x: 0, y: 0 };
        const target = {
          x: rest.x + vx * remaining + f.x * lead,
          y: rest.y + vy * remaining + f.y * lead,
        };
        // Land within comfortable reach of where the hip will be, so the limb stays bent.
        // Check against both the hip now and where it will be on landing.
        const max = reach * COMFORT * 0.92;
        for (const h of [{ x: hip.x + vx * remaining, y: hip.y + vy * remaining }, hip]) {
          const tx = target.x - h.x, ty = target.y - h.y, tl = Math.hypot(tx, ty);
          if (tl > max) { target.x = h.x + (tx / tl) * max; target.y = h.y + (ty / tl) * max; }
        }
        const fs = this.forward(leg.def.seg);
        leg.advance(dt, target, { x: -fs.y * leg.def.side, y: fs.x * leg.def.side });
      }

      // Never let a foot be dragged beyond physical reach; in a sprint it slides first.
      const sx = leg.foot.x - hip.x, sy = leg.foot.y - hip.y;
      const sl = Math.hypot(sx, sy), lim = this.skitter ? reach * COMFORT : reach;
      if (sl > lim) {
        leg.foot.x = hip.x + (sx / sl) * lim;
        leg.foot.y = hip.y + (sy / sl) * lim;
      }

      leg.knee = this.solveKnee(leg, hip);
    }
  }

  private solveKnee(leg: Leg, hip: Pt): Pt {
    const { seg, side, front, l1, l2 } = leg.def;
    const f = this.forward(seg);
    const ox = -f.y * side, oy = f.x * side;
    // Elbows sit behind the hands on the forelegs; knees face forward on the hind legs.
    // Both sweep outward at mid-swing, which gives the popping-elbow lizard walk.
    const swing = leg.swinging ? Math.sin(leg.t * Math.PI) : 0;
    let hx: number, hy: number;
    if (front) {
      const back = 0.62 * (1 - swing);
      hx = ox * (1 - back) - f.x * back; hy = oy * (1 - back) - f.y * back;
    } else {
      const fwd = 0.32 * (1 - swing);
      hx = ox * (1 - fwd) + f.x * fwd; hy = oy * (1 - fwd) + f.y * fwd;
    }
    const fx = leg.foot.x, fy = leg.foot.y;
    const d = Math.min(Math.hypot(fx - hip.x, fy - hip.y), l1 + l2 - 0.01);
    if (d < 0.01) return { x: hip.x + hx * l1, y: hip.y + hy * l1 };
    const base = Math.atan2(fy - hip.y, fx - hip.x);
    const cosB = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const b = Math.acos(cosB);
    const k1 = { x: hip.x + l1 * Math.cos(base + b), y: hip.y + l1 * Math.sin(base + b) };
    const k2 = { x: hip.x + l1 * Math.cos(base - b), y: hip.y + l1 * Math.sin(base - b) };
    const d1 = (k1.x - hip.x) * hx + (k1.y - hip.y) * hy;
    const d2 = (k2.x - hip.x) * hx + (k2.y - hip.y) * hy;
    return d1 >= d2 ? k1 : k2;
  }

  breathScale(i: number): number {
    if (i < TORSO_FIRST || i > TORSO_LAST) return 1;
    return 1 + Math.sin(this.breath) * this.breathDepth;
  }

  /** Translate the whole animal (used when the art scale changes). */
  scale(f: number) {
    for (const p of this.pts) { p.x *= f; p.y *= f; }
    for (const p of this.path) { p.x *= f; p.y *= f; }
    for (const l of this.legs) { l.foot.x *= f; l.foot.y *= f; }
  }

  /** Move the whole animal without disturbing its pose. */
  translate(dx: number, dy: number) {
    for (const p of this.pts) { p.x += dx; p.y += dy; }
    for (const p of this.path) { p.x += dx; p.y += dy; }
    for (const l of this.legs) {
      for (const q of [l.foot, l.hip, l.knee, l.from]) { q.x += dx; q.y += dy; }
    }
  }
}

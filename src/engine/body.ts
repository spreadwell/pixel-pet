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
 *
 * The ground has height (see World.groundAt). Each spine point takes the height of the
 * terrain under it, and the body drapes over steps like a rope, never steeper than
 * DRAPE_SLOPE: points beside a ledge lift off the low side and bridge up to the top.
 * Spacing between points is kept in 3D, so where the body is steep it bunches up as
 * seen from above. At the foot of a step it hesitates, then scrambles up; at the top of
 * a drop it stops with its head out over the edge and peers about before picking its
 * way down. In a narrow gap it squeezes thinner.
 *
 * It can be picked up: while held, the gripped point follows the pointer, the rest
 * dangles and squirms with the legs paddling, high above its shadow.
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
/** Steepest the body drapes over a step: height change per art px of spine. */
const DRAPE_SLOPE = 0.8;
/** How high a held gecko is lifted above the ground, in art px. */
const HELD_Z = 12;
/** Horizontal length of one spine segment that rises `dz`. */
const segH = (dz: number) => Math.sqrt(Math.max(0.5, SEG * SEG - dz * dz));

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

  /** Height of each spine point above the note. */
  z: number[] = new Array(SPINE).fill(0);
  /** Width factor per spine point: below 1 while squeezing through a gap. */
  squeeze: number[] = new Array(SPINE).fill(1);
  /** Terrain height at (x, y); flat unless the engine supplies the workspace's. */
  ground: (x: number, y: number) => number = () => 0;
  /** Crawling under a panel rather than over the terrain. */
  under = false;
  /** Speed factor from the slope ahead: below 1 climbing up, a little below going down. */
  private climb = 1;
  /** A pause at the foot of a ledge before scrambling up it; re-armed once clear of it. */
  private ledgePause = 0;
  private ledgeArmed = true;
  /** Pausing at the top of a drop, looking over. */
  private peering = false;
  /** Picked up by the user: which spine point is gripped, and where it is being held. */
  private held: { i: number; x: number; y: number } | null = null;
  private zDrape: number[] = new Array(SPINE).fill(0);

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

  get isHeld() { return !!this.held; }

  /** Pick the gecko up at (x, y), gripping the nearest spine point. */
  grab(x: number, y: number) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < SPINE; i++) {
      const d = Math.hypot(this.pts[i].x - x, this.pts[i].y - y);
      if (d < bd) { bd = d; best = i; }
    }
    this.held = { i: best, x, y };
    this.under = false;
  }

  holdAt(x: number, y: number) { if (this.held) { this.held.x = x; this.held.y = y; } }

  /** Let go: it drops onto whatever is below and carries on from the pose it is in. */
  release() {
    if (!this.held) return;
    this.held = null;
    this.speed = 0;
    this.heading = Math.atan2(this.pts[0].y - this.pts[NECK].y, this.pts[0].x - this.pts[NECK].x);
    this.headYaw = 0;
    for (let i = 0; i < SPINE; i++) { this.path[i].x = this.pts[i].x; this.path[i].y = this.pts[i].y; }
    for (const leg of this.legs) { leg.lift = 0; leg.swinging = false; leg.syncCycle(this.gaitPhase); }
  }

  /** Height of a foot: on the ground, raised while it swings, dangling when held. */
  footZ(leg: Leg) {
    return this.held ? this.z[leg.def.seg] : this.ground(leg.foot.x, leg.foot.y) + leg.lift * 1.5;
  }

  update(dt: number, drive: Drive) {
    this.time += dt;
    if (this.held) { this.updateHeld(dt); this.lifeSignals(dt); return; }

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

    // A step up ahead slows it to a scramble; going down it picks its way a little.
    const n = this.pts[NECK];
    const rise = this.ground(n.x + Math.cos(this.heading) * 3, n.y + Math.sin(this.heading) * 3) - this.z[NECK];
    // A step up or down: hesitate first — a beat for a line of text, longer at a real
    // ledge, and at the top of a big drop, a long look over the edge.
    if (Math.abs(rise) > 2.5 && this.speed > 3 && this.speed < 60) {
      if (this.ledgeArmed) {
        const big = Math.abs(rise) > 5.5;
        this.ledgePause = rise > 0 ? (big ? rand(0.25, 0.5) : rand(0.08, 0.16)) : big ? rand(0.4, 0.8) : rand(0.05, 0.12);
        this.peering = rise < 0 && big;
        this.ledgeArmed = false;
      }
    } else if (Math.abs(rise) < 1) this.ledgeArmed = true;
    this.ledgePause -= dt;
    if (this.ledgePause <= 0) this.peering = false;
    this.climb = approach(this.climb, this.ledgePause > 0 ? 0.05 : rise > 0.5 ? 0.45 : rise < -0.5 ? 0.55 : 1, 6, dt);
    const ds = this.speed * dt * this.climb;
    // Faster means longer strides first (up to what the legs can reach), then quicker ones.
    this.stride = approach(this.stride, clamp(STRIDE_MIN + this.speed * 0.05, STRIDE_MIN, STRIDE_MAX), 5, dt);
    // Above ~8 steps a second legs only flicker on screen, so a sprint skitters instead.
    this.skitter = ds / this.stride > MAX_STEP_HZ * dt;
    this.gaitPhase += Math.min(ds / this.stride, MAX_STEP_HZ * dt);
    const walking = clamp(this.speed / 10, 0, 1);
    const waveAmp = (0.12 + 0.08 * sNorm) * walking;
    const wave = Math.sin(this.gaitPhase * TAU) * waveAmp;

    n.x += Math.cos(this.heading + wave) * ds;
    n.y += Math.sin(this.heading + wave) * ds;

    // ── Head: stabilised against the wave, free to look around ──
    let yawTarget = 0;
    if (drive.look !== null) yawTarget = clamp(angleDiff(this.heading, drive.look), -1.05, 1.05);
    else if (this.speed < 3) yawTarget = noise1(this.time * 0.35, this.idleSeed) * 0.25;
    if (this.peering) yawTarget += Math.sin(this.time * 4) * 0.5;
    this.headYaw = approachAngle(this.headYaw, yawTarget - wave * 0.6, this.speed > 20 ? 14 : 9, dt);

    const ha = this.headAngle;
    let reach = 0;
    for (let k = 1; k <= NECK; k++) {
      const p = this.pts[NECK - k];
      reach += segH(this.z[NECK - k] - this.z[NECK - k + 1]);
      p.x = n.x + Math.cos(ha) * reach;
      p.y = n.y + Math.sin(ha) * reach;
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
      d = clamp(d, -maxB, maxB);
      ang = prevAng + d;
      const len = segH(this.z[i] - this.z[i - 1]);
      p.x = a.x + Math.cos(ang) * len;
      p.y = a.y + Math.sin(ang) * len;
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
      // At rest the tail lies in a loose curve to one side.
      if (i > HIP) off += this.curlDir * this.curl * 0.018 * (i - HIP) * (i - HIP);
      this.pts[i].x = p.x + (fy / fl) * off;
      this.pts[i].y = p.y - (fx / fl) * off;
    }

    this.drape(dt);

    // ── Legs ────────────────────────────────────────────────
    this.placeLegs(false, dt);
    this.lifeSignals(dt);
  }

  /** Dangling from the user's grip: squirming, legs paddling, lifted high. */
  private updateHeld(dt: number) {
    const h = this.held!, pts = this.pts;
    const g = pts[h.i];
    g.x = approach(g.x, h.x, 30, dt);
    g.y = approach(g.y, h.y, 30, dt);
    // Each free end trails from the grip, stiff enough to keep its shape, with a squirm
    // running along it.
    const hang = (from: number, to: number, step: number) => {
      const g0 = pts[from - step], g1 = pts[Math.min(SPINE - 1, Math.max(0, from - 2 * step))];
      let prev = Math.atan2(g0.y - g1.y, g0.x - g1.x);
      for (let i = from; i !== to; i += step) {
        const a = pts[i - step], q = pts[i];
        let ang = Math.atan2(q.y - a.y, q.x - a.x);
        ang = prev + clamp(angleDiff(prev, ang) + Math.sin(this.time * 9 + i * 0.5) * 0.05, -0.16, 0.16);
        q.x = a.x + Math.cos(ang) * SEG;
        q.y = a.y + Math.sin(ang) * SEG;
        prev = ang;
      }
    };
    hang(h.i - 1, -1, -1);
    hang(h.i + 1, SPINE, 1);
    for (let i = 0; i < SPINE; i++) {
      this.path[i].x = pts[i].x; this.path[i].y = pts[i].y;
      this.z[i] = approach(this.z[i], HELD_Z, 12, dt);
      this.squeeze[i] = approach(this.squeeze[i], 1, 10, dt);
    }
    this.heading = Math.atan2(pts[0].y - pts[NECK].y, pts[0].x - pts[NECK].x);
    this.headYaw = approachAngle(this.headYaw, Math.sin(this.time * 5) * 0.3, 8, dt);
    for (const leg of this.legs) {
      const hip = this.hipOf(leg);
      leg.hip = hip;
      const rest = this.restOf(leg, hip);
      const f = this.forward(leg.def.seg);
      const paddle = Math.sin(this.time * 13 + leg.def.phase * Math.PI * 2) * 1.6;
      leg.foot = { x: rest.x + f.x * paddle, y: rest.y + f.y * paddle };
      leg.lift = 1;
      leg.swinging = false;
      leg.knee = this.solveKnee(leg, hip);
    }
    this.speed = 0;
  }

  private lifeSignals(dt: number) {
    this.breath += dt * TAU * this.breathRate;
    this.twitch = approach(this.twitch, this.tailTwitch, 6, dt);
    this.updateLids(dt);
    this.mouth = approach(this.mouth, this.mouthTarget, 28, dt);
    if (this.tongue) {
      this.tongue.t += dt / (this.tongue.kind === 'flick' ? 0.22 : 0.42);
      if (this.tongue.t >= 1) this.tongue = null;
    }
  }

  /** Heights along the spine: terrain under each point, draped over steps, eased in time. */
  private drape(dt: number) {
    const zt = this.zDrape;
    for (let i = 0; i < SPINE; i++) zt[i] = this.ground(this.pts[i].x, this.pts[i].y);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < SPINE; i++) zt[i] = Math.max(zt[i], zt[i - 1] - DRAPE_SLOPE);
      for (let i = SPINE - 2; i >= 0; i--) zt[i] = Math.max(zt[i], zt[i + 1] - DRAPE_SLOPE);
    }
    for (let i = 0; i < SPINE; i++) {
      this.z[i] = approach(this.z[i], zt[i], 25, dt);
      // Squeezing: how much room is there either side before the ground rises?
      let target = 1;
      if (!this.under) {
        const p = this.pts[i], f = this.forward(i), lx = -f.y, ly = f.x;
        const room = (side: number) => {
          for (let d = 0.5; d <= 6; d += 0.5) if (this.ground(p.x + lx * side * d, p.y + ly * side * d) > this.z[i] + 0.8) return d;
          return 6;
        };
        target = clamp((room(1) + room(-1) - 1) / (2 * halfWidth(i) + 5), 0.65, 1);
      }
      this.squeeze[i] = approach(this.squeeze[i], target, 10, dt);
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
    const { seg, side, restFwd, restOut, front } = leg.def;
    const f = this.forward(seg);
    const ox = -f.y * side, oy = f.x * side;
    // Resting, the legs tuck in alongside the body.
    const out = restOut * (1 - 0.45 * this.curl), fwd = restFwd - (front ? 1.0 : 0.6) * this.curl;
    return { x: hip.x + ox * out + f.x * fwd, y: hip.y + oy * out + f.y * fwd };
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
        } else if ((stretch > reach * COMFORT && swingingCount < 2 && !this.skitter) || stretch > reach || (!moving && off > (this.curl > 0.5 ? 1 : 2) && swingingCount < 2)) {
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

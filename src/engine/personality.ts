import { Body, Drive, NEARER, TAIL_FIRST, halfWidth } from './body';
import type { Bug, Particles, Swarm } from './bugs';
import type { InputTracker } from './input';
import { angleDiff, clamp, lerp, rand } from './math';
import type { NibbleTarget, Nibbler } from './nibble';
import type { Palette } from './palette';
import type { Reactions } from './reactions';
import { Waypoint, findRoute } from './route';
import type { CoverEntry, World } from './world';

// ═══════════════════════════════════════════════════════════════════
// PERSONALITY
// ═══════════════════════════════════════════════════════════════════
// The mind of the gecko, ported from the original pixel-lizard prototype
// (pixel-lizard-new-states.jsx): its trait engine, drives, state machine and the
// rhythms of each state are kept close to the original. Instead of moving a spine of
// its own, it steers the physical Body (feet, gait, flexion), so movement quality comes
// from the body and character comes from here.
//
// Changes from the original:
//   - Steps on a fixed 60 Hz tick, so it no longer speeds up on high-refresh displays.
//   - Wall steering blends along the shortest arc (the original could spin near walls).
//   - Sleep peeking is timed in ticks instead of setTimeout.
//   - Walls are the workspace's panel seams and the window; home is a panel corner.
//   - Prey is only struck when it is on the ground; flying insects are watched.
//   - The stats readout is gone. Hunger and sleepiness only show through behaviour.
//   - New: scare() for pokes, panels and typing; petting; stealing a letter out of a
//     word to carry off and eat; and a nap when the user is away.
//   - New: the workspace is terrain. It climbs onto the sidebars and tabs and over
//     your text, and squeezes along the gaps between paragraphs (the Body does the
//     climbing). Side panels are also cover: it slips under one, waits and peeks back
//     out, and bolts for one when frightened. While it is under a panel, a pointer or
//     click on that panel is above it and unseen.
//   - New: it finds its way over that terrain (route.ts) instead of beelining: along the
//     margins and the gaps between paragraphs, around headings, climbing when it pays.
//   - New: it notices what happens in Obsidian. A modal or the command palette opening
//     freezes it, watching, until it closes; a notice popping up draws it over to pounce;
//     something being dragged is prey to chase; a new note gets a look round. While you
//     type it creeps closer, hesitantly, and lurks a little way off, watching; when you
//     stop, it comes right up to sniff along the words you just wrote.
//
// Sections: TRAIT SYSTEM · NEEDS · SUB-BEHAVIOURS · STATE HANDLERS · PERSONALITY
// Distances are multiples of S (the original's body scale, here in art px) and times
// are in 60 Hz ticks, exactly as in the original.

const S = 0.55;
/** The pointer catches its eye within this distance (art px)... */
const CURIOUS_RADIUS = 170;
/** ...and within this one it stalks it. */
const STALK_RADIUS = 55;
/** Hiding under the side panels is switched off for now; the code stays for later. */
const HIDING = false;
const dist = (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x2 - x1, y2 - y1);
const lerpAngle = (a: number, b: number, t: number) => a + angleDiff(a, b) * t;

export interface BrainOptions {
  nibble: boolean;
  sleepAfterMs: number;
  reducedMotion: boolean;
  traits?: Traits;
}

export interface Ctx {
  body: Body;
  world: World;
  input: InputTracker;
  swarm: Swarm;
  nibbler: Nibbler;
  reactions: Reactions;
  particles: Particles;
  pal: Palette;
  opts: BrainOptions;
  now: number;
  /** Pointer in art px, or null. */
  pointer: { x: number; y: number } | null;
  pointerSpeed: number;
}

// ═══════════════════════════════════════════════════════════════════
// TRAIT SYSTEM
// ═══════════════════════════════════════════════════════════════════
// Traits are soft-normalised against a budget to prevent a "god lizard": only the
// ratios between them matter. Each install rolls its own personality.

const TRAIT_BUDGET = 2.5;
export type Traits = Record<'speed' | 'aggression' | 'awareness' | 'endurance' | 'metabolism', number>;

export function rollTraits(): Traits {
  const r = () => 0.3 + Math.random() * 0.4;
  return { speed: r(), aggression: r(), awareness: r(), endurance: r(), metabolism: r() };
}

const Curves: Record<string, (t: number) => number> = {
  linear: (t) => clamp(t, 0, 1),
  eager: (t) => { const c = clamp(t, 0, 1); return 1 - (1 - c) * (1 - c); },
  lazy: (t) => { const c = clamp(t, 0, 1); return c * c; },
  step3: (t) => { const c = clamp(t, 0, 1); return c < 0.33 ? 0 : c < 0.66 ? 0.5 : 1; },
};

// "source → parameter": curve and output range. Entries for the same parameter sum.
const INFLUENCE_MAP: Record<string, { curve: string; range: [number, number] }> = {
  'speed → baseSpeed': { curve: 'linear', range: [0.5, 2.5] },
  'speed → fleeMultiplier': { curve: 'linear', range: [1.4, 3.0] },
  'speed → fleeDuration': { curve: 'linear', range: [20, 50] },
  'aggression → huntChance': { curve: 'linear', range: [0.005, 0.035] },
  'aggression → stalkSpeed': { curve: 'linear', range: [0.15, 0.45] },
  'awareness → baseSight': { curve: 'linear', range: [40, 160] },
  'awareness → startleDist': { curve: 'linear', range: [30, 90] },
  'awareness → startleSpeed': { curve: 'linear', range: [4, 12] },
  'endurance → baseSleepRate': { curve: 'linear', range: [0.00035, 0.00005] },
  'endurance → sleepThreshold': { curve: 'linear', range: [0.6, 1.0] },
  'endurance → idleDuration': { curve: 'linear', range: [30, 90] },
  'endurance → baskDuration': { curve: 'linear', range: [100, 300] },
  'endurance → sleepDuration': { curve: 'linear', range: [150, 450] },
  // Slower than the prototype: in a workspace, food only comes from your writing.
  'metabolism → hungerDecay': { curve: 'linear', range: [0.0006, 0.0026] },
  'metabolism → fullnessSlowFactor': { curve: 'linear', range: [0.7, 0.3] },
  'metabolism → fullnessSleepFactor': { curve: 'linear', range: [0.001, 0.005] },
  'hunger → sightBonus': { curve: 'lazy', range: [0, 340] },
  'hunger → eagernessBoost': { curve: 'step3', range: [0.1, 1.0] },
  'hunger → stalkSpeedBoost': { curve: 'linear', range: [0, 0.3] },
  'hunger → speedBoost': { curve: 'lazy', range: [0, 1.2] },
  'hunger → huntChanceBoost': { curve: 'eager', range: [0, 0.03] },
};

class TraitEngine {
  traits: Record<string, number> = {};
  drives: Record<string, number> = { hunger: 0, fullness: 0, sleepiness: 0 };
  private byOutput: Record<string, { from: string; curve: string; range: [number, number] }[]> = {};

  constructor(raw: Traits, budget: number) {
    const entries = Object.entries(raw);
    const sum = entries.reduce((a, [, v]) => a + v, 0);
    const scale = sum > 0 ? budget / sum : 1;
    for (const [k, v] of entries) this.traits[k] = clamp(v * scale, 0, 1);
    for (const [key, config] of Object.entries(INFLUENCE_MAP)) {
      const [from, to] = key.split(' → ');
      (this.byOutput[to] ??= []).push({ from, curve: config.curve, range: config.range });
    }
  }

  resolve(output: string): number {
    const entries = this.byOutput[output];
    if (!entries) return 0;
    let total = 0;
    for (const e of entries) total += lerp(e.range[0], e.range[1], Curves[e.curve](this.traits[e.from] ?? this.drives[e.from] ?? 0));
    return total;
  }

  updateDrives(needs: Needs) {
    this.drives.hunger = clamp(1 - needs.hunger / 100, 0, 1);
    this.drives.fullness = needs.hunger / 100;
    this.drives.sleepiness = needs.sleepiness;
  }
}

// ═══════════════════════════════════════════════════════════════════
// STATES & NEEDS
// ═══════════════════════════════════════════════════════════════════

export const STATE = {
  IDLE: 'idle',
  BASKING: 'basking',
  EXPLORE: 'explore',
  HUNT: 'hunt',
  STARTLE: 'startle',
  FLEE: 'flee',
  SLEEP: 'sleep',
  NIBBLE: 'nibble',
  HIDE: 'hide',
  HELD: 'held',
  WATCH: 'watch',
  INSPECT: 'inspect',
  LURK: 'lurk',
  CURIOUS: 'curious',
} as const;
export type State = (typeof STATE)[keyof typeof STATE];

class Needs {
  hunger = 50;
  sleepiness = 0;
  constructor(private engine: TraitEngine) {}

  get hungerFactor() { return clamp(1 - this.hunger / 100, 0, 1); }
  get fullness() { return this.hunger / 100; }

  update(state: State) {
    this.engine.updateDrives(this);
    this.hunger = Math.max(0, this.hunger - this.engine.resolve('hungerDecay'));
    if (state === STATE.SLEEP) this.sleepiness = Math.max(0, this.sleepiness - 0.003);
    else {
      const bonus = this.fullness > 0.7 ? (this.fullness - 0.7) * this.engine.resolve('fullnessSleepFactor') : 0;
      this.sleepiness = Math.min(1, this.sleepiness + this.engine.resolve('baseSleepRate') + bonus);
    }
  }

  feed(amount: number) { this.hunger = Math.min(100, this.hunger + amount); }
  canSleep() {
    const threshold = this.engine.resolve('sleepThreshold');
    return (this.sleepiness > threshold && this.hunger > 20) || (this.hunger > 90 && this.sleepiness > 0.3);
  }
  wantsSleepSoon() { return this.sleepiness > this.engine.resolve('sleepThreshold') - 0.1; }
  /** Bugs are rare in a workspace: it spots them from most of the window, hungry ones furthest. */
  get sightRange() { return 150 + (this.engine.resolve('baseSight') + this.engine.resolve('sightBonus')) * S * 2; }
  get huntEagerness() { return this.engine.resolve('eagernessBoost'); }
  get fullnessSlowdown() { return 1 - this.fullness * this.engine.resolve('fullnessSlowFactor'); }
}

// ═══════════════════════════════════════════════════════════════════
// SUB-BEHAVIOURS (the rest — tongue, blink, breathing, tail — live on the Body)
// ═══════════════════════════════════════════════════════════════════

class HeadLookBehavior {
  offset = 0; target = 0;
  look() { this.target = (Math.random() - 0.5) * 1.2; }
  lookAt(rel: number) { this.target = clamp(rel, -0.9, 0.9); }
  update() {
    this.offset = lerp(this.offset, this.target, 0.08);
    if (Math.abs(this.offset - this.target) < 0.02) this.target = lerp(this.target, 0, 0.05);
  }
}

// ═══════════════════════════════════════════════════════════════════
// STATE HANDLERS — each state defines enter() and update()
// ═══════════════════════════════════════════════════════════════════
// update() returns the target speed (art px per tick) and optionally a transition.

type Result = { targetSpeed: number; transition?: State };
interface Handler { enter(g: Personality): void; update(g: Personality): Result; }

const StateHandlers: Record<State, Handler> = {
  [STATE.IDLE]: {
    enter(g) {
      const urgency = Math.max(g.needs.hungerFactor * 0.7, g.needs.fullness > 0.7 ? (g.needs.fullness - 0.7) * 2 : 0);
      const baseDur = g.traits.resolve('idleDuration');
      g.stateData = {
        duration: (baseDur + Math.random() * baseDur * 2) * (1 - urgency),
        nextLookTime: 20 + Math.random() * 40,
        nextTongueTime: 40 + Math.random() * 80,
        nextBlinkTime: 30 + Math.random() * 60,
      };
    },
    update(g) {
      const t = g.stateTimer, d = g.stateData;
      if (t > d.nextLookTime) { g.headLook.look(); d.nextLookTime = t + 30 + Math.random() * 50; }
      if (t > d.nextTongueTime) { g.flick(); d.nextTongueTime = t + 50 + Math.random() * 100; }
      if (t > d.nextBlinkTime) { g.blink(); d.nextBlinkTime = t + 30 + Math.random() * 60; }
      if (t > d.duration) {
        const homeDist = g.distTo(g.homeX, g.homeY);
        if (g.needs.canSleep()) return { targetSpeed: 0.05 * S, transition: homeDist < 60 * S ? STATE.SLEEP : STATE.EXPLORE };
        if (g.letter) return { targetSpeed: 0.05 * S, transition: STATE.NIBBLE };
        if (g.wantsCover()) return { targetSpeed: 0.05 * S, transition: STATE.HIDE };
        const nearHome = homeDist < 80 * S;
        const r = Math.random();
        if (nearHome && g.needs.fullness > 0.6 && r < g.needs.fullness) return { targetSpeed: 0.05 * S, transition: STATE.BASKING };
        if (r < 0.4) return { targetSpeed: 0.05 * S, transition: STATE.EXPLORE };
        if (r < 0.7) return { targetSpeed: 0.05 * S, transition: STATE.BASKING };
        return { targetSpeed: 0.05 * S, transition: STATE.EXPLORE };
      }
      return { targetSpeed: 0.05 * S };
    },
  },

  [STATE.BASKING]: {
    enter(g) {
      const nearHome = g.distTo(g.homeX, g.homeY) < 80 * S;
      const baseDur = g.traits.resolve('baskDuration');
      const fullBonus = nearHome && g.needs.hunger > 70 ? g.needs.fullness * baseDur * 1.5 : 0;
      g.stateData = { duration: baseDur + Math.random() * baseDur * 1.5 + fullBonus, nextLookTime: 60 + Math.random() * 80, nextBlinkTime: 40 + Math.random() * 50 };
    },
    update(g) {
      const t = g.stateTimer, d = g.stateData;
      if (g.petted) d.duration = Math.max(d.duration, t + 60);
      if (t > d.nextLookTime && !g.petted) { g.headLook.look(); d.nextLookTime = t + 80 + Math.random() * 100; }
      if (t > d.nextBlinkTime) { g.blink(); d.nextBlinkTime = t + 40 + Math.random() * 60; }
      if (t > d.duration) {
        if (g.needs.canSleep()) return { targetSpeed: 0, transition: g.distTo(g.homeX, g.homeY) < 60 * S ? STATE.SLEEP : STATE.EXPLORE };
        if (g.letter) return { targetSpeed: 0, transition: STATE.NIBBLE };
        return { targetSpeed: 0, transition: Math.random() < 0.6 ? STATE.EXPLORE : STATE.IDLE };
      }
      return { targetSpeed: 0 };
    },
  },

  [STATE.EXPLORE]: {
    enter(g) {
      g.pickDestination();
      g.stateData = { investigateTime: 0, investigating: false, wallFollowing: false, wallFollowTimer: 0, wallAngle: 0, lookCount: 0, maxLooks: 0 };
    },
    update(g) {
      const head = g.head;
      const d = dist(head.x, head.y, g.destX, g.destY);
      const sd = g.stateData;

      // Near a seam, sometimes run along it for a while. Panels put seams everywhere, so
      // this is rarer than the original's walls, and never right before arriving.
      if (!sd.wallFollowing && !sd.investigating && !g.entering && d > 40 * S && Math.random() < 0.005) {
        const seam = g.nearestSeam(40 * S);
        if (seam) {
          sd.wallFollowing = true;
          sd.wallFollowTimer = 60 + Math.random() * 120;
          const along = Math.atan2(seam.y2 - seam.y1, seam.x2 - seam.x1);
          sd.wallAngle = Math.abs(angleDiff(g.angle, along)) < Math.PI / 2 ? along : along + Math.PI;
        }
      }

      let targetSpeed: number;
      if (sd.wallFollowing) {
        g.targetAngle = sd.wallAngle;
        targetSpeed = g.speed * 0.7;
        sd.wallFollowTimer--;
        if (sd.wallFollowTimer % 30 === 0) g.flick();
        if (sd.wallFollowTimer <= 0 || d < 15 * S) sd.wallFollowing = false;
      } else if (!sd.investigating) {
        const wp = g.waypoint(g.destX, g.destY);
        g.targetAngle = Math.atan2(wp.y - head.y, wp.x - head.x);
        // The explore rhythm: hesitate, dash, slow — over and over.
        const burstPhase = g.burstTimer % 80;
        if (burstPhase < 15) targetSpeed = 0.15 * S;
        else if (burstPhase < 55) targetSpeed = g.speed;
        else targetSpeed = 0.3 * S;
        g.targetAngle += Math.sin(g.burstTimer * 0.08) * 0.15;
        // Something just popped up: hurry, no dawdling.
        if (sd.forLure && g.lure) targetSpeed = g.speed * 1.5;

        if (d < 15 * S) {
          // Came over to see what popped up: if it's still there, pounce on it.
          if (sd.forLure && g.lure) return { targetSpeed, transition: STATE.HUNT };
          if ((g.needs.canSleep() || g.forcedNap) && g.distTo(g.homeX, g.homeY) < 60 * S) return { targetSpeed, transition: STATE.SLEEP };
          sd.investigating = true; sd.investigateTime = 0; sd.lookCount = 0;
          sd.maxLooks = 2 + Math.floor(Math.random() * 3);
        }
      } else {
        // Arrived: look about, taste the air, blink.
        targetSpeed = 0.05 * S;
        sd.investigateTime++;
        if (sd.investigateTime % 25 === 10) { g.headLook.look(); sd.lookCount++; }
        if (sd.investigateTime % 40 === 20) {
          // Words nearby get a taste: turn to them first.
          const w = g.c.world.nearestText(head.x, head.y, 12);
          if (w) g.headLook.lookAt(angleDiff(g.angle, Math.atan2(w.y - head.y, w.x - head.x)));
          g.flick();
        }
        if (sd.investigateTime % 35 === 5) g.blink();
        if (sd.lookCount >= sd.maxLooks) {
          if (g.letter) return { targetSpeed, transition: STATE.NIBBLE };
          if (g.wantsCover()) return { targetSpeed, transition: STATE.HIDE };
          const nearHome = g.distTo(g.homeX, g.homeY) < 80 * S;
          if (nearHome && g.needs.fullness > 0.7) return { targetSpeed, transition: Math.random() < 0.8 ? STATE.BASKING : STATE.IDLE };
          const r = Math.random();
          if (r < 0.5) return { targetSpeed, transition: STATE.EXPLORE };
          if (r < 0.8) return { targetSpeed, transition: STATE.IDLE };
          return { targetSpeed, transition: STATE.BASKING };
        }
      }
      if (!g.entering) g.steerFromWalls(25 * S, 0.3, !sd.wallFollowing);
      return { targetSpeed };
    },
  },

  [STATE.HUNT]: {
    enter(g) { g.stateData = { phase: 'stalk', stalkTime: 0, lungeTimer: 0, lure: !g.targetBug && !!g.lure }; },
    update(g) {
      const head = g.head;
      const bug = g.targetBug;
      const p = g.pointer;
      const sd = g.stateData;
      // Prey is a bug, or a lure (a notice, something dragged), or the pointer.
      const lure = !bug && sd.lure ? g.lure : null;
      const target = bug ?? lure ?? p;
      const huntX = target ? target.x : head.x;
      const huntY = target ? target.y : head.y;
      const huntDist = dist(head.x, head.y, huntX, huntY);
      const huntLost = bug ? !g.preyAlive(bug) : sd.lure ? !g.lure : !p || huntDist > 120 * S;

      if (sd.phase === 'stalk') {
        // Spotted from afar: go over first; the stalk starts within striking range.
        if (huntDist > 60 && !huntLost) {
          const wp = g.waypoint(huntX, huntY);
          g.targetAngle = Math.atan2(wp.y - head.y, wp.x - head.x);
          return { targetSpeed: g.speed * 1.2 };
        }
        g.targetAngle = Math.atan2(huntY - head.y, huntX - head.x);
        let targetSpeed = (g.traits.resolve('stalkSpeed') + g.traits.resolve('stalkSpeedBoost')) * S;
        sd.stalkTime++;
        if (sd.stalkTime % 40 > 30) targetSpeed = 0;
        // A flying insect is watched, not struck.
        const strikeable = !bug || bug.catchable;
        if (!strikeable && huntDist < 50 * S) targetSpeed = 0;
        if (strikeable && (huntDist < 40 * S || sd.stalkTime > 120)) { sd.phase = 'lunge'; sd.lungeTimer = 0; }
        if (huntLost) return { targetSpeed, transition: STATE.IDLE };
        return { targetSpeed };
      }

      g.targetAngle = Math.atan2(huntY - head.y, huntX - head.x);
      const approachSpeed = huntDist < 30 * S ? g.speed * 0.8 : g.speed * 2;
      sd.lungeTimer++;
      if (huntDist < 12 * S) { g.body.mouthTarget = 1; if (!g.body.tongue) g.flick(); }
      if (sd.lungeTimer > 60 || huntDist < 8 * S || huntLost) return { targetSpeed: approachSpeed, transition: STATE.IDLE };
      return { targetSpeed: g.c.opts.reducedMotion ? Math.min(approachSpeed, g.speed) : approachSpeed };
    },
  },

  [STATE.STARTLE]: {
    enter(g) { g.stateData = { freezeDuration: 10 + Math.random() * 15 }; },
    update(g) {
      if (g.stateTimer > g.stateData.freezeDuration) return { targetSpeed: 0, transition: STATE.FLEE };
      return { targetSpeed: 0 };
    },
  },

  [STATE.FLEE]: {
    enter(g) {
      const baseFlee = g.traits.resolve('fleeDuration');
      g.stateData = { duration: (baseFlee + Math.random() * baseFlee) * (g.mildScare ? 0.5 : 1) };
      const head = g.head;
      g.targetAngle = Math.atan2(head.y - g.threatY, head.x - g.threatX) + (Math.random() - 0.5) * 0.8;
      g.angle = lerpAngle(g.angle, g.targetAngle, 0.5);
    },
    update(g) {
      // Bolt for the nearest panel leading away from the threat, if there is one.
      if (HIDING && g.stateTimer === 1 && g.findCover(110, { x: g.threatX, y: g.threatY })) { g.hideFast = true; return { targetSpeed: g.speed, transition: STATE.HIDE }; }
      const mult = g.mildScare || g.c.opts.reducedMotion ? 1.2 : g.traits.resolve('fleeMultiplier');
      const targetSpeed = g.speed * mult;
      g.targetAngle += Math.sin(g.burstTimer * 0.3) * 0.15;
      g.steerFromWalls(20 * S, 0.5);
      if (g.stateTimer > g.stateData.duration) return { targetSpeed, transition: STATE.IDLE };
      return { targetSpeed };
    },
  },

  [STATE.SLEEP]: {
    enter(g) {
      const baseSleep = g.traits.resolve('sleepDuration');
      g.stateData = { duration: baseSleep + Math.random() * baseSleep * 1.3, nextPeekTime: 60 + Math.random() * 100, peekUntil: 0, wakeAt: 0 };
      g.sleepPeeking = false;
      g.body.curlDir = Math.random() > 0.5 ? 1 : -1;
    },
    update(g) {
      const t = g.stateTimer, sd = g.stateData;
      // Now and then it peeks out from under its lids.
      if (t > sd.nextPeekTime) {
        g.sleepPeeking = true;
        sd.peekUntil = t + 36 + Math.random() * 24;
        sd.nextPeekTime = t + 80 + Math.random() * 150;
        if (Math.random() < 0.5) g.headLook.look();
      }
      if (g.sleepPeeking && t > sd.peekUntil) g.sleepPeeking = false;
      // While you're away it stays asleep; when you come back it wakes shortly after.
      if (g.userIdle) { sd.duration = Math.max(sd.duration, t + 60); g.needs.sleepiness = Math.max(g.needs.sleepiness, 0.5); sd.wakeAt = 0; }
      else if (g.forcedNap) {
        if (!sd.wakeAt) sd.wakeAt = t + 20 + Math.random() * 30;
        if (t > sd.wakeAt) { g.forcedNap = false; g.sleepPeeking = false; return { targetSpeed: 0, transition: STATE.IDLE }; }
      }
      if (!g.userIdle && !g.forcedNap && (t > sd.duration || g.needs.sleepiness < 0.1)) {
        g.sleepPeeking = false;
        return { targetSpeed: 0, transition: STATE.IDLE };
      }
      return { targetSpeed: 0 };
    },
  },

  [STATE.NIBBLE]: {
    enter(g) {
      g.stateData = { phase: 'approach', timer: 0, flicks: 0 };
      if (g.letterAt) g.planRoute(g.letterAt.x, g.letterAt.y);
    },
    update(g) {
      const sd = g.stateData, head = g.head;
      sd.timer++;
      if (sd.phase === 'grab' || sd.phase === 'carry' || sd.phase === 'eat') return stealing(g);
      const at = g.letterAt;
      if (!at || (g.typing && sd.phase === 'approach')) { g.dropLetter(); return { targetSpeed: 0.05 * S, transition: STATE.IDLE }; }
      // Measured from the tip of its snout as drawn (up on a paragraph it is drawn lifted a
      // little up the screen), so it is the snout that meets the letter, not the whole head.
      const tip = g.snout();
      const d = dist(tip.x, tip.y, at.x, at.y);
      const toLetter = Math.atan2(at.y - tip.y, at.x - tip.x);
      if (sd.phase === 'approach') {
        const wp = g.waypoint(at.x, at.y);
        g.targetAngle = d < 20 * S ? toLetter : Math.atan2(wp.y - head.y, wp.x - head.x);
        const burstPhase = g.burstTimer % 80;
        let targetSpeed = burstPhase < 15 ? 0.15 * S : burstPhase < 55 ? g.speed * 0.8 : 0.3 * S;
        // Creep the last few pixels, and stop dead with the snout touching it.
        if (d < 20 * S) targetSpeed = Math.min(targetSpeed, 0.3 * S);
        if (d < 6) targetSpeed = Math.min(targetSpeed, 0.12 * S);
        if (d < 1.8) { sd.phase = 'taste'; sd.timer = 0; g.currentSpeed = 0; return { targetSpeed: 0 }; }
        if (sd.timer > 1800) { g.dropLetter(); return { targetSpeed, transition: STATE.IDLE }; }
        return { targetSpeed };
      }
      g.headLook.lookAt(angleDiff(g.angle, toLetter));
      // Taste it first, a couple of times, then snatch it out of the word. Sometimes it
      // is stuck fast and takes a struggle to pull free.
      if (sd.timer % 30 === 5 && sd.flicks < 2) { g.flick(); sd.flicks++; }
      if (sd.timer > 75) {
        const stuck = Math.random() < g.stuckChance;
        sd.slot = { ...at };
        sd.toLetter = toLetter;
        if (!g.stealLetter(stuck)) return { targetSpeed: 0, transition: STATE.IDLE };
        sd.phase = 'grab'; sd.timer = 0;
        sd.stuck = stuck;
        sd.len = stuck ? 70 + Math.random() * 90 : 12;
      }
      return { targetSpeed: 0 };
    },
  },

  // Something opened over the workspace (a modal, the command palette): freeze and watch it.
  [STATE.WATCH]: {
    enter(g) { g.stateData = { nextBlink: 40 }; g.currentSpeed = 0; },
    update(g) {
      const w = g.watching, head = g.head, t = g.stateTimer;
      if (w) g.headLook.lookAt(angleDiff(g.angle, Math.atan2(w.y - head.y, w.x - head.x)));
      if (t > g.stateData.nextBlink) { g.blink(); g.stateData.nextBlink = t + 60 + Math.random() * 90; }
      // It went away (or this has gone on long enough): relax.
      if (!w || t > 3600) { g.watching = null; g.flick(); return { targetSpeed: 0, transition: STATE.IDLE }; }
      return { targetSpeed: 0 };
    },
  },

  // Stalking the caret as you type, or the pointer when it rests nearby: drawn to it and
  // a little afraid of it. It creeps in, stop-start, head locked on it, tail tip twitching
  // when it freezes, and keeps a little way off; if it comes too close it startles and
  // scurries back, watches a moment, and starts creeping in again.
  [STATE.LURK]: {
    enter(g) { g.stateData = { phase: 'stalk', spot: null, anchor: null, timer: 0, phaseTimer: 0, target: g.lurkTarget }; },
    update(g) {
      const sd = g.stateData, head = g.head, w = g.c.world;
      sd.timer++;
      sd.phaseTimer++;
      const caret = sd.target === 'caret';
      const k = caret ? w.caret ?? w.lastCaret : g.pointer;
      // You stopped typing (the close look at the new words is fresh ink's job), the pointer
      // went away, or it has lost interest.
      const gone = !k || (caret ? !g.c.input.typedWithin(g.c.now, 4000) : dist(head.x, head.y, k.x, k.y) > CURIOUS_RADIUS);
      if (gone || sd.timer > (caret ? 6000 : 2400)) {
        if (caret) g.lurkCooldown = 300; else g.curiousCooldown = 900;
        return { targetSpeed: 0.05 * S, transition: STATE.IDLE };
      }
      const near = dist(head.x, head.y, k.x, k.y);
      const toCaret = Math.atan2(k.y - head.y, k.x - head.x);

      if (sd.phase === 'scurry') {
        // Away, fast, to a safer distance.
        const wp = g.waypoint(sd.spot.x, sd.spot.y);
        g.targetAngle = Math.atan2(wp.y - head.y, wp.x - head.x);
        if (dist(head.x, head.y, sd.spot.x, sd.spot.y) < 5 || sd.phaseTimer > 70) { sd.phase = 'wary'; sd.phaseTimer = 0; sd.waryFor = 50 + Math.random() * 50; g.currentSpeed = 0; }
        return { targetSpeed: g.speed * 2.2 };
      }
      if (sd.phase === 'wary') {
        // Frozen, head turned to watch it, before it dares to creep back in. (It turns its
        // head rather than shuffling round, which in a tight spot tied it in knots.)
        g.headLook.lookAt(angleDiff(g.angle, toCaret));
        if (sd.phaseTimer > sd.waryFor) { sd.phase = 'stalk'; sd.phaseTimer = 0; sd.spot = null; }
        return { targetSpeed: 0 };
      }

      // Too close, or right in the path of the line being written: startle and scurry back.
      // Out in the open, a pointer that comes slowly is allowed close: it holds still,
      // watching, and lets itself be petted. Anywhere near the words, or if it comes in a
      // rush, it is too much.
      const gentle = !caret && !g.nearText() && g.cursorSpeed < 2 * S;
      if (near < 20 && gentle) { sd.frozen = true; return { targetSpeed: 0 }; }
      if (near < 20 || (caret && Math.abs(head.y - k.y) < 7 && Math.abs(head.x - k.x) < 40)) {
        g.scurryFrom(k);
        return { targetSpeed: g.speed * 2.2 };
      }
      // A spot a little way off, re-chosen as the caret moves along.
      if (!sd.spot || dist(sd.anchor.x, sd.anchor.y, k.x, k.y) > 10) {
        sd.spot = g.lurkSpot(k, caret);
        sd.anchor = { ...k };
        g.planRoute(sd.spot.x, sd.spot.y);
      }
      g.headLook.lookAt(angleDiff(g.angle, toCaret));
      const d = dist(head.x, head.y, sd.spot.x, sd.spot.y);
      if (g.arrived(sd)) return { targetSpeed: 0 };
      const wp = g.waypoint(sd.spot.x, sd.spot.y);
      g.targetAngle = Math.atan2(wp.y - head.y, wp.x - head.x);
      // From afar it hurries closer; falling behind as you type along, it catches up at a
      // walk; within striking range it stalks: creep, freeze, creep.
      if (d > 50) { sd.frozen = false; return { targetSpeed: g.speed * 1.3 }; }
      if (d > 20) { sd.frozen = false; return { targetSpeed: g.speed }; }
      sd.frozen = sd.phaseTimer % 60 >= 34;
      return { targetSpeed: sd.frozen ? 0 : 0.8 * S };
    },
  },

  // The pointer is resting some way off: mild interest. It turns to look, and drifts a
  // little closer now and then, unhurried; close enough, it stalks it as it does the caret.
  [STATE.CURIOUS]: {
    enter(g) { g.stateData = { spot: null, anchor: null, timer: 0, leaveAt: 1200 + Math.random() * 1200, keep: STALK_RADIUS + 12, waited: 0 }; },
    update(g) {
      const sd = g.stateData, head = g.head, p = g.pointer, w = g.c.world;
      sd.timer++;
      if (!p || sd.timer > sd.leaveAt) { g.curiousCooldown = 600 + Math.random() * 900; return { targetSpeed: 0.05 * S, transition: STATE.IDLE }; }
      const d = dist(head.x, head.y, p.x, p.y);
      if (d > CURIOUS_RADIUS * 1.2) return { targetSpeed: 0.05 * S, transition: STATE.IDLE };
      if (d < STALK_RADIUS) { g.lurkTarget = 'pointer'; return { targetSpeed: 0, transition: STATE.LURK }; }
      const toP = Math.atan2(p.y - head.y, p.x - head.x);
      g.headLook.lookAt(angleDiff(g.angle, toP));
      // A spot a little nearer, kept to as the pointer moves.
      if (!sd.spot || dist(sd.anchor.x, sd.anchor.y, p.x, p.y) > 15) {
        const a = Math.atan2(head.y - p.y, head.x - p.x) + (Math.random() - 0.5) * 0.6, r = sd.keep + Math.random() * 6;
        sd.spot = w.clampToBounds(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 8);
        sd.anchor = { ...p };
        g.planRoute(sd.spot.x, sd.spot.y);
      }
      if (g.arrived(sd)) {
        // Having watched a while, it dares a little closer — until it is close enough to stalk.
        if (++sd.waited > 120 + Math.random() * 60) { sd.waited = 0; sd.keep -= 12; sd.spot = null; }
        if (sd.timer % 200 === 100) g.flick();
        return { targetSpeed: 0 };
      }
      // Unhurried: a few steps, a look, a few more.
      const wp = g.waypoint(sd.spot.x, sd.spot.y);
      g.targetAngle = Math.atan2(wp.y - head.y, wp.x - head.x);
      if (sd.timer % 200 === 150) g.flick();
      return { targetSpeed: sd.timer % 100 < 50 ? g.speed * 0.6 : 0 };
    },
  },

  // You stopped typing: come and sniff along the words you just wrote.
  [STATE.INSPECT]: {
    enter(g) {
      g.stateData = { phase: 'go', timer: 0, sniffs: 0 };
      const k = g.inkAt;
      if (k) g.planRoute(k.x, k.y);
    },
    update(g) {
      const sd = g.stateData, k = g.inkAt, head = g.head;
      sd.timer++;
      // Back to typing: leave it be.
      if (!k || g.c.input.typedWithin(g.c.now, 300)) return { targetSpeed: 0.05 * S, transition: STATE.IDLE };
      const tip = g.snout();
      const d = dist(tip.x, tip.y, k.x, k.y);
      if (sd.phase === 'go') {
        const wp = g.waypoint(k.x, k.y);
        g.targetAngle = d < 12 ? Math.atan2(k.y - tip.y, k.x - tip.x) : Math.atan2(wp.y - head.y, wp.x - head.x);
        const burstPhase = g.burstTimer % 80;
        let targetSpeed = burstPhase < 15 ? 0.15 * S : burstPhase < 55 ? g.speed : 0.3 * S;
        if (d < 12) targetSpeed = Math.min(targetSpeed, 0.15 * S);
        if (d < 3) { sd.phase = 'sniff'; sd.timer = 0; g.currentSpeed = 0; }
        if (sd.timer > 1200) return { targetSpeed, transition: STATE.IDLE };
        return { targetSpeed };
      }
      // Work back along the new words, nose down, tasting them as it goes.
      g.targetAngle = Math.PI;
      if (sd.timer % 22 === 8) { g.flick(); sd.sniffs++; }
      g.headLook.lookAt(Math.sin(sd.timer * 0.15) * 0.35);
      if (sd.sniffs >= 4 + Math.floor(Math.random() * 3) || sd.timer > 260) {
        g.inkAt = null;
        return { targetSpeed: 0, transition: STATE.IDLE };
      }
      return { targetSpeed: sd.timer % 22 < 10 ? 0 : 0.12 * S };
    },
  },

  // Picked up by the user. The body dangles and squirms; the mind just waits to be let go.
  [STATE.HELD]: {
    enter(g) { g.stateData = {}; g.currentSpeed = 0; },
    update(g) {
      if (g.stateTimer % 40 === 15) g.flick();
      return { targetSpeed: 0 };
    },
  },

  // Under a side panel: approach its edge, slip under, wait, turn round, peek out and
  // look about, then come out — or think better of it and go back under.
  [STATE.HIDE]: {
    enter(g) {
      g.stateData = { phase: g.hideFast ? 'slip' : 'approach', timer: 0, wait: 0, looks: 0 };
      if (g.cover && !g.hideFast) g.planRoute(g.cover.x - g.cover.nx * 8, g.cover.y - g.cover.ny * 8);
    },
    update(g) {
      const sd = g.stateData, e = g.cover, head = g.head;
      if (!e) return { targetSpeed: 0.05 * S, transition: STATE.IDLE };
      sd.timer++;
      // How far the head is past the panel's edge (negative: still outside).
      const depth = (head.x - e.x) * e.nx + (head.y - e.y) * e.ny;
      const out = Math.atan2(-e.ny, -e.nx);
      if (sd.phase !== 'approach' && !g.c.world.coverAt(e.x + e.nx * 3, e.y + e.ny * 3)) {
        // The panel went away and left it out in the open.
        g.cover = null;
        g.scare(e.x + e.nx * 20, e.y);
        return { targetSpeed: 0 };
      }
      switch (sd.phase) {
        case 'approach': {
          const ox = e.x - e.nx * 8, oy = e.y - e.ny * 8;
          const wp = g.waypoint(ox, oy);
          g.targetAngle = Math.atan2(wp.y - head.y, wp.x - head.x);
          const burstPhase = g.burstTimer % 80;
          const targetSpeed = burstPhase < 15 ? 0.15 * S : burstPhase < 55 ? g.speed : 0.3 * S;
          if (dist(head.x, head.y, ox, oy) < 6) { sd.phase = 'slip'; g.flick(); }
          if (sd.timer > 900) { g.cover = null; return { targetSpeed, transition: STATE.EXPLORE }; }
          return { targetSpeed };
        }
        case 'slip': {
          g.body.under = true;
          g.targetAngle = Math.atan2(e.y + e.ny * e.depth - head.y, e.x + e.nx * e.depth - head.x);
          const targetSpeed = g.hideFast ? g.speed * g.traits.resolve('fleeMultiplier') : g.speed * 0.8;
          if (depth > e.depth - 4) {
            sd.phase = 'under'; sd.timer = 0;
            sd.wait = (120 + Math.random() * 240) * (g.hideFast ? 1.5 : 1) * (1 - g.needs.hungerFactor * 0.5);
            g.hideFast = false;
          }
          return { targetSpeed };
        }
        case 'under':
          if (sd.timer > sd.wait) { sd.phase = 'turn'; sd.timer = 0; }
          return { targetSpeed: 0 };
        case 'turn':
          g.targetAngle = out;
          if (Math.abs(angleDiff(g.angle, out)) < 0.25) { sd.phase = 'peek'; sd.timer = 0; }
          return { targetSpeed: 0.3 * S };
        case 'peek':
          // Back to the edge at a walk, then creep the last bit until just the head is out.
          g.targetAngle = out;
          if (depth < -3) { sd.phase = 'look'; sd.timer = 0; sd.looks = 2 + Math.floor(Math.random() * 3); }
          return { targetSpeed: depth > 8 ? g.speed * 0.7 : 0.3 * S };
        default: {
          // Just the head out: look about and taste the air.
          if (sd.timer % 35 === 12) { g.headLook.look(); sd.looks--; }
          if (sd.timer % 45 === 25) g.flick();
          if (sd.timer % 50 === 40) g.blink();
          if (sd.looks <= 0) {
            if (Math.random() < 0.2 && !g.needs.canSleep()) { sd.phase = 'slip'; sd.timer = 0; return { targetSpeed: 0 }; }
            g.cover = null;
            g.hideCooldown = 2400 + Math.random() * 3000;
            return { targetSpeed: 0, transition: STATE.EXPLORE };
          }
          return { targetSpeed: 0 };
        }
      }
    },
  },
};

/**
 * After the snatch: a tug to pull it free, off to a quiet spot with it, and eat it there,
 * chewing, crumbs falling, until it's gone.
 */
function stealing(g: Personality): Result {
  const sd = g.stateData, head = g.head, b = g.body;
  if (sd.phase === 'grab') {
    b.mouthTarget = 1;
    if (sd.stuck) {
      // Jaws clamped, it braces and wrenches its head side to side in bursts.
      const t = sd.timer, burst = Math.floor(t / 28) % 2 === 0;
      g.headLook.lookAt(angleDiff(g.angle, sd.toLetter) + Math.sin(t * 0.85) * (burst ? 0.5 : 0.12));
      g.c.reactions.tug(burst ? 0.55 + 0.45 * Math.abs(Math.sin(t * 0.42)) : 0.3);
    }
    if (sd.timer > sd.len) {
      if (sd.stuck) {
        // Pop: it comes free, scattering a few crumbs from where it was.
        g.c.particles.burst(sd.slot.x, sd.slot.y, g.c.pal.ink, 3, 10);
        g.flick();
      }
      g.c.reactions.free();
      b.mouthTarget = 0.35;
      sd.spot = g.eatingSpot();
      g.planRoute(sd.spot.x, sd.spot.y);
      sd.phase = 'carry'; sd.timer = 0;
    }
    // A moment, jaws clamped, to pull it free.
    return { targetSpeed: 0 };
  }
  if (sd.phase === 'carry') {
    const wp = g.waypoint(sd.spot.x, sd.spot.y);
    g.targetAngle = Math.atan2(wp.y - head.y, wp.x - head.x);
    const burstPhase = g.burstTimer % 70;
    const targetSpeed = burstPhase < 10 ? 0.2 * S : burstPhase < 50 ? g.speed : 0.35 * S;
    if (dist(head.x, head.y, sd.spot.x, sd.spot.y) < 6 || sd.timer > 600) { sd.phase = 'eat'; sd.timer = 0; }
    return { targetSpeed };
  }
  // Eat: jaws working, head bobbing, the letter shrinking bite by bite.
  const t = sd.timer, EAT = 120;
  b.mouthTarget = Math.floor(t / 7) % 2 === 0 ? 0.6 : 0.1;
  g.headLook.lookAt(Math.sin(t * 0.5) * 0.2);
  g.c.reactions.chew(1 - t / EAT);
  if (t % 22 === 11) {
    const s = g.snout();
    g.c.particles.burst(s.x, s.y, g.c.pal.ink, 2, 8);
  }
  if (t > EAT) {
    g.c.reactions.finish(true);
    g.carrying = false;
    b.mouthTarget = 0;
    g.needs.feed(4);
    g.flick();
    return { targetSpeed: 0, transition: STATE.IDLE };
  }
  return { targetSpeed: 0 };
}

// ═══════════════════════════════════════════════════════════════════
// PERSONALITY — orchestrator
// ═══════════════════════════════════════════════════════════════════

const NIBBLE_FIRST: [number, number] = [60, 120];
const NIBBLE_EVERY: [number, number] = [150, 330];

export class Personality {
  readonly traits: TraitEngine;
  readonly needs: Needs;
  angle: number;
  targetAngle: number;
  speed: number;
  currentSpeed = 0;
  burstTimer = 0;

  headLook = new HeadLookBehavior();

  state: State = STATE.IDLE;
  stateTimer = 0;
  // Per-state scratch; each handler owns its own shape, as in the original.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stateData: any = {};
  destX = 0;
  destY = 0;
  homeX = 0;
  homeY = 0;
  targetBug: Bug | null = null;
  sleepPeeking = false;
  cursorSpeed = 0;
  private lastCursor: { x: number; y: number } | null = null;

  threatX = 0;
  threatY = 0;
  mildScare = false;
  petted = false;
  forcedNap = false;
  entering: boolean;
  typing = false;
  userIdle = false;
  private petTimer = 0;
  /** The panel it is heading under or hiding beneath. */
  cover: CoverEntry | null = null;
  hideFast = false;
  /** Has a stolen letter in its mouth. */
  carrying = false;
  /** Something to chase that isn't a bug: a notice, a dragged item (art px). */
  lure: { x: number; y: number } | null = null;
  private lureTicks = 0;
  /** For a notice: is it still on screen? */
  private lureThere: (() => boolean) | null = null;
  /** What it is watching (a modal's centre). */
  watching: { x: number; y: number } | null = null;
  /** The end of what you just wrote, to come and sniff. */
  inkAt: { x: number; y: number } | null = null;
  /** Ticks before it will come and lurk by your typing again. */
  lurkCooldown = 0;
  /** What it is (about to be) stalking from a distance. */
  lurkTarget: 'caret' | 'pointer' = 'caret';
  /** Ticks before the pointer can catch its eye again. */
  curiousCooldown = 0;
  /** How often a letter is stuck fast and takes a struggle to pull free. */
  stuckChance = 0.45;
  private route: Waypoint[] | null = null;
  private routeAt = 0;
  private routeTo: { x: number; y: number } | null = null;
  /** Ticks until it will hide again of its own accord. */
  hideCooldown = 0;
  private mouthTicks = 0;

  letter: NibbleTarget | null = null;
  letterAt: { x: number; y: number } | null = null;
  private letterSince = 0;
  private nextNibble: number;
  private trackIn = 0;

  constructor(readonly c: Ctx, entering: boolean) {
    this.traits = new TraitEngine(c.opts.traits ?? rollTraits(), TRAIT_BUDGET);
    this.needs = new Needs(this.traits);
    this.angle = this.targetAngle = c.body.heading;
    this.speed = this.traits.resolve('baseSpeed') * S;
    this.entering = entering;
    this.nextNibble = c.now + rand(...NIBBLE_FIRST) * 1000;
    this.chooseHome();
    if (entering) {
      this.enterState(STATE.EXPLORE);
      const b = c.world.bounds;
      this.destX = b.x + rand(40, 70);
      this.destY = c.body.head.y;
      // It comes in from under the side panels and stops once it's out in the open.
      for (let r = c.world.coverAt(this.destX, this.destY); r; r = c.world.coverAt(this.destX, this.destY)) this.destX = r.x + r.w + rand(12, 30);
    } else this.enterState(STATE.IDLE);
  }

  get body() { return this.c.body; }
  /** The pointer, unless the gecko is under a panel and the pointer is on top of it. */
  get pointer() { const p = this.c.pointer; return p && !(this.body.under && this.c.world.coverAt(p.x, p.y)) ? p : null; }

  /** Wary geckos like to get under things. */
  wantsCover() {
    if (!HIDING || this.hideCooldown > 0) return false;
    if (Math.random() > 0.02 + 0.06 * (this.traits.traits.awareness ?? 0.5)) return false;
    this.hideFast = false;
    return this.findCover(150);
  }

  findCover(range: number, threat?: { x: number; y: number }) {
    this.cover = this.c.world.coverEntry(this.head.x, this.head.y, range, threat);
    return !!this.cover;
  }
  get head() { return this.c.body.head; }
  distTo(x: number, y: number) { return dist(this.head.x, this.head.y, x, y); }

  flick() { this.body.flickTongue('flick'); }
  blink() { this.body.blink(); }

  enterState(state: State) {
    // Interrupted with a stolen letter in its mouth: it drops it.
    if (this.carrying && state !== STATE.NIBBLE) { this.c.reactions.finish(false); this.carrying = false; }
    // Coming to rest under a panel (after a dash, say) is hiding: it will peek out.
    if ((state === STATE.IDLE || state === STATE.BASKING) && this.body.under && this.c.world.coverAt(this.head.x, this.head.y) && this.findCover(200)) {
      state = STATE.HIDE;
      this.hideFast = false;
    }
    this.state = state;
    this.stateTimer = 0;
    this.stateData = {};
    StateHandlers[state].enter(this);
    if (state === STATE.HIDE && this.body.under && this.c.world.coverAt(this.head.x, this.head.y) && this.stateData.phase === 'approach') {
      this.stateData.phase = 'under';
      this.stateData.wait = 60 + Math.random() * 120;
    }
  }

  /** Home is a quiet corner: the inner bottom corner of a panel, or of the window. */
  chooseHome() {
    const b = this.c.world.bounds;
    const pool = this.corners();
    const c = pool.length ? pool[Math.floor(Math.random() * pool.length)] : { x: b.x + 25, y: b.y + b.h - 25 };
    this.homeX = c.x;
    this.homeY = c.y;
  }

  private corners() {
    const out: { x: number; y: number }[] = [];
    for (const r of this.c.world.surfaces) {
      if (r.w < 50 || r.h < 50) continue;
      out.push({ x: r.x + 14, y: r.y + r.h - 14 }, { x: r.x + r.w - 14, y: r.y + r.h - 14 });
    }
    const b = this.c.world.bounds;
    out.push({ x: b.x + 16, y: b.y + b.h - 16 }, { x: b.x + b.w - 16, y: b.y + b.h - 16 });
    return out.filter((p) => this.c.world.inBounds(p.x, p.y, 8));
  }

  nearestSeam(within: number) {
    const h = this.head;
    let best = null, bd = within;
    for (const s of this.c.world.edges) {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const u = clamp(((h.x - s.x1) * dx + (h.y - s.y1) * dy) / (s.len * s.len), 0, 1);
      const d = dist(h.x, h.y, s.x1 + dx * u, s.y1 + dy * u);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /**
   * Turn back from the window edges, the shortest way round — unless it is heading for
   * somewhere up against that edge on purpose (a tab, say).
   */
  steerFromWalls(margin: number, rate: number, toDest = false) {
    const h = this.head, b = this.c.world.bounds;
    const m = margin + 4;
    const ok = (near: boolean) => !(toDest && near);
    if (h.x < b.x + margin && ok(this.destX < b.x + m)) this.targetAngle = lerpAngle(this.targetAngle, 0, rate);
    else if (h.x > b.x + b.w - margin && ok(this.destX > b.x + b.w - m)) this.targetAngle = lerpAngle(this.targetAngle, Math.PI, rate);
    if (h.y < b.y + margin && ok(this.destY < b.y + m)) this.targetAngle = lerpAngle(this.targetAngle, Math.PI / 2, rate);
    else if (h.y > b.y + b.h - margin && ok(this.destY > b.y + b.h - m)) this.targetAngle = lerpAngle(this.targetAngle, -Math.PI / 2, rate);
  }

  /** Pick somewhere to go and work out how to get there. */
  pickDestination() {
    this.chooseDestination();
    this.planRoute(this.destX, this.destY);
  }

  /** Plan a way over the terrain to (x, y). */
  planRoute(x: number, y: number) {
    this.route = findRoute(this.c.world, this.head.x, this.head.y, x, y);
    this.routeAt = 0;
    this.routeTo = { x, y };
  }

  /**
   * Where to steer now on the way to (x, y): the next waypoint of the planned route.
   * Every few seconds, or if it has been pushed off course, it looks again: the note
   * scrolls and panels move.
   */
  waypoint(x: number, y: number): Waypoint {
    const h = this.head, to = this.routeTo;
    if (!this.route || !to || dist(to.x, to.y, x, y) > 4 || this.burstTimer % 180 === 0) this.planRoute(x, y);
    const r = this.route;
    if (!r || !r.length) return { x, y };
    while (this.routeAt < r.length - 1 && dist(h.x, h.y, r[this.routeAt].x, r[this.routeAt].y) < 6) this.routeAt++;
    const wp = r[this.routeAt];
    if (dist(h.x, h.y, wp.x, wp.y) > 40) { this.planRoute(x, y); return this.route?.[0] ?? { x, y }; }
    return wp;
  }

  private chooseDestination() {
    const w = this.c.world, b = w.bounds;
    const set = (x: number, y: number) => { const q = w.clampToBounds(x, y, 12); this.destX = q.x; this.destY = q.y; };
    if (this.needs.wantsSleepSoon() || this.forcedNap) { set(this.homeX, this.homeY); return; }
    const f = this.needs.fullness;
    const homeUrge = f > 0.9 ? 0.95 : f > 0.5 ? (f - 0.5) * 0.6 : 0;
    if (homeUrge > 0 && Math.random() < homeUrge) { set(this.homeX + (Math.random() - 0.5) * 22, this.homeY + (Math.random() - 0.5) * 22); return; }
    // Destinations stay within a few body lengths: a workspace is far bigger, in lizard
    // terms, than the prototype's canvas was.
    const h = this.head;
    const near = (x: number, y: number) => 1 / (1 + dist(h.x, h.y, x, y) / 70);
    const weighted = <T>(items: T[], weight: (t: T) => number): T | undefined => {
      let k = Math.random() * items.reduce((a, t) => a + weight(t), 0);
      for (const t of items) { k -= weight(t); if (k <= 0) return t; }
      return items[0];
    };
    // Now and then, climb up onto something: a tab, or a heading.
    if (w.perches.length && Math.random() < 0.12) {
      const p = weighted(w.perches, (r) => near(r.x + r.w / 2, r.y + r.h / 2));
      if (p && dist(h.x, h.y, p.x + p.w / 2, p.y + p.h / 2) < 190) {
        const q = w.clampToBounds(p.x + p.w * (0.25 + Math.random() * 0.5), p.y + p.h / 2, 4);
        this.destX = q.x; this.destY = q.y;
        return;
      }
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      const r = Math.random();
      let x: number, y: number;
      if (r < 0.35 && w.edges.length) {
        // Somewhere along a seam: longer and closer seams are likelier.
        const e = weighted(w.edges, (s) => s.len * near((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2))!;
        const u = Math.random();
        x = e.x1 + (e.x2 - e.x1) * u; y = e.y1 + (e.y2 - e.y1) * u;
      } else if (r < 0.5) {
        const c = weighted(this.corners(), (p) => near(p.x, p.y) ** 2) ?? { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        x = c.x; y = c.y;
      } else {
        const a = Math.random() * Math.PI * 2, d = 25 + Math.random() * 75;
        x = h.x + Math.cos(a) * d; y = h.y + Math.sin(a) * d;
      }
      if (dist(h.x, h.y, x, y) > 190 || dist(h.x, h.y, x, y) < 12) continue;
      // Anywhere goes, the sidebars and tabs included; it sits on your words only now and then.
      ({ x, y } = w.clampToBounds(x, y, 12));
      if (w.onText(x, y, 3) && Math.random() < 0.75) continue;
      // The note is home ground; up on a panel is an excursion.
      if (w.groundAt(x, y) >= 6 && Math.random() < 0.65) continue;
      // Leave the place you're typing alone.
      if (this.typing && w.caret && dist(x, y, w.caret.x, w.caret.y) < 45) continue;
      set(x, y);
      return;
    }
    set(this.homeX, this.homeY);
  }

  /** Something alarming at (x, y): a poke, a panel snapping open, typing right next to it. */
  scare(x: number, y: number, mild = false) {
    if (this.state === STATE.FLEE || this.state === STATE.STARTLE || this.state === STATE.HELD) return;
    this.threatX = x;
    this.threatY = y;
    this.mildScare = mild || this.c.opts.reducedMotion;
    this.forcedNap = false;
    this.petted = false;
    this.petTimer = 0;
    this.enterState(mild ? STATE.FLEE : STATE.STARTLE);
  }

  /** Lifted off the ground by the user. */
  pickUp() {
    this.dropLetter();
    this.cover = null;
    this.forcedNap = false;
    this.petted = false;
    this.petTimer = 0;
    this.enterState(STATE.HELD);
  }

  /** Set down again: a moment frozen where it landed, then off it scurries. */
  putDown() {
    const b = this.body;
    this.angle = this.targetAngle = b.heading;
    // The threat is behind it, so it runs the way it is facing.
    this.threatX = b.pts[12].x;
    this.threatY = b.pts[12].y;
    this.mildScare = this.c.opts.reducedMotion;
    this.enterState(STATE.STARTLE);
  }

  /** Is it calm enough to take an interest in something new? */
  get calm() {
    const s = this.state;
    return s === STATE.IDLE || s === STATE.EXPLORE || s === STATE.BASKING || s === STATE.LURK || s === STATE.CURIOUS;
  }

  /**
   * Is it at `sd.spot`, near enough? Close by, a spot that is off to the side or behind
   * would take a circle to reach — it can't turn on the spot — so it settles where it is.
   */
  arrived(sd: { spot: { x: number; y: number }; spin?: number; spinAt?: number; spinFrom?: number; lastAngle?: number }) {
    const h = this.head, d = dist(h.x, h.y, sd.spot.x, sd.spot.y);
    const settle = () => { sd.spot = { x: h.x, y: h.y }; sd.spin = 0; return true; };
    if (d < 6) return true;
    if (d < 18 && Math.abs(angleDiff(this.angle, Math.atan2(sd.spot.y - h.y, sd.spot.x - h.x))) > 1.2) return settle();
    // Turning and turning without getting any nearer means it is circling: stop.
    sd.spin = (sd.spin ?? 0) + Math.abs(angleDiff(sd.lastAngle ?? this.angle, this.angle));
    sd.lastAngle = this.angle;
    if (sd.spinAt === undefined || this.stateTimer - sd.spinAt > 45) {
      const circling = sd.spin > 2.1 && d > (sd.spinFrom ?? Infinity) - 3;
      sd.spin = 0; sd.spinAt = this.stateTimer; sd.spinFrom = d;
      if (circling) return settle();
    }
    return false;
  }

  /** Is any of its head or trunk on, or right by, the text of the note? */
  nearText() {
    const w = this.c.world, b = this.body;
    return [0, 6, 12, 18].some((i) => w.onText(b.pts[i].x, b.pts[i].y, 6));
  }

  /** Startle and dash from `from` (art px) to somewhere clear of the words, then watch warily. */
  scurryFrom(from: { x: number; y: number }) {
    const sd = this.stateData, h = this.head, w = this.c.world;
    const away = Math.atan2(h.y - from.y, h.x - from.x);
    let best: { x: number; y: number } | null = null, bestScore = -Infinity;
    for (const r of [24, 34, 46, 60, 76, 96, 120]) {
      for (let i = 0; i < 12; i++) {
        const a = away + ((i - 5.5) / 6) * Math.PI;
        const q = w.clampToBounds(h.x + Math.cos(a) * r, h.y + Math.sin(a) * r, 8);
        if (w.onText(q.x, q.y, 8) || dist(q.x, q.y, from.x, from.y) < 26) continue;
        // Nearest clear ground, leaning away from what it is fleeing.
        const score = Math.cos(angleDiff(away, a)) * 20 - r;
        if (score > bestScore) { bestScore = score; best = q; }
      }
      if (best) break;
    }
    sd.phase = 'scurry';
    sd.phaseTimer = 0;
    sd.spot = best ?? w.clampToBounds(h.x + Math.cos(away) * 40, h.y + Math.sin(away) * 40, 8);
    this.planRoute(sd.spot.x, sd.spot.y);
    this.flick();
  }

  /** Where to stalk the caret from: a little way off, on its own side, off the words if it can. */
  lurkSpot(k: { x: number; y: number }, caret = true) {
    const w = this.c.world, h = this.head;
    const side = Math.atan2(h.y - k.y, h.x - k.x);
    let fallback: { x: number; y: number } | null = null;
    for (let i = 0; i < 16; i++) {
      const a = side + (Math.random() - 0.5) * 1.8, d = 26 + Math.random() * 8;
      const q = w.clampToBounds(k.x + Math.cos(a) * d, k.y + Math.sin(a) * d, 8);
      fallback ??= q;
      // Clear of the line being typed (and the one a new line would start on), off the words.
      if ((!caret || Math.abs(q.y - k.y) >= 11) && !w.onText(q.x, q.y, 2)) return q;
    }
    return fallback!;
  }

  /** A modal opened over the workspace (its centre, art px), or closed (null). */
  modalChanged(at: { x: number; y: number } | null) {
    this.watching = at;
    if (at && (this.calm || this.state === STATE.NIBBLE || this.state === STATE.INSPECT || this.state === STATE.HUNT)) this.enterState(STATE.WATCH);
  }

  /** A notice popped up just here (art px): hurry over, and pounce if it's still there. */
  noticed(at: { x: number; y: number }, stillThere: () => boolean) {
    if (!this.calm || this.distTo(at.x, at.y) > 260) return;
    this.lure = at;
    this.lureTicks = 1200;
    this.lureThere = stillThere;
    this.summon(at);
    this.stateData.forLure = true;
  }

  /** Something is being dragged around here (art px), or was dropped (null): prey. */
  dragged(at: { x: number; y: number } | null) {
    this.lure = at;
    this.lureTicks = at ? 60 : 0;
    this.lureThere = null;
    if (at && this.calm && this.distTo(at.x, at.y) < 120) { this.targetBug = null; this.enterState(STATE.HUNT); }
  }

  /** A different note is open: everything around it has changed. Have a look round. */
  newSurroundings() {
    this.route = null;
    if (!this.calm) return;
    this.enterState(STATE.IDLE);
    this.stateData.nextLookTime = 5;
    this.stateData.nextTongueTime = 25;
  }

  /** The page it is standing on scrolled by (dx, dy) art px: everything it had in mind moved too. */
  shifted(dx: number, dy: number) {
    this.destX += dx; this.destY += dy;
    if (this.route) for (const p of this.route) { p.x += dx; p.y += dy; }
    if (this.routeTo) { this.routeTo.x += dx; this.routeTo.y += dy; }
    if (this.inkAt) { this.inkAt.x += dx; this.inkAt.y += dy; }
  }

  summon(target: { x: number; y: number }) {
    this.enterState(STATE.EXPLORE);
    this.destX = target.x;
    this.destY = target.y;
  }

  /** Shortest distance from (x, y) to the head and trunk as drawn (lifted by height). */
  bodyDistance(x: number, y: number) {
    const b = this.body;
    let best = Infinity;
    for (let i = 0; i < TAIL_FIRST; i += 2) {
      const p = b.project(b.pts[i].x, b.pts[i].y, b.z[i]);
      best = Math.min(best, dist(p.x, p.y, x, y) - halfWidth(i) * (1 + NEARER * Math.max(0, b.z[i])));
    }
    return best;
  }

  preyAlive(b: Bug) { return b.alive && b.state !== 'leaving'; }

  dropLetter() { this.letter = null; this.letterAt = null; }

  /** Snatch the target letter out of its word: hidden there, and now in its mouth (or stuck). */
  stealLetter(stuck = false) {
    const t = this.letter;
    this.dropLetter();
    if (!t || !this.c.nibbler.bite(t)) return false;
    this.c.reactions.carry(t.range, t.ch, stuck);
    this.carrying = true;
    this.body.flickTongue();
    return true;
  }

  /** Where the snout tip is, in art px (as drawn). */
  snout() {
    const b = this.body, a = b.headAngle;
    return b.project(b.pts[0].x + Math.cos(a) * 1.5, b.pts[0].y + Math.sin(a) * 1.5, b.z[0]);
  }

  /** Somewhere quiet nearby to eat: off the words, out in the open. */
  eatingSpot() {
    const w = this.c.world, h = this.head;
    for (let i = 0; i < 16; i++) {
      const a = this.angle + Math.PI + (Math.random() - 0.5) * 2.4, d = 20 + Math.random() * 25;
      const q = w.clampToBounds(h.x + Math.cos(a) * d, h.y + Math.sin(a) * d, 10);
      if (w.groundAt(q.x, q.y) === 0 && !w.onText(q.x, q.y, 3)) return q;
    }
    return { x: h.x, y: h.y };
  }

  get stateName() { return this.state + (this.petted ? '+petted' : ''); }

  // ── Perception ────────────────────────────────────────────────

  private checkInterrupts(cursorDist: number) {
    const st = this.state, p = this.pointer;
    if (p && st !== STATE.STARTLE && st !== STATE.FLEE && st !== STATE.HUNT) {
      if (this.cursorSpeed > this.traits.resolve('startleSpeed') * S && cursorDist < this.traits.resolve('startleDist') * S) { this.scareFrom(p); return; }
    }
    // On or by the text, a pointer coming near always sends it scurrying clear of the words,
    // so it is never in the way of a click there.
    const scurrying = st === STATE.LURK && this.stateData.phase === 'scurry';
    if (p && !scurrying && this.calm && cursorDist < 30 && this.bodyDistance(p.x, p.y) < 14 && this.nearText()) {
      this.lurkTarget = 'pointer';
      this.enterState(STATE.LURK);
      this.scurryFrom(p);
      return;
    }
    // A resting pointer catches its eye from some way off (it never hunts it).
    if (p && !this.petted && !this.typing && (st === STATE.IDLE || st === STATE.BASKING || st === STATE.EXPLORE)) {
      if (cursorDist < CURIOUS_RADIUS && this.cursorSpeed < 4 * S && this.curiousCooldown <= 0 && Math.random() < 0.01) {
        this.enterState(STATE.CURIOUS);
        return;
      }
    }
    if (this.needs.hunger >= 90 && st !== STATE.SLEEP && st !== STATE.FLEE && st !== STATE.STARTLE && st !== STATE.HUNT) {
      if (this.distTo(this.homeX, this.homeY) < 80 * S && this.needs.sleepiness > 0.2) { this.enterState(STATE.SLEEP); return; }
    }
    if (st === STATE.SLEEP && this.targetBug && !this.userIdle && this.distTo(this.targetBug.x, this.targetBug.y) < 40 * S) { this.forcedNap = false; this.enterState(STATE.HUNT); return; }
    if (st === STATE.SLEEP && p && this.cursorSpeed > this.traits.resolve('startleSpeed') * 0.7 * S && cursorDist < this.traits.resolve('startleDist') * 1.3 * S) { this.scareFrom(p); return; }
    // You've gone quiet: head home and settle in.
    if (this.userIdle && st !== STATE.SLEEP && st !== STATE.HUNT && st !== STATE.FLEE && st !== STATE.STARTLE) {
      this.forcedNap = true;
      if (this.distTo(this.homeX, this.homeY) < 60 * S || st === STATE.BASKING) this.enterState(STATE.SLEEP);
      else if (st !== STATE.EXPLORE) this.enterState(STATE.EXPLORE);
    }
  }

  private scareFrom(p: { x: number; y: number }) {
    this.threatX = p.x;
    this.threatY = p.y;
    this.mildScare = this.c.opts.reducedMotion;
    this.forcedNap = false;
    this.petted = false;
    this.petTimer = 0;
    this.enterState(STATE.STARTLE);
  }

  private detectBugs() {
    const head = this.head;
    const keep = this.state === STATE.HUNT ? this.targetBug : null;
    this.targetBug = null;
    let nearest = this.needs.sightRange;
    for (const bug of this.c.swarm.bugs) {
      if (!this.preyAlive(bug)) continue;
      const bd = dist(head.x, head.y, bug.x, bug.y);
      if (bd < nearest) { nearest = bd; this.targetBug = bug; }
      if (bd < 10 * S && bug.catchable) {
        bug.alive = false;
        this.needs.feed(bug.kind === 'cricket' ? 40 : 15);
        this.flick();
        this.mouthTicks = 10;
        this.c.particles.burst(bug.x, bug.y, this.c.pal.wing, 2, 8);
      }
      // Prey that sees the lizard coming may bolt; a stalking lizard is far harder to spot.
      const facing = Math.abs(angleDiff(this.angle, Math.atan2(bug.y - head.y, bug.x - head.x))) < 0.8;
      const stalking = this.state === STATE.HUNT;
      if (facing && bd < (stalking ? 20 : 80) * S && Math.random() < (stalking ? 0.08 : 0.02)) bug.startle(head.x, head.y);
    }
    if (keep && this.preyAlive(keep) && !this.targetBug) this.targetBug = keep;
    if (this.targetBug && this.state !== STATE.STARTLE && this.state !== STATE.FLEE && this.state !== STATE.HUNT && this.state !== STATE.SLEEP && this.state !== STATE.NIBBLE) {
      if (Math.random() < this.needs.huntEagerness * 0.1) this.enterState(STATE.HUNT);
    }
  }

  private updatePetting() {
    const p = this.pointer, st = this.state;
    // Petting: a pointer held still on it, out in the open (by the words it scurries off instead).
    const calm = (st === STATE.IDLE || st === STATE.BASKING || st === STATE.EXPLORE || st === STATE.SLEEP || st === STATE.LURK || st === STATE.CURIOUS)
      && !(st === STATE.LURK && this.stateData.target === 'caret') && !this.nearText();
    const over = !!p && calm && this.cursorSpeed < 1.5 * S && this.bodyDistance(p.x, p.y) < 1.5;
    this.petTimer = over ? Math.min(40, this.petTimer + 1) : Math.max(0, this.petTimer - 2);
    const was = this.petted;
    this.petted = this.petTimer > 20;
    if (this.petted && !was && st !== STATE.SLEEP && st !== STATE.BASKING) this.enterState(STATE.BASKING);
    if (!this.petted && was && this.state === STATE.BASKING && Math.random() < 0.6) this.body.flickTongue('lick');
  }

  /** Pokes, panels sweeping past, typing alongside. */
  private disturbances() {
    const c = this.c, px = c.world.px;
    for (const p of c.input.presses.splice(0)) {
      const x = p.x / px, y = p.y / px;
      // A click on a panel it is hiding under lands on the panel, not on the gecko.
      if (this.body.under && c.world.coverAt(x, y)) continue;
      for (const bug of c.swarm.bugs) if (dist(bug.x, bug.y, x, y) < 6) bug.startle(x, y);
      if (this.bodyDistance(x, y) < 3) { this.scare(x, y); return; }
    }
    if (c.world.shifts.length) {
      const h = this.head;
      for (const s of c.world.shifts) {
        if (h.x > s.x - 10 && h.x < s.x + s.w + 10 && h.y > s.y - 10 && h.y < s.y + s.h + 10) {
          this.scare(h.x - s.x < s.x + s.w - h.x ? s.x : s.x + s.w, h.y, c.opts.reducedMotion);
          break;
        }
      }
      c.world.shifts.length = 0;
    }
    const k = c.world.caret;
    // (Stalking the caret, it keeps its own distance.)
    if (this.typing && k && this.state !== STATE.FLEE && this.state !== STATE.STARTLE && this.state !== STATE.LURK && this.bodyDistance(k.x, k.y) < 12) this.scare(k.x, k.y, true);
  }

  /** Every few minutes, offer it a letter to nibble — only when you're not typing. */
  private scheduleNibble() {
    const c = this.c, now = c.now;
    if (this.letter) {
      this.trackIn--;
      if (this.trackIn <= 0) {
        this.trackIn = 24;
        const at = c.nibbler.locate(this.letter);
        if (!at || now - this.letterSince > 60000 || c.input.typedWithin(now, 1500)) this.dropLetter();
        else this.letterAt = { x: at.x / c.world.px, y: at.y / c.world.px };
      }
      return;
    }
    if (!c.opts.nibble || now < this.nextNibble || c.input.typedWithin(now, 12000) || c.nibbler.count >= 3) return;
    const st = this.state;
    if (st !== STATE.IDLE && st !== STATE.EXPLORE && st !== STATE.BASKING) return;
    this.nextNibble = now + rand(...NIBBLE_EVERY) * 1000;
    const caret = c.world.caret ? { x: c.world.caret.x * c.world.px, y: c.world.caret.y * c.world.px } : null;
    const t = c.nibbler.pickTarget(caret, 160);
    if (!t) return;
    this.letter = t;
    this.letterSince = now;
    this.letterAt = { x: t.x / c.world.px, y: t.y / c.world.px };
  }

  // ── Tick ──────────────────────────────────────────────────────

  /** One 60 Hz tick. Returns how the body should move. */
  update(): Drive {
    const c = this.c, b = this.body;
    this.stateTimer++;
    this.burstTimer++;
    if (this.hideCooldown > 0) this.hideCooldown--;
    this.typing = c.input.typedWithin(c.now, 3500);
    // A notice goes away by itself after a few seconds; a drag lure is refreshed while it moves.
    if (this.lure && (--this.lureTicks <= 0 || (this.lureThere && !this.lureThere()))) { this.lure = null; this.lureThere = null; }
    // You're typing: now and then it creeps over to lurk nearby and watch.
    if (this.lurkCooldown > 0) this.lurkCooldown--;
    if (this.curiousCooldown > 0) this.curiousCooldown--;
    const caret = c.world.caret;
    const onCaret = this.state === STATE.LURK && this.stateData.target === 'caret';
    if (!onCaret && this.lurkCooldown <= 0 && this.calm && caret && this.typing && Math.random() < 0.04) {
      const d = this.distTo(caret.x, caret.y);
      if (d > 30) { this.lurkTarget = 'caret'; this.enterState(STATE.LURK); }
    }
    // You wrote something and stopped: come and have a look.
    if (this.calm && c.world.lastCaret && c.input.claimFreshInk(c.now)) {
      const k = c.world.lastCaret;
      this.inkAt = { x: k.x, y: k.y };
      this.enterState(STATE.INSPECT);
    }
    this.userIdle = c.input.idleFor(c.now) > c.opts.sleepAfterMs;
    if (this.entering && c.world.inBounds(this.head.x, this.head.y, 6)) this.entering = false;
    if (!c.world.inBounds(this.homeX, this.homeY, 8)) this.chooseHome();

    this.needs.update(this.state);
    this.speed = (this.traits.resolve('baseSpeed') + this.traits.resolve('speedBoost')) * S;

    const p = this.pointer;
    this.cursorSpeed = p && this.lastCursor ? dist(p.x, p.y, this.lastCursor.x, this.lastCursor.y) : 0;
    this.lastCursor = p ? { ...p } : null;
    const cursorDist = p ? this.distTo(p.x, p.y) : Infinity;

    if (this.state !== STATE.HELD) {
      this.disturbances();
      this.scheduleNibble();
      this.detectBugs();
      this.checkInterrupts(cursorDist);
      this.updatePetting();
    }

    const result = StateHandlers[this.state].update(this);
    if (result.transition) this.enterState(result.transition);
    this.headLook.update();

    // ── Movement, as the original computed it ──
    let targetSpeed = result.targetSpeed;
    if (this.state !== STATE.FLEE && this.state !== STATE.STARTLE) targetSpeed *= this.needs.fullnessSlowdown;
    if (this.petted) targetSpeed = 0;
    const turnRate = this.state === STATE.HUNT ? (this.stateData.phase === 'lunge' ? 0.15 : 0.08) : this.state === STATE.SLEEP ? 0.02 : 0.06;
    this.angle += angleDiff(this.angle, this.targetAngle) * turnRate;
    this.currentSpeed = lerp(this.currentSpeed, targetSpeed, 0.05);

    // ── Body expression ──
    const sleeping = this.state === STATE.SLEEP;
    b.curlTarget = sleeping ? 1 : 0;
    b.lidTarget = sleeping ? (this.sleepPeeking ? 0.25 : 1) : this.petted ? 0.55 : 0;
    b.breathRate = sleeping || this.state === STATE.BASKING || this.petted ? 0.29 : 0.57;
    b.breathDepth = sleeping ? 0.085 : 0.05;
    b.tailTwitch = this.state === STATE.HELD ? 0.8 : this.state === STATE.LURK && (this.stateData.frozen || this.stateData.phase === 'wary') ? 0.5 : this.state === STATE.NIBBLE && this.stateData.phase === 'grab' && this.stateData.stuck ? 0.6 : this.state === STATE.HUNT ? 0.7 : this.state === STATE.STARTLE ? 0.35 : 0;
    if (this.mouthTicks > 0) { this.mouthTicks--; b.mouthTarget = this.mouthTicks > 4 ? 1 : 0.4; }
    else if (this.state !== STATE.NIBBLE && this.state !== STATE.HUNT) b.mouthTarget = 0;

    const slow = clamp(1 - this.currentSpeed / (this.speed || 1), 0, 1);
    return {
      heading: this.angle,
      // The prototype's speeds suit its longer legs; this body covers ground in shorter strides.
      speed: this.currentSpeed * 60 * 0.65,
      accel: 2400,
      turnRate: 24,
      look: this.angle + this.headLook.offset * slow,
    };
  }
}

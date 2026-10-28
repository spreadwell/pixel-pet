import type { Palette } from './palette';

/*
 * The gecko napping on a code block or callout, drawn by hand from the side (with a hint
 * of three-quarter depth: the top of the back shows as a lit band). It lies along the
 * block's top edge, chin on its far forearm, near front leg hanging limp over the front,
 * tail draped over too. Drawn facing right; mirrored to face left.
 *
 * Grid: art px, x from the tail end, y from the top. The block's top edge is between
 * rows LEDGE - 1 and LEDGE: everything from row LEDGE down hangs over the block's face.
 */

export interface NapPose {
  /** Head raised and looking about (1) → resting on the forearm (0). */
  headUp: number;
  /** Near front leg standing (0) → hanging over the edge (1). */
  armDown: number;
  /** Tail lying along the top (0) → draped over the edge (1). */
  tailDown: number;
  /** 0 eyes open → 1 shut. */
  lids: number;
  /** Breathing, 0..1. */
  breath: number;
}

export const NAP_W = 32, LEDGE = 8;

/**
 * Top row of the body in each column (tail end → snout); the body rests on the shelf
 * (bottom row LEDGE - 1) except where noted. -1: nothing there.
 */
const TOP = [
  -1, -1, -1, -1, 6, 6, 5, 4, 4, 3, 3, 3, 3, 2, 2, 2,
  2, 2, 3, 3, 4, 4, 3, 3, 3, 3, 3, 4, 4, 5, 6, -1,
];
const HEAD = 21, EYE = 25;

type Put = (x: number, y: number, tone: number) => void;

/** Tones: 1 darkest (contact, creases) · 2 shade · 3 body · 4 lit back · 5 eye. */
export function paintNap(put: Put, p: NapPose) {
  const lift = p.headUp > 0.5 ? 1 : 0;
  const swell = p.breath > 0.5;
  for (let x = 0; x < NAP_W; x++) {
    let top = TOP[x];
    if (top < 0) continue;
    const head = x >= HEAD;
    // The head rests on the forearm, a row above the shelf; raised, a row higher still.
    const bottom = (head ? LEDGE - 2 : LEDGE - 1) - (head ? lift : 0);
    top -= head ? lift : 0;
    for (let y = top; y <= bottom; y++) {
      const fromTop = y - top, fromBottom = bottom - y;
      // Breathing: the lit band over the ribs widens and narrows.
      const lit = fromTop === 0 || (fromTop === 1 && bottom - top >= 3 && (swell || x < 12 || x > 17));
      const tone = lit ? 4 : head ? 3 : fromBottom === 0 ? 1 : fromBottom === 1 ? 2 : 3;
      put(x, y, tone);
    }
  }
  // Hind leg folded against the flank: the thigh's crease and the foot tucked behind.
  put(9, 5, 2); put(10, 5, 2); put(11, 6, 2); put(8, 6, 2);
  put(6, LEDGE - 1, 2); put(5, LEDGE - 1, 1);

  // The far forearm, lying along the shelf under the chin, hand forward.
  if (lift === 0) {
    for (let x = 21; x <= 27; x++) put(x, LEDGE - 1, x === 27 ? 1 : 2);
  } else {
    put(21, LEDGE - 1, 2); put(22, LEDGE - 1, 2); put(23, LEDGE - 1, 1);
  }

  // The near front leg: standing on the shelf, or hanging limp over its edge.
  if (p.armDown < 0.33) {
    put(19, 6, 2); put(20, LEDGE - 1, 2); put(21, LEDGE - 1, 1); put(19, LEDGE - 1, 2);
  } else if (p.armDown < 0.66) {
    put(19, 6, 2); put(20, LEDGE - 1, 3); put(21, LEDGE, 3); put(22, LEDGE, 2); put(22, LEDGE + 1, 1);
  } else {
    put(19, 6, 2); put(20, 6, 2); put(19, LEDGE - 1, 3); put(20, LEDGE - 1, 2); put(19, LEDGE, 3); put(20, LEDGE, 2);
    put(20, LEDGE + 1, 3); put(21, LEDGE + 2, 2); put(20, LEDGE + 2, 1);
  }

  // The tail: back along the shelf from the hips, then (draped) over the edge and down,
  // its tip curling up.
  put(5, LEDGE - 2, 3); put(4, LEDGE - 2, 3);
  if (p.tailDown < 0.5) {
    for (let x = 3; x >= 0; x--) put(x, LEDGE - 1, x > 1 ? 3 : 2);
    put(4, LEDGE - 1, 2);
  } else {
    put(3, LEDGE - 1, 3); put(4, LEDGE - 1, 2);
    put(2, LEDGE, 3); put(2, LEDGE + 1, 3); put(2, LEDGE + 2, 2); put(2, LEDGE + 3, 2);
    put(3, LEDGE + 4, 2); put(4, LEDGE + 4, 2); put(4, LEDGE + 3, 1);
  }

  // Face: the jaw line, a nostril, and the eye — open, a dark pixel; shutting, a line.
  const jaw = LEDGE - 2 - lift;
  for (let x = 27; x <= 29; x++) put(x, jaw, 2);
  put(30, jaw - 1 + (lift ? 0 : 0), 2);
  const ey = 4 - lift;
  if (p.lids < 0.4) { put(EYE, ey, 5); put(EYE + 1, ey, 3); }
  else if (p.lids < 0.8) { put(EYE, ey, 5); put(EYE + 1, ey, 1); }
  else { put(EYE, ey + 1, 1); put(EYE + 1, ey + 1, 1); put(EYE - 1, ey, 1); }
}

/** Palette colour for a tone. */
export function napTone(pal: Palette, tone: number) {
  return tone === 1 ? pal.crease : tone === 2 ? pal.shade : tone === 3 ? pal.base : tone === 4 ? pal.crest : pal.eye;
}

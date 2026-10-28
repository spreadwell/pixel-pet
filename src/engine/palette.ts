import { clamp } from './math';

export interface Palette {
  /** The lit side of the body. */
  base: string;
  /** The side turned away from the light. */
  shade: string;
  /** Where the body crests over something and catches the light. */
  crest: string;
  /** Where it dips into a crease, in shade. */
  crease: string;
  /** The pale throat and belly, seen when it's side-on. */
  belly: string;
  eye: string;
  /** A catch-light in the eye. */
  glint: string;
  tongue: string;
  shadow: string;
  ink: string;      // theme text colour, for crumbs and bugs
  wing: string;
  cricket: string;
  cricketDark: string;
}

type Rgb = [number, number, number];

/** Resolve any CSS colour expression (including var(--x)) to rgb via a probe element. */
export function resolveCssColor(doc: Document, expr: string): Rgb | null {
  const probe = doc.createElement('span');
  probe.style.display = 'none';
  probe.style.color = expr;
  doc.body.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  const m = out.match(/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** The shortest way round the colour wheel from hue a to hue b, degrees. */
const angleTo = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;
const hsl = (h: number, s: number, l: number) =>
  `hsl(${((h % 360) + 360) % 360} ${Math.round(clamp(s, 0, 1) * 100)}% ${Math.round(clamp(l, 0, 1) * 100)}%)`;

const luminance = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;


/**
 * Build the gecko palette from a seed colour. Values are kept inside a band that
 * reads as a living animal (no neon, no near-black) whatever the accent is.
 */
export function buildPalette(doc: Document, seedExpr: string): Palette {
  const seed = resolveCssColor(doc, seedExpr) ?? [232, 184, 74];
  const bg = resolveCssColor(doc, 'var(--background-primary, #ffffff)') ?? [255, 255, 255];
  const ink = resolveCssColor(doc, 'var(--text-normal, #222222)') ?? [34, 34, 34];
  const dark = luminance(bg) < 0.45;

  const [h, s0, l0] = rgbToHsl(seed);
  const s = clamp(s0, 0.3, 0.78);
  const l = clamp(l0, 0.45, 0.62);

  return {
    base: hsl(h, s, l),
    shade: hsl(h - 4, Math.min(1, s * 1.05), l * 0.68),
    crest: hsl(h + 2, s * 0.97, Math.min(0.8, l + 0.05)),
    crease: hsl(h - 5, Math.min(1, s * 1.05), l * 0.61),
    belly: hsl(h + angleTo(h, 50) * 0.7, 0.55, dark ? 0.8 : 0.86),
    eye: hsl(h - 25, 0.35, 0.1),
    glint: 'hsl(0 0% 96%)',
    tongue: 'hsl(350 70% 66%)',
    shadow: dark ? 'rgba(0,0,0,0.42)' : 'rgba(40,30,10,0.16)',
    ink: `rgb(${ink.join(',')})`,
    wing: dark ? 'rgba(220,230,240,0.55)' : 'rgba(150,170,190,0.55)',
    cricket: dark ? 'hsl(34 42% 58%)' : 'hsl(34 38% 38%)',
    cricketDark: dark ? 'hsl(30 40% 40%)' : 'hsl(30 40% 22%)',
  };
}

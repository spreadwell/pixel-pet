/*
 * Tiny pixel-art icons for the pet panel, so it looks like it belongs to the pet: little
 * bitmaps (mostly 8×8) drawn as crisp squares in the current text color.
 */

const ICONS: Record<string, string[]> = {
  bug: [
    '..#...#..',
    '...#.#...',
    '..#####..',
    '#.#####.#',
    '.###.###.',
    '.###.###.',
    '#.##.##.#',
    '..##.##..',
    '.#.....#.',
  ],
  cricket: [
    '#.......',
    '.#......',
    '..#.###.',
    '...#####',
    '.#######',
    '#..#.#..',
    '..#...#.',
    '........',
  ],
  letter: [
    '..##....',
    '.#..#...',
    '#....#..',
    '#....#..',
    '######..',
    '#....#..',
    '#....#..',
    '........',
  ],
  moon: [
    '...###..',
    '..##....',
    '.##.....',
    '.##.....',
    '.##.....',
    '.##.....',
    '..##....',
    '...###..',
  ],
  sun: [
    '...##...',
    '.#....#.',
    '..####..',
    '#.####.#',
    '#.####.#',
    '..####..',
    '.#....#.',
    '...##...',
  ],
  ball: [
    '..####..',
    '.#....#.',
    '#.##...#',
    '#.##...#',
    '#......#',
    '#......#',
    '.#....#.',
    '..####..',
  ],
  flame: [
    '...#....',
    '...##...',
    '..###.#.',
    '.#####..',
    '.##.###.',
    '##...##.',
    '.#...#..',
    '..###...',
  ],
  heart: [
    '........',
    '.##.##..',
    '#######.',
    '#######.',
    '.#####..',
    '..###...',
    '...#....',
    '........',
  ],
  paw: [
    '..#..#..',
    '.##..##.',
    '........',
    '.#.##.#.',
    '...##...',
    '..####..',
    '..####..',
    '...##...',
  ],
  look: [
    '.####...',
    '#....#..',
    '#....#..',
    '#....#..',
    '#....#..',
    '.####...',
    '.....##.',
    '......##',
  ],
  bang: [
    '...##...',
    '...##...',
    '...##...',
    '...##...',
    '...##...',
    '........',
    '...##...',
    '...##...',
  ],
  up: [
    '...##...',
    '..####..',
    '.######.',
    '...##...',
    '...##...',
    '...##...',
    '...##...',
    '........',
  ],
  hand: [
    '...#....',
    '.#.#.#..',
    '.#.#.#..',
    '.#####.#',
    '.######.',
    '.#####..',
    '..###...',
    '..###...',
  ],
};

/** Append pixel icon `name` (`size` CSS px square) to `parent`. */
export function pixelIcon(parent: HTMLElement, name: string, size = 16) {
  parent.empty();
  const rows = ICONS[name] ?? ICONS.paw;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  // Square, whatever the bitmap's size, so every icon sits the same in a row.
  const n = Math.max(rows.length, ...rows.map((r) => r.length));
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('pixel-pet-pixel-icon');
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== '#') continue;
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', '1');
      r.setAttribute('height', '1');
      svg.appendChild(r);
    }
  });
  parent.appendChild(svg);
}

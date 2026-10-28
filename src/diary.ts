import type { DiaryKind } from './engine/personality';

/** One thing the pet did: what, where (the note, if it matters), when, and how many times in a row. */
export interface DiaryEntry { kind: DiaryKind; text: string; note?: string; at: number; times: number; }

/** The same thing again within this long (ms) just counts up on the last entry. */
const SAME_WITHIN = 3 * 60_000;
/** Some things it does all the time: these are only noted this often (ms). */
const AT_MOST_EVERY: Partial<Record<DiaryKind, number>> = { bask: 10 * 60_000, startle: 2 * 60_000, pushups: 10 * 60_000, held: 60_000 };
const KEEP = 60;

/**
 * What the pet has been up to, newest first, for the pet panel: caught a fly, napped on
 * a code block in *Garden*, stole the letter “e”. Kept for the session only.
 */
export class Diary {
  entries: DiaryEntry[] = [];
  private listeners = new Set<() => void>();
  private last = new Map<DiaryKind, number>();

  add(kind: DiaryKind, text: string, note?: string) {
    const now = Date.now(), every = AT_MOST_EVERY[kind];
    if (every && now - (this.last.get(kind) ?? -Infinity) < every) return;
    this.last.set(kind, now);
    const top = this.entries[0];
    if (top && top.kind === kind && top.text === text && top.note === note && now - top.at < SAME_WITHIN) { top.times++; top.at = now; }
    else this.entries.unshift({ kind, text, note, at: now, times: 1 });
    this.entries.length = Math.min(this.entries.length, KEEP);
    for (const fn of this.listeners) fn();
  }

  /** Call `fn` whenever there's something new. Returns the way to stop. */
  watch(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** "just now", "4 min ago", "2 h ago". */
export function ago(at: number, now = Date.now()) {
  const s = (now - at) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

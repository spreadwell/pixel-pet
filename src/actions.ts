import { Menu, Notice } from 'obsidian';
import type { PetEngine } from './engine/engine';

/** Something you can ask the pet to do, from its panel or its right-click menu. */
export interface Action {
  cmd: string;
  label: string;
  /** Obsidian icon, for the menu. */
  icon: string;
  /** Pixel icon, for the panel. */
  pixel: string;
  /** What it is instead while the pet is asleep. */
  asleep?: Omit<Action, 'asleep'>;
}

export const ACTIONS: Action[] = [
  { cmd: 'come', label: 'Come here', icon: 'hand', pixel: 'hand' },
  { cmd: 'explore', label: 'Explore', icon: 'compass', pixel: 'look' },
  { cmd: 'sleep', label: 'Sleep', icon: 'moon', pixel: 'moon', asleep: { cmd: 'wake', label: 'Wake up', icon: 'alarm-clock', pixel: 'sun' } },
  { cmd: 'eat', label: 'Something to eat', icon: 'bug', pixel: 'fly' },
  { cmd: 'nibble', label: 'Steal a letter', icon: 'type', pixel: 'letter' },
  { cmd: 'play', label: 'Play ball', icon: 'git-fork', pixel: 'ball' },
  { cmd: 'pushups', label: 'Push-ups', icon: 'dumbbell', pixel: 'up' },
  { cmd: 'bask', label: 'Bask', icon: 'sun-medium', pixel: 'sun' },
  { cmd: 'prank', label: 'Cause mischief', icon: 'flame', pixel: 'flame' },
];

/** The action as it is right now (sleep becomes wake while the pet is asleep). */
export const current = (a: Action, engine: PetEngine | null): Omit<Action, 'asleep'> => (a.asleep && engine?.asleep ? a.asleep : a);

/** Where the menu breaks into groups: after these. */
const BREAK_AFTER = new Set(['sleep', 'nibble', 'bask']);

/**
 * The pet's own menu, for a right-click on it: everything you can ask it to do (dimmed if
 * it can't just now), its diary, and its settings.
 */
export function showPetMenu(e: MouseEvent, engine: PetEngine, extra: { diary(): void; settings(): void }) {
  const menu = new Menu();
  for (const a of ACTIONS) {
    const f = current(a, engine), why = engine.unavailable(f.cmd);
    menu.addItem((item) => item
      .setTitle(f.label)
      .setIcon(f.icon)
      .setDisabled(!!why)
      .onClick(() => { const said = engine.command(f.cmd); if (said) new Notice(said); }));
    if (BREAK_AFTER.has(a.cmd)) menu.addSeparator();
  }
  menu.addSeparator();
  menu.addItem((item) => item.setTitle('Open pet panel').setIcon('paw-print').onClick(extra.diary));
  menu.addItem((item) => item.setTitle('Settings').setIcon('settings').onClick(extra.settings));
  menu.showAtMouseEvent(e);
}

import type { App } from 'obsidian';
import type { PrankTarget, Pranks } from './engine/personality';

/*
 * The buttons the pet can press, in CSS px. The pet panel's "Have something to eat" is
 * how it asks for food when it's hungry (as long as some kind of bug is switched on). The
 * sidebar toggles are mischief: harmless and undoable, and a sidebar it opens or closes is
 * owed back — after a while it goes and presses that button again (unless you've put it
 * back yourself). Nothing behind a modal; buttons that aren't there, or can't be seen, are
 * simply skipped. While its hand is over a button the button shows hovered, and pressed
 * while it's held down.
 */

type Side = 'left' | 'right';
/** How long before it puts a sidebar back the way it was, ms. */
const OWED_AFTER = [40_000, 120_000];

export class WorkspacePranks implements Pranks {
  private owed: { side: Side; collapsed: boolean; due: number } | null = null;

  constructor(private app: App, private canEat: () => boolean) {}

  targets(): (PrankTarget & { due?: boolean })[] {
    const doc = document;
    if (doc.querySelector('.modal-container')) return [];
    const owed = this.owed;
    if (owed) {
      if (this.collapsed(owed.side) === owed.collapsed) this.owed = null;
      else if (Date.now() > owed.due) {
        const t = this.sidebar(owed.side);
        return t ? [{ ...t, due: true }] : [];
      }
    }
    const out: PrankTarget[] = [];
    const eat = doc.querySelector<HTMLElement>('.pixel-pet-panel-action[data-cmd="eat"]');
    if (eat && this.canEat()) {
      const r = eat.getBoundingClientRect();
      const t = this.target('panel-eat', 'food', eat, r.left + Math.min(36, r.width / 2), r.top + r.height / 2, () => eat.click());
      if (t) out.push(t);
    }
    for (const side of ['left', 'right'] as Side[]) {
      if (owed?.side === side) continue;
      const t = this.sidebar(side);
      if (t) out.push(t);
    }
    return out;
  }

  private collapsed(side: Side) {
    const ws = this.app.workspace;
    return (side === 'left' ? ws.leftSplit : ws.rightSplit).collapsed;
  }

  private sidebar(side: Side): PrankTarget | null {
    const el = document.querySelector<HTMLElement>(`.sidebar-toggle-button.mod-${side} .clickable-icon`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return this.target(`sidebar-${side}`, 'mischief', el, r.left + r.width / 2, r.top + r.height / 2, () => {
      const was = this.collapsed(side);
      el.click();
      // Put it back later, unless that was it putting it back.
      if (this.owed?.side === side) this.owed = null;
      else this.owed = { side, collapsed: was, due: Date.now() + OWED_AFTER[0] + Math.random() * (OWED_AFTER[1] - OWED_AFTER[0]) };
    });
  }

  /** A target at (x, y) on `el`, if it's on screen and nothing is covering it there. */
  private target(id: string, kind: PrankTarget['kind'], el: HTMLElement, x: number, y: number, press: () => void): PrankTarget | null {
    const there = () => {
      if (!el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit));
    };
    if (!there()) return null;
    return {
      id, kind, x, y, ok: there, press,
      hover: (on) => el.toggleClass('pixel-pet-hover', on),
      down: (on) => el.toggleClass('pixel-pet-down', on),
    };
  }
}

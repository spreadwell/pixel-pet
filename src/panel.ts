import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type { PetEngine } from './engine/engine';

export const PANEL_VIEW = 'pixel-pet-panel';

/** The things you can ask the pet to do: command, label, icon. */
const ACTIONS: [string, string, string][] = [
  ['come', 'Come here', 'hand'],
  ['sleep', 'Find a place to sleep', 'moon'],
  ['wake', 'Wake up', 'alarm-clock'],
  ['explore', 'Go exploring', 'compass'],
  ['scout', 'Explore this note', 'file-search'],
  ['eat', 'Have something to eat', 'bug'],
  ['nibble', 'Steal a letter', 'type'],
  ['bask', 'Bask', 'sun-medium'],
  ['pushups', 'Do push-ups', 'dumbbell'],
  ['play', 'Play with the graph', 'git-fork'],
  ['prank', 'Cause mischief', 'sparkles'],
];

/**
 * A side panel, like any other, for telling the pet what to do — and seeing what it's
 * up to. Optional: open it from the command palette when you want it.
 */
export class PetPanel extends ItemView {
  private status!: HTMLElement;
  private note!: HTMLElement;
  private noteTimer = 0;

  constructor(leaf: WorkspaceLeaf, private engine: () => PetEngine | null) {
    super(leaf);
  }

  getViewType() { return PANEL_VIEW; }
  getDisplayText() { return 'Pixel Pet'; }
  getIcon() { return 'paw-print'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('pixel-pet-panel');
    const head = root.createDiv({ cls: 'pixel-pet-panel-status' });
    head.createSpan({ cls: 'pixel-pet-panel-label', text: 'Now: ' });
    this.status = head.createSpan({ text: '…' });
    const list = root.createDiv({ cls: 'pixel-pet-panel-actions' });
    for (const [cmd, label, icon] of ACTIONS) {
      const button = list.createEl('button', { cls: 'pixel-pet-panel-action', attr: { 'data-cmd': cmd } });
      setIcon(button.createSpan({ cls: 'pixel-pet-panel-icon' }), icon);
      button.createSpan({ text: label });
      button.addEventListener('click', () => this.run(cmd));
    }
    this.note = root.createDiv({ cls: 'pixel-pet-panel-note' });
    this.registerInterval(window.setInterval(() => this.refresh(), 400));
    this.refresh();
  }

  private run(cmd: string) {
    const engine = this.engine();
    if (!engine) { this.say('The pet is hidden. Show it from the ribbon or the command palette.'); return; }
    const said = engine.command(cmd);
    this.say(said ?? '');
    this.refresh();
  }

  private say(text: string) {
    this.note.setText(text);
    window.clearTimeout(this.noteTimer);
    if (text) this.noteTimer = window.setTimeout(() => this.note.setText(''), 4000);
  }

  private refresh() {
    this.status.setText(this.engine()?.activity ?? 'Hidden');
  }

  async onClose() {
    window.clearTimeout(this.noteTimer);
  }
}

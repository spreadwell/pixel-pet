import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { ACTIONS, Action, current } from './actions';
import { Diary, DiaryEntry, ago } from './diary';
import type { DiaryKind } from './engine/personality';
import type { PetEngine } from './engine/engine';
import { pixelIcon } from './pixels';

export const PANEL_VIEW = 'pixel-pet-panel';

/** A pixel icon to go with what it's doing. */
const STATE_ICONS: Record<string, string> = {
  idle: 'paw', basking: 'sun', explore: 'look', scout: 'look', hunt: 'bug', feast: 'bug',
  startle: 'bang', flee: 'bang', sleep: 'moon', nap: 'moon', nibble: 'letter', held: 'hand',
  watch: 'paw', inspect: 'letter', lurk: 'paw', curious: 'paw', retreat: 'look', play: 'ball',
  prank: 'flame', search: 'look', hide: 'paw', away: 'paw',
};

/** And one for each kind of diary entry. */
const DIARY_ICONS: Record<DiaryKind, string> = {
  catch: 'bug', letter: 'letter', nap: 'moon', sleep: 'moon', play: 'ball', prank: 'flame', snack: 'bug',
  explore: 'look', retreat: 'look', petted: 'heart', held: 'hand', startle: 'bang', pushups: 'up', bask: 'sun',
  search: 'look', cheer: 'up',
};

type Button = { action: Action; el: HTMLButtonElement; icon: HTMLElement; label: HTMLElement; shown: string };

/**
 * A side panel for keeping up with the pet: what it's doing now, a short diary of what
 * it's been up to (scrolling, so it doesn't take over the sidebar), and the things you can
 * ask it to do, two to a row. One that can't do anything just now is dimmed, and says
 * why. Drawn in the pet's own pixel style.
 */
export class PetPanel extends ItemView {
  private statusIcon!: HTMLElement;
  private statusText!: HTMLElement;
  private list!: HTMLElement;
  private hintEl!: HTMLElement;
  private buttons: Button[] = [];
  private hintTimer = 0;
  private lastIcon = '';
  private drawn = '';

  constructor(leaf: WorkspaceLeaf, private engine: () => PetEngine | null, private diary: Diary, private openSettings: () => void) {
    super(leaf);
  }

  getViewType() { return PANEL_VIEW; }
  getDisplayText() { return 'Pixel Pet'; }
  getIcon() { return 'paw-print'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('pixel-pet-panel');

    const status = root.createDiv({ cls: 'pixel-pet-box pixel-pet-status', attr: { 'aria-live': 'polite' } });
    this.statusIcon = status.createSpan({ cls: 'pixel-pet-status-icon' });
    this.statusText = status.createSpan({ cls: 'pixel-pet-status-text' });

    const diary = root.createDiv({ cls: 'pixel-pet-box pixel-pet-diary' });
    this.list = diary.createDiv({ cls: 'pixel-pet-diary-list' });

    const grid = root.createDiv({ cls: 'pixel-pet-panel-grid' });
    for (const action of ACTIONS) {
      const el = grid.createEl('button', { cls: 'pixel-pet-panel-action', attr: { 'data-cmd': action.cmd, type: 'button' } });
      const b: Button = { action, el, icon: el.createSpan({ cls: 'pixel-pet-panel-icon' }), label: el.createSpan({ cls: 'pixel-pet-panel-label' }), shown: '' };
      el.addEventListener('click', () => this.run(b));
      this.buttons.push(b);
    }
    this.hintEl = root.createDiv({ cls: 'pixel-pet-panel-hint' });


    const footer = root.createDiv({ cls: 'pixel-pet-panel-footer' });
    const settings = footer.createEl('button', { cls: 'clickable-icon pixel-pet-panel-settings', attr: { 'aria-label': 'Pixel Pet settings', type: 'button' } });
    setIcon(settings.createSpan({ cls: 'pixel-pet-panel-settings-icon' }), 'settings');
    settings.createSpan({ text: 'Settings' });
    settings.addEventListener('click', () => this.openSettings());

    this.register(this.diary.watch(() => this.drawDiary()));
    this.registerInterval(window.setInterval(() => this.refresh(), 300));
    this.registerInterval(window.setInterval(() => this.drawDiary(true), 30_000));
    this.refresh();
    this.drawDiary();
  }

  private run(b: Button) {
    const engine = this.engine();
    if (!engine) { this.hint('The pet is hidden. Show it from the ribbon or the command palette.'); return; }
    const { cmd } = current(b.action, engine);
    const why = engine.unavailable(cmd);
    if (why) { this.hint(why); return; }
    this.hint(engine.command(cmd) ?? '');
    this.refresh();
  }

  /** A few words under the buttons, for a few seconds. */
  private hint(text: string) {
    this.hintEl.setText(text);
    this.hintEl.toggleClass('is-shown', !!text);
    window.clearTimeout(this.hintTimer);
    if (text) this.hintTimer = window.setTimeout(() => this.hint(''), 4000);
  }

  private refresh() {
    const engine = this.engine();
    this.statusText.setText(engine ? engine.activity : 'Hidden');
    const icon = STATE_ICONS[engine?.stateKey ?? 'away'] ?? 'paw';
    if (icon !== this.lastIcon) { pixelIcon(this.statusIcon, icon); this.lastIcon = icon; }
    for (const b of this.buttons) {
      const f = current(b.action, engine);
      if (b.shown !== f.cmd) { b.label.setText(f.label); pixelIcon(b.icon, f.pixel); b.shown = f.cmd; }
      const why = engine ? engine.unavailable(f.cmd) : 'The pet is hidden';
      b.el.toggleClass('is-unavailable', !!why);
      b.el.setAttr('aria-disabled', why ? 'true' : 'false');
      b.el.setAttr('aria-label', why ? `${f.label}: ${why}` : f.label);
    }
  }

  /** The diary, newest first. (`times` only: just bring the "4 min ago"s up to date.) */
  private drawDiary(times = false) {
    const entries = this.diary.entries, key = entries.map((e) => `${e.at}:${e.times}`).join(',');
    if (times && key === this.drawn) {
      this.list.querySelectorAll<HTMLElement>('.pixel-pet-diary-when').forEach((el, i) => el.setText(ago(entries[i].at)));
      return;
    }
    this.drawn = key;
    this.list.empty();
    if (!entries.length) { this.list.createDiv({ cls: 'pixel-pet-diary-empty', text: 'Nothing yet. Give it a minute.' }); return; }
    for (const e of entries) this.entry(e);
  }

  private entry(e: DiaryEntry) {
    const row = this.list.createDiv({ cls: 'pixel-pet-diary-entry' });
    pixelIcon(row.createSpan({ cls: 'pixel-pet-diary-icon' }), DIARY_ICONS[e.kind], 12);
    const what = row.createSpan({ cls: 'pixel-pet-diary-what', text: e.text });
    if (e.note) { what.appendText(e.kind === 'explore' ? ' ' : ' in '); what.createEl('em', { text: e.note }); }
    if (e.times > 1) what.createSpan({ cls: 'pixel-pet-diary-times', text: ` ×${e.times}` });
    row.createSpan({ cls: 'pixel-pet-diary-when', text: ago(e.at) });
  }

  async onClose() {
    window.clearTimeout(this.hintTimer);
  }
}

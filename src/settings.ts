import { App, Modal, PluginSettingTab, Setting, SettingPage, setIcon } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type PixelPetPlugin from './main';
import { BUG_KINDS, type BugKind, type Pace } from './engine/bugs';
import { natureOf, type Temperament, type Traits } from './engine/personality';

/** One kind of bug: whether it turns up at all, what brings it out, and how busy it is. */
export interface CritterSettings {
  enabled: boolean;
  /** One for every this many words you write; 0 = not from writing. */
  words: number;
  /** One for each task you tick off. */
  tasks: boolean;
  /** One now and then of its own accord, about this often; 0 = never. */
  minutes: number;
  pace: Pace;
}

export interface PetSettings {
  enabled: boolean;
  /** CSS px per art pixel; 0 = automatic for the device. */
  size: number;
  colorMode: 'accent' | 'custom';
  customColor: string;
  temperament: Temperament;
  mischief: boolean;
  /** How often it gets up to mischief, when it does. */
  mischiefOften: MischiefOften;
  nibbleLetters: boolean;
  sleepAfterMinutes: number;
  reducedMotion: 'system' | 'on' | 'off';
  critters: Record<BugKind, CritterSettings>;
  /** This gecko's personality, rolled on first run. */
  traits?: Traits;
}

export const DEFAULT_SETTINGS: PetSettings = {
  enabled: true,
  size: 0,
  colorMode: 'accent',
  customColor: '#e8b84a',
  temperament: 'own',
  mischief: false,
  mischiefOften: 'sometimes',
  nibbleLetters: true,
  sleepAfterMinutes: 3,
  reducedMotion: 'system',
  critters: {
    fly: { enabled: true, words: 40, tasks: false, minutes: 0, pace: 'normal' },
    cricket: { enabled: false, words: 0, tasks: true, minutes: 0, pace: 'normal' },
  },
};

export type MischiefOften = 'rarely' | 'sometimes' | 'often' | 'very';
/** Minutes between pranks, at random between the two, for each setting. */
export const MISCHIEF_MINUTES: Record<MischiefOften, [number, number]> = {
  rarely: [20, 40],
  sometimes: [8, 20],
  often: [3, 8],
  very: [1, 3],
};

/** Saved settings, filled out with the defaults, and older ones carried over. */
export function settingsFrom(data: Record<string, unknown> | null): PetSettings {
  const d: Record<string, unknown> = { ...(data ?? {}) };
  const saved = d.critters as Partial<Record<BugKind, Partial<CritterSettings>>> | undefined;
  const critters = structuredClone(DEFAULT_SETTINGS.critters);
  if (saved) for (const k of BUG_KINDS) Object.assign(critters[k], saved[k]);
  else {
    // Older versions: a flies toggle and slider, and a crickets toggle.
    if (d.bugsFromWriting === false) critters.fly.words = 0;
    else if (typeof d.wordsPerBug === 'number') critters.fly.words = d.wordsPerBug;
    if (typeof d.crickets === 'boolean') critters.cricket.enabled = d.crickets;
  }
  for (const k of ['bugsFromWriting', 'wordsPerBug', 'bugsFromTasks', 'crickets']) delete d[k];
  return { ...DEFAULT_SETTINGS, ...d, critters };
}

const NAMES: Record<BugKind, { one: string; many: string }> = {
  fly: { one: 'fly', many: 'Flies' },
  cricket: { one: 'cricket', many: 'Crickets' },
};

type Section = 'general' | 'personality' | 'critters' | 'support';
const PAGES: { id: Section; name: string; desc: string; icon: string }[] = [
  { id: 'general', name: 'General', desc: 'Showing it, its size and color.', icon: 'settings-2' },
  { id: 'personality', name: 'Personality', desc: 'Its nature, its habits, and whether it gets up to mischief.', icon: 'smile' },
  { id: 'critters', name: 'Critters', desc: 'The bugs it hunts, and what brings them out.', icon: 'bug' },
  { id: 'support', name: 'Help & feedback', desc: 'Report a problem or suggest an idea.', icon: 'messages-square' },
];

const REPO = 'https://github.com/spreadwell/pixel-pet';
/** Where to find the developer's other plugins. */
const MORE = 'https://community.obsidian.md/users/giblicious';

/**
 * Settings as pages, the way Butter Editor lays them out: an index of pages, each made of
 * titled groups, shown as Obsidian's own settings pages (with its back button and titlebar).
 */
export class PixelPetSettingTab extends PluginSettingTab {
  /** Re-draws whatever page is showing, after a change that adds or removes rows. */
  private redraw: () => void = () => {};
  private icons: MutationObserver | null = null;

  constructor(app: App, private plugin: PixelPetPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    this.watchIcons();
    // The page's own `this` is the page; these reach back to the tab.
    const setRedraw = (f: () => void) => { this.redraw = f; };
    const render = (el: HTMLElement, id: Section) => this.renderSection(el, id);
    return [{
      type: 'group',
      items: PAGES.map((p) => ({
        type: 'page' as const,
        name: p.name,
        desc: p.desc,
        page: () => {
          const page = new (class extends SettingPage {
            display() {
              setRedraw(() => this.display());
              this.containerEl.empty();
              render(this.containerEl, p.id);
            }
          })();
          page.title = p.name;
          return page;
        },
      })),
    }, {
      type: 'group',
      items: [{ name: 'More plugins', searchable: false, render: (setting: Setting) => moreBanner(setting) }],
    }];
  }

  /** Obsidian's page links have no icon: add each one's in front of its name, once drawn. */
  private watchIcons() {
    if (this.icons) return;
    const decorate = () => {
      for (const row of Array.from(this.containerEl.querySelectorAll<HTMLElement>('.setting-item.mod-navigable'))) {
        const name = row.querySelector<HTMLElement>('.setting-item-name');
        const page = PAGES.find((p) => p.name === name?.textContent?.trim());
        if (!name || !page || name.querySelector('.pixel-pet-page-icon')) continue;
        const icon = createSpan({ cls: 'pixel-pet-page-icon' });
        setIcon(icon, page.icon);
        name.prepend(icon);
      }
    };
    this.icons = new MutationObserver(decorate);
    this.icons.observe(this.containerEl, { childList: true, subtree: true });
    this.plugin.register(() => this.icons?.disconnect());
    decorate();
  }

  private renderSection(el: HTMLElement, section: Section) {
    if (section === 'general') this.renderGeneral(el);
    else if (section === 'personality') this.renderPersonality(el);
    else if (section === 'critters') this.renderCritters(el);
    else this.renderSupport(el);
  }

  private async save() { await this.plugin.saveSettings(); }

  private renderGeneral(el: HTMLElement) {
    const s = this.plugin.settings;
    const pet = group(el, 'Pet');
    new Setting(pet)
      .setName('Show the pet')
      .setDesc('You can also toggle it from the ribbon or the command palette.')
      .addToggle((t) => t.setValue(s.enabled).onChange(async (v) => { s.enabled = v; await this.save(); }));
    new Setting(pet)
      .setName('Pet panel')
      .setDesc('A side panel for telling it what to do, and seeing what it’s up to.')
      .addButton((b) => b.setButtonText('Open').onClick(() => { void this.plugin.openPanel(); }));

    const look = group(el, 'Appearance');
    new Setting(look)
      .setName('Size')
      .setDesc('Auto is a little smaller on phones.')
      .addDropdown((d) => d
        .addOptions({ '0': 'Auto', '2': 'Small', '3': 'Medium', '4': 'Large' })
        .setValue(String(s.size))
        .onChange(async (v) => { s.size = Number(v); await this.save(); }));
    const color = new Setting(look)
      .setName('Color')
      .setDesc('Follows your accent color unless you pick one.');
    if (s.colorMode === 'custom') color.addColorPicker((c) => c.setValue(s.customColor).onChange(async (v) => { s.customColor = v; await this.save(); }));
    color.addDropdown((d) => d
      .addOptions({ accent: 'Accent color', custom: 'Custom' })
      .setValue(s.colorMode)
      .onChange(async (v) => { s.colorMode = v as PetSettings['colorMode']; await this.save(); this.redraw(); }));

    const access = group(el, 'Accessibility');
    new Setting(access)
      .setName('Reduced motion')
      .setDesc('Calmer movement, with no darting or lunging.')
      .addDropdown((d) => d
        .addOptions({ system: 'Follow system', on: 'On', off: 'Off' })
        .setValue(s.reducedMotion)
        .onChange(async (v) => { s.reducedMotion = v as PetSettings['reducedMotion']; await this.save(); }));
  }

  private renderPersonality(el: HTMLElement) {
    const s = this.plugin.settings;
    const nature = group(el, 'Nature');
    new Setting(nature)
      .setName('Temperament')
      .setDesc('Keep the nature it was born with, or nudge it another way. Some of its own nature always shows through.')
      .addDropdown((d) => d
        .addOptions({ own: 'Its own', lazy: 'Lazy', energetic: 'Energetic', bold: 'Bold' })
        .setValue(s.temperament)
        .onChange(async (v) => { s.temperament = v as Temperament; await this.save(); this.redraw(); }));
    new Setting(nature)
      .setName('As it is now')
      .setDesc(s.traits ? describe(natureOf(s.traits, s.temperament)) : '')
      .addButton((b) => b.setButtonText('New personality').onClick(() => {
        new ConfirmModal(this.app, 'New personality', 'Give your pet a whole new personality? Its old one can’t be brought back.', 'New personality', () => {
          void this.plugin.newPersonality().then(() => this.redraw());
        }).open();
      }));

    const habits = group(el, 'Habits');
    new Setting(habits)
      .setName('Steal letters')
      .setDesc('Now and then it carries off a letter to eat. Only the display changes, never your note, and the letter grows back.')
      .addToggle((t) => t.setValue(s.nibbleLetters).onChange(async (v) => { s.nibbleLetters = v; await this.save(); }));
    new Setting(habits)
      .setName('Falls asleep after')
      .setDesc('When you’ve been away for a while.')
      .addDropdown((d) => d
        .addOptions(choices({}, [1, 3, 5, 10, 15], s.sleepAfterMinutes, (n) => (n === 1 ? '1 minute' : `${n} minutes`)))
        .setValue(String(s.sleepAfterMinutes))
        .onChange(async (v) => { s.sleepAfterMinutes = Number(v); await this.save(); }));
    new Setting(habits)
      .setName('Mischievous')
      .setDesc('Once in a while it presses a button it shouldn’t, like a sidebar toggle. Harmless, never while you’re typing, and it puts sidebars back after a while.')
      .addToggle((t) => t.setValue(s.mischief).onChange(async (v) => { s.mischief = v; await this.save(); this.redraw(); }));
    if (s.mischief) {
      new Setting(habits)
        .setName('How often')
        .setDesc('Roughly how long between pranks.')
        .addDropdown((d) => d
          .addOptions({ rarely: 'Rarely (20–40 minutes)', sometimes: 'Now and then (8–20 minutes)', often: 'Often (3–8 minutes)', very: 'Very often (1–3 minutes)' })
          .setValue(s.mischiefOften)
          .onChange(async (v) => { s.mischiefOften = v as MischiefOften; await this.save(); }));
    }
  }

  private renderCritters(el: HTMLElement) {
    for (const kind of BUG_KINDS) {
      const c = this.plugin.settings.critters[kind], name = NAMES[kind];
      const items = group(el, name.many);
      new Setting(items)
        .setName(`${name.many} turn up`)
        .addToggle((t) => t.setValue(c.enabled).onChange(async (v) => { c.enabled = v; await this.save(); this.redraw(); }));
      if (!c.enabled) continue;
      new Setting(items)
        .setName('From your writing')
        .setDesc(`A ${name.one} comes, near where you’re typing.`)
        .addDropdown((d) => d
          .addOptions(choices({ '0': 'Off' }, [20, 40, 80, 120], c.words || 40, (n) => `Every ${n} words`))
          .setValue(String(c.words))
          .onChange(async (v) => { c.words = Number(v); await this.save(); }));
      new Setting(items)
        .setName('From finished tasks')
        .setDesc(`A ${name.one} for every task you tick off.`)
        .addToggle((t) => t.setValue(c.tasks).onChange(async (v) => { c.tasks = v; await this.save(); }));
      new Setting(items)
        .setName('On their own')
        .setDesc('Now and then, whatever you’re doing.')
        .addDropdown((d) => d
          .addOptions(choices({ '0': 'Never' }, [2, 5, 10, 20], c.minutes || 5, (n) => `About every ${n} minutes`))
          .setValue(String(c.minutes))
          .onChange(async (v) => { c.minutes = Number(v); await this.save(); }));
      new Setting(items)
        .setName('Pace')
        .setDesc('Lazy ones dawdle and linger; quick ones dart about and leave sooner.')
        .addDropdown((d) => d
          .addOptions({ lazy: 'Lazy', normal: 'Normal', quick: 'Quick', mixed: 'A mix' })
          .setValue(c.pace)
          .onChange(async (v) => { c.pace = v as Pace; await this.save(); }));
    }
  }

  private renderSupport(el: HTMLElement) {
    const help = group(el, 'Help & feedback');
    const link = (name: string, desc: string, url: string) => new Setting(help)
      .setName(name)
      .setDesc(desc)
      .addExtraButton((b) => b.setIcon('external-link').setTooltip('Open').onClick(() => window.open(url)));
    link('Report a problem', 'On GitHub. Say what it did, and what you expected.', `${REPO}/issues/new`);
    link('Suggest an idea', 'New animals, new tricks: all welcome.', `${REPO}/issues/new`);
    link('Read about it', 'Everything it does, on GitHub.', `${REPO}#readme`);
    new Setting(help).setName('Version').setDesc(this.plugin.manifest.version);
  }
}

/** A small banner pointing to the developer's other plugins. */
function moreBanner(setting: Setting) {
  setting.settingEl.addClass('pixel-pet-more');
  setting.nameEl.empty();
  const icon = setting.nameEl.createSpan({ cls: 'pixel-pet-page-icon' });
  setIcon(icon, 'puzzle');
  setting.nameEl.createSpan({ text: 'More plugins by Spreadwell' });
  setting.setDesc('Other plugins from the same maker.');
  setting.addButton((b) => b.setButtonText('Take a look').onClick(() => window.open(MORE)));
}

/** Asks before something that can't be undone; `yes` runs only if confirmed. */
class ConfirmModal extends Modal {
  constructor(app: App, title: string, private question: string, private action: string, private yes: () => void) {
    super(app);
    this.setTitle(title);
  }

  onOpen() {
    this.contentEl.createEl('p', { text: this.question });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.action).setDestructive().setCta().onClick(() => { this.close(); this.yes(); }));
  }

  onClose() { this.contentEl.empty(); }
}

/** A titled group of settings, in Obsidian's own grouped style: returns where its rows go. */
function group(parent: HTMLElement, heading?: string): HTMLElement {
  const el = parent.createDiv({ cls: 'setting-group pixel-pet-setting-group' });
  if (heading) new Setting(el).setName(heading).setHeading();
  return el.createDiv({ cls: 'setting-items' });
}

/** Dropdown options for `values` (plus `current`, if it was set to something else), after `first`. */
function choices(first: Record<string, string>, values: number[], current: number, label: (n: number) => string) {
  const all = values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  const out = { ...first };
  for (const n of all) out[String(n)] = label(n);
  return out;
}

/** Its nature in a few words. */
function describe(t: Traits) {
  const pick = (v: number, [low, mid, high]: string[]) => (v < 0.4 ? low : v > 0.6 ? high : mid);
  return [
    pick(t.speed, ['Unhurried', 'Steady on its feet', 'Quick']),
    pick(t.aggression, ['a gentle hunter', 'a keen hunter', 'a fierce hunter']),
    pick(t.awareness, ['hard to startle', 'alert', 'jumpy']),
    pick(t.endurance, ['often sleepy', 'rests now and then', 'tireless']),
    pick(t.metabolism, ['a small appetite', 'a healthy appetite', 'always hungry']),
  ].join(', ') + '.';
}

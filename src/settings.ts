import { App, PluginSettingTab, Setting } from 'obsidian';
import type ButterPetPlugin from './main';
import type { Traits } from './engine/personality';

export interface PetSettings {
  enabled: boolean;
  /** CSS px per art pixel; 0 = automatic for the device. */
  size: number;
  colorMode: 'accent' | 'custom';
  customColor: string;
  nibbleLetters: boolean;
  bugsFromWriting: boolean;
  wordsPerBug: number;
  bugsFromTasks: boolean;
  sleepAfterMinutes: number;
  reducedMotion: 'system' | 'on' | 'off';
  /** This gecko's personality, rolled on first run. Not shown in the UI. */
  traits?: Traits;
}

export const DEFAULT_SETTINGS: PetSettings = {
  enabled: true,
  size: 0,
  colorMode: 'accent',
  customColor: '#e8b84a',
  nibbleLetters: true,
  bugsFromWriting: true,
  wordsPerBug: 40,
  bugsFromTasks: true,
  sleepAfterMinutes: 3,
  reducedMotion: 'system',
};

export class ButterPetSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ButterPetPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveSettings(); };
    containerEl.empty();

    new Setting(containerEl)
      .setName('Show the pet')
      .setDesc('You can also toggle it from the ribbon or the command palette.')
      .addToggle((t) => t.setValue(s.enabled).onChange(async (v) => { s.enabled = v; await save(); }));

    new Setting(containerEl)
      .setName('Size')
      .addDropdown((d) => d
        .addOptions({ '0': 'Auto', '2': 'Small', '3': 'Medium', '4': 'Large' })
        .setValue(String(s.size))
        .onChange(async (v) => { s.size = Number(v); await save(); }));

    new Setting(containerEl)
      .setName('Color')
      .setDesc('Follows your accent color unless you pick one.')
      .addDropdown((d) => d
        .addOptions({ accent: 'Accent color', custom: 'Custom' })
        .setValue(s.colorMode)
        .onChange(async (v) => { s.colorMode = v as PetSettings['colorMode']; await save(); this.display(); }));
    if (s.colorMode === 'custom') {
      new Setting(containerEl)
        .setName('Custom color')
        .addColorPicker((c) => c.setValue(s.customColor).onChange(async (v) => { s.customColor = v; await save(); }));
    }

    new Setting(containerEl).setName('Behavior').setHeading();

    new Setting(containerEl)
      .setName('Nibble letters')
      .setDesc('Now and then it eats a letter off the screen. Only the display is affected — your note is never changed — and the letter grows back.')
      .addToggle((t) => t.setValue(s.nibbleLetters).onChange(async (v) => { s.nibbleLetters = v; await save(); }));

    new Setting(containerEl)
      .setName('Writing attracts flies')
      .addToggle((t) => t.setValue(s.bugsFromWriting).onChange(async (v) => { s.bugsFromWriting = v; await save(); }));

    new Setting(containerEl)
      .setName('Words per fly')
      .addSlider((sl) => sl.setLimits(10, 200, 10).setValue(s.wordsPerBug).setDynamicTooltip()
        .onChange(async (v) => { s.wordsPerBug = v; await save(); }));

    new Setting(containerEl)
      .setName('Completed tasks bring out crickets')
      .addToggle((t) => t.setValue(s.bugsFromTasks).onChange(async (v) => { s.bugsFromTasks = v; await save(); }));

    new Setting(containerEl)
      .setName('Falls asleep after')
      .setDesc('Minutes without any activity.')
      .addSlider((sl) => sl.setLimits(1, 15, 1).setValue(s.sleepAfterMinutes).setDynamicTooltip()
        .onChange(async (v) => { s.sleepAfterMinutes = v; await save(); }));

    new Setting(containerEl)
      .setName('Reduced motion')
      .setDesc('Calmer movement, with no darting or lunging.')
      .addDropdown((d) => d
        .addOptions({ system: 'Follow system', on: 'On', off: 'Off' })
        .setValue(s.reducedMotion)
        .onChange(async (v) => { s.reducedMotion = v as PetSettings['reducedMotion']; await save(); }));
  }
}

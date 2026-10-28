import { Editor, MarkdownFileInfo, MarkdownView, Platform, Plugin, TFile } from 'obsidian';
import { PetEngine, PetOptions } from './engine/engine';
import { rollTraits } from './engine/personality';
import { GraphBalls } from './graph';
import { PANEL_VIEW, PetPanel } from './panel';
import { PixelPetSettingTab, DEFAULT_SETTINGS, PetSettings } from './settings';

const WORD = /[\p{L}\p{N}]+/gu;
const DONE_TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/gm;

export default class PixelPetPlugin extends Plugin {
  settings: PetSettings = { ...DEFAULT_SETTINGS };
  private engine: PetEngine | null = null;
  private counts = new Map<string, { words: number; tasks: number }>();
  private wordBank = 0;
  private pending = new Map<string, number>();
  private graph = new GraphBalls(this.app);

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new PixelPetSettingTab(this.app, this));

    this.addRibbonIcon('paw-print', 'Toggle pet', () => this.toggle());
    this.addCommand({ id: 'toggle', name: 'Show or hide the pet', callback: () => this.toggle() });
    this.addCommand({ id: 'summon', name: 'Call the pet over', callback: () => this.engine?.summon() });
    this.addCommand({ id: 'release-bug', name: 'Release a bug', callback: () => this.engine?.spawnBug(this.settings.crickets && Math.random() < 0.4 ? 'cricket' : 'fly') });
    this.registerView(PANEL_VIEW, (leaf) => new PetPanel(leaf, () => this.engine));
    this.addCommand({ id: 'open-panel', name: 'Open pet panel', callback: () => this.openPanel() });

    this.registerEvent(this.app.workspace.on('css-change', () => this.engine?.refreshPalette()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.engine?.noteChanged()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.engine?.noteChanged()));
    this.registerEvent(this.app.workspace.on('editor-change', (editor: Editor, info: MarkdownView | MarkdownFileInfo) => this.onEdit(editor, info)));
    // Editors that don't raise editor-change (Butter Editor, say) still save the note.
    this.registerEvent(this.app.vault.on('modify', (file) => { if (file instanceof TFile && file.extension === 'md') this.onSaved(file); }));
    this.register(() => { for (const t of this.pending.values()) window.clearTimeout(t); });

    this.app.workspace.onLayoutReady(() => { if (this.settings.enabled) this.start(); });
  }

  onunload() {
    this.stop();
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    // Every gecko gets its own personality the first time, and keeps it.
    if (!this.settings.traits) {
      this.settings.traits = rollTraits();
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applySettings();
  }

  private engineOptions(): PetOptions {
    const s = this.settings;
    const reduced = s.reducedMotion === 'on' || (s.reducedMotion === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    return {
      // Auto size: a little smaller on phones, where screens are small but dense.
      px: s.size || (Platform.isPhone ? 2 : 3),
      maxFps: Platform.isMobile ? 30 : 0,
      color: s.colorMode === 'accent' ? 'var(--interactive-accent)' : s.customColor,
      traits: s.traits,
      nibble: s.nibbleLetters,
      crickets: s.crickets,
      sleepAfterMs: s.sleepAfterMinutes * 60_000,
      reducedMotion: reduced,
      graph: this.graph,
    };
  }

  private start(at?: { x: number; y: number; heading: number }) {
    if (this.engine) return;
    this.engine = new PetEngine(window, this.engineOptions());
    this.engine.start(at);
  }

  private stop() {
    this.engine?.destroy();
    this.engine = null;
  }

  /** Open the pet panel in the right sidebar (or show it, if it's already open). */
  private async openPanel() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(PANEL_VIEW)[0];
    if (!leaf) {
      leaf = ws.getRightLeaf(false) ?? ws.getLeaf(true);
      await leaf.setViewState({ type: PANEL_VIEW, active: true });
    }
    await ws.revealLeaf(leaf);
  }

  private async toggle() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
  }

  /** Push settings into the running pet, rebuilding it if the scale changed. */
  applySettings() {
    if (!this.settings.enabled) { this.stop(); return; }
    if (!this.engine) { this.start(); return; }
    const opts = this.engineOptions();
    if (opts.px !== this.engine.px) {
      const pose = this.engine.pose();
      this.stop();
      this.start(pose);
      return;
    }
    this.engine.setOptions(opts);
  }

  /** A note was saved: count its words and tasks (once things have settled). */
  private onSaved(file: TFile) {
    if (!this.engine) return;
    const key = file.path;
    const prev = this.pending.get(key);
    if (prev) window.clearTimeout(prev);
    this.pending.set(key, window.setTimeout(async () => {
      this.pending.delete(key);
      this.feed(key, await this.app.vault.cachedRead(file));
    }, 1200));
  }

  private onEdit(editor: Editor, info: MarkdownView | MarkdownFileInfo) {
    if (!this.engine) return;
    const key = info.file?.path ?? '';
    const prev = this.pending.get(key);
    if (prev) window.clearTimeout(prev);
    this.pending.set(key, window.setTimeout(() => {
      this.pending.delete(key);
      this.feed(key, editor.getValue());
    }, 1200));
  }

  /** Writing attracts flies; completed tasks bring out crickets, if they're on. */
  private feed(key: string, text: string) {
    const words = text.match(WORD)?.length ?? 0;
    const tasks = text.match(DONE_TASK)?.length ?? 0;
    const before = this.counts.get(key);
    this.counts.set(key, { words, tasks });
    if (!before || !this.engine) return;
    const s = this.settings;
    if (s.bugsFromWriting && words > before.words) {
      this.wordBank += words - before.words;
      let spawned = 0;
      while (this.wordBank >= s.wordsPerBug && spawned < 2) {
        this.wordBank -= s.wordsPerBug;
        this.engine.spawnBug('fly');
        spawned++;
      }
      this.wordBank = Math.min(this.wordBank, s.wordsPerBug);
    }
    if (s.crickets && tasks > before.tasks) {
      for (let i = 0; i < Math.min(2, tasks - before.tasks); i++) this.engine.spawnBug('cricket');
    }
  }
}

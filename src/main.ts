import { Editor, MarkdownFileInfo, MarkdownView, Platform, Plugin, TFile } from 'obsidian';
import { PetEngine, PetOptions } from './engine/engine';
import { showPetMenu } from './actions';
import { Diary } from './diary';
import { BUG_KINDS, BugKind } from './engine/bugs';
import { DiaryKind, rollTraits } from './engine/personality';
import { GraphBalls } from './graph';
import { PANEL_VIEW, PetPanel } from './panel';
import { WorkspacePranks } from './pranks';
import { MISCHIEF_MINUTES, PixelPetSettingTab, DEFAULT_SETTINGS, PetSettings, settingsFrom } from './settings';

const WORD = /[\p{L}\p{N}]+/gu;
const DONE_TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/gm;

export default class PixelPetPlugin extends Plugin {
  settings: PetSettings = { ...DEFAULT_SETTINGS };
  private engine: PetEngine | null = null;
  private counts = new Map<string, { words: number; tasks: number }>();
  /** Words written toward each kind of bug's next one. */
  private wordBank: Record<BugKind, number> = { fly: 0, cricket: 0 };
  /** When each kind of bug next turns up of its own accord (ms). */
  private nextAlone: Partial<Record<BugKind, { at: number; minutes: number }>> = {};
  private pending = new Map<string, number>();
  private graph = new GraphBalls(this.app);
  /** What it has been up to, for the pet panel. */
  readonly diary = new Diary();
  /** The note opened last (the active one, when the panel has the focus, isn't). */
  private lastNote: string | undefined;
  private pranks = new WorkspacePranks(this.app, () => BUG_KINDS.some((k) => this.settings.critters[k].enabled));

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new PixelPetSettingTab(this.app, this));

    this.addRibbonIcon('paw-print', 'Toggle pet', () => this.toggle());
    this.addCommand({ id: 'toggle', name: 'Show or hide the pet', callback: () => this.toggle() });
    this.addCommand({ id: 'summon', name: 'Call the pet over', callback: () => this.engine?.summon() });
    this.addCommand({ id: 'release-bug', name: 'Release a bug', callback: () => {
      const kinds = BUG_KINDS.filter((k) => this.settings.critters[k].enabled);
      if (kinds.length) this.engine?.spawnBug(kinds[Math.floor(Math.random() * kinds.length)]);
    } });
    this.registerView(PANEL_VIEW, (leaf) => new PetPanel(leaf, () => this.engine, this.diary, () => this.openSettings()));
    // Right-click the pet for its own menu.
    this.registerDomEvent(window, 'contextmenu', (e) => {
      if (!this.engine?.hits(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
      showPetMenu({ x: e.clientX, y: e.clientY }, this.engine, this.menuExtras);
    }, { capture: true });
    this.addCommand({ id: 'open-panel', name: 'Open pet panel', callback: () => this.openPanel() });

    this.registerEvent(this.app.workspace.on('css-change', () => this.engine?.refreshPalette()));
    this.registerEvent(this.app.workspace.on('file-open', (file) => { if (file) this.lastNote = file.basename; this.engine?.noteChanged(); }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.engine?.noteChanged()));
    this.registerEvent(this.app.workspace.on('editor-change', (editor: Editor, info: MarkdownView | MarkdownFileInfo) => this.onEdit(editor, info)));
    // Editors that don't raise editor-change (Butter Editor, say) still save the note.
    this.registerEvent(this.app.vault.on('modify', (file) => { if (file instanceof TFile && file.extension === 'md') this.onSaved(file); }));
    this.register(() => { for (const t of this.pending.values()) window.clearTimeout(t); });
    this.registerInterval(window.setInterval(() => this.bugsOnTheirOwn(), 5000));

    this.app.workspace.onLayoutReady(() => { if (this.settings.enabled) this.start(); });
  }

  onunload() {
    this.stop();
  }

  async loadSettings() {
    this.settings = settingsFrom(await this.loadData());
    // Every gecko gets its own personality the first time, and keeps it.
    if (!this.settings.traits) {
      this.settings.traits = rollTraits();
      await this.saveData(this.settings);
    }
  }

  private menuExtras = { diary: () => void this.openPanel(), settings: () => this.openSettings() };

  /** Pixel Pet's settings. */
  openSettings() {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** Into the diary, with the note it happened in where that matters. */
  private noteDiary(kind: DiaryKind, text: string) {
    const inNote = kind === 'explore' || kind === 'nap' || kind === 'letter';
    this.diary.add(kind, text, inNote ? this.app.workspace.getActiveFile()?.basename ?? this.lastNote : undefined);
  }

  /** A whole new personality, rolled afresh. */
  async newPersonality() {
    this.settings.traits = rollTraits();
    await this.saveSettings();
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
      temperament: s.temperament,
      mischief: s.mischief,
      mischiefMinutes: MISCHIEF_MINUTES[s.mischiefOften] ?? MISCHIEF_MINUTES.sometimes,
      nibble: s.nibbleLetters,
      critters: s.critters,
      sleepAfterMs: s.sleepAfterMinutes * 60_000,
      reducedMotion: reduced,
      graph: this.graph,
      pranks: this.pranks,
      onDiary: (kind, text) => this.noteDiary(kind, text),
      onMenu: (x, y) => { if (this.engine) showPetMenu({ x, y }, this.engine, this.menuExtras); },
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
  async openPanel() {
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

  /** Writing and finished tasks bring out bugs, each kind as its settings say. */
  private feed(key: string, text: string) {
    const words = text.match(WORD)?.length ?? 0;
    const tasks = text.match(DONE_TASK)?.length ?? 0;
    const before = this.counts.get(key);
    this.counts.set(key, { words, tasks });
    if (!before || !this.engine) return;
    for (const kind of BUG_KINDS) {
      const c = this.settings.critters[kind];
      if (!c.enabled) continue;
      if (c.words > 0 && words > before.words) {
        this.wordBank[kind] += words - before.words;
        let spawned = 0;
        while (this.wordBank[kind] >= c.words && spawned < 2) {
          this.wordBank[kind] -= c.words;
          this.engine.spawnBug(kind);
          spawned++;
        }
        this.wordBank[kind] = Math.min(this.wordBank[kind], c.words);
      }
      if (c.tasks && tasks > before.tasks) {
        for (let i = 0; i < Math.min(2, tasks - before.tasks); i++) this.engine.spawnBug(kind);
      }
    }
  }

  /** Bugs that turn up now and then of their own accord, at a loose rhythm. */
  private bugsOnTheirOwn() {
    const now = Date.now();
    for (const kind of BUG_KINDS) {
      const c = this.settings.critters[kind];
      if (!c.enabled || c.minutes <= 0 || !this.engine) { delete this.nextAlone[kind]; continue; }
      const next = this.nextAlone[kind];
      if (next && next.minutes === c.minutes && now < next.at) continue;
      if (next && next.minutes === c.minutes) this.engine.spawnBug(kind);
      this.nextAlone[kind] = { at: now + c.minutes * 60_000 * (0.6 + Math.random() * 0.8), minutes: c.minutes };
    }
  }
}

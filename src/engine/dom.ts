/** A window with Obsidian's element helpers, which every Obsidian window (popouts too) has. */
export type ObsidianWindow = Window & { createEl: typeof createEl; createDiv: typeof createDiv; createSpan: typeof createSpan };

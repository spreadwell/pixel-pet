# Pixel Pet

A pixel pet that lives in your Obsidian workspace. The first pet is a gecko.

Every gecko has its own personality. Some are quick and bold, others are wary, lazy or always hungry. It explores in short dashes, stops to look around and taste the air, basks in a favorite corner, and takes naps. It keeps to the seams between your panels the way real geckos keep to the cracks between stones.

Your workspace is its terrain. It finds its way along the margins and the gaps between paragraphs, climbs up onto the sidebars and the tab bar, perches on tabs and headings, and climbs up onto your paragraphs when that's the short way. It rears up at a ledge before scrambling over, peers over the edge before climbing down, and looks bigger the higher it is. Letters dip under its feet, and after walking through your text it leaves a few inky footprints in the text's colour. Small icons dip under its feet when it steps on them. (Only the display moves; your note is never touched.) When the note scrolls, it rides along on the page. Press on it and drag to pick it up and carry it somewhere else.

It notices what happens in Obsidian: open the command palette or a dialog and it freezes and watches until it closes; a notice popping up draws it over to pounce; drag a file or a tab and it chases it; open another note and it scouts a quick lap round your writing, stopping at the corners to look about. If it was by a side panel when the view changed, it scurries up onto the panel for safety and watches from there. Startle it near a code block or callout and it dives underneath, then peeks back out. In the graph view, the nodes are its balls: it stalks one, wiggles, pounces and knocks it flying, sometimes trots off with it in its mouth, and goes again. When you stop typing, it comes over to sniff along the words you just wrote.

Rest your pointer somewhere nearby and it takes an interest: it turns to look, drifts closer, and ends up watching it from a wary distance, as it does your caret while you type. Move at it too fast and it freezes, then bolts. Out in the margins, bring the pointer to it slowly and hold it still on it to pet it. On or next to your text, though, a pointer coming near always sends it scurrying clear of the words, so it is never in the way of a click. Now and then, at rest, it does a few slow push-ups or a big yawn. When you've been away for a while, it heads home, stretches out and sleeps.

Writing brings it food. Every few dozen words a fly drifts in from the edge of the window, and finishing a task brings out a cricket. It spots them from most of the window away and comes over to hunt them; a hungry gecko hunts harder; a full one would rather bask. It stalks, freezes and winds up with its tail lashing and hips wiggling, then strikes in a burst. Catch one and it snaps its jaws shut, gives it a shake, chews, and you can see the lump go down before it licks its lips. It doesn't always catch them.

Now and then it tastes a word with its tongue, plucks a letter out of it and scurries off somewhere quiet to eat it. **Only the display changes. Your note is never modified.** The eaten letter stays faintly visible, so your text is still readable, and fills back in over half a minute.

## Details

- It takes on your accent color by default, or you can choose your own.
- It stays out of the way while you type and never sits on the line you're writing.
- It never blocks clicks: the pet lives on a click-through layer that sits below menus, popovers and modals.
- It pauses completely when Obsidian is hidden and runs at a few frames per second while asleep.
- Reduced motion is respected, following your system setting unless you override it.

Show or hide it from the ribbon (paw icon) or the command palette. The palette also has **Call the pet over** and **Release a bug**.

Works on desktop and mobile. On touch screens, tap near it to get its attention, hold a finger on it to pet it, and tap it directly to make it dart away.

## Development

```text
npm install
npm run typecheck
npm run build      # main.js for Obsidian
npm run harness    # harness/harness.js, then open harness/index.html over http
```

The engine in `src/engine/` has no Obsidian dependency. `harness/index.html` mimics Obsidian's layout so behavior can be tuned in a plain browser, with a loupe, contact sheets, and `sim(seconds)` to step the simulation. `harness/studio.html` drives the bare body at fixed speeds and paints frame-by-frame sheets (`strips([0, 30, 80])`, `turn(30)`, `zoom(n)`) for judging the sprite and gait.

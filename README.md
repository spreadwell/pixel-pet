# Pixel Pet

A pixel pet that lives in your Obsidian workspace. The first pet is a gecko.

Every gecko has its own personality. Some are quick and bold, others are wary, lazy or always hungry. It explores in short dashes, stops to look around and taste the air, basks in a favorite corner, and takes naps. It keeps to the seams between your panels the way real geckos keep to the cracks between stones.

Your workspace is its terrain. It climbs up onto the sidebars and the tab bar, perches on tabs and headings, clambers over your lines of text and squeezes along the gaps between paragraphs. You can see it scramble at a ledge and its shadow fall away beneath it. The sidebars are also its rocks: when it wants cover it slips underneath one, waits a while, then peeks out with just its head showing. Frighten it and it bolts for the nearest one.

Leave your pointer resting near it and it may stalk it. Move at it too fast and it freezes, then bolts. Hover over it slowly and it lets you pet it. When you've been away for a while, it heads home, curls up and sleeps.

Writing brings it food. Every few dozen words a fly drifts in from the edge of the window, and finishing a task brings out a cricket. A hungry gecko spots prey from farther away and hunts harder; a full one would rather bask. It stalks, freezes with its tail twitching, and strikes. It doesn't always catch them.

Now and then it tastes a word with its tongue and takes a bite out of a letter. **Only the display changes. Your note is never modified.** The letter grows back after a minute or so.

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

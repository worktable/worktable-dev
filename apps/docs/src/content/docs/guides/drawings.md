---
title: Drawings
description: Sketch, edit visual plans with agents, and recover drawing changes.
---

Drawings hold freehand marks, shapes, arrows, text, and images. Connected agents
can inspect and edit them.

## Create a drawing

Choose **Drawing** from a Space's **+** menu. Changes save automatically when
you stop drawing.

- **Board menu → Grid** sets the background.
- **Archives → Keep** makes a temporary drawing durable.

If **Drawing** is missing on an older installation, complete the
[workspace upgrade](/guides/update-and-uninstall/#workspace-upgrades).

## Work with agents

Ask an agent to inspect the drawing first. Agents read PNG or SVG previews and
edit specific objects, such as labels, arrows, shapes, and images:

```text
Open the workshop layout drawing. Move the check-in table beside the
entrance and leave the other stations unchanged. Show me the updated preview.
```

Agents can preview proposals and undo saved batches while history is kept. See
[agent drawing guidance](/agents/drawings/).

Typed text appears in search; freehand marks don't.

## Handle concurrent changes

An idle canvas picks up agent changes without moving your view. Undo steps that
would overwrite those changes are cleared, with a notification.

Simultaneous edits are not merged. If the drawing changed while you were
drawing, choose **Save a copy** before **Reload drawing** to keep your work.

## Export and recover

The document menu offers **Download PNG**, **Download Drawing**, and **Save a
Copy**. There is no drawing history panel yet, but agents can recover retained
versions.

Each autosave stores the whole drawing, images included, so image-heavy drawings
use a lot of history storage. To limit it, set retention in **Settings → Data**.
Shorter retention removes older recovery points.

On iPad, if Apple Pencil handwriting skips strokes, try turning off **Settings →
Apple Pencil → Scribble**.

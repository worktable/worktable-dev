---
title: Drawings
description: Sketch, edit visual plans with agents, and recover drawing changes.
---

Drawings hold freehand marks, shapes, arrows, typed text, and images. They save
with the rest of a Space and can be inspected or edited by connected agents.

## Create a drawing

Choose **Drawing** from the **+** menu beside a Space. Drawings open with the
selection arrow active. Use the drawing tools for shapes, text, and freehand
marks; changes save automatically after you stop drawing.

Choose a background under **Board menu → Grid**. It saves with the drawing.
Use **Archives → Keep** to make a temporary drawing durable.

If **Drawing** is missing from that menu on an older installation, complete
the [workspace upgrade](/guides/update-and-uninstall/#workspace-upgrades).

## Work with agents

Ask an agent to inspect the drawing before changing it. Agents can read PNG or
SVG previews and edit specific objects, including labels, arrows, shapes, and
images. Typed text appears in search; freehand marks need visual inspection.

For example:

```text
Open the workshop layout drawing. Move the check-in table beside the
entrance and leave the other stations unchanged. Show me the updated preview.
```

Agents can preview proposals and undo saved batches while the relevant history
is retained. See [agent drawing guidance](/agents/drawings/).

## Handle concurrent changes

An idle canvas refreshes after agent changes without moving your viewport.
Compatible local undo and redo steps remain available. Worktable clears steps
that would overwrite external changes or remove objects they need, and shows
a notification.

Simultaneous drawing edits are not merged. If the saved drawing changed while
you were drawing, choose **Save a copy** to preserve your work before choosing
**Reload drawing**.

## Export and recover

The document menu offers **Download PNG**, **Download Drawing**, and **Save a
Copy**. Drawing versions are retained through the document API, but the browser
does not yet have a drawing history panel. An agent can use retained versions
for recovery.

Each autosave stores the full drawing, including embedded images. Image-heavy
drawings can use substantial history storage. Set a retention limit in
**Settings → History** if needed; shorter retention removes older recovery
points.

On iPad, if Apple Pencil handwriting skips strokes, try disabling **Settings →
Apple Pencil → Scribble**. Handwriting with Scribble enabled and palm rejection
still need further device validation.

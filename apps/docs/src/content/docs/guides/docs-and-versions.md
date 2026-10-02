---
title: Docs, versions, and links
description: Editing, markdown in and out, version history, and the link graph that keeps a space navigable.
---

Docs hold your writing, sketches, and interactive tools. This guide covers working with them from the human side.

## Editing

The editor is a block editor: headings, lists, tables, code, diagrams, drag-to-reorder. It's collaborative under the hood (you and an agent can touch the same doc simultaneously without stepping on each other), and offline edits sync when you're back.

Click **New doc** without typing a name and Worktable names it `untitled` (or `untitled-2`, and so on) — the sidebar label switches to the doc's first heading as soon as it has one. Drag docs and folders in the sidebar to set your own order; it's saved and syncs to your other clients.

## Markdown in, markdown out

Agents write docs as Markdown; simple docs are stored as `.md` files you can open anywhere. Select **Edit** on a Markdown doc to work on it in the rich editor. Rich content is stored as structured JSON, and agents can still read it as Markdown. Doc paths are slugs derived from titles (`research/competitive-analysis`), so filenames stay clean no matter who writes.

Need a doc's content somewhere else? **Copy Markdown** in the doc header or the sidebar's right-click menu copies it as clean Markdown, converting from rich text if that's how it's stored. **Download Markdown** saves the same content as a `.md` file. When a rich doc can be represented completely in Markdown, **Save Markdown** also appears and changes the doc back to `.md` storage. Rich-only formatting keeps that action hidden so saving cannot silently lose part of the doc. If another device still has offline edits from before the format changed, Worktable offers to recover them into a separate doc. **Print PDF** opens your browser's print dialog with a clean, chrome-free layout.

## Durable and temporary documents

Every document is durable or temporary. Durable documents stay until someone
archives them. Temporary documents hold supporting work, such as handoffs,
drafts, and run notes: they stay out of the main sidebar tree in a Temporary
section and archive themselves 7 days after their last edit, rename, or
comment, or on a date you choose.

New documents you create in the app start temporary; clear **New documents are
temporary** in the Space's **+** menu to create durable ones. On a temporary
document, the **Archives** chip next to the title offers **Keep** (make it
durable), a new date, or archiving now. **Make temporary** in a durable
document's menu does the reverse. Archived documents are never deleted
automatically; restore one and it comes back durable.

Home lists recent durable documents across Spaces; turn on **Include
temporary** to see supporting work too.

## Version history

Every doc keeps history, kept forever by default. Open it from the doc menu to read old versions, mark a checkpoint before risky work, or restore. This is what makes "let the agent rewrite it" a safe instruction because a bad rewrite is one restore away. If a workspace is growing large, trim retention to a time window or a per-doc count in Settings → History; tightening it deletes older versions immediately, so Worktable confirms before applying.

HTML docs keep their own history and checkpoints. Restoring an older version
changes the HTML doc itself but does not roll back its saved interface state.

Drawing history is retained through the document API; drawings do not yet have
a history panel in the browser. Each autosave keeps a full drawing, including
embedded images. Image-heavy drawings can grow history quickly; use Settings →
History to choose a retention limit if needed.

## Links and the graph

Link docs by path `[Title](/other-doc)` and Worktable tracks the graph: agents see each doc's links and backlinks, and a write that links to a missing doc returns a warning. Worktable links stay in the current tab, while links to other websites open in a new tab. You can still use your browser's link menu to open or copy any destination. Ask your agents to link related docs; the graph is how a space stays navigable at fifty docs.

Renaming a doc or moving a folder doesn't break the links that point at the old
path: existing links and bookmarks keep resolving to the doc's new location.

## Diagrams

Worktable checks Mermaid diagrams in docs before saving them. When an agent
builds a diagram inside an HTML doc, it checks that diagram before embedding it.

Select a diagram, or its **Fullscreen** button, to open it in a viewer where
you can zoom, pan, fit it to the screen, and download it as an SVG.

## Drawings

Choose **New → New drawing** beside a Space to open a Quickdraw scratchpad for
freehand notes, shapes, text, and images. This action is available on Worktables
using V2 document storage. Changes save automatically after you stop drawing.
The document menu offers **Download PNG**, **Download drawing**, and **Save a copy**.

Agents can inspect PNG or SVG previews and edit specific objects, including
shapes, arrows, labels and images. Typed text appears in search; freehand marks
need visual inspection. Agents can preview proposals and undo their saved
batches while history is retained. See [the drawing tool workflow](/agents/writing-docs/#working-with-drawings).

Clean idle canvases refresh after agent changes without moving your viewport.
Local undo and redo remain available for compatible gestures. Steps that would
overwrite external changes or remove objects needed by them are cleared, with
a notification. Agent batches and retained document versions also provide
durable recovery paths.
Concurrent edits are not merged; if the saved drawing changed elsewhere while
you were drawing, use **Save a copy** to keep your work before **Reload drawing**.

On iPad, Scribble can cause browser handwriting to skip strokes. If that happens,
turn off **Settings → Apple Pencil → Scribble** while drawing. Handwriting with
Scribble enabled and palm rejection still need further device validation.

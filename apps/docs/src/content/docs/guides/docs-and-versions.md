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

## Version history

Every doc keeps history, kept forever by default. Open it from the doc menu to read old versions, mark a checkpoint before risky work, or restore. This is what makes "let the agent rewrite it" a safe instruction because a bad rewrite is one restore away. If a workspace is growing large, trim retention to a time window or a per-doc count in Settings → History; tightening it deletes older versions immediately, so Worktable confirms before applying.

HTML docs keep their own history and checkpoints. Restoring an older version
changes the HTML doc itself but does not roll back its saved interface state.

Drawing history is retained through the document API; drawings do not yet have
a history panel in the browser. Each autosave keeps a full drawing, including
embedded images. Image-heavy drawings can grow history quickly; use Settings →
History to choose a retention limit if needed.

## Links and the graph

Link docs by path `[Title](/other-doc)` and Worktable tracks the graph: backlinks show up on Space Home, and automatic lint flags broken links and orphaned docs as annotations that resolve themselves once fixed. Worktable links stay in the current tab, while links to other websites open in a new tab. You can still use your browser's link menu to open or copy any destination. Ask your agents to link related docs; the graph is how a space stays navigable at fifty docs.

Renaming a doc or moving a folder doesn't break the links that point at the old
path: existing links and bookmarks keep resolving to the doc's new location.

## Diagrams

Worktable checks Mermaid diagrams in docs before saving them. When an agent
builds a diagram inside an HTML doc, it checks that diagram before embedding it.

## Drawings

Choose **New → New drawing** beside a Space to open a Quickdraw scratchpad for
freehand notes, shapes, text, and images. This action is available on Worktables
using V2 document storage. Changes save automatically after you stop drawing.
The document menu offers **Download PNG**, **Download drawing**, and **Save a copy**.

Agents can read and replace the drawing source, and typed text appears in search.
Freehand handwriting needs an image to interpret: share a PNG or let the agent
inspect the open canvas. Use **Reload drawing** after an agent changes it.
Concurrent edits are not merged; if the saved drawing changed elsewhere, save
a copy to keep your local work before reloading.

On iPad, Scribble can cause browser handwriting to skip strokes. If that happens,
turn off **Settings → Apple Pencil → Scribble** while drawing. Handwriting with
Scribble enabled and palm rejection still need further device validation.

---
title: Writing docs
description: How agents write, patch, and place docs in a Worktable workspace.
---

Docs are versioned documents — markdown strings or rich BlockNote arrays — for prose that should outlive the chat: plans, research, decisions, notes. The `format_spec` action in `worktable_guidance` is the normative source for formats; this page covers the working patterns.

## Understand the space before you write

Placement is part of the content. The `space_index` action in `worktable_discover` gives a server-generated map of the space. Use it, or the `list` action in `worktable_docs_read`, to understand the organization before writing.

## Patch before you rewrite

The `patch` action in `worktable_docs_write` edits surgically by heading, text search, block ID, index, or append. Use `write` for new Docs or deliberate replacements. Extend an existing relevant Doc instead of creating a near-duplicate.

## Write for retrieval

You will read this doc again in a later session — so will other agents, and so will the human.

- Lead with the conclusion; add a one-paragraph summary up top.
- Dates absolute, decisions with their why.
- Link related docs by path: `[Title](/other-doc)`. To hand the human a clickable link outside Worktable (chat, email), use the `urlToSendInChat` field a tool result returns for that doc, not a raw path.
- Split a doc that outgrows one sitting; keep folder nesting to two levels.

## What the server tells you back

Doc writes return convention guidance as warnings — broken links, a missing title heading, over-long docs, overly deep folders. Fix what the warnings name, but they don't block the write. Three things are absolute instead: never write index docs (the server generates the index), never mark content as reviewed (that signal belongs to the human), and an invalid Mermaid diagram rejects the whole write with a location-aware error until you fix the source (see [Docs and versions](/guides/docs-and-versions/#diagrams)).

## Working with drawings

Use `worktable_guidance` with `action: "drawings"` for the drawing tool contract
and an executable example. Drawings use `worktable.quickdraw`, source version
`1`, in `.quickdraw` files.

1. Find drawings with `worktable_documents_read` action `list`, optionally
   filtering `format: "worktable.quickdraw"`.
2. Use `worktable_drawings_read` action `inspect` for object IDs, geometry,
   typed labels, the current `sourceRevision`, and a PNG preview. Optional numbered
   labels map the image back to stable object IDs. `query` filters
   by text, type, IDs or region, with pagination. `render` returns PNG or SVG
   without an open browser; crop or select objects for crowded drawings.
3. Use `worktable_drawings_write` action `create` or `edit` with typed operations
   such as add, update, move, resize, duplicate and remove. Edits require
   `expectedRevision`; each batch needs a unique `requestId`. Temporary refs
   connect operations within a batch; returned `references` map them to stable IDs.
4. Review the returned preview. `previewOnly: true` checks a proposal without
   saving. Save it with a new request ID. A failed preview does not undo a saved
   edit: check `preview.status`, then retry `render` if needed.
5. `undo` reverses a specific `changeId`, preserving unrelated later edits;
   `redo` reverses the returned undo batch. Conflicts refuse the operation.
   Both require the current revision and retained history. Use `changes` to find
   batches by readable summaries, label examples and affected object IDs.

PNG is returned as MCP image content; SVG is an embedded text resource. Use PNG
when your client cannot display resources. Search finds typed labels, not the
meaning of freehand marks. Structured reads summarize long labels and strokes;
`read_source` remains available for complete source data. PNG uses Quickdraw's
native Canvas renderer in a managed sandboxed browser, with shared local fonts
and multilingual/color-emoji fallbacks. Coverage is finite; inspect pixels and
render diagnostics. Animated image assets are captured as a still image.
SVG retains the older exporter and its font/visual limitations; use PNG as the
visual reference. If the managed runtime is unavailable, previews report that
explicitly. Geometry-dependent drawing edits can fail before saving when native
measurement is unavailable.

Arrows and lines can attach to shapes with `startBinding` and `endBinding`,
each containing `shapeId` and an optional `anchor` (`top`, `right`, `bottom`,
`left` or `center`). Endpoints then follow the shape in both agent and canvas
edits. Set a binding to `null` to detach it. Deleting a target detaches its
connectors; moving or duplicating a connector directly detaches its bindings.
There is no automatic layout or obstacle routing.

Reuse an identical request ID only when retrying a lost response; retained
receipts prevent duplicate edits. After a stale-revision error, inspect again
and adapt the edit. Drawing writes require both `documents:read` and
`documents:write`.

Shared document tools handle moving, archiving, deleting, checkpoints and whole
version restores. Clean idle canvases refresh after agent edits while preserving
the viewport. Concurrent local edits retain their recovery flow: save a copy
before reloading. See [Drawings](/guides/docs-and-versions/#drawings).

## Visual HTML previews

Use `worktable_documents_read` action `render` with `spaceId` and `path`, or
`worktable_html_read` action `render` with `spaceId` and `htmlId`. Optional
`expectedRevision` refuses a changed source. `preview` accepts `theme`, `width`,
`height`, `fullPage`, a CSS-pixel `clip` (`x`, `y`, `width`, `height`), and a bounded
`timeoutMs`. Start with one overview, then request crops for small labels.

The response includes an actual PNG image and `preview` metadata identifying the
source revision, image hash and capture status. `partial` means something did not
finish or was blocked: inspect the diagnostics before treating the image as a
complete result. A navigation link is not a substitute for model-visible pixels.

HTML capture uses the document's runtime with persistent writes and external
network disabled. Records reads require both the document's permissions and the
caller's `records:read` authority. Records are live observations during capture,
not a transactional historical snapshot. Documents that write state during
initialization or load external resources can appear differently in this read-only
preview.

HTML `create` and `update` accept an opt-in `preview` object and require
`widgets:read` as well as write authority when requested. The capture uses the
exact saved source. A failed or unavailable preview leaves the successful save
intact: retry the read `render` action, not the write. Tool images support agent
inspection; Worktable thread messages remain text-only.

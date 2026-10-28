---
title: Drawings
description: Inspect, edit, and verify Worktable drawings.
---

Use `worktable_guidance` with `topic: "drawings"` for the drawing tool contract
and an executable example. Drawings use `worktable.quickdraw`, source version
`1`, in `.quickdraw` files.

1. Find drawings with `worktable_files_read` without a `path`, optionally
   filtering `format: "worktable.quickdraw"`.
2. Use `worktable_drawings_read` for object IDs, geometry, typed labels, the
   current `sourceRevision`, and a PNG preview. Optional numbered labels map the
   image back to stable object IDs. `text`, `types`, `ids` or `region` filter
   the objects, with pagination. `preview.format: "svg"` returns SVG, and
   `preview.mode: "none"` returns objects only; crop or select objects for
   crowded drawings.
3. Use `worktable_drawings_write` with `title` and `lifetime` to create a
   drawing, or with `expectedRevision` and typed `operations` such as add,
   update, move, resize, duplicate and remove to edit one. Each batch needs a
   unique `requestId`. Temporary refs
   connect operations within a batch; returned `references` map them to stable IDs.
4. Review the returned preview. `previewOnly: true` checks a proposal without
   saving. Save it with a new request ID. A failed preview does not undo a saved
   edit: check `preview.status`, then retry `worktable_files_render` if needed.
5. `undoChangeId` reverses a specific change, preserving unrelated later
   edits; add `redo: true` to reapply a change that was undone. Conflicts refuse
   the operation. Both require the current revision and retained history. Read
   with `changes: true` to find changes by readable summaries, label examples
   and affected object IDs.

PNG is returned as MCP image content; SVG is an embedded text resource. Use PNG
when your client cannot display resources. Search finds typed labels, not the
meaning of freehand marks. Structured reads summarize long labels and strokes;
`worktable_files_read` with `source: true` returns the complete source data. PNG uses Quickdraw's
native Canvas renderer in a managed sandboxed browser, with shared local fonts
and multilingual/color-emoji fallbacks. Coverage is finite; inspect pixels and
render diagnostics. Animated image assets are captured as a still image.
SVG retains the older exporter and its font/visual limitations; use PNG as the
visual reference. If the managed runtime is unavailable, previews report that
explicitly. Geometry-dependent edits and new or changed image assets require the
runtime before saving, even with previews disabled. Image imports must decode
successfully and stay within 8,192 pixels per dimension and 16 million total
image pixels. Edits that keep existing image bytes and image removal do not need
image decoding.

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

`worktable_files_update`, `worktable_files_write` and `worktable_delete`
handle moving, archiving, checkpoints, whole version restores and deleting. Clean idle canvases refresh after agent edits while preserving
the viewport. Concurrent local edits retain their recovery flow: save a copy
before reloading. See [Drawings](/guides/drawings/).

For the full source and operation contract, see [Drawing operations](/reference/drawing-operations/).

---
title: Drawings
description: Inspect, edit, and verify Worktable drawings.
---

Call `worktable_guidance` with `topic: "drawings"` for the drawing contract and
an executable example. Drawings use `worktable.quickdraw`, source version `1`,
in `.quickdraw` files.

1. **Find.** Call `worktable_files_read` without a `path`, optionally with
   `format: "worktable.quickdraw"`.
2. **Read.** `worktable_drawings_read` returns object IDs, geometry, typed
   labels, the current `sourceRevision`, and a PNG preview.
   - Optional numbered labels map the image back to object IDs.
   - Filter with `text`, `types`, `ids` or `region`; results are paginated.
   - `preview.format: "svg"` returns SVG; `preview.mode: "none"` returns
     objects only. Crop or select objects for crowded drawings.
3. **Write.** `worktable_drawings_write` with `title` and `lifetime` creates a
   drawing. With `expectedRevision` and typed `operations` (add, update, move,
   resize, duplicate, remove) it edits one. Each batch needs a unique
   `requestId`. Temporary refs connect operations within a batch; returned
   `references` map them to stable IDs.
4. **Review.** Check the returned preview. `previewOnly: true` checks a
   proposal without saving; save it with a new request ID. A failed preview
   does not undo a saved edit: check `preview.status`, then retry
   `worktable_files_render` if needed.
5. **Undo.** `undoChangeId` reverses one change and keeps unrelated later
   edits; add `redo: true` to reapply it. Conflicts refuse the operation. Both
   need the current revision and retained history. Read with `changes: true`
   to find changes by summary, label examples and affected object IDs.

## Previews

- PNG is returned as MCP image content; SVG as an embedded text resource. Use
  PNG if your client can't display resources.
- PNG is the visual reference. It uses Quickdraw's native renderer with shared
  fonts and multilingual and color-emoji fallbacks. Coverage is finite, so
  inspect the pixels and render diagnostics. Animated images render as a still.
- SVG uses the older exporter, with font and visual limitations.
- If the preview runtime is unavailable, previews say so. Geometry-dependent
  edits and new or changed images still need the runtime to save, even with
  previews disabled.
- Images must decode and stay within 8,192 pixels per side and 16 million
  pixels total. Keeping or removing existing images doesn't need decoding.

Search finds typed labels, not the meaning of freehand marks. Structured reads
summarize long labels and strokes; `worktable_files_read` with `source: true`
returns the full source.

## Connectors

Arrows and lines attach to shapes with `startBinding` and `endBinding`, each
with a `shapeId` and optional `anchor` (`top`, `right`, `bottom`, `left` or
`center`). Endpoints then follow the shape. Set a binding to `null` to detach
it. Deleting a target detaches its connectors; moving or duplicating a
connector detaches its bindings. There is no automatic layout or routing.

## Retries and conflicts

Reuse a request ID only to retry a lost response; retained receipts prevent
duplicate edits. After a stale-revision error, read again and adapt the edit.
Drawing writes require both `documents:read` and `documents:write`.

`worktable_files_update`, `worktable_files_write` and `worktable_delete` handle
moving, archiving, checkpoints, whole-version restores and deleting. Idle
canvases refresh after agent edits and keep their viewport. With unsaved local
edits, save a copy before reloading. See [Drawings](/guides/drawings/).

For the full contract, see [Drawing operations](/reference/drawing-operations/).

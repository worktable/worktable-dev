/** Kept with the tool implementation so examples use the same public contract. */
export const DRAWING_GUIDE = `Drawings are Worktable documents with a visual editing surface.

## Find drawings

Use \`worktable_documents_read\` action \`list\`; the drawing format ID is
\`worktable.quickdraw\`. Use the returned extensionless path. Search finds titles
and typed labels, but does not interpret freehand strokes.

\`worktable_documents_write\` handles \`move\`, \`archive\`, \`restore\`, \`checkpoint\`,
and \`restore_version\`. \`worktable_delete\` action \`document\` deletes a drawing.

For exact source round trips, use \`read_source\` and \`replace\`. Preserve the full
envelope, its optional grid background, and existing records. Read
\`worktable_guidance\` action \`format_spec\` for the raw format contract.

## Document previews

\`worktable_documents_read\` action \`render\` accepts \`spaceId\`, \`path\`, optional
\`expectedRevision\`, and \`preview {theme,width}\`. HTML uses the same action with
optional viewport height, \`fullPage\`, CSS-pixel \`clip\`, and \`timeoutMs\`.
PNG bytes arrive as image content, not a URL or base64 text.

## Inspect drawings

Use \`worktable_drawings_read\`:

- \`inspect\` returns \`sourceRevision\`, stable object IDs, geometry, text, bounds,
  and a PNG by default. Inspect the image before interpreting freehand marks,
  overlap, or spatial relationships.
- \`query\` filters by IDs, text, types, and intersecting \`region {x,y,w,h}\`.
  Paginate with \`offset\` and \`limit\`; \`nextOffset\` signals more results.
  Queries omit images by default.
- \`render\` returns an image without a structured object list. It uses the
  managed preview browser; no open user window is needed.

Render options are \`preview {format:'png'|'svg',theme:'light'|'dark',region,ids,width,background,labels}\`.
A top-level \`region\` filters structured objects and supplies the default crop.
\`preview.region\` only crops the image. Set \`labels:true\` to overlay short numbers
with an ID map in \`preview.labels\`.

PNG is an MCP image block; SVG is an embedded text resource. Request PNG if the
client cannot display embedded resources. Preview metadata identifies the same
\`sourceRevision\` as the returned objects.

## Read history

Supply \`versionId\` to read a retained historical version. Action \`changes\` lists
retained agent batches with readable summaries, \`changeId\`, and affected
\`addedIds\`, \`changedIds\`, and \`removedIds\`. Summaries include short label examples
and before/after labels for renames.

Each affected-ID list includes at most 100 IDs. Counts and \`affectedIdsTruncated\`
identify larger batches. Inspect with \`versionId\` equal to \`changeId\` to read the
retained resulting drawing. \`undoAvailable\` means the required history is
retained; later conflicting edits can still prevent undo.

## Create drawings

\`worktable_drawings_write\` action \`create\` takes \`spaceId\`, \`path\`, \`title\`,
\`lifetime\`, \`requestId\`, and \`operations\`. Choose \`durable\` for retained work or
\`temporary\` for supporting material. Each \`add\` uses a simple object. MCP arguments wrap these fields in \`request\`:

\`\`\`json
{
  "request": {
    "action": "create",
    "spaceId": "demo",
    "path": "request-flow",
    "title": "Request flow",
    "requestId": "flow-create-1",
    "operations": [
      {
        "op": "add",
        "ref": "browser",
        "object": {
          "type": "rectangle",
          "x": 0,
          "y": 0,
          "width": 180,
          "height": 90,
          "text": "Browser"
        }
      },
      {
        "op": "add",
        "ref": "api",
        "object": {
          "type": "rectangle",
          "x": 300,
          "y": 0,
          "width": 180,
          "height": 90,
          "text": "API",
          "color": "blue"
        }
      },
      {
        "op": "add",
        "object": {
          "type": "arrow",
          "startBinding": {
            "shapeId": "browser",
            "anchor": "right"
          },
          "endBinding": {
            "shapeId": "api",
            "anchor": "left"
          }
        }
      }
    ],
    "lifetime": "durable"
  }
}
\`\`\`

The \`references\` result maps temporary refs to stable IDs. Later operations in
the same batch may use earlier refs. Coordinates are world pixels; rotation is
in radians. Arrows use start coordinates \`x\`/\`y\` and local endpoint deltas \`dx\`/\`dy\`.

## Connect objects

Arrows and lines attach endpoints through \`startBinding\` and \`endBinding\`, each
with \`{shapeId,anchor}\`. \`shapeId\` accepts a stable ID or earlier batch ref.
Anchors are \`top\`, \`right\`, \`bottom\`, \`left\`, or \`center\`; defaults are \`right\`
for the start and \`left\` for the end.

- Attached endpoints follow target movement, size, and rotation in tools and canvas.
- Set a binding to \`null\` to detach that endpoint.
- Removing a target detaches its endpoints at their current positions.
- Direct connector geometry edits detach existing bindings unless supplied again.
- Duplicated connectors start detached.

Attachments use bounding-box anchors, not obstacle routing or outline snapping.
Agents choose placement; there is no automatic layout.

## Edit drawings

Inspect first. Then use action \`edit\` with \`expectedRevision\` equal to the
returned \`sourceRevision\`, a new \`requestId\`, and operations:

- \`update {id,changes:{text,color,...}}\`
- \`move {id,x,y}\`
- \`resize {id,width,height}\`
- \`rotate {id,rotation}\`
- \`duplicate {id,ref,x,y}\`
- \`reorder {id,position:'front'|'back'}\`
- \`remove {id}\`
- \`title {title}\`

Geometry types are \`rectangle\`, \`ellipse\`, \`triangle\`, \`diamond\`, \`hexagon\`, and
\`star\`. Other types are \`text\`, \`note\`, \`arrow\`, \`line\`, \`draw\`, \`highlight\`, and
\`image\`. Sizes \`s\`/\`m\`/\`l\`/\`xl\` and fonts \`draw\`/\`sans\`/\`serif\`/\`mono\` have defaults.

Notes resize proportionally by width; their height follows content, so omit
\`height\`. Read summaries use the same \`text\`, \`width\`, and \`height\` names as
writes. Draw and highlight points are local \`x,y,pressure\` triples.

## Import images

Use \`import_image {ref,width,height,dataUrl}\` to embed a bounded PNG, JPEG, WebP,
or GIF. Add an image object with \`assetId\` set to that ref. Remote URLs and SVG
image imports are unsupported.

New or changed image bytes must decode before saving, even with
\`preview.mode: 'none'\`. Each dimension is limited to 8,192 pixels; stored images
total at most 16 million pixels. Native PNG captures browser-decoded assets as
a still image.

## Verify changes

Writes return a PNG of the resulting snapshot by default. \`preview.mode\` accepts
\`all\`, \`changed\` (crop to affected objects), or \`none\`.

To inspect a proposal without saving, set \`previewOnly:true\` on create/edit.
Send the same operations with a **new** \`requestId\` to save. Proposal previews
have \`kind=proposal\`; \`sourceRevision\` identifies the base revision, or \`null\`
for a new document. It does not identify a saved proposal. Added object IDs can
change on save; use the final \`references\` mapping.

Validation is atomic: invalid operations leave the document unchanged.

- **Stale revision:** inspect again and adapt. Do not blindly retry against a new revision.
- **Connection loss:** retry the **same** \`requestId\` and identical input.
  Retained receipts prevent duplicate writes.
- **Saved with a failed preview:** \`preview.status='failed'\` or \`'unavailable'\`
  means the edit succeeded. Retry rendering, not the edit.

## Rendering limits

Native PNG uses Quickdraw's Canvas renderer and shared local fonts, including
multilingual fallbacks and color emoji. Font coverage is finite; inspect the
image and diagnostics. SVG is a legacy exporter with limited fonts and visual
differences. Native PNG is the visual reference.

The managed sandboxed browser must be installed and runnable. When unavailable,
geometry-dependent edits and new or changed image imports fail before saving.
Very large scenes and raster images have resource limits.

## Undo changes

Use action \`undo\` with the specific \`changeId\`, latest \`expectedRevision\`, and a
new \`requestId\`. Only the principal that authored the batch can undo or redo it.
Undo reverses that batch while preserving unrelated later changes; conflicting
changes to affected objects or the title prevent it.

Redo references the undo batch's returned \`changeId\` and uses the same conflict
checks. Creation undo removes created objects; it does not delete the document.

Receipts and reversibility expire with retained document history. Use shared
checkpoints for long-lived recovery. Whole-version restore replaces the whole
document and is distinct from targeted undo.

## Access

Drawing reads require \`documents:read\`. Writes require both \`documents:read\` and
\`documents:write\`. A permission denial requires an authorized connection or
token, not a different tool workaround.
`

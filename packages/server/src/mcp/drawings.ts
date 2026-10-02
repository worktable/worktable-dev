import { createHash } from "node:crypto"
import {
  DrawingsReadRequestSchema,
  DrawingsWriteRequestSchema,
  type DrawingPreview,
} from "@worktable/types"
import { withResultMedia } from "./media.ts"
export { takeResultMedia as takeDrawingMedia } from "./media.ts"
import { renderDrawing } from "../drawing-render.ts"
import { measureDrawing } from "../drawing-native.ts"
import type { OperationId } from "./operations.ts"
import { applyLifetimeOnCreate } from "../document-lifetime.ts"

export async function dispatchDrawingOperation(
  operation: OperationId,
  args: Record<string, unknown>,
  actor: string,
  signal?: AbortSignal
) {
  const { drawingRead, drawingWrite } = await import("../drawing-service.ts")
  const action = operation.slice("drawings.".length)
  const writing = ["create", "edit", "undo", "redo"].includes(action)
  const request = writing
    ? DrawingsWriteRequestSchema.parse({ ...args, action })
    : DrawingsReadRequestSchema.parse({ ...args, action })
  const result = writing
    ? await drawingWrite(DrawingsWriteRequestSchema.parse(request), {
        actor,
        source: "mcp",
        signal,
      })
    : await drawingRead(DrawingsReadRequestSchema.parse(request), { signal })
  // A saved create records the lifetime the agent chose. Preview-only
  // creates save nothing; a retried create re-applies the same choice.
  const lifetime =
    request.action === "create" && !request.previewOnly
      ? await applyLifetimeOnCreate({
          spaceId: request.spaceId,
          path: request.path,
          lifetime: request.lifetime,
          archiveOn: request.archiveOn,
        })
      : {}
  if (!("drawing" in result)) return { ...result, ...lifetime }
  const { drawing, ...metadata } = result
  const output: Record<string, unknown> = { ...metadata, ...lifetime }
  if (action === "render") {
    delete output.objects
    delete output.assets
    delete output.total
    delete output.nextOffset
  }
  const preview: DrawingPreview =
    "preview" in request ? (request.preview ?? {}) : {}
  const mode =
    action === "render"
      ? "all"
      : (preview.mode ??
        (action === "query" || action === "changes" ? "none" : "all"))
  if (mode === "none") return output
  try {
    const changedIds =
      "changedIds" in result
        ? [...result.addedIds, ...result.changedIds].filter(
            (id) => drawing.snapshot.document.store[id]?.typeName === "shape"
          )
        : []
    // Crop around affected objects while retaining nearby objects and crossing
    // connectors, so the preview can reveal overlaps introduced by the edit.
    const measurements =
      mode === "changed" && !preview.region && !preview.ids && changedIds.length
        ? await measureDrawing(drawing, changedIds, { signal })
        : {}
    const boxes = changedIds.flatMap((id) =>
      measurements[id] ? [measurements[id].page] : []
    )
    const x = boxes.length ? Math.min(...boxes.map((box) => box.x)) - 32 : 0
    const y = boxes.length ? Math.min(...boxes.map((box) => box.y)) - 32 : 0
    const changedRegion = boxes.length
      ? {
          x,
          y,
          w: Math.max(...boxes.map((box) => box.x + box.w)) - x + 32,
          h: Math.max(...boxes.map((box) => box.y + box.h)) - y + 32,
        }
      : undefined
    const image = await renderDrawing(drawing, {
      ...preview,
      signal,
      ...("region" in request && request.region && !preview.region
        ? { region: request.region }
        : {}),
      ...("ids" in request && request.ids && !preview.ids
        ? { ids: request.ids }
        : {}),
      ...(mode === "changed" && changedRegion && !preview.region && !preview.ids
        ? { region: changedRegion }
        : {}),
    })
    const { data, ...imageMetadata } = image
    const contentHash = createHash("sha256")
      .update(Buffer.from(data, "base64"))
      .digest("hex")
    const kind =
      "previewOnly" in result && result.previewOnly ? "proposal" : "saved"
    output.preview = {
      status: "ready",
      kind,
      contentHash,
      sourceRevision: result.sourceRevision,
      ...imageMetadata,
      contentBlockIndex: 1,
      capturedAt: new Date().toISOString(),
      theme: preview.theme ?? "light",
    }
    withResultMedia(
      output,
      image.mimeType === "image/png"
        ? [{ type: "image", mimeType: image.mimeType, data }]
        : [
            {
              type: "resource",
              resource: {
                uri: `worktable-drawing://preview/${encodeURIComponent("documentId" in result ? (result.documentId ?? "proposal") : "proposal")}/${contentHash}.svg`,
                mimeType: image.mimeType,
                text: Buffer.from(data, "base64").toString("utf8"),
              },
            },
          ]
    )
  } catch (error) {
    output.preview = {
      status:
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "PREVIEW_UNAVAILABLE"
          ? "unavailable"
          : "failed",
      kind:
        "previewOnly" in result && result.previewOnly ? "proposal" : "saved",
      sourceRevision: result.sourceRevision,
      error: error instanceof Error ? error.message : String(error),
      retry:
        "Call worktable_drawings_read action render with a smaller region or fewer ids. The write result, if any, is already saved unless previewOnly is true.",
    }
  }
  return output
}

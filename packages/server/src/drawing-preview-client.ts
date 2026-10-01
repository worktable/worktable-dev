// Runs only in the isolated drawing page. Generate its packaged JS with
// scripts/generate-drawing-preview.ts; never execute authored document scripts.
import {
  Store,
  THEMES,
  FONTS,
  drawShape,
  localBounds,
  pageBounds,
  loadAssetImages,
  type ShapeRecord,
} from "@quickdrawjs/core"
import { DRAWING_THEME } from "../../types/src/drawing-theme.generated.ts"
import { drawingBindingUpdates } from "../../types/src/drawing-bindings.ts"
import {
  applyDrawingOperations,
  type DrawingShape,
  type DrawingBounds,
} from "../../types/src/drawing-engine.ts"
import type { QuickdrawDocument } from "../../types/src/quickdraw-document.ts"
import type { DrawingOperation } from "../../types/src/drawing-operations.ts"
import {
  MAX_DOCUMENT_PREVIEW_BYTES,
  MAX_DOCUMENT_PREVIEW_PIXELS,
} from "../../types/src/document-preview.ts"
import {
  DRAWING_FONTS,
  loadDrawingFonts,
  type DrawingFontAsset,
  type DrawingFontRun,
} from "../../ui/src/lib/drawing-fonts.ts"

type RenderOptions = {
  theme?: "light" | "dark"
  width?: number
  region?: DrawingBounds
  ids?: string[]
  labels?: boolean
  background?: boolean
}
function shapes(doc: QuickdrawDocument, ids?: string[]) {
  return Object.values(doc.snapshot.document.store)
    .filter(
      (r): r is DrawingShape =>
        r.typeName === "shape" && (!ids || ids.includes(r.id))
    )
    .sort((a, b) => a.z - b.z || a.id.localeCompare(b.id))
}
const local = (shape: DrawingShape) => localBounds(shape as ShapeRecord)
const page = (shape: DrawingShape) => pageBounds(shape as ShapeRecord)
const api = {
  async initialize(fonts: DrawingFontAsset[], runs: DrawingFontRun[]) {
    Object.assign(THEMES.light, DRAWING_THEME.light)
    Object.assign(THEMES.dark, DRAWING_THEME.dark)
    Object.assign(FONTS, DRAWING_FONTS)
    await loadDrawingFonts(fonts, runs)
  },
  measure(doc: QuickdrawDocument, ids?: string[]) {
    api.reconcile(doc)
    return Object.fromEntries(
      shapes(doc, ids).map((shape) => [
        shape.id,
        {
          local: local(shape),
          page: page(shape),
          ...((shape.type === "arrow" || shape.type === "line") &&
          (shape.props.startBinding || shape.props.endBinding)
            ? { shape }
            : {}),
        },
      ])
    )
  },
  apply(doc: QuickdrawDocument, operations: DrawingOperation[], ids: string[]) {
    return applyDrawingOperations(doc, operations, ids, local)
  },
  reconcile(doc: QuickdrawDocument) {
    const store = doc.snapshot.document.store
    for (const connector of drawingBindingUpdates(store, local))
      store[connector.id] = connector
    return doc
  },
  async render(doc: QuickdrawDocument, options: RenderOptions) {
    api.reconcile(doc)
    let visible = shapes(doc, options.ids)
    const boxes = visible.map(page)
    const x = boxes.length ? Math.min(...boxes.map((b) => b.x)) - 32 : 0
    const y = boxes.length ? Math.min(...boxes.map((b) => b.y)) - 32 : 0
    const bounds = options.region ?? {
      x,
      y,
      w: boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) - x + 32 : 800,
      h: boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) - y + 32 : 600,
    }
    visible = visible.filter((shape) => {
      const b = page(shape)
      return (
        b.x + b.w + 32 >= bounds.x &&
        b.x - 32 <= bounds.x + bounds.w &&
        b.y + b.h + 32 >= bounds.y &&
        b.y - 32 <= bounds.y + bounds.h
      )
    })
    const ratio = Math.min(
      (options.width ?? 1200) / bounds.w,
      2048 / bounds.h,
      Math.sqrt(MAX_DOCUMENT_PREVIEW_PIXELS / (bounds.w * bounds.h))
    )
    const width = Math.max(1, Math.round(bounds.w * ratio)),
      height = Math.max(1, Math.round(bounds.h * ratio))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")!
    const theme = THEMES[options.theme ?? "light"]
    if (options.background !== false) {
      ctx.fillStyle = theme.background
      ctx.fillRect(0, 0, width, height)
    }
    ctx.setTransform(ratio, 0, 0, ratio, -bounds.x * ratio, -bounds.y * ratio)
    const store = new Store()
    store.loadSnapshot(doc.snapshot)
    await loadAssetImages(store, visible as ShapeRecord[])
    const labels: { label: string; id: string }[] = []
    for (const shape of visible) {
      drawShape(ctx, shape as ShapeRecord, { theme, store, zoom: ratio })
      if (options.labels && labels.length < 500) {
        const label = String(labels.length + 1),
          b = page(shape)
        labels.push({ label, id: shape.id })
        ctx.save()
        ctx.fillStyle = theme.background
        ctx.fillRect(b.x, b.y - 19, label.length * 8 + 8, 18)
        ctx.font = `500 12px ${DRAWING_FONTS.sans}`
        ctx.fillStyle = theme.colors.black.stroke
        ctx.fillText(label, b.x + 4, b.y - 6)
        ctx.restore()
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))),
        "image/png"
      )
    )
    if (blob.size > MAX_DOCUMENT_PREVIEW_BYTES)
      throw new Error(
        "Preview exceeds the 4 MiB image budget; request fewer objects or a smaller region"
      )
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ""
    for (let i = 0; i < bytes.length; i += 16384)
      binary += String.fromCharCode(...bytes.subarray(i, i + 16384))
    return {
      mimeType: "image/png" as const,
      data: btoa(binary),
      width,
      height,
      bounds,
      ...(options.labels ? { labels } : {}),
      ...(options.labels && visible.length > 500
        ? {
            warnings: [
              "Object labels are limited to 500; select fewer objects for a complete label map.",
            ],
          }
        : {}),
    }
  },
}
export type DrawingPreviewClient = typeof api
;(
  globalThis as unknown as { worktableDrawing: DrawingPreviewClient }
).worktableDrawing = api

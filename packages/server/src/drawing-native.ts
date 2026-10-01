import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { localBounds, pageBounds, type ShapeRecord } from "@quickdrawjs/core"
import { imageSize } from "image-size"
import type { DrawingOperation, QuickdrawDocument } from "@worktable/types"
import {
  parseQuickdrawDocument,
  drawingBindingUpdates,
  MAX_DOCUMENT_PREVIEW_BYTES,
} from "@worktable/types"
import {
  applyDrawingOperations,
  type DrawingBounds,
  type DrawingShape,
} from "../../types/src/drawing-engine.ts"
import { withPreviewPage } from "./document-preview-browser.ts"
import {
  previewFontAssets,
  fulfillPreviewFont,
  previewFontVersion,
} from "./preview-fonts.ts"
import { DocumentWriteError } from "./document-write-service.ts"
import type { DrawingPreviewClient } from "./drawing-preview-client.ts"
import type { DrawingFontRun } from "@worktable/ui/lib/drawing-fonts"
import { productFontIssue } from "./product-fonts.ts"
import type {
  DrawingRenderOptions,
  DrawingRenderResult,
} from "./drawing-render.ts"
import bundlePath from "./generated/drawing-preview.bundle.js" with { type: "file" }

export const DRAWING_RENDERER_VERSION = "quickdraw-0.2.0-worktable-native-1"
export type DrawingMeasurements = Record<
  string,
  { local: DrawingBounds; page: DrawingBounds; shape?: DrawingShape }
>
const origin = "https://worktable-preview.invalid"
function drawingFontRuns(
  drawing: QuickdrawDocument,
  operations: DrawingOperation[] = []
) {
  const runs: DrawingFontRun[] = [{ font: "sans", text: "Mg0123456789" }]
  const byId = new Map<string, DrawingFontRun>()
  for (const record of Object.values(drawing.snapshot.document.store)) {
    if (record.typeName !== "shape") continue
    if ("font" in record.props) {
      const text =
        "text" in record.props
          ? record.props.text
          : "label" in record.props
            ? record.props.label
            : ""
      const run = { font: record.props.font, text: text ?? "" }
      if (text) runs.push(run)
      byId.set(record.id, run)
    }
  }
  for (const operation of operations) {
    if (operation.op === "add") {
      const run = {
        font: operation.object.font ?? "sans",
        text: operation.object.text ?? "",
      }
      if (run.text) runs.push(run)
      if (operation.ref) byId.set(operation.ref, run)
    }
    if (operation.op === "duplicate" && operation.ref) {
      const previous = byId.get(operation.id)
      if (previous) byId.set(operation.ref, previous)
    }
    if (
      operation.op === "update" &&
      (operation.changes.text !== undefined ||
        operation.changes.font !== undefined)
    ) {
      const previous = byId.get(operation.id)
      const run = {
        font: operation.changes.font ?? previous?.font ?? "sans",
        text: operation.changes.text ?? previous?.text ?? "",
      }
      runs.push(run)
      byId.set(operation.id, run)
    }
  }
  return runs
}

declare global {
  interface Window {
    worktableDrawing: DrawingPreviewClient
  }
}
async function nativeJob<T>(
  drawing: QuickdrawDocument,
  task: (page: import("playwright-core").Page) => Promise<T>,
  operations: DrawingOperation[] = [],
  timeoutMs = 30_000,
  signal?: AbortSignal
): Promise<T> {
  return withPreviewPage(
    "drawing",
    async (page) => {
      const runs = drawingFontRuns(drawing, operations)
      const fonts = previewFontAssets(runs.map((run) => run.text).join("\n"))
      const permittedFonts = new Set(fonts.map((font) => `/fonts/${font.id}`))
      await page.route(`${origin}/**`, async (route) => {
        const url = new URL(route.request().url())
        if (route.request().method() !== "GET") return route.abort()
        if (url.pathname === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta charset="utf-8"><script type="module" src="/drawing.js"></script>',
          })
        if (url.pathname === "/drawing.js")
          return route.fulfill({
            contentType: "text/javascript",
            body: await readFile(new URL(bundlePath, import.meta.url)),
          })
        if (permittedFonts.has(url.pathname)) {
          const bytes = await fulfillPreviewFont(url.pathname)
          if (bytes)
            return route.fulfill({
              contentType: url.pathname.endsWith(".woff")
                ? "font/woff"
                : "font/woff2",
              body: Buffer.from(bytes),
            })
        }
        return route.abort()
      })
      await page.goto(origin, { waitUntil: "load" })
      await page.waitForFunction(() => !!window.worktableDrawing)
      await page.evaluate(
        ({ fonts, runs }) => window.worktableDrawing.initialize(fonts, runs),
        {
          fonts: fonts.map((font) => ({
            ...font,
            url: `${origin}/fonts/${font.id}`,
          })),
          runs,
        }
      )
      return task(page)
    },
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    }
  )
}

class NativeMeasurementRequired extends Error {}
function fixedLocal(shape: DrawingShape): DrawingBounds {
  if (shape.type === "text" || shape.type === "note")
    throw new NativeMeasurementRequired()
  return localBounds(shape as ShapeRecord)
}
/** Fixed geometry uses the actual native engine without needing a browser. */
export async function measureDrawing(
  drawing: QuickdrawDocument,
  ids?: string[],
  options: { signal?: AbortSignal } = {}
): Promise<DrawingMeasurements> {
  options.signal?.throwIfAborted()
  let shapes = Object.values(drawing.snapshot.document.store).filter(
    (r): r is DrawingShape =>
      r.typeName === "shape" && (!ids || ids.includes(r.id))
  )
  // Targeted reads need only the selected shapes and their direct dependencies.
  // An unrelated text-bound connector must not turn fixed geometry into a
  // browser job, or add unrelated fonts to a necessary native measurement.
  let measuredDrawing = drawing
  if (ids) {
    const records = drawing.snapshot.document.store
    const needed = new Set(shapes.map((shape) => shape.id))
    for (const shape of shapes)
      if (shape.type === "arrow" || shape.type === "line")
        for (const binding of [
          shape.props.startBinding,
          shape.props.endBinding,
        ])
          if (binding) needed.add(binding.shapeId)
    for (const id of needed) {
      const record = records[id]
      if (record?.typeName === "shape" && record.type === "image")
        needed.add(record.props.assetId)
    }
    measuredDrawing = {
      ...drawing,
      snapshot: {
        document: {
          store: Object.fromEntries(
            [...needed].map((id) => [id, records[id]!])
          ),
        },
      },
    }
  }
  let nativeBindings = false
  if (
    shapes.some(
      (shape) =>
        (shape.type === "arrow" || shape.type === "line") &&
        (shape.props.startBinding || shape.props.endBinding)
    )
  ) {
    const candidate = { ...measuredDrawing.snapshot.document.store }
    try {
      for (const updated of drawingBindingUpdates(candidate, fixedLocal))
        candidate[updated.id] = updated
      shapes = shapes.map((shape) => candidate[shape.id] as DrawingShape)
    } catch (error) {
      if (!(error instanceof NativeMeasurementRequired)) throw error
      nativeBindings = true
    }
  }
  if (
    !nativeBindings &&
    shapes.every((shape) => shape.type !== "text" && shape.type !== "note")
  )
    return Object.fromEntries(
      shapes.map((shape) => [
        shape.id,
        {
          local: fixedLocal(shape),
          page: pageBounds(shape as ShapeRecord),
          shape,
        },
      ])
    )
  return nativeJob(
    measuredDrawing,
    (page) =>
      page.evaluate(
        ({ drawing, ids }) => window.worktableDrawing.measure(drawing, ids),
        { drawing: measuredDrawing, ids }
      ),
    [],
    30_000,
    options.signal
  )
}

export async function prepareDrawingOperations(
  before: QuickdrawDocument,
  operations: DrawingOperation[],
  seed: string,
  options: { signal?: AbortSignal } = {}
) {
  options.signal?.throwIfAborted()
  const ids = operations.map((_, index) =>
    createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 24)
  )
  // No measurements are needed for many edits. A private sentinel aborts the
  // in-memory candidate before persistence if a text-dependent binding occurs.
  try {
    return applyDrawingOperations(before, operations, ids, fixedLocal)
  } catch (error) {
    if (!(error instanceof NativeMeasurementRequired))
      throw new DocumentWriteError(
        "invalid",
        error instanceof Error ? error.message : String(error)
      )
  }
  const result = await nativeJob(
    before,
    (page) =>
      page.evaluate(
        ({ before, operations, ids }) => {
          try {
            return {
              ok: true as const,
              result: window.worktableDrawing.apply(before, operations, ids),
            }
          } catch (error) {
            return {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        },
        { before, operations, ids }
      ),
    operations,
    30_000,
    options.signal
  )
  if (!result.ok) throw new DocumentWriteError("invalid", result.error)
  // Browser owns pure preparation only. The server validates source and still
  // commits under its existing source-revision and mutation-receipt checks.
  result.result.drawing = parseQuickdrawDocument(
    new TextEncoder().encode(JSON.stringify(result.result.drawing))
  )
  return result.result
}

export async function reconcileDrawingBindings(
  drawing: QuickdrawDocument,
  options: { signal?: AbortSignal } = {}
): Promise<QuickdrawDocument> {
  options.signal?.throwIfAborted()
  const candidate = structuredClone(drawing)
  try {
    for (const connector of drawingBindingUpdates(
      candidate.snapshot.document.store,
      fixedLocal
    ))
      candidate.snapshot.document.store[connector.id] = connector
    return candidate
  } catch (error) {
    if (!(error instanceof NativeMeasurementRequired)) throw error
  }
  const result = await nativeJob(
    drawing,
    (page) =>
      page.evaluate(
        (drawing) => window.worktableDrawing.reconcile(drawing),
        drawing
      ),
    [],
    30_000,
    options.signal
  )
  return parseQuickdrawDocument(
    new TextEncoder().encode(JSON.stringify(result))
  )
}

export async function renderNativeDrawing(
  drawing: QuickdrawDocument,
  options: DrawingRenderOptions = {}
): Promise<DrawingRenderResult> {
  const requested = options.width ?? 1200
  if (!Number.isFinite(requested) || requested < 64 || requested > 2048)
    throw new Error("Preview width must be between 64 and 2048 pixels")
  if (
    options.region &&
    (!Object.values(options.region).every(Number.isFinite) ||
      options.region.w <= 0 ||
      options.region.h <= 0)
  )
    throw new Error(
      "Preview region requires finite coordinates and positive dimensions"
    )
  const shapes = Object.values(drawing.snapshot.document.store).filter(
    (r): r is DrawingShape =>
      r.typeName === "shape" && (!options.ids || options.ids.includes(r.id))
  )
  for (const id of options.ids ?? [])
    if (!shapes.some((shape) => shape.id === id))
      throw new Error(`Drawing object not found: ${id}`)
  const validateBudget = (shapes: DrawingShape[]) => {
    let pixels = 0,
      points = 0
    const checked = new Set<string>()
    for (const shape of shapes) {
      if ("pts" in shape.props) points += shape.props.pts.length
      if (shape.type === "geo" && shape.props.dash === "draw")
        points += Math.ceil((shape.props.w + shape.props.h) / 4)
      if (shape.type !== "image" || checked.has(shape.props.assetId)) continue
      checked.add(shape.props.assetId)
      const asset = drawing.snapshot.document.store[shape.props.assetId]
      if (
        !asset ||
        asset.typeName !== "asset" ||
        !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(
          asset.src
        )
      )
        throw new Error("Invalid drawing image asset")
      const dimensions = imageSize(
        Buffer.from(asset.src.split(",")[1]!, "base64")
      )
      pixels += dimensions.width * dimensions.height
      if (
        dimensions.width > 8192 ||
        dimensions.height > 8192 ||
        pixels > 16_000_000
      )
        throw new Error("Drawing images exceed preview pixel budget")
    }
    if (points > 200_000)
      throw new Error("Drawing preview is too complex; request fewer objects")
  }
  if (!options.region) validateBudget(shapes)
  const { signal, ...renderOptions } = options
  const result = await nativeJob(
    drawing,
    async (page) => {
      if (options.region) {
        const measured = await page.evaluate(
          ({ drawing, ids }) => window.worktableDrawing.measure(drawing, ids),
          { drawing, ids: options.ids }
        )
        const r = options.region
        validateBudget(
          shapes.filter((shape) => {
            const b = measured[shape.id]!.page
            return (
              b.x + b.w + 32 >= r.x &&
              b.x - 32 <= r.x + r.w &&
              b.y + b.h + 32 >= r.y &&
              b.y - 32 <= r.y + r.h
            )
          })
        )
      }
      return page.evaluate(
        ({ drawing, options }) =>
          window.worktableDrawing.render(drawing, options),
        { drawing, options: renderOptions }
      )
    },
    [],
    options.timeoutMs,
    signal
  )
  if (Buffer.byteLength(result.data, "base64") > MAX_DOCUMENT_PREVIEW_BYTES)
    throw new Error("Drawing preview exceeds output budget")
  return {
    ...result,
    ...(productFontIssue() ? { warnings: [productFontIssue()!] } : {}),
    rendererVersion: DRAWING_RENDERER_VERSION,
    fontVersion: previewFontVersion(),
  }
}

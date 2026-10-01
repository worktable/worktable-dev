import { renderNativeDrawing } from "./drawing-native.ts"
import { inspectDrawingImageAssets } from "./drawing-image-validation.ts"
import { strokeOutline } from "@quickdrawjs/core/freehand"
import {
  ellipsePolygon,
  geoPolygon,
  traceSmooth,
  wobblePolyline,
} from "@quickdrawjs/core/geometry"
import { DRAWING_THEME, type QuickdrawDocument } from "@worktable/types"
import {
  drawingLocalBounds,
  drawingObjectBounds,
  drawingStrokeSizes,
  drawingTextLayout,
  type DrawingBounds,
  type DrawingShape,
} from "./drawing-geometry.ts"

import {
  drawingDefaultFont,
  drawingFontEmbedding,
  type DrawingFontFace,
} from "./drawing-fonts.ts"

export { drawingObjectBounds } from "./drawing-geometry.ts"
export type DrawingRenderOptions = {
  format?: "png" | "svg"
  theme?: "light" | "dark"
  region?: DrawingBounds
  ids?: string[]
  width?: number
  background?: boolean
  labels?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}
export type DrawingRenderResult = {
  mimeType: "image/png" | "image/svg+xml"
  data: string
  width: number
  height: number
  bounds: DrawingBounds
  warnings?: string[]
  rendererVersion?: string
  fontVersion?: string
  labels?: Array<{ label: string; id: string }>
}
const MAX_OUTPUT = 12 * 1024 * 1024
const MAX_POINTS = 200_000
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!
  )
const n = (value: number) => Number(value.toFixed(3))
function path(points: number[], closed = false) {
  const commands: string[] = []
  traceSmooth(
    {
      moveTo: (x, y) => commands.push(`M${n(x)} ${n(y)}`),
      lineTo: (x, y) => commands.push(`L${n(x)} ${n(y)}`),
      quadraticCurveTo: (x, y, nx, ny) =>
        commands.push(`Q${n(x)} ${n(y)} ${n(nx)} ${n(ny)}`),
      closePath: () => commands.push("Z"),
    },
    points,
    closed
  )
  return commands.join("")
}
function textSvg(
  shape: DrawingShape,
  color: string,
  warnings: Set<string>,
  fonts: Set<DrawingFontFace>
) {
  const l = drawingTextLayout(shape)
  if (l.lines.some((line) => line.runs.some((run) => run.missing)))
    warnings.add(
      "Some characters are unavailable in the bundled fonts (Latin, Greek, Cyrillic, Vietnamese); use structured text to read those labels."
    )
  warnings.add(
    "Text uses bundled Noto Sans, Noto Serif, Noto Sans Mono and Caveat; system fonts and wrapping on the canvas can differ."
  )
  const p = shape.props
  const center = shape.type === "geo" || shape.type === "note"
  const w =
    shape.type === "geo" ? shape.props.w : shape.type === "note" ? 200 : l.w
  const h =
    shape.type === "geo"
      ? shape.props.h
      : shape.type === "note"
        ? Math.max(200, l.h + 40)
        : l.h
  const align = center
    ? "middle"
    : "align" in p
      ? (p.align ?? "start")
      : "start"
  const x = align === "middle" ? w / 2 : align === "end" ? w : 0
  const y = (center ? (h - l.h) / 2 : 0) + l.baseline
  if (
    center &&
    (l.h > h - (shape.type === "note" ? 40 : 24) ||
      l.lines.some((line) => line.w > w - 24))
  )
    warnings.add(`Text may exceed object bounds: ${shape.id}`)
  for (const line of l.lines) for (const run of line.runs) fonts.add(run.face)
  // Position each font run explicitly. The rasterizer's nested tspan shaping
  // drops text containing multiple mixed-subset Unicode runs.
  return l.lines
    .map((line, i) => {
      let offset =
        x - (align === "middle" ? line.w / 2 : align === "end" ? line.w : 0)
      return line.runs
        .map((run) => {
          const text = `<text xml:space="preserve" font-kerning="none" x="${n(offset)}" y="${n(y + i * l.lh)}" fill="${color}" font-family="${run.face.family}" font-weight="500" font-size="${n(l.fontSize)}">${esc(run.text)}</text>`
          offset += run.w
          return text
        })
        .join("")
    })
    .join("")
}
function shapeSvg(
  shape: DrawingShape,
  doc: QuickdrawDocument,
  theme: typeof DRAWING_THEME.light | typeof DRAWING_THEME.dark,
  warnings: Set<string>,
  index: number,
  fonts: Set<DrawingFontFace>,
  imageSources: Map<string, string>
) {
  const p = shape.props
  const col = theme.colors["color" in p ? p.color : "black"]
  const sw = drawingStrokeSizes["size" in p ? p.size : "s"]
  const dash = "dash" in p ? p.dash : undefined
  const stroke = `stroke="${col.stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${dash === "dashed" ? ` stroke-dasharray="${sw * 3.2} ${sw * 2.6}"` : dash === "dotted" ? ` stroke-dasharray="0.01 ${sw * 2.5}"` : ""}`
  let body = ""
  switch (shape.type) {
    case "draw":
    case "highlight": {
      const p = shape.props
      const flat: number[] = []
      for (let i = 0; i < p.pts.length; i += 3)
        flat.push(p.pts[i], p.pts[i + 1])
      if (shape.type === "highlight") {
        warnings.add(
          "PNG highlighter uses translucent ink; multiply/lighten blending can differ from the canvas."
        )
        body = `<path d="${path(flat)}" fill="none" stroke="${col.stroke}" stroke-width="${sw * 4.5}" stroke-linecap="round" stroke-linejoin="round" opacity="0.55" style="mix-blend-mode:${theme.id === "dark" ? "lighten" : "multiply"}"/>`
      } else if (!p.dash || p.dash === "draw") {
        body = `<path d="${path(strokeOutline(p.pts, { size: { s: 3.4, m: 5.2, l: 6.5, xl: 10 }[p.size], simulate: !p.isPen }), true)}" fill="${col.stroke}"/>`
      } else body = `<path d="${path(flat)}" fill="none" ${stroke}/>`
      break
    }
    case "geo": {
      const p = shape.props
      let d: string
      if (p.geo === "ellipse" && p.dash !== "draw")
        d = `M0 ${p.h / 2}a${p.w / 2} ${p.h / 2} 0 1 0 ${p.w} 0a${p.w / 2} ${p.h / 2} 0 1 0 ${-p.w} 0`
      else {
        let points =
          p.geo === "ellipse"
            ? ellipsePolygon(p.w, p.h, 40)
            : geoPolygon(p.geo, p.w, p.h)
        if (p.dash === "draw")
          points = wobblePolyline(points, shape.id, {
            step: p.geo === "ellipse" ? 18 : 22,
            amp:
              p.geo === "ellipse"
                ? Math.min(2, p.w / 40 + 0.6)
                : Math.min(2.2, (p.w + p.h) / 160 + 0.6),
          })
        d =
          p.geo === "ellipse"
            ? path(points, true)
            : points.reduce(
                (out, v, i) =>
                  out +
                  (i % 2 === 0 ? `${i === 0 ? "M" : "L"}${n(v)} ` : `${n(v)} `),
                ""
              ) + "Z"
      }
      const fill =
        p.fill === "solid"
          ? col.fill
          : p.fill === "semi"
            ? theme.background
            : p.fill === "pattern"
              ? `url(#hatch-${index})`
              : "none"
      if (p.fill === "pattern")
        body += `<defs><pattern id="hatch-${index}" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2 6L6 -2M2 10L10 2" stroke="${col.stroke}" opacity="0.55" stroke-width="1.4"/></pattern></defs>`
      body += `<path d="${d}" fill="${fill}"${p.fill === "semi" ? ' fill-opacity="0.85"' : ""} ${stroke}/>`
      if (p.label) body += textSvg(shape, col.stroke, warnings, fonts)
      break
    }
    case "line":
    case "arrow": {
      const { dx, dy, bend = 0 } = shape.props
      const len = Math.hypot(dx, dy) || 1,
        cx = dx / 2 - (dy / len) * bend * 2,
        cy = dy / 2 + (dx / len) * bend * 2
      body = `<path d="M0 0${bend ? `Q${n(cx)} ${n(cy)} ` : "L"}${dx} ${dy}" fill="none" ${stroke}/>`
      if (shape.type === "arrow") {
        const angle = bend ? Math.atan2(dy - cy, dx - cx) : Math.atan2(dy, dx),
          length = Math.min(Math.max(sw * 3.2, 12), len * 0.4)
        body += `<path d="M${n(dx - Math.cos(angle - 0.5) * length)} ${n(dy - Math.sin(angle - 0.5) * length)}L${dx} ${dy}L${n(dx - Math.cos(angle + 0.5) * length)} ${n(dy - Math.sin(angle + 0.5) * length)}" fill="none" stroke="${col.stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
      }
      break
    }
    case "text":
      body = textSvg(shape, col.stroke, warnings, fonts)
      break
    case "note": {
      const l = drawingTextLayout(shape),
        scale = shape.props.scale ?? 1
      body = `<g transform="scale(${scale})"><rect width="200" height="${Math.max(200, l.h + 40)}" rx="6" fill="${col.note}"/>${textSvg(shape, theme.noteText, warnings, fonts)}</g>`
      break
    }
    case "image": {
      const asset = doc.snapshot.document.store[shape.props.assetId]
      if (!asset || asset.typeName !== "asset")
        throw new Error(`Drawing image is missing its asset: ${shape.id}`)
      body = `<defs><clipPath id="image-${index}"><rect width="${shape.props.w}" height="${shape.props.h}" rx="4"/></clipPath></defs><image width="${shape.props.w}" height="${shape.props.h}" preserveAspectRatio="none" href="${imageSources.get(asset.id) ?? asset.src}" clip-path="url(#image-${index})"/>`
      break
    }
  }
  const b = drawingLocalBounds(shape)
  return `<g data-object-id="${esc(shape.id)}" transform="translate(${shape.x} ${shape.y}) rotate(${n((shape.rot * 180) / Math.PI)} ${n(b.x + b.w / 2)} ${n(b.y + b.h / 2)})">${body}</g>`
}

/** Headless, bounded rendering; only persisted embedded raster assets are resolved. */
export async function renderDrawing(
  doc: QuickdrawDocument,
  options: DrawingRenderOptions = {}
): Promise<DrawingRenderResult> {
  if (options.format !== "svg") return renderNativeDrawing(doc, options)
  const started = performance.now()
  const ids = options.ids ? new Set(options.ids) : undefined
  const all = Object.values(doc.snapshot.document.store).filter(
    (r): r is DrawingShape => r.typeName === "shape"
  )
  if (ids)
    for (const id of ids)
      if (!all.some((shape) => shape.id === id))
        throw new Error(`Drawing object not found: ${id}`)
  let bounds = options.region
  if (
    bounds &&
    (!Object.values(bounds).every(Number.isFinite) ||
      bounds.w <= 0 ||
      bounds.h <= 0)
  )
    throw new Error(
      "Preview region requires finite coordinates and positive dimensions"
    )
  const region = bounds
  const shapes = all
    .filter((shape) => {
      if (ids && !ids.has(shape.id)) return false
      if (!region) return true
      const b = drawingObjectBounds(shape)
      return (
        b.x + b.w + 32 >= region.x &&
        b.y + b.h + 32 >= region.y &&
        b.x - 32 <= region.x + region.w &&
        b.y - 32 <= region.y + region.h
      )
    })
    .sort((a, b) => a.z - b.z)
  const points = shapes.reduce(
    (sum, shape) =>
      sum +
      ("pts" in shape.props
        ? shape.props.pts.length
        : shape.type === "geo" && shape.props.dash === "draw"
          ? Math.ceil((shape.props.w + shape.props.h) / 4)
          : 0),
    0
  )
  if (points > MAX_POINTS)
    throw new Error(
      "Drawing preview is too complex; request fewer objects or a smaller region"
    )
  // Header dimensions guard against embedded compressed-image allocation bombs.
  const assets = []
  const imageSources = new Map<string, string>()
  for (const assetId of new Set(
    shapes.flatMap((shape) =>
      shape.type === "image" ? [shape.props.assetId] : []
    )
  )) {
    const asset = doc.snapshot.document.store[assetId]
    if (!asset || asset.typeName !== "asset")
      throw new Error("Invalid drawing image asset")
    assets.push(asset)
  }
  inspectDrawingImageAssets(assets)
  if (!bounds) {
    const boxes = shapes.map(drawingObjectBounds)
    const x = boxes.length ? Math.min(...boxes.map((b) => b.x)) - 32 : 0,
      y = boxes.length ? Math.min(...boxes.map((b) => b.y)) - 32 : 0
    bounds = {
      x,
      y,
      w: boxes.length
        ? Math.max(1, Math.max(...boxes.map((b) => b.x + b.w)) - x + 32)
        : 800,
      h: boxes.length
        ? Math.max(1, Math.max(...boxes.map((b) => b.y + b.h)) - y + 32)
        : 600,
    }
  }
  const requested = options.width ?? 1200
  if (!Number.isFinite(requested) || requested < 64 || requested > 2048)
    throw new Error("Preview width must be between 64 and 2048 pixels")
  const ratio = Math.min(requested / bounds.w, 2048 / bounds.h)
  const width = Math.max(1, Math.round(bounds.w * ratio)),
    height = Math.max(1, Math.round(bounds.h * ratio))
  const theme = DRAWING_THEME[options.theme ?? "light"],
    warnings = new Set<string>([
      "SVG uses the legacy vector renderer; native PNG is authoritative for multilingual text, emoji and geometry.",
    ])
  const fonts = new Set<DrawingFontFace>([drawingDefaultFont])
  const parts: string[] = []
  const labels: Array<{ label: string; id: string }> = []
  let outputBytes = 0
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i],
      b = drawingObjectBounds(shape)
    if (
      options.region &&
      (b.x + b.w + 32 < bounds.x ||
        b.y + b.h + 32 < bounds.y ||
        b.x - 32 > bounds.x + bounds.w ||
        b.y - 32 > bounds.y + bounds.h)
    )
      continue
    const fragment = shapeSvg(
      shape,
      doc,
      theme,
      warnings,
      i,
      fonts,
      imageSources
    )
    outputBytes += Buffer.byteLength(fragment)
    if (outputBytes > MAX_OUTPUT)
      throw new Error(
        "Drawing preview exceeds output budget; request fewer objects"
      )
    parts.push(fragment)
    if (options.labels && labels.length < 500) {
      const label = String(labels.length + 1)
      labels.push({ label, id: shape.id })
      parts.push(
        `<g><rect x="${n(b.x)}" y="${n(b.y - 19)}" width="${label.length * 8 + 8}" height="18" rx="3" fill="${theme.background}"/><text x="${n(b.x + 4)}" y="${n(b.y - 6)}" font-family="${drawingDefaultFont.family}" font-weight="500" font-size="12" fill="${theme.colors.black.stroke}">${label}</text></g>`
      )
    }
    if (performance.now() - started > 5000)
      throw new Error(
        "Drawing preview exceeded processing budget; request fewer objects"
      )
  }
  if (options.labels && shapes.length > 500)
    warnings.add(
      "Object labels are limited to 500; crop or select fewer objects for a complete label map."
    )
  const fontStyle =
    options.format === "svg"
      ? `<style>${[...fonts].map(drawingFontEmbedding).join("")}</style>`
      : ""
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}"><title>${esc(doc.title)}</title>${fontStyle}${options.background === false ? "" : `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" fill="${theme.background}"/>`}${parts.join("")}</svg>`
  if (Buffer.byteLength(svg) > MAX_OUTPUT)
    throw new Error(
      "Drawing preview exceeds output budget; request fewer objects"
    )
  const bytes = Buffer.from(svg)
  if (bytes.byteLength > MAX_OUTPUT)
    throw new Error(
      "Drawing preview exceeds output budget; request fewer objects"
    )
  return {
    mimeType: "image/svg+xml",
    rendererVersion: "worktable-legacy-svg-1",
    data: Buffer.from(bytes).toString("base64"),
    width,
    height,
    bounds,
    ...(warnings.size ? { warnings: [...warnings] } : {}),
    ...(options.labels ? { labels } : {}),
  }
}

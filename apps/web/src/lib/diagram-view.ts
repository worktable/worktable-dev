export interface DiagramView {
  scale: number
  x: number
  y: number
}

export interface DiagramSize {
  width: number
  height: number
}

/**
 * "open" starts at actual size or larger, so a diagram squeezed into the page
 * column becomes readable; "fit" shows the whole diagram.
 */
export type DiagramPlacement = "open" | "fit"

export const MIN_DIAGRAM_SCALE = 0.1
export const MAX_DIAGRAM_SCALE = 8
/** Placement never enlarges a small diagram past this, so it still reads as a diagram. */
const MAX_PLACED_SCALE = 2
/** Fit's floor, which stays visible even before the viewer has its size. */
const MIN_FIT_SCALE = 0.01
const PLACEMENT_PADDING = 24

/** Mermaid sizes its SVG to the page column; the viewBox holds its real size. */
export function diagramNaturalSize(svg: string): DiagramSize | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ""
  const [, , width, height] = (/\bviewBox="([^"]+)"/i.exec(root)?.[1] ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  return width > 0 && height > 0 ? { width, height } : null
}

/** The scale that shows the whole diagram, below the zoom minimum if needed. */
export function fitDiagramScale(canvas: DiagramSize, size: DiagramSize): number {
  const inner = (length: number) =>
    Math.max(length - PLACEMENT_PADDING * 2, length / 2)
  const scale = Math.min(
    inner(canvas.width) / size.width,
    inner(canvas.height) / size.height,
    MAX_PLACED_SCALE
  )
  return Math.max(scale, MIN_FIT_SCALE)
}

/** Zooming out stops at the minimum, or at Fit for a diagram too large for it. */
export function minDiagramScale(canvas: DiagramSize, size: DiagramSize): number {
  return Math.min(MIN_DIAGRAM_SCALE, fitDiagramScale(canvas, size))
}

export function placeDiagram(
  mode: DiagramPlacement,
  canvas: DiagramSize,
  size: DiagramSize
): DiagramView {
  const fitScale = fitDiagramScale(canvas, size)
  const scale = mode === "fit" ? fitScale : Math.max(fitScale, 1)
  // Center an axis that fits; start an overflowing axis at its edge.
  const offset = (available: number, length: number) =>
    length * scale <= available - PLACEMENT_PADDING * 2
      ? (available - length * scale) / 2
      : PLACEMENT_PADDING
  return {
    scale,
    x: offset(canvas.width, size.width),
    y: offset(canvas.height, size.height),
  }
}

/** Zoom by `factor` while keeping the canvas point (originX, originY) still. */
export function zoomDiagramAt(
  view: DiagramView,
  factor: number,
  originX: number,
  originY: number,
  minScale = MIN_DIAGRAM_SCALE
): DiagramView {
  const scale = Math.min(
    Math.max(view.scale * factor, minScale),
    MAX_DIAGRAM_SCALE
  )
  const ratio = scale / view.scale
  return {
    scale,
    x: originX - (originX - view.x) * ratio,
    y: originY - (originY - view.y) * ratio,
  }
}

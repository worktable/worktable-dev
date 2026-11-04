// Pan and zoom for the full-window viewers: diagrams and images.

export interface ZoomView {
  scale: number
  x: number
  y: number
}

export interface ViewSize {
  width: number
  height: number
}

/**
 * "open" starts at actual size or larger, so a diagram squeezed into the page
 * column becomes readable; "fit" shows the whole of it.
 */
export type ViewPlacement = "open" | "fit"

/** How a viewer places what it shows, before the person moves it. */
export interface PlacementRule {
  /** Where the view starts. */
  open: ViewPlacement
  /** Placement never enlarges past this. */
  largest: number
}

/** A small diagram opens larger, up to twice its size, so it still reads as one. */
export const DIAGRAM_PLACEMENT: PlacementRule = { open: "open", largest: 2 }
/** An image opens whole, and never larger than its own pixels. */
export const IMAGE_PLACEMENT: PlacementRule = { open: "fit", largest: 1 }

export const MIN_VIEW_SCALE = 0.1
export const MAX_VIEW_SCALE = 8
/** Fit's floor, which stays visible even before the viewer has its size. */
const MIN_FIT_SCALE = 0.01
const PLACEMENT_PADDING = 24

/** Mermaid sizes its SVG to the page column; the viewBox holds its real size. */
export function svgNaturalSize(svg: string): ViewSize | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ""
  const [, , width, height] = (/\bviewBox="([^"]+)"/i.exec(root)?.[1] ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  return width > 0 && height > 0 ? { width, height } : null
}

/** The scale that shows the whole of it, below the zoom minimum if needed. */
export function fitViewScale(
  canvas: ViewSize,
  size: ViewSize,
  largest = DIAGRAM_PLACEMENT.largest
): number {
  const inner = (length: number) =>
    Math.max(length - PLACEMENT_PADDING * 2, length / 2)
  const scale = Math.min(
    inner(canvas.width) / size.width,
    inner(canvas.height) / size.height,
    largest
  )
  return Math.max(scale, MIN_FIT_SCALE)
}

/** Zooming out stops at the minimum, or at Fit for something too large for it. */
export function minViewScale(canvas: ViewSize, size: ViewSize): number {
  return Math.min(MIN_VIEW_SCALE, fitViewScale(canvas, size))
}

export function placeView(
  mode: ViewPlacement,
  canvas: ViewSize,
  size: ViewSize,
  largest = DIAGRAM_PLACEMENT.largest
): ZoomView {
  const fitScale = fitViewScale(canvas, size, largest)
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
export function zoomViewAt(
  view: ZoomView,
  factor: number,
  originX: number,
  originY: number,
  minScale = MIN_VIEW_SCALE
): ZoomView {
  const scale = Math.min(
    Math.max(view.scale * factor, minScale),
    MAX_VIEW_SCALE
  )
  const ratio = scale / view.scale
  return {
    scale,
    x: originX - (originX - view.x) * ratio,
    y: originY - (originY - view.y) * ratio,
  }
}

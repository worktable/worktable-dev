import {
  drawingFontMetrics,
  drawingTextRuns,
  type DrawingFontStyle,
} from "./drawing-fonts.ts"
import type { QuickdrawDocument } from "@worktable/types"

export type DrawingShape = Extract<
  QuickdrawDocument["snapshot"]["document"]["store"][string],
  { typeName: "shape" }
>
export type DrawingBounds = { x: number; y: number; w: number; h: number }
export const drawingStrokeSizes = { s: 2.5, m: 4, l: 6.5, xl: 10 }
export const drawingFontSizes = { s: 20, m: 26, l: 36, xl: 48 }
const noteFontSizes = { s: 16, m: 20, l: 26, xl: 32 }

export function drawingTextLayout(shape: DrawingShape) {
  const p = shape.props
  const style: DrawingFontStyle = "font" in p ? (p.font ?? "draw") : "sans"
  const font = drawingFontMetrics(style)
  const measure = (text: string, size: number) =>
    drawingTextRuns(text, size, style).reduce((sum, run) => sum + run.w, 0)
  const text = "text" in p ? p.text : "label" in p ? (p.label ?? "") : ""
  const size =
    shape.type === "note"
      ? noteFontSizes[shape.props.size]
      : drawingFontSizes[
          shape.type === "geo"
            ? (shape.props.labelSize ?? "s")
            : "size" in p
              ? p.size
              : "s"
        ]
  const scale = shape.type === "text" ? (shape.props.scale ?? 1) : 1
  const fontSize = size * scale
  const lh =
    fontSize *
    (shape.type === "note" ? 1.35 : shape.type === "geo" ? 1.3 : 1.32)
  const maxW =
    shape.type === "note"
      ? 160
      : shape.type === "geo"
        ? Math.max(24, shape.props.w - 24)
        : shape.type === "text" && shape.props.autosize === false
          ? (shape.props.w ?? 0)
          : 0
  const lines: { text: string; w: number }[] = []
  for (const paragraph of text.split("\n")) {
    if (!maxW) {
      lines.push({ text: paragraph, w: measure(paragraph, fontSize) })
      continue
    }
    let line = "",
      lineWidth = 0
    for (const word of paragraph.split(/(\s+)/)) {
      const wordWidth = measure(word, fontSize)
      if (line && lineWidth + wordWidth > maxW) {
        lines.push({ text: line, w: measure(line, fontSize) })
        line = word.trimStart()
        lineWidth = line === word ? wordWidth : measure(line, fontSize)
      } else {
        line += word
        lineWidth += wordWidth
      }
    }
    lines.push({ text: line, w: measure(line, fontSize) })
  }
  const w = maxW || Math.max(8, ...lines.map((line) => line.w)) + 2
  return {
    lines: lines.map((line) => ({
      ...line,
      runs: drawingTextRuns(line.text, fontSize, style),
    })),
    fontSize,
    lh,
    w,
    h: Math.max(lh, lines.length * lh),
    baseline:
      (lh - ((font.ascender - font.descender) / font.unitsPerEm) * fontSize) /
        2 +
      (font.ascender / font.unitsPerEm) * fontSize,
  }
}

export function drawingLocalBounds(shape: DrawingShape): DrawingBounds {
  const p = shape.props
  switch (shape.type) {
    case "draw":
    case "highlight": {
      const { pts, size } = shape.props
      let x = Infinity,
        y = Infinity,
        right = -Infinity,
        bottom = -Infinity
      for (let i = 0; i < pts.length; i += 3) {
        x = Math.min(x, pts[i])
        y = Math.min(y, pts[i + 1])
        right = Math.max(right, pts[i])
        bottom = Math.max(bottom, pts[i + 1])
      }
      const m =
        drawingStrokeSizes[size] * (shape.type === "highlight" ? 2.25 : 0.75)
      return { x: x - m, y: y - m, w: right - x + m * 2, h: bottom - y + m * 2 }
    }
    case "line":
    case "arrow": {
      const { dx, dy, bend = 0 } = shape.props
      return {
        x: Math.min(0, dx) - Math.abs(bend),
        y: Math.min(0, dy) - Math.abs(bend),
        w: Math.abs(dx) + Math.abs(bend) * 2,
        h: Math.abs(dy) + Math.abs(bend) * 2,
      }
    }
    case "text": {
      const layout = drawingTextLayout(shape)
      return { x: 0, y: 0, w: layout.w, h: layout.h }
    }
    case "note": {
      const layout = drawingTextLayout(shape)
      const scale = shape.props.scale ?? 1
      return {
        x: 0,
        y: 0,
        w: 200 * scale,
        h: Math.max(200, layout.h + 40) * scale,
      }
    }
    default:
      return { x: 0, y: 0, w: "w" in p ? p.w! : 1, h: "h" in p ? p.h : 1 }
  }
}

export function drawingObjectBounds(shape: DrawingShape): DrawingBounds {
  const b = drawingLocalBounds(shape)
  const c = Math.cos(shape.rot),
    s = Math.sin(shape.rot)
  const w = Math.abs(b.w * c) + Math.abs(b.h * s),
    h = Math.abs(b.w * s) + Math.abs(b.h * c)
  return {
    x: shape.x + b.x + b.w / 2 - w / 2,
    y: shape.y + b.y + b.h / 2 - h / 2,
    w,
    h,
  }
}

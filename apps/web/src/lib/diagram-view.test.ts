import { describe, expect, test } from "bun:test"
import {
  diagramNaturalSize,
  minDiagramScale,
  placeDiagram,
  zoomDiagramAt,
} from "./diagram-view"

const desktop = { width: 1280, height: 812 }
const phone = { width: 390, height: 796 }
const wideFlow = { width: 2181, height: 70 }
const smallSequence = { width: 400, height: 260 }

describe("diagram viewer placement", () => {
  test("reads the real size from a column-fitted Mermaid SVG", () => {
    expect(
      diagramNaturalSize(
        '<svg width="100%" style="max-width: 2180.97px;" viewBox="0 0 2180.97 70"><g/></svg>'
      )
    ).toEqual({ width: 2180.97, height: 70 })
    expect(diagramNaturalSize('<svg width="100%"></svg>')).toBeNull()
  })

  test("opens a squeezed diagram at actual size from its leading edge", () => {
    for (const canvas of [desktop, phone]) {
      const view = placeDiagram("open", canvas, wideFlow)
      expect(view.scale).toBe(1)
      expect(view.x).toBe(24)
      expect(view.y).toBe((canvas.height - wideFlow.height) / 2)
    }
  })

  test("enlarges a small diagram on open, but not past twice its size", () => {
    const view = placeDiagram("open", desktop, smallSequence)
    expect(view.scale).toBe(2)
    expect(view.x + smallSequence.width * view.scale / 2).toBe(desktop.width / 2)
  })

  test("fit shows the whole diagram inside the padded canvas", () => {
    for (const canvas of [desktop, phone]) {
      const view = placeDiagram("fit", canvas, wideFlow)
      expect(view.x).toBeGreaterThanOrEqual(24)
      expect(view.x + wideFlow.width * view.scale).toBeLessThanOrEqual(
        canvas.width - 24 + 1e-9
      )
      expect(view.scale).toBeLessThan(1)
    }
  })

  test("a diagram too large for the zoom minimum still fits, and zoom returns to Fit", () => {
    const huge = { width: 10_000, height: 400 }
    const fitted = placeDiagram("fit", phone, huge)
    expect(fitted.scale).toBeLessThan(0.1)
    expect(fitted.x + huge.width * fitted.scale).toBeLessThanOrEqual(
      phone.width - 24 + 1e-9
    )
    const floor = minDiagramScale(phone, huge)
    const zoomedIn = zoomDiagramAt(fitted, 1.25, 0, 0, floor)
    expect(zoomedIn.scale).toBeCloseTo(fitted.scale * 1.25)
    expect(zoomDiagramAt(zoomedIn, 0.5, 0, 0, floor).scale).toBe(fitted.scale)
    expect(minDiagramScale(phone, wideFlow)).toBe(0.1)
  })

  test("fit stays visible on a canvas smaller than its padding", () => {
    const scale = placeDiagram("fit", { width: 40, height: 30 }, wideFlow).scale
    expect(scale).toBeGreaterThanOrEqual(0.01)
    expect(placeDiagram("fit", { width: 0, height: 0 }, wideFlow).scale).toBe(0.01)
  })

  test("zooming keeps the point under the cursor still and stays in bounds", () => {
    const view = { scale: 1, x: 24, y: 100 }
    const zoomed = zoomDiagramAt(view, 2, 300, 135)
    const before = { x: (300 - view.x) / view.scale, y: (135 - view.y) / view.scale }
    const after = { x: (300 - zoomed.x) / zoomed.scale, y: (135 - zoomed.y) / zoomed.scale }
    expect(after).toEqual(before)
    expect(zoomDiagramAt(view, 1000, 0, 0).scale).toBe(8)
    expect(zoomDiagramAt(view, 0.0001, 0, 0).scale).toBe(0.1)
  })
})

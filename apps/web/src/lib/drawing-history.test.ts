import { expect, spyOn, test } from "bun:test"
import * as quickdraw from "@quickdrawjs/core"
import { Store, type ShapeRecord } from "@quickdrawjs/core"
import { refreshDrawingHistory } from "./drawing-history"
import {
  installDrawingBindings,
  refreshDrawingBindings,
} from "./drawing-bindings"

const box = (id: string, x = 0): ShapeRecord => ({
  id,
  typeName: "shape",
  type: "geo",
  x,
  y: 0,
  rot: 0,
  z: 1,
  props: { geo: "rectangle", w: 100, h: 100, color: "blue" },
})

test("native undo and redo preserve external changes and discard whole conflicting gestures", () => {
  const store = new Store()
  store.put(box("first"))
  store.put(box("second"))
  store.transact(() => {
    store.update("first", { x: 40 })
    store.update("second", { x: 40 })
  })
  const saved = store.getSnapshot()
  saved.document.store.second = box("second", 90)
  saved.document.store.agent = box("agent")
  expect(refreshDrawingHistory(store, saved)).toBe(3)
  expect(store.canUndo).toBe(false)
  expect(store.get("first")).toMatchObject({ x: 40 })
  expect(store.get("second")).toMatchObject({ x: 90 })

  store.put(box("local"))
  const reordered = store.getSnapshot()
  reordered.document.store.local = Object.fromEntries(
    Object.entries(reordered.document.store.local!).reverse()
  ) as ShapeRecord
  expect(refreshDrawingHistory(store, reordered)).toBe(0)
  store.undo()
  const newer = store.getSnapshot()
  newer.document.store.agent = box("agent", 100)
  expect(refreshDrawingHistory(store, newer)).toBe(0)
  expect(store.canRedo).toBe(true)
  store.redo()
  expect(store.has("local")).toBe(true)
  store.undo()
  expect(store.has("local")).toBe(false)
  expect(store.get("agent")).toMatchObject({ x: 100 })
  expect(store.get("second")).toMatchObject({ x: 90 })
})

test("undo cannot remove an asset or target used by a new remote object", () => {
  const store = new Store()
  store.put(box("unrelated"))
  store.put({
    id: "asset",
    typeName: "asset",
    w: 1,
    h: 1,
    src: "data:image/png;base64,AA==",
  })
  store.put(box("target"))
  const saved = store.getSnapshot()
  saved.document.store.image = {
    ...box("image"),
    type: "image",
    props: { assetId: "asset" },
  }
  saved.document.store.arrow = {
    ...box("arrow"),
    type: "arrow",
    props: { startBinding: { shapeId: "target", anchor: "right" } },
  }
  expect(refreshDrawingHistory(store, saved)).toBe(2)
  store.undo()
  expect(store.has("unrelated")).toBe(false)
  expect(store.has("asset")).toBe(true)
  expect(store.has("target")).toBe(true)
  expect(store.has("image")).toBe(true)
  expect(store.has("arrow")).toBe(true)
})

test("bound connectors follow gestures and changing metrics without masking remote conflicts", () => {
  const store = new Store()
  installDrawingBindings(store)
  store.put(box("target"), "remote")
  store.update("target", { x: 40 })
  const saved = store.getSnapshot()
  saved.document.store.arrow = {
    ...box("arrow", 140),
    y: 50,
    type: "arrow",
    props: {
      dx: 200,
      dy: 0,
      label: "Agent label",
      startBinding: { shapeId: "target", anchor: "right" },
    },
  }
  expect(refreshDrawingHistory(store, saved)).toBe(0)
  store.undo()
  expect(store.get("target")).toMatchObject({ x: 0 })
  expect(store.get("arrow")).toMatchObject({
    x: 100,
    props: { dx: 240, label: "Agent label" },
  })
  store.redo()
  expect(store.get("arrow")).toMatchObject({
    x: 140,
    props: { dx: 200, label: "Agent label" },
  })

  store.update("target", { props: { w: 150 } })
  expect(store.get("arrow")).toMatchObject({ x: 190 })
  expect(Object.keys(store.undos.at(-1)!.updated)).toEqual(["target", "arrow"])
  store.undo()
  expect(store.get("arrow")).toMatchObject({ x: 140 })
  store.redo()
  expect(store.get("arrow")).toMatchObject({ x: 190 })
  store.update("arrow", { x: 240 })
  expect((store.get("arrow") as ShapeRecord).props.startBinding).toBeUndefined()
  store.undo()
  expect(store.get("arrow")).toMatchObject({
    x: 190,
    props: { startBinding: { shapeId: "target", anchor: "right" } },
  })

  // A font changes measured text width without changing the authored record.
  // Keep this store/history check independent of browser font availability.
  let glyphWidth = 10
  const originalBounds = quickdraw.localBounds
  const measure = spyOn(quickdraw, "localBounds").mockImplementation((shape) =>
    shape.type === "text"
      ? { x: 0, y: 0, w: shape.props.text.length * glyphWidth, h: 20 }
      : originalBounds(shape)
  )
  try {
    const initial = {
      document: {
        store: {
          target: { ...box("target"), type: "text", props: { text: "A" } },
          far: box("far", 400),
          arrow: {
            ...box("arrow", 10),
            type: "arrow",
            y: 10,
            props: {
              dx: 290,
              dy: 0,
              color: "blue",
              startBinding: { shapeId: "target", anchor: "right" },
            },
          },
          linked: {
            ...box("linked", 10),
            type: "line",
            y: 10,
            props: {
              dx: 390,
              dy: 40,
              startBinding: { shapeId: "target", anchor: "right" },
              endBinding: { shapeId: "far", anchor: "left" },
            },
          },
          incoming: {
            ...box("incoming", -100),
            type: "arrow",
            y: 10,
            props: {
              dx: 110,
              dy: 0,
              endBinding: { shapeId: "target", anchor: "right" },
            },
          },
          // Moving the bound end across this fractional free end changes its
          // floating-point representation, but not the authored position.
          short: {
            ...box("short", 10),
            type: "arrow",
            y: 10,
            props: {
              dx: 14.1,
              dy: 0,
              startBinding: { shapeId: "target", anchor: "right" },
            },
          },
        } as Record<string, ShapeRecord>,
      },
    }
    const metrics = new Store()
    installDrawingBindings(metrics)
    metrics.loadSnapshot(initial)
    let userEvents = 0
    metrics.listen(() => userEvents++, { source: "user" })
    metrics.beginBatch()
    metrics.update("target", { props: { text: "AB" } })
    const savedBeforeFont = metrics.getSnapshot()
    expect(metrics.get("arrow")).toMatchObject({ x: 20, props: { dx: 280 } })
    glyphWidth = 20
    refreshDrawingBindings(metrics)
    expect(metrics.get("arrow")).toMatchObject({ x: 40, props: { dx: 260 } })
    expect(metrics.get("linked")).toMatchObject({ x: 40, props: { dx: 360 } })
    expect(metrics.get("incoming")).toMatchObject({
      x: -100,
      props: { dx: 140 },
    })
    expect(userEvents).toBe(1)
    expect(metrics.undos).toHaveLength(0)
    metrics.endBatch()
    expect(metrics.undos).toHaveLength(1)
    const external = structuredClone(savedBeforeFont)
    external.document.store.agent = box("agent")
    expect(refreshDrawingHistory(metrics, external)).toBe(0)
    expect(metrics.get("arrow")).toMatchObject({ x: 40, props: { dx: 260 } })
    expect(userEvents).toBe(1)
    metrics.undo()
    expect(metrics.get("target")).toMatchObject({ props: { text: "A" } })
    expect(metrics.get("arrow")).toMatchObject({ x: 20, props: { dx: 280 } })
    const afterUndo = metrics.getSnapshot()
    afterUndo.document.store.agent = box("agent", 50)
    expect(refreshDrawingHistory(metrics, afterUndo)).toBe(0)
    expect(metrics.canRedo).toBe(true)
    refreshDrawingBindings(metrics)
    expect(metrics.canRedo).toBe(true)
    expect(userEvents).toBe(2)
    metrics.redo()
    expect(metrics.get("arrow")).toMatchObject({ x: 40, props: { dx: 260 } })
    expect(metrics.get("agent")).toMatchObject({ x: 50 })

    for (const conflict of [
      "free-end",
      "free-start",
      "detach",
      "style",
    ] as const) {
      const conflicted = new Store()
      installDrawingBindings(conflicted)
      conflicted.loadSnapshot(initial)
      conflicted.update("target", { props: { text: "AB" } })
      const changed = structuredClone(conflicted.getSnapshot())
      const id = conflict === "free-start" ? "incoming" : "arrow"
      const arrow = changed.document.store[id] as ShapeRecord
      if (conflict === "free-end") arrow.props.dx += 30
      if (conflict === "free-start") {
        arrow.x += 30
        arrow.props.dx -= 30
      }
      if (conflict === "detach") delete arrow.props.startBinding
      if (conflict === "style") arrow.props.color = "red"
      expect(refreshDrawingHistory(conflicted, changed)).toBe(1)
      expect(conflicted.canUndo).toBe(false)
      expect(conflicted.get("target")).toMatchObject({ props: { text: "AB" } })
      expect(conflicted.get(id)).toEqual(arrow)
    }
  } finally {
    measure.mockRestore()
  }
})

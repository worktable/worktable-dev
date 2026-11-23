import { describe, expect, it } from "bun:test"
import { buildTree } from "./tree"
import {
  currentReveal,
  FOLDER_ROWS,
  folderRows,
  markTreeNavigation,
  noteRouteChange,
} from "./sidebar-live"

describe("revealing what opened from elsewhere", () => {
  it("shows a document opened from outside even past a folder's first rows", () => {
    const docs = Array.from({ length: FOLDER_ROWS + 4 }, (_, i) => ({
      path: `research/note-${i}`,
      updatedAt: new Date(2026, 10, 20 - i).toISOString(),
    }))
    const [research] = buildTree(docs, { mode: "custom", newestFirst: true })
    const old = `research/note-${FOLDER_ROWS + 3}`

    const steady = folderRows(research.children, old)
    expect(steady.shown.map((node) => node.path)).not.toContain(old)
    expect(steady.currentHidden).toBe(true)

    const revealed = folderRows(research.children, old, old)
    expect(revealed.shown.map((node) => node.path)).toContain(old)
    expect(revealed.currentHidden).toBe(false)
  })

  it("reveals a route from elsewhere, and keeps it while the tree opens others", () => {
    noteRouteChange("/spaces/work/documents/research/a")
    expect(currentReveal()?.path).toBe("research/a")

    markTreeNavigation()
    noteRouteChange("/spaces/work/documents/research/b")
    expect(currentReveal()?.path).toBe("research/a")

    noteRouteChange("/spaces/work/documents/research/c")
    expect(currentReveal()).toMatchObject({ spaceId: "work", path: "research/c" })
  })
})

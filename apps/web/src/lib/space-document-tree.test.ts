import { describe, expect, it } from "bun:test"
import type { DocListEntry, DocumentListItem } from "@worktable/types"
import type { WidgetListEntry } from "./widgets-api"
import {
  buildSpaceDocumentIndex,
  spaceDocumentTrees,
} from "./space-document-tree"

const markdown = { id: "worktable.markdown", sourceVersion: 1 } as const
const archivedAt = {
  archivedAt: "2026-09-01T00:00:00.000Z",
  archivedBy: "user",
}

function document(
  path: string,
  extra: Partial<Extract<DocumentListItem, { kind: "document" }>> = {}
): DocumentListItem {
  return {
    kind: "document",
    path,
    format: markdown,
    title: path,
    health: "supported",
    folderOperations: { move: true, archive: true, delete: true },
    ...extra,
  }
}

describe("space document index", () => {
  it("finds a row's list entry by path and archive state", () => {
    const docs = [
      { path: "plan", format: "markdown", headings: ["Plan"] },
      {
        path: "plan",
        format: "markdown",
        headings: ["Last year's plan"],
        archived: archivedAt,
      },
    ] as DocListEntry[]
    const widgets = [
      { id: "board", name: "Board" },
      { id: "old/board", name: "Old board", archive: archivedAt },
    ] as unknown as WidgetListEntry[]
    const index = buildSpaceDocumentIndex({ documents: [], docs, widgets })

    expect(index.doc("plan", undefined)?.headings).toEqual(["Plan"])
    expect(index.doc("plan", true)?.headings).toEqual(["Last year's plan"])
    expect(index.widget("board", undefined)?.name).toBe("Board")
    expect(index.widget("board", true)).toBeUndefined()
    expect(index.widget("old/board", true)?.name).toBe("Old board")
    expect(index.hasWidget("old/board")).toBe(true)
    expect(index.hasWidget("old")).toBe(false)
  })

  it("refuses a folder operation when anything at or below the folder cannot take part", () => {
    const index = buildSpaceDocumentIndex({
      documents: [
        document("Area-1/Notes/plan"),
        // Older producers omit archive and delete: they fail closed.
        document("area-1/notes/legacy", { folderOperations: { move: true } }),
        document("area-10/report", { health: "unsupported-format" }),
        document("café/menu", { folderOperations: { move: false } }),
        {
          kind: "conflict",
          pathKey: "shared/brief",
          health: "ambiguous",
          claims: [
            { kind: "document", path: "shared/brief", format: markdown },
            { kind: "document", path: "shared/Brief", format: markdown },
          ],
        },
      ],
      docs: [],
      widgets: [],
    })

    expect(index.folderSupports("area-1", "move")).toBe(true)
    // Case and Unicode form name the same folder, as they do on the server.
    expect(index.folderSupports("AREA-1/notes", "archive")).toBe(false)
    expect(index.folderSupports("area-1", "delete")).toBe(false)
    expect(index.folderSupports("café", "move")).toBe(false)
    // "area-10" only starts like "area-1"; each folder answers for itself.
    expect(index.folderSupports("area-10", "move")).toBe(false)
    expect(index.folderSupports("shared", "delete")).toBe(false)
    expect(index.folderSupports("elsewhere", "move")).toBe(true)
  })
})

describe("space document trees", () => {
  it("builds once per catalog read for every view that presents it", () => {
    const documents = [document("b"), document("a"), document("c")]
    const docs = [
      { path: "a", format: "markdown", headings: ["Alpha"] },
    ] as DocListEntry[]
    const widgets: WidgetListEntry[] = []
    const sidebar = spaceDocumentTrees({
      documents,
      docs,
      widgets,
      sort: "custom",
      order: ["b", "a"],
    })

    // A Markdown doc is named by its first heading, others by catalog title.
    expect(sidebar.active.map((node) => node.label)).toEqual([
      "b",
      "Alpha",
      "c",
    ])
    // The header asks with its own copy of the same settings.
    expect(
      spaceDocumentTrees({
        documents,
        docs,
        widgets,
        sort: "custom",
        order: ["b", "a"],
      })
    ).toBe(sidebar)
    // A new read of any list is a new catalog.
    expect(
      spaceDocumentTrees({
        documents,
        docs: [...docs],
        widgets,
        sort: "custom",
        order: ["b", "a"],
      })
    ).not.toBe(sidebar)
  })
})

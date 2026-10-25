import { describe, expect, it } from "bun:test"
import type { DocListEntry, DocumentListItem } from "@worktable/types"
import {
  buildSpaceDocumentIndex,
  fileDisplayLabels,
  spaceDocumentTrees,
} from "./space-document-tree"

const markdown = { id: "worktable.markdown", sourceVersion: 1 } as const
const html = { id: "worktable.html", sourceVersion: 1 } as const
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
  it("finds a row's entry by path and archive state, and HTML docs from the catalog", () => {
    const docs = [
      { path: "plan", format: "markdown", headings: ["Plan"] },
      {
        path: "plan",
        format: "markdown",
        headings: ["Last year's plan"],
        archived: archivedAt,
      },
    ] as DocListEntry[]
    const index = buildSpaceDocumentIndex({
      documents: [
        document("plan"),
        document("board", { format: html }),
        document("old/board", { format: html, archived: true }),
      ],
      docs,
    })

    expect(index.doc("plan", undefined)?.headings).toEqual(["Plan"])
    expect(index.doc("plan", true)?.headings).toEqual(["Last year's plan"])
    expect(index.isHtmlDocument("board")).toBe(true)
    expect(index.isHtmlDocument("old/board")).toBe(true)
    expect(index.isHtmlDocument("old")).toBe(false)
    expect(index.isHtmlDocument("plan")).toBe(false)
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
    const documents = [
      document("b"),
      document("a", { title: "Alpha" }),
      document("c", { format: html, title: "Launch board" }),
    ]
    // The docs list's headings no longer name a Doc; the catalog does.
    const docs = [
      { path: "a", format: "markdown", headings: ["Later heading"] },
    ] as DocListEntry[]
    const sidebar = spaceDocumentTrees({
      documents,
      docs,
      sort: "custom",
      order: ["b", "a"],
    })

    // Every document is named by its catalog title: the title a Doc opens
    // with, or an HTML doc's name.
    expect(sidebar.active.map((node) => node.label)).toEqual([
      "b",
      "Alpha",
      "Launch board",
    ])
    // The header asks with its own copy of the same settings.
    expect(
      spaceDocumentTrees({
        documents,
        docs,
        sort: "custom",
        order: ["b", "a"],
      })
    ).toBe(sidebar)
    // A new read of any list is a new catalog.
    expect(
      spaceDocumentTrees({
        documents,
        docs: [...docs],
        sort: "custom",
        order: ["b", "a"],
      })
    ).not.toBe(sidebar)
  })
})

describe("file names in the sidebar", () => {
  it("reads a file by its name without the extension, unless a neighbour would read the same", () => {
    const file = { id: "worktable.file", sourceVersion: 1 } as const
    const labels = fileDisplayLabels([
      document("research/feedback-export.csv", { format: file }),
      document("design/funnel.png", { format: file }),
      document("design/funnel.csv", { format: file }),
      document("design/README", { format: file }),
      document("design/brief"),
    ])
    expect(Object.fromEntries(labels)).toEqual({
      "research/feedback-export.csv": "Feedback Export",
      // Two files that would both read "Funnel" keep their whole names.
      "design/funnel.png": "funnel.png",
      "design/funnel.csv": "funnel.csv",
      "design/README": "README",
    })
  })
})

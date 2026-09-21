import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { SpaceFile, WidgetFile } from "@worktable/types"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts"
import { readDocument } from "./document-query.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { invalidateSearchIndex, search } from "./search-index.ts"
import { setDocArchived, writeDoc, writeSpace } from "./store.ts"
import { withWidgetWriteLock, writeWidget } from "./widget-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { stringifyCanonicalYaml } from "./yaml.ts"

let root = ""
let client: Client | null = null
const spaceId = "documents"

function space(): SpaceFile {
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Documents",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    createdBy: "test",
    settings: {},
  }
}

function widget(id: string, name: string, archived = false): WidgetFile {
  return {
    version: 1,
    kind: "worktable.widget",
    id,
    name,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    createdBy: "test",
    ...(archived
      ? {
          archive: {
            archivedAt: "2026-08-27T00:00:00.000Z",
            archivedBy: "test",
          },
        }
      : {}),
    metadata: {},
    runtime: { type: "html", entry: "index.html" },
    permissions: {
      network: false,
      records: {},
      state: { read: true, write: true },
    },
  }
}

async function connect(scopes = ["documents:read"]): Promise<Client> {
  const server = createWorktableMcpServer({
    version: "test",
    scopes,
  })
  client = new Client({ name: "documents-test", version: "1" })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-mcp-documents-"))
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  invalidateSearchIndex()
  await writeSpace(space())
})

afterEach(async () => {
  await client?.close()
  client = null
  setWorkspaceRootOverride(null)
  invalidateSearchIndex()
  await rm(root, { recursive: true, force: true })
})

describe("format-neutral document access", () => {
  // The real-I/O authoring journey shares the bounded allowance below.
  it("authors a directly added V2 HTML file through the existing agent tools", async () => {
    const manifestPath = join(root, "worktable.workspace.json")

    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as Record<string, unknown>
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`
    )
    const docs = join(root, "spaces", spaceId, "docs", "Team Board")
    await mkdir(docs, { recursive: true })
    await writeFile(
      join(docs, "state.html"),
      "<!doctype html><title>Direct state</title><p>Before agent edit</p>"
    )

    const connected = await connect([
      "documents:read",
      "documents:write",
      "widgets:read",
      "widgets:write",
    ])
    const read = await connected.callTool({
      name: "worktable_html_read",
      arguments: {
        request: {
          action: "read",
          spaceId,
          htmlId: "Team Board/state",
          includeHtml: true,
        },
      },
    })
    expect(read.isError).not.toBe(true)
    expect(read.structuredContent).toMatchObject({
      htmlDoc: {
        id: "Team Board/state",
        permissions: { network: false, records: {} },
      },
      html: expect.stringContaining("Before agent edit"),
    })

    const updated = await connected.callTool({
      name: "worktable_html_write",
      arguments: {
        request: {
          action: "update",
          spaceId,
          htmlId: "Team Board/state",
          name: "Team state",
          html: "<!doctype html><title>Team state</title><p>After agent edit</p>",
        },
      },
    })
    expect(updated.isError).not.toBe(true)
    expect(updated.structuredContent).toMatchObject({
      htmlId: "Team Board/state",
      htmlDoc: { id: "Team Board/state", name: "Team state" },
    })
    expect(await readFile(join(docs, "state.html"), "utf8")).toContain(
      "After agent edit"
    )
    const created = await connected.callTool({
      name: "worktable_html_write",
      arguments: {
        request: {
          action: "create",
          spaceId,
          id: "Team Board/Agent View",
          name: "Agent View",
          html: "<!doctype html><title>Agent View</title><p>Created by agent</p>",
        },
      },
    })
    expect(created.isError).not.toBe(true)
    expect(created.structuredContent).toMatchObject({
      htmlId: "Team Board/Agent View",
      htmlDoc: { id: "Team Board/Agent View" },
    })
    expect(
      await readFile(join(docs, "Agent View.html"), "utf8")
    ).toContain("Created by agent")
    for (const action of ["archive", "restore"] as const) {
      const lifecycle = await connected.callTool({
        name: "worktable_html_write",
        arguments: { request: { action, spaceId, htmlId: "Team Board/Agent View" } },
      })
      expect(lifecycle.isError).not.toBe(true)
      expect(lifecycle.structuredContent).toMatchObject({ ok: true })
    }
    await expect(
      readFile(
        join(
          root,
          "spaces",
          spaceId,
          "widgets",
          "Team Board",
          "state",
          "index.html"
        ),
        "utf8"
      )
    ).rejects.toThrow()
  }, 15_000)

  // Use the same bounded real-I/O allowance as the projection journey below.
  it("keeps authorized common search canonical across mixed folder lifecycle", async () => {
    const html = await writeWidget(
      spaceId,
      widget("dashboards/searchable", "Searchable board"),
      "<main><h1>Operations</h1><p>The heliograph signal is ready.</p></main>"
    )
    html.release?.()
    await writeDoc(
      spaceId,
      "dashboards/notes",
      "# Notes\n\nThe chronometer report is ready."
    )

    const legacy = await connect(["search:read"])
    const hidden = await legacy.callTool({
      name: "worktable_discover",
      arguments: {
        request: { action: "search", query: "heliograph" },
      },
    })
    expect(hidden.structuredContent).toMatchObject({ results: [] })
    await legacy.close()
    client = null

    const connected = await connect([
      "search:read",
      "documents:read",
      "documents:write",
      "widgets:read",
      "widgets:write",
    ])
    const initialResult = await connected.callTool({
      name: "worktable_discover",
      arguments: {
        request: { action: "search", query: "heliograph" },
      },
    })

    expect(initialResult.isError).not.toBe(true)
    expect(initialResult.structuredContent).toMatchObject({
      results: [
        {
          path: "dashboards/searchable",
          documentKind: "document",
          documentView: "html",
          format: { id: "worktable.html", sourceVersion: 1 },
          health: "supported",
          excerpt: expect.stringContaining("heliograph"),
        },
      ],
    })

    const exactMove = await connected.callTool({
      name: "worktable_html_write",
      arguments: {
        request: {
          action: "move",
          spaceId,
          htmlId: "dashboards/searchable",
          newPath: "dashboards/searchable-moved",
        },
      },
    })
    expect(exactMove.isError).not.toBe(true)
    expect(exactMove.structuredContent).toMatchObject({
      htmlId: "dashboards/searchable-moved",
      oldPath: "dashboards/searchable",
      newPath: "dashboards/searchable-moved",
    })

    const moved = await connected.callTool({
      name: "worktable_documents_write",
      arguments: {
        request: {
          action: "move_folder",
          spaceId,
          oldPath: "dashboards",
          newPath: "boards",
        },
      },
    })
    expect(moved.isError).not.toBe(true)
    expect(
      (
        moved.structuredContent as {
          renamed: Array<{ from: string; to: string }>
        }
      ).renamed
    ).toHaveLength(2)
    expect(moved.structuredContent).toMatchObject({
      ok: true,
      oldPath: "dashboards",
      newPath: "boards",
      count: 2,
      renamed: expect.arrayContaining([
        { from: "dashboards/notes", to: "boards/notes" },
        {
          from: "dashboards/searchable-moved",
          to: "boards/searchable-moved",
        },
      ]),
    })

    const archivedFolder = await connected.callTool({
      name: "worktable_documents_write",
      arguments: {
        request: {
          action: "archive_folder",
          spaceId,
          path: "boards",
          reason: "Superseded dashboard",
        },
      },
    })
    expect(archivedFolder.isError).not.toBe(true)
    expect(archivedFolder.structuredContent).toMatchObject({
      ok: true,
      path: "boards",
      archived: true,
    })

    const archivedSearch = await connected.callTool({
      name: "worktable_discover",
      arguments: {
        request: { action: "search", query: "heliograph" },
      },
    })
    expect(archivedSearch.structuredContent).toMatchObject({ results: [] })

    const restoredFolder = await connected.callTool({
      name: "worktable_documents_write",
      arguments: {
        request: {
          action: "restore_folder",
          spaceId,
          path: "boards",
        },
      },
    })
    expect(restoredFolder.isError).not.toBe(true)
    expect(restoredFolder.structuredContent).toMatchObject({
      ok: true,
      path: "boards",
      archived: false,
    })

    const recreated = await writeWidget(
      spaceId,
      widget("dashboards/searchable", "Hidden recreation"),
      "<p>shadow copy</p>"
    )
    if (recreated.error) throw new Error(recreated.error)
    recreated.release?.()

    const htmlList = await connected.callTool({
      name: "worktable_html_read",
      arguments: { request: { action: "list", spaceId } },
    })
    expect(htmlList.isError).not.toBe(true)
    expect(
      (
        htmlList.structuredContent as {
          htmlDocs: Array<{ id: string }>
        }
      ).htmlDocs.map((document) => document.id)
    ).toEqual(["boards/searchable-moved"])

    const aliasRead = await connected.callTool({
      name: "worktable_html_read",
      arguments: {
        request: {
          action: "read",
          spaceId,
          htmlId: "dashboards/searchable",
        },
      },
    })
    expect(aliasRead.isError).not.toBe(true)
    expect(aliasRead.structuredContent).toMatchObject({
      htmlDoc: { id: "boards/searchable-moved" },
      html: expect.stringContaining("heliograph"),
    })

    const rejectedAliasMutation = await connected.callTool({
      name: "worktable_html_write",
      arguments: {
        request: {
          action: "rename",
          spaceId,
          htmlId: "dashboards/searchable",
          name: "Must not mutate the hidden recreation",
        },
      },
    })
    expect(rejectedAliasMutation.isError).toBe(true)

    const rejectedShadowDelete = await connected.callTool({
      name: "worktable_delete",
      arguments: {
        request: {
          action: "html",
          spaceId,
          htmlId: "boards/searchable-moved",
        },
      },
    })
    expect(rejectedShadowDelete.isError).toBe(true)

    const aliasReadAfterRejectedDelete = await connected.callTool({
      name: "worktable_html_read",
      arguments: {
        request: {
          action: "read",
          spaceId,
          htmlId: "dashboards/searchable",
        },
      },
    })
    expect(aliasReadAfterRejectedDelete.isError).not.toBe(true)
    expect(aliasReadAfterRejectedDelete.structuredContent).toMatchObject({
      htmlDoc: { id: "boards/searchable-moved" },
      html: expect.stringContaining("heliograph"),
    })

    const afterMove = await connected.callTool({
      name: "worktable_discover",
      arguments: {
        request: { action: "search", query: "heliograph" },
      },
    })
    expect(afterMove.isError).not.toBe(true)
    const canonicalResults = (
      afterMove.structuredContent as {
        results: Array<Record<string, unknown>>
      }
    ).results
    expect(canonicalResults.map((result) => result["path"])).toEqual([
      "boards/searchable-moved",
    ])
    const movedDocSearch = await connected.callTool({
      name: "worktable_discover",
      arguments: {
        request: { action: "search", query: "chronometer" },
      },
    })
    expect(movedDocSearch.structuredContent).toMatchObject({
      results: [expect.objectContaining({ path: "boards/notes" })],
    })

    const deletedFolder = await connected.callTool({
      name: "worktable_delete",
      arguments: {
        request: {
          action: "document_folder",
          spaceId,
          path: "boards",
        },
      },
    })
    expect(deletedFolder.isError).not.toBe(true)
    expect(deletedFolder.structuredContent).toMatchObject({
      ok: true,
      path: "boards",
      count: 2,
      paths: expect.arrayContaining([
        "boards/notes",
        "boards/searchable-moved",
      ]),
    })
    await expect(
      readDocument({ spaceId, path: "boards/notes" })
    ).rejects.toThrow("Document not found")
    expect(
      await connected.callTool({
        name: "worktable_discover",
        arguments: {
          request: { action: "search", query: "chronometer" },
        },
      })
    ).toMatchObject({ structuredContent: { results: [] } })
    expect(
      await connected.callTool({
        name: "worktable_discover",
        arguments: {
          request: { action: "search", query: "heliograph" },
        },
      })
    ).toMatchObject({ structuredContent: { results: [] } })
  }, 15_000)

  it("keeps HTML reads and common search coherent with widget writes", async () => {
    const initial = await writeWidget(
      spaceId,
      widget("dashboard", "Dashboard"),
      "<h1>Original heading</h1><p>Original HTML content</p>"
    )
    initial.release?.()

    let metadataWritten!: () => void
    let finishUpdate!: () => void
    const metadataReady = new Promise<void>((resolve) => {
      metadataWritten = resolve
    })
    const updateGate = new Promise<void>((resolve) => {
      finishUpdate = resolve
    })
    const updatedWidget = widget("dashboard", "Updated dashboard")
    const update = withWidgetWriteLock(spaceId, "dashboard", async () => {
      await writeFile(
        join(root, "spaces", spaceId, "widgets", "dashboard", "widget.yaml"),
        stringifyCanonicalYaml(updatedWidget)
      )
      metadataWritten()
      await updateGate
      await writeFile(
        join(root, "spaces", spaceId, "widgets", "dashboard", "index.html"),
        "<h1>Updated heading</h1><p>Updated HTML content</p>"
      )
    })
    await metadataReady

    const readDuringUpdate = readDocument({ spaceId, path: "dashboard" })
    const searchDuringUpdate = search("dashboard", {
      documentAccess: "common",
    })
    let readReturnedBeforeCommit: boolean
    let searchReturnedBeforeCommit: boolean
    try {
      ;[readReturnedBeforeCommit, searchReturnedBeforeCommit] =
        await Promise.all([
          Promise.race([
            readDuringUpdate.then(() => true),
            new Promise<false>((resolve) => {
              setTimeout(() => resolve(false), 250)
            }),
          ]),
          Promise.race([
            searchDuringUpdate.then(() => true),
            new Promise<false>((resolve) => {
              setTimeout(() => resolve(false), 250)
            }),
          ]),
        ])
    } finally {
      finishUpdate()
      await update
    }

    expect(readReturnedBeforeCommit).toBe(false)
    expect(searchReturnedBeforeCommit).toBe(false)
    expect(await readDuringUpdate).toMatchObject({
      document: { title: "Updated dashboard" },
      projection: {
        kind: "text",
        headings: ["Updated heading"],
        text: "Updated heading\nUpdated HTML content",
      },
    })
    expect(await searchDuringUpdate).toEqual([
      expect.objectContaining({
        path: "dashboard",
        title: "Updated dashboard",
        documentKind: "document",
        documentView: "html",
        excerpt: expect.stringContaining("Updated HTML content"),
      }),
    ])
  })

  it("lists every format without exposing private identity or source details", async () => {
    const docs = join(root, "spaces", spaceId, "docs")
    await mkdir(join(docs, "notes"), { recursive: true })
    await writeFile(join(docs, "notes", "brief.md"), "# Brief")
    await writeFile(join(docs, "same.md"), "# Markdown")
    await writeFile(join(docs, "same.json"), "[]")
    await writeFile(join(docs, "mixed.md"), "# Active")
    await writeFile(join(docs, "archived.md"), "# Archived")
    await writeFile(join(docs, "canvas.bin"), "opaque")
    await mkdir(join(docs, "future"), { recursive: true })
    await writeFile(join(docs, "future", "canvas.md"), "# Old canvas")

    const activeWidget = await writeWidget(
      spaceId,
      widget("dashboards/status", "Status board"),
      "<h1>Status</h1>"
    )
    activeWidget.release?.()
    const archivedWidget = await writeWidget(
      spaceId,
      widget("dashboards/old", "Old board", true),
      "<h1>Old</h1>"
    )
    archivedWidget.release?.()
    const mixedWidget = await writeWidget(
      spaceId,
      widget("mixed", "Archived mixed", true),
      "<h1>Archived mixed</h1>"
    )
    mixedWidget.release?.()
    const aliasedWidget = await writeWidget(
      spaceId,
      widget("legacy/brief", "HTML at aliased path"),
      "<h1>Aliased address</h1>"
    )
    aliasedWidget.release?.()
    await writeFile(
      join(root, "spaces", spaceId, "doc-aliases.json"),
      JSON.stringify({
        type: "worktable.doc-aliases",
        version: 1,
        exact: { "legacy/brief": "notes/brief" },
        prefixes: {},
      })
    )
    await setDocArchived(spaceId, "archived", true, "test")
    await setDocArchived(spaceId, "future/canvas", true, "test")
    await rm(join(docs, "future", "canvas.md"))
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "future/canvas",
          format: { id: "future.canvas", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/canvas.bin" },
        },
      ],
    })

    const connected = await connect()
    const visible = await connected.callTool({
      name: "worktable_documents_read",
      arguments: {
        request: { action: "list", spaceId },
      },
    })
    expect(visible.isError).not.toBe(true)
    const documents = (
      visible.structuredContent as { documents: Array<Record<string, unknown>> }
    ).documents
    const byPath = Object.fromEntries(
      documents.map((entry) => [
        entry.kind === "conflict" ? entry.pathKey : entry.path,
        entry,
      ])
    )
    expect(Object.keys(byPath).sort()).toEqual([
      "dashboards/status",
      "future/canvas",
      "legacy/brief",
      "mixed",
      "notes/brief",
      "same",
    ])
    expect(byPath["dashboards/status"]).toMatchObject({
      kind: "document",
      title: "Status board",
      format: { id: "worktable.html" },
      health: "supported",
    })
    expect(byPath["future/canvas"]).toMatchObject({
      kind: "document",
      format: { id: "future.canvas" },
      health: "unsupported-format",
      updatedAt: expect.any(String),
    })
    expect(byPath["mixed"]).toMatchObject({
      kind: "document",
      format: { id: "worktable.markdown" },
    })
    expect(byPath["legacy/brief"]).toMatchObject({
      kind: "conflict",
      claims: [
        { kind: "document", format: { id: "worktable.html" } },
        {
          kind: "alias",
          path: "legacy/brief",
          targetPath: "notes/brief",
        },
      ],
    })
    const same = byPath["same"] as {
      kind: "conflict"
      claims: Array<
        { kind: "document"; format: { id: string } } | { kind: "alias" }
      >
    }
    expect(same.kind).toBe("conflict")
    expect(
      same.claims
        .flatMap((claim) =>
          claim.kind === "document" ? [claim.format.id] : []
        )
        .sort()
    ).toEqual(["worktable.markdown", "worktable.rich-text"])
    expect(JSON.stringify(documents)).not.toMatch(
      /"(?:documentId|identity|source|diagnostics)"|"doc_[A-Za-z0-9_-]{22}"/
    )

    const includingArchived = await connected.callTool({
      name: "worktable_documents_read",
      arguments: {
        request: { action: "list", spaceId, includeArchived: true },
      },
    })
    const allDocuments = (
      includingArchived.structuredContent as {
        documents: Array<{ path?: string; archived?: true }>
      }
    ).documents
    expect(
      allDocuments
        .filter((entry) => entry.archived)
        .map((entry) => entry.path)
        .sort()
    ).toEqual(["archived", "dashboards/old"])
    const mixed = allDocuments.find(
      (entry) => (entry as { pathKey?: string }).pathKey === "mixed"
    ) as {
      kind: "conflict"
      claims: Array<{ archived?: true }>
    }
    expect(mixed.kind).toBe("conflict")
    expect(mixed.claims.filter((claim) => claim.archived)).toHaveLength(1)
  })

  it("reads supported formats through one bounded inert projection", async () => {
    const docs = join(root, "spaces", spaceId, "docs")
    await mkdir(docs, { recursive: true })
    await writeFile(join(docs, "guide.md"), "# Guide\n\nVisible markdown")
    await writeFile(
      join(docs, "rich.json"),
      JSON.stringify([
        {
          type: "heading",
          content: [{ type: "text", text: "Rich heading", styles: {} }],
          children: [],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Rich paragraph", styles: {} }],
          children: [],
        },
        {
          type: "table",
          content: {
            type: "tableContent",
            rows: [
              {
                cells: [
                  [{ type: "text", text: "Status", styles: {} }],
                  [{ type: "text", text: "Ready", styles: {} }],
                ],
              },
            ],
          },
          children: [],
        },
        {
          type: "image",
          props: { name: "photo.png", caption: "Visible caption" },
          content: undefined,
          children: [],
        },
      ])
    )
    await writeFile(join(docs, "same.md"), "# Markdown conflict")
    await writeFile(join(docs, "same.json"), "[]")
    await writeFile(join(docs, "malformed.json"), "{")
    await writeFile(join(docs, "invalid-utf8.md"), Buffer.from([0xff]))
    await writeFile(join(docs, "archived.md"), "# Archived\n\nArchived text")
    await writeFile(join(docs, "oversized.md"), "x".repeat(600 * 1024))
    await writeFile(join(docs, "future.bin"), Buffer.alloc(600 * 1024, 0xff))
    await setDocArchived(spaceId, "archived", true, "test")

    const html = await writeWidget(
      spaceId,
      widget("dashboard", "Dashboard"),
      `<!doctype html><html><head><title>Dashboard title</title><style>STYLE_SECRET</style></head><body><h1>Visible heading</h1><p>Visible HTML</p><template>TEMPLATE_SECRET</template><noscript>NOSCRIPT_SECRET</noscript><script>globalThis.__worktableProjectionExecuted = "SCRIPT_SECRET"</script></body></html>`
    )
    html.release?.()
    const aliasCollision = await writeWidget(
      spaceId,
      widget("legacy-guide", "HTML at aliased path"),
      "<h1>Must remain inert</h1>"
    )
    aliasCollision.release?.()

    const bundleId = mintDocumentId()
    const bundle = join(docs, "bundled.wtdoc")
    await mkdir(bundle)
    await writeFile(join(bundle, "content.md"), "# Bundled\n\nBundle text")
    await writeFile(
      join(bundle, "manifest.json"),
      JSON.stringify({
        type: "worktable.document-bundle",
        version: 1,
        documentId: bundleId,
        format: { id: "worktable.markdown", sourceVersion: 1 },
        content: "content.md",
      })
    )
    await writeFile(
      join(root, "spaces", spaceId, "doc-aliases.json"),
      JSON.stringify({
        type: "worktable.doc-aliases",
        version: 1,
        exact: { "old-guide": "guide", "legacy-guide": "guide" },
        prefixes: {},
      })
    )
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: bundleId,
          path: "bundled",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: {
            kind: "bundle",
            relativePath: "docs/bundled.wtdoc",
            manifestPath: "docs/bundled.wtdoc/manifest.json",
          },
        },
        {
          documentId: mintDocumentId(),
          path: "future",
          format: { id: "future.canvas", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/future.bin" },
        },
      ],
    })

    const connected = await connect(["documents:read", "search:read"])
    const read = async (
      path: string,
      includeArchived = false
    ): Promise<Record<string, unknown>> => {
      const response = await connected.callTool({
        name: "worktable_documents_read",
        arguments: {
          request: {
            action: "read",
            spaceId,
            path,
            ...(includeArchived ? { includeArchived: true } : {}),
          },
        },
      })
      expect(response.isError).not.toBe(true)
      return (response.structuredContent as { result: Record<string, unknown> })
        .result
    }

    expect(await read("guide")).toMatchObject({
      kind: "document",
      document: { path: "guide", format: { id: "worktable.markdown" } },
      projection: {
        kind: "text",
        text: "# Guide\n\nVisible markdown",
        headings: ["Guide"],
        truncated: false,
      },
    })
    expect(await read("old-guide")).toMatchObject({
      kind: "document",
      resolvedFrom: "old-guide",
      document: { path: "guide" },
    })
    const rich = await read("rich")
    expect(rich).toMatchObject({
      projection: {
        kind: "text",
        headings: ["Rich heading"],
      },
    })
    const richText = (rich.projection as { text: string }).text
    expect(richText).toContain("Rich heading")
    expect(richText).toContain("Rich paragraph")
    expect(richText).toContain("Status")
    expect(richText).toContain("Ready")
    expect(richText).toContain("photo.png")
    expect(richText).toContain("Visible caption")
    const htmlRead = await read("dashboard")
    expect(htmlRead).toMatchObject({
      document: { format: { id: "worktable.html" } },
      projection: {
        kind: "text",
        headings: ["Visible heading"],
        truncated: false,
      },
    })
    const htmlText = (htmlRead.projection as { text: string }).text
    expect(htmlText).toContain("Dashboard title")
    expect(htmlText).toContain("Visible HTML")
    expect(htmlText).not.toMatch(
      /STYLE_SECRET|TEMPLATE_SECRET|NOSCRIPT_SECRET|SCRIPT_SECRET|<[^>]+>/
    )
    expect(
      (globalThis as Record<string, unknown>)["__worktableProjectionExecuted"]
    ).toBeUndefined()

    expect(await read("bundled")).toMatchObject({
      projection: { kind: "text", text: "# Bundled\n\nBundle text" },
    })
    const bundledSearch = await connected.callTool({
      name: "worktable_discover",
      arguments: {
        request: { action: "search", query: "Bundle text" },
      },
    })
    expect(bundledSearch.isError).not.toBe(true)
    const bundledHit = (
      bundledSearch.structuredContent as {
        results: Array<Record<string, unknown>>
      }
    ).results.find((result) => result.path === "bundled")
    expect(bundledHit).toMatchObject({
      documentKind: "document",
      format: { id: "worktable.markdown", sourceVersion: 1 },
      health: "supported",
    })
    expect(bundledHit).not.toHaveProperty("documentView")
    const conflict = await read("same")
    expect(conflict).toMatchObject({
      kind: "conflict",
      conflict: { pathKey: "same", health: "ambiguous" },
    })
    const aliasPathConflict = await read("legacy-guide")
    expect(aliasPathConflict).toMatchObject({
      kind: "conflict",
      conflict: {
        pathKey: "legacy-guide",
        claims: [
          { kind: "document", format: { id: "worktable.html" } },
          {
            kind: "alias",
            path: "legacy-guide",
            targetPath: "guide",
          },
        ],
      },
    })
    expect(await read("future")).toMatchObject({
      projection: { kind: "metadata-only", reason: "unsupported-format" },
    })
    expect(await read("oversized")).toMatchObject({
      projection: { kind: "metadata-only", reason: "too-large" },
    })
    expect(await read("malformed")).toMatchObject({
      document: { health: "invalid" },
      projection: { kind: "metadata-only", reason: "invalid" },
    })
    expect(await read("invalid-utf8")).toMatchObject({
      document: { health: "invalid" },
      projection: { kind: "metadata-only", reason: "invalid" },
    })
    const hiddenArchived = await connected.callTool({
      name: "worktable_documents_read",
      arguments: {
        request: { action: "read", spaceId, path: "archived" },
      },
    })
    expect(hiddenArchived.isError).toBe(true)
    expect(await read("archived", true)).toMatchObject({
      document: { path: "archived", archived: true },
      projection: { kind: "text", text: "# Archived\n\nArchived text" },
    })
    expect(JSON.stringify([htmlRead, conflict, aliasPathConflict])).not.toMatch(
      /"(?:documentId|identity|source|diagnostics)"/
    )
  }, 15_000)
})

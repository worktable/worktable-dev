import { writeWidget } from "./widget-store.ts"
import { writeWorkspaceManifest } from "./workspace.ts"
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
import { withWidgetWriteLock} from "./widget-store.ts"
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

async function connect(
  scopes = ["documents:read"],
  surface: "released" | "preview" = "released"
): Promise<Client> {
  const server = createWorktableMcpServer({
    version: "test",
    scopes,
    surface,
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
  // This catalog fixture deliberately includes legacy bundles and alias shadows.
  writeWorkspaceManifest({ ...ensureWorkspaceManifest(), version: 1 })
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

describe("files for agents on the preview surface", () => {
  it("creates, reads and replaces files through the file tools", async () => {
    const manifestPath = join(root, "worktable.workspace.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`
    )
    const previous = process.env["WORKTABLE_FILES_PREVIEW"]
    process.env["WORKTABLE_FILES_PREVIEW"] = "1"
    try {
      const connected = await connect(
        ["documents:read", "documents:write"],
        "preview"
      )
      const write = (request: Record<string, unknown>) =>
        connected.callTool({ name: "worktable_files_write", arguments: { request } })
      const read = (request: Record<string, unknown>) =>
        connected.callTool({ name: "worktable_files_read", arguments: { request } })
      const file = { id: "worktable.file", sourceVersion: 1 }

      const csv = await write({
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "data/feedback.csv",
        format: file,
        source: "id,score\n007,5\n008,4\n",
      })
      expect(csv.isError).not.toBe(true)
      const png = await write({
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "design/dot.png",
        format: file,
        source: Buffer.from("\x89PNG\r\n\x1a\nfake").toString("base64"),
        encoding: "base64",
      })
      expect(png.isError).not.toBe(true)

      // A text file reads as text, an image as an image the model can see.
      const text = await read({ action: "read_source", spaceId, path: "data/feedback.csv" })
      expect(text.isError).not.toBe(true)
      expect(text.structuredContent).toMatchObject({
        encoding: "utf8",
        source: "id,score\n007,5\n008,4\n",
      })
      const image = await read({ action: "read_source", spaceId, path: "design/dot.png" })
      expect(image.isError).not.toBe(true)
      expect(image.structuredContent).toMatchObject({
        encoding: "image",
        mediaType: "image/png",
      })
      expect(image.structuredContent).not.toHaveProperty("source")
      expect(
        (image.content as Array<{ type: string; mimeType?: string }>).some(
          (block) => block.type === "image" && block.mimeType === "image/png"
        )
      ).toBe(true)

      // A byte-order mark reads back as it is, so writing it back changes nothing.
      const marked = await write({
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "data/marked.csv",
        format: file,
        source: "\uFEFFid,score\n007,5\n",
      })
      expect(marked.isError).not.toBe(true)
      expect(
        (
          (await read({ action: "read_source", spaceId, path: "data/marked.csv" }))
            .structuredContent as { source: string }
        ).source
      ).toBe("\uFEFFid,score\n007,5\n")

      // Guidance names the tools this surface offers.
      const spec = JSON.stringify(
        (
          await connected.callTool({
            name: "worktable_guidance",
            arguments: { request: { action: "format_spec" } },
          })
        ).structuredContent
      )
      expect(spec).not.toContain("worktable_documents_read")
      expect(spec).not.toContain("worktable_documents_write")
      const descriptions = JSON.stringify(
        (await connected.listTools()).tools.map((tool) => tool.description)
      )
      expect(descriptions).not.toContain("worktable_documents_read")
      expect(descriptions).not.toContain("worktable_documents_write")
      // So do the workspace's orientation and the HTML authoring guide.
      const everything = await connect(["*"], "preview")
      const instructions = JSON.stringify([
        (
          await everything.callTool({
            name: "worktable_discover",
            arguments: { request: { action: "state" } },
          })
        ).structuredContent,
        (
          await everything.callTool({
            name: "worktable_html_read",
            arguments: { request: { action: "guide" } },
          })
        ).structuredContent,
      ])
      expect(instructions).toContain("worktable_files_read")
      expect(instructions).not.toContain("worktable_documents_read")

      // Overwriting a CSV says what changed, row by row.
      const replaced = await write({
        action: "replace",
        spaceId,
        path: "data/feedback.csv",
        source: "id,score\n007,5\n009,3\n",
        expectedRevision: (text.structuredContent as { sourceRevision: string })
          .sourceRevision,
      })
      expect(replaced.isError).not.toBe(true)
      expect(replaced.structuredContent).toMatchObject({
        changes: {
          header: "unchanged",
          rowsBefore: 2,
          rowsAfter: 2,
          rowsKept: 1,
          rowsAdded: 1,
          rowsRemoved: 1,
        },
      })

      // A credential that can't read the file isn't told what was in it.
      const writeOnly = await connect(["documents:write"], "preview")
      const blind = await writeOnly.callTool({
        name: "worktable_files_write",
        arguments: {
          request: {
            action: "replace",
            spaceId,
            path: "data/feedback.csv",
            source: "id,score\n010,1\n",
            expectedRevision: (replaced.structuredContent as { sourceRevision: string })
              .sourceRevision,
          },
        },
      })
      expect(blind.isError).not.toBe(true)
      expect(blind.structuredContent).not.toHaveProperty("changes")

      // Bytes that aren't UTF-8 get no summary rather than a wrong one.
      const latin1 = await write({
        action: "replace",
        spaceId,
        path: "data/feedback.csv",
        source: Buffer.from("id,score\ncaf\xE9,5\n", "latin1").toString("base64"),
        encoding: "base64",
        expectedRevision: (blind.structuredContent as { sourceRevision: string })
          .sourceRevision,
      })
      expect(latin1.isError).not.toBe(true)
      expect(latin1.structuredContent).not.toHaveProperty("changes")
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"]
      else process.env["WORKTABLE_FILES_PREVIEW"] = previous
    }
  })
})

describe("importing a file into Records", () => {
  it("proposes fields, imports chosen columns once, and writes nothing when a row is wrong", async () => {
    const manifestPath = join(root, "worktable.workspace.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`)
    const previous = process.env["WORKTABLE_FILES_PREVIEW"]
    process.env["WORKTABLE_FILES_PREVIEW"] = "1"
    try {
      const connected = await connect(
        ["documents:read", "documents:write", "records:read", "records:write"],
        "preview"
      )
      const write = (name: string, request: Record<string, unknown>) =>
        connected.callTool({ name, arguments: { request } })
      const file = { id: "worktable.file", sourceVersion: 1 }
      expect(
        (
          await write("worktable_files_write", {
            action: "create",
            lifetime: "durable",
            spaceId,
            path: "research/feedback.csv",
            format: file,
            source: "id,code,score,note\nfb-1,007,5,Loved it\nfb-2,012,3,\n",
          })
        ).isError
      ).not.toBe(true)

      const proposal = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "feedback",
        path: "research/feedback.csv",
        dryRun: true,
      })
      expect(proposal.isError).not.toBe(true)
      expect(proposal.structuredContent).toMatchObject({
        proposal: {
          rowCount: 2,
          idColumn: "id",
          idColumns: ["id", "code", "score"],
          // The text column with the most different values names a record.
          titleColumn: "code",
          columns: [
            { column: "id", field: "id", type: "text" },
            // A leading zero would be lost as a number.
            { column: "code", field: "code", type: "text" },
            { column: "score", field: "score", type: "number" },
            { column: "note", field: "note", type: "text" },
          ],
        },
      })

      const columns = [
        { column: "code", field: "code", type: "text" },
        { column: "score", field: "score", type: "number" },
      ]
      const imported = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "feedback",
        path: "research/feedback.csv",
        columns,
        idColumn: "id",
      })
      expect(imported.isError).not.toBe(true)
      expect(imported.structuredContent).toMatchObject({
        counts: { rows: 2, created: 2, skipped: 0, failed: 0 },
        columnsLeftOut: ["note"],
      })
      const again = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "feedback",
        path: "research/feedback.csv",
        columns,
        idColumn: "id",
      })
      expect(again.structuredContent).toMatchObject({
        counts: { created: 0, skipped: 2 },
      })

      // A value that can't be a number stops the whole import.
      await write("worktable_files_write", {
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "research/bad.csv",
        format: file,
        source: "id,score,extra\nfb-3,4,x\nfb-4,high,y\n",
      })
      const refused = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "feedback",
        path: "research/bad.csv",
        columns: [
          { column: "score", field: "score", type: "number" },
          { column: "extra", field: "extra", type: "text" },
        ],
        idColumn: "id",
      })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain("Nothing was imported")
      const schema = await readFile(
        join(root, "spaces", spaceId, "records", "feedback", "schema.yaml"),
        "utf8"
      )
      expect(schema).not.toContain("extra")
      // A new collection's records are named by the proposed column.
      expect(schema).toContain(`titleField: "code"`)

      // Names that make one key get distinct fields; a number too long to
      // hold exactly stays text; two columns can't fill one field; and a
      // row without its id is refused, so a second import can't duplicate it.
      await write("worktable_files_write", {
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "research/people.csv",
        format: file,
        source: "id,First Name,first_name,account\np-1,Ada,ada,9007199254740993\n,Bo,bo,1\n",
      })
      const people = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "people",
        path: "research/people.csv",
        dryRun: true,
      })
      expect(people.structuredContent).toMatchObject({
        proposal: {
          columns: [
            { column: "id", field: "id" },
            { column: "First Name", field: "first_name" },
            { column: "first_name", field: "first_name_2" },
            { column: "account", type: "text" },
          ],
        },
      })
      const clash = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "people",
        path: "research/people.csv",
        columns: [
          { column: "First Name", field: "name", type: "text" },
          { column: "first_name", field: "name", type: "text" },
        ],
      })
      expect(JSON.stringify(clash.content)).toContain("both fill the field name")
      const noId = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "people",
        path: "research/people.csv",
        columns: [{ column: "First Name", field: "name", type: "text" }],
        idColumn: "id",
      })
      expect(JSON.stringify(noId.content)).toContain("row 2: no id in id")

      // A blank line is no row; a row longer than its header, an empty
      // column choice and a file past the row limit are refused.
      await write("worktable_files_write", {
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "research/ragged.csv",
        format: file,
        source: "a,b\n1,2\n\n3\n",
      })
      const ragged = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "ragged",
        path: "research/ragged.csv",
        dryRun: true,
      })
      expect(ragged.structuredContent).toMatchObject({ proposal: { rowCount: 2 } })
      expect(
        (
          await write("worktable_records_write", {
            action: "import",
            spaceId,
            collectionId: "ragged",
            path: "research/ragged.csv",
            columns: [],
          })
        ).isError
      ).toBe(true)
      await write("worktable_files_write", {
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "research/wide.csv",
        format: file,
        source: "a,b\n1,2,3\n",
      })
      const wide = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "wide",
        path: "research/wide.csv",
        dryRun: true,
      })
      expect(JSON.stringify(wide.content)).toContain("Row 1 has 3 values for 2 columns")
      await write("worktable_files_write", {
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "research/long.csv",
        format: file,
        source: `n\n${"1\n".repeat(5001)}`,
      })
      const long = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "long",
        path: "research/long.csv",
        dryRun: true,
      })
      expect(JSON.stringify(long.content)).toContain("import up to 5,000 at a time")

      // A repeated column name is refused; a JSONL number keeps every digit.
      await write("worktable_files_write", {
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "research/twice.csv",
        format: file,
        source: "name,name\nAlice,Bob\n",
      })
      const twice = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "twice",
        path: "research/twice.csv",
        dryRun: true,
      })
      expect(JSON.stringify(twice.content)).toContain('two columns named \\"name\\"')
      await write("worktable_files_write", {
        action: "create",
        lifetime: "durable",
        spaceId,
        path: "research/accounts.jsonl",
        format: file,
        source: '{"account":9007199254740993,"meta":{"n":9007199254740993}}\n',
      })
      const accounts = await write("worktable_records_write", {
        action: "import",
        spaceId,
        collectionId: "accounts",
        path: "research/accounts.jsonl",
        dryRun: true,
      })
      expect(accounts.structuredContent).toMatchObject({
        proposal: {
          columns: [
            { column: "account", type: "text" },
            { column: "meta", type: "text" },
          ],
          sample: [{ account: "9007199254740993", meta: '{"n":9007199254740993}' }],
        },
      })

      // Reading a file to import it needs documents:read as well.
      const recordsOnly = await connect(["records:read", "records:write"], "preview")
      const unscoped = await recordsOnly.callTool({
        name: "worktable_records_write",
        arguments: {
          request: {
            action: "import",
            spaceId,
            collectionId: "people",
            path: "research/people.csv",
            dryRun: true,
          },
        },
      })
      expect(unscoped.isError).toBe(true)
      expect(JSON.stringify(unscoped.content)).toContain("documents:read")
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"]
      else process.env["WORKTABLE_FILES_PREVIEW"] = previous
    }
  })
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
          lifetime: "durable",
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

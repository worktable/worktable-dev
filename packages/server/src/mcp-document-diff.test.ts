import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { SpaceFile } from "@worktable/types"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { writeSpace } from "./store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const spaceId = "history"
let root = ""
let client: Client | null = null

function space(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "History",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

async function tool(
  name: string,
  request: Record<string, unknown>
): Promise<{ ok: boolean; data: Record<string, unknown>; text: string }> {
  const result = await client!.callTool({ name, arguments: { request } })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("\n")
  return {
    ok: result.isError !== true,
    data: (result.structuredContent ?? {}) as Record<string, unknown>,
    text,
  }
}

const paragraph = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
  children: [],
})

async function writeRichDoc(texts: string[], extra: Record<string, unknown> = {}) {
  const written = await tool("worktable_docs_write", {
    action: "write",
    spaceId,
    docPath: "notes/plan",
    // A table keeps the Doc in its rich .json source.
    content: [
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [{ cells: [[{ type: "text", text: "Owner", styles: {} }]] }],
        },
        children: [],
      },
      ...texts.map(paragraph),
    ],
    ...extra,
  })
  expect(written.data).toMatchObject({ ok: true, storedAs: "json" })
}

const diff = (request: Record<string, unknown>) =>
  tool("worktable_documents_read", { action: "diff", spaceId, ...request })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-mcp-diff-"))
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  invalidateSearchIndex()
  await writeSpace(space())
  const server = createWorktableMcpServer({ version: "test", scopes: ["documents:read", "documents:write", "docs:read", "docs:write", "widgets:write"] })
  client = new Client({ name: "diff-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client?.close()
  client = null
  setWorkspaceRootOverride(null)
  invalidateSearchIndex()
  await rm(root, { recursive: true, force: true })
})

describe("document diffs over MCP", () => {
  it("diffs a Doc's Markdown from the revision an agent last read", async () => {
    await writeRichDoc(["Alpha", "Beta", "Delta"], { lifetime: "durable" })
    const firstRead = await tool("worktable_documents_read", {
      action: "read_source",
      spaceId,
      path: "notes/plan",
    })
    const lastRead = firstRead.data["sourceRevision"] as string
    await writeRichDoc(["Alpha", "Beta revised", "Delta"])
    await writeRichDoc(["Alpha", "Beta revised", "Delta", "Gamma"])
    const current = await tool("worktable_documents_read", {
      action: "read_source",
      spaceId,
      path: "notes/plan",
    })

    const changed = await diff({ path: "notes/plan", from: lastRead, context: 0 })
    expect(changed.data).toMatchObject({
      path: "notes/plan",
      from: lastRead,
      to: current.data["sourceRevision"],
      stats: { added: 3, removed: 1 },
      truncated: false,
    })
    const unified = changed.data["unified"] as string
    expect(unified.split("\n").filter((line) => /^[-+](?![-+])/.test(line))).toEqual([
      "-Beta",
      "+Beta revised",
      "+",
      "+Gamma",
    ])

    // Version ids from action versions resolve too, in either position.
    const versions = await tool("worktable_documents_read", {
      action: "versions",
      spaceId,
      path: "notes/plan",
      all: true,
    })
    const ids = (versions.data["versions"] as Array<{ id: string }>).map((v) => v.id)
    const between = await diff({ path: "notes/plan", from: ids.at(-1), to: ids[0] })
    expect(between.data).toMatchObject({ stats: { added: 3, removed: 1 } })
    // The default context keeps unchanged neighbours around each change.
    expect(between.data["unified"]).toContain("\n Alpha\n \n-Beta\n")

    const unchanged = await diff({ path: "notes/plan", from: current.data["sourceRevision"] })
    expect(unchanged.data).toMatchObject({ unified: "", stats: { added: 0, removed: 0 } })

    for (const from of ["rev_pruned", "2020-01-01T00-00-00-000Z-000000-deadbeef"]) {
      const missing = await diff({ path: "notes/plan", from })
      expect(missing.ok).toBe(false)
      expect(missing.text).toContain("not in this document's version history")
      expect(missing.text).toContain("action versions")
    }
  })

  it("diffs from the revision a Doc read returned, in the same scheme", async () => {
    const readDoc = async () =>
      (await tool("worktable_docs_read", { action: "read", spaceId, docPath: "notes/plan" })).data[
        "revision"
      ] as string
    await writeRichDoc(["Alpha", "Beta"], { lifetime: "durable" })
    const lastRead = await readDoc()
    expect(lastRead).toMatch(/^json:sha256:[0-9a-f]{64}$/)
    await writeRichDoc(["Alpha", "Beta revised"])
    await writeRichDoc(["Alpha", "Beta revised", "Gamma"])

    const changed = await diff({ path: "notes/plan", from: lastRead, context: 0 })
    expect(changed.data).toMatchObject({
      from: lastRead,
      to: await readDoc(),
      stats: { added: 3, removed: 1 },
    })
    expect(changed.data["unified"]).toContain("-Beta\n+Beta revised\n")

    const missing = await diff({ path: "notes/plan", from: `json:sha256:${"0".repeat(64)}` })
    expect(missing.text).toContain("action versions")
  })

  it("diffs HTML source and rejects formats without text", async () => {
    const created = await tool("worktable_html_write", {
      action: "create",
      lifetime: "durable",
      spaceId,
      id: "board",
      name: "Board",
      html: "<h1>Board</h1>\n<p>Open</p>\n",
    })
    expect(created.ok).toBe(true)
    await tool("worktable_html_write", {
      action: "update",
      spaceId,
      htmlId: "board",
      html: "<h1>Board</h1>\n<p>Closed</p>\n",
    })
    const versions = await tool("worktable_documents_read", {
      action: "versions",
      spaceId,
      path: "board",
      all: true,
    })
    const oldest = (versions.data["versions"] as Array<{ id: string }>).at(-1)!.id
    const html = await diff({ path: "board", from: oldest })
    expect(html.data).toMatchObject({ stats: { added: 1, removed: 1 } })
    expect(html.data["unified"]).toContain("-<p>Open</p>\n+<p>Closed</p>")

    const docs = join(root, "spaces", spaceId, "docs")
    await mkdir(docs, { recursive: true })
    await writeFile(join(docs, "sketch.excalidraw"), JSON.stringify({ type: "excalidraw", elements: [] }))
    const drawing = await diff({ path: "sketch", from: oldest })
    expect(drawing.ok).toBe(false)
    expect(drawing.text).toContain("no text projection")
  })

  it("resolves revisions read before a move and a Doc storage change", async () => {
    const write = (docPath: string, content: unknown, extra: Record<string, unknown> = {}) =>
      tool("worktable_docs_write", { action: "write", spaceId, docPath, content, ...extra })
    await write("drafts/plan", "# Plan\n\nAlpha\n", { lifetime: "durable" })
    const readBeforeMove = await tool("worktable_documents_read", {
      action: "read_source",
      spaceId,
      path: "drafts/plan",
    })
    const moved = await tool("worktable_documents_write", {
      action: "move",
      spaceId,
      path: "drafts/plan",
      to: "plans/plan",
    })
    expect(moved.ok).toBe(true)
    // A table moves the Doc from Markdown to rich-text storage.
    await write("plans/plan", [
      { type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Plan", styles: {} }], children: [] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "Owner", styles: {} }]] }] }, children: [] },
      paragraph("Omega"),
    ])

    const changed = await diff({ path: "plans/plan", from: readBeforeMove.data["sourceRevision"] })
    expect(changed.ok).toBe(true)
    expect(changed.data["unified"]).toContain("-Alpha")
    expect(changed.data["unified"]).toContain("+Omega")
  })

  it("resolves revisions from stored source alone and reports unknown ones", async () => {
    await tool("worktable_html_write", {
      action: "create",
      lifetime: "durable",
      spaceId,
      id: "status",
      name: "Status",
      html: "<p>Open</p>\n",
    })
    const lastRead = (
      await tool("worktable_documents_read", { action: "read_source", spaceId, path: "status" })
    ).data["sourceRevision"] as string
    await tool("worktable_html_write", { action: "update", spaceId, htmlId: "status", html: "<p>Closed</p>\n" })

    // Revision lookup reads only each version's source, never its companions.
    const documents = join(root, "versions", spaceId, "documents")
    let removed = 0
    for (const documentId of await readdir(documents)) {
      for (const generation of await readdir(join(documents, documentId))) {
        const directory = join(documents, documentId, generation)
        if (!(await readdir(directory)).includes("companions")) continue
        await rm(join(directory, "companions"), { recursive: true })
        removed += 1
      }
    }
    expect(removed).toBeGreaterThan(1)
    const changed = await diff({ path: "status", from: lastRead })
    expect(changed.data).toMatchObject({ stats: { added: 1, removed: 1 } })

    const mistyped = await diff({ path: "status", from: `${lastRead}x` })
    expect(mistyped.ok).toBe(false)
    expect(mistyped.text).toContain("Use action versions")
  })
})

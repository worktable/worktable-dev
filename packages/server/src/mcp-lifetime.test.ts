import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { SpaceFile } from "@worktable/types"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { writeSpace } from "./store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const spaceId = "agents"
const DAY = 86_400_000
let root = ""
let client: Client | null = null

function space(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Agents",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

async function connect(): Promise<Client> {
  const server = createWorktableMcpServer({ version: "test", scopes: ["*"] })
  client = new Client({ name: "lifetime-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
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

const writeDoc = (docPath: string, extra: Record<string, unknown> = {}) =>
  tool("worktable_docs_write", {
    action: "write",
    spaceId,
    docPath,
    content: `# ${docPath}\n`,
    ...extra,
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-mcp-lifetime-"))
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  invalidateSearchIndex()
  await writeSpace(space())
  await connect()
})

afterEach(async () => {
  await client?.close()
  client = null
  setWorkspaceRootOverride(null)
  invalidateSearchIndex()
  await rm(root, { recursive: true, force: true })
})

describe("agent document lifetimes over MCP", () => {
  it("requires a lifetime to create a document and keeps it on later writes", async () => {
    const missing = await writeDoc("plans/handoff")
    expect(missing.ok).toBe(false)
    expect(missing.text).toContain("lifetime is required")

    const dated = await writeDoc("plans/handoff", { archiveOn: "2030-01-01" })
    expect(dated.ok).toBe(false)

    const created = await writeDoc("plans/handoff", { lifetime: "temporary" })
    expect(created.ok).toBe(true)
    expect(created.data["lifetime"]).toBe("temporary")
    const archiveOn = created.data["archiveOn"] as string
    expect(Math.abs(Date.parse(archiveOn) - (Date.now() + 7 * DAY))).toBeLessThan(60_000)

    const updated = await writeDoc("plans/handoff", { content: "# Handoff\n\nNext steps.\n" })
    expect(updated.ok).toBe(true)
    const read = await tool("worktable_docs_read", {
      action: "read",
      spaceId,
      docPath: "plans/handoff",
    })
    expect(read.data["lifetime"]).toBe("temporary")
    expect(read.data["createdAt"]).toBeDefined()
  })

  it("changes lifetimes by folder and lists one scoped page at a time", async () => {
    await writeDoc("plans/a", { lifetime: "durable" })
    await writeDoc("plans/b", { lifetime: "durable" })
    await writeDoc("notes/c", { lifetime: "durable" })

    const folder = await tool("worktable_documents_write", {
      action: "set_folder_lifetime",
      spaceId,
      path: "plans",
      lifetime: "temporary",
    })
    expect(folder.data).toMatchObject({ ok: true, count: 2, paths: ["plans/a", "plans/b"] })

    const first = await tool("worktable_documents_read", {
      action: "list",
      spaceId,
      pathPrefix: "plans",
      lifetime: "temporary",
      limit: 1,
    })
    expect(first.data["total"]).toBe(2)
    expect(first.data["scope"]).toMatchObject({ spaceId, pathPrefix: "plans", lifetime: "temporary" })
    const page1 = first.data["documents"] as Array<{ path: string }>
    expect(page1.map((d) => d.path)).toEqual(["plans/a"])
    const second = await tool("worktable_documents_read", {
      action: "list",
      spaceId,
      pathPrefix: "plans",
      lifetime: "temporary",
      limit: 1,
      cursor: first.data["nextCursor"],
    })
    expect((second.data["documents"] as Array<{ path: string }>).map((d) => d.path)).toEqual(["plans/b"])
    expect(second.data["nextCursor"]).toBeUndefined()

    const durable = await tool("worktable_documents_write", {
      action: "set_lifetime",
      spaceId,
      path: "plans/a",
      lifetime: "durable",
    })
    expect(durable.data).toMatchObject({ ok: true, path: "plans/a", lifetime: "durable" })

    const search = await tool("worktable_discover", {
      action: "search",
      spaceId,
      query: "plans",
      pathPrefix: "notes",
    })
    expect(search.data["scope"]).toMatchObject({ spaceId, pathPrefix: "notes" })
    expect((search.data["results"] as Array<{ path?: string }>).every((r) => r.path?.startsWith("notes/"))).toBe(true)
  })

  it("pins Start here documents that follow renames and report archiving", async () => {
    await writeDoc("guide", { lifetime: "durable" })
    await writeDoc("plan", { lifetime: "durable" })

    const pinned = await tool("worktable_spaces", {
      action: "update",
      spaceId,
      description: "Agent work",
      startHere: [{ path: "guide", note: "Read first" }, { path: "plan" }],
    })
    expect(pinned.ok).toBe(true)
    expect(pinned.data["startHere"]).toMatchObject([
      { path: "guide", note: "Read first", status: "active" },
      { path: "plan", status: "active" },
    ])

    const unknown = await tool("worktable_spaces", {
      action: "update",
      spaceId,
      startHere: [{ path: "missing" }],
    })
    expect(unknown.ok).toBe(false)

    await tool("worktable_documents_write", { action: "move", spaceId, path: "guide", to: "handbook" })
    await tool("worktable_documents_write", { action: "archive", spaceId, path: "plan" })

    const state = await tool("worktable_discover", { action: "state", spaceId })
    expect(state.data["startHere"]).toMatchObject([
      { path: "handbook", status: "active" },
      { path: "plan", status: "archived" },
    ])

    const archived = await tool("worktable_spaces", { action: "archive", spaceId, reason: "Done" })
    expect(archived.data).toMatchObject({ ok: true })
    const restored = await tool("worktable_spaces", { action: "restore", spaceId })
    expect(restored.data).toMatchObject({ ok: true })
  })
})

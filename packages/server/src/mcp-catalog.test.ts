import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CATALOG_TOOLS,
  PUBLIC_TOOL_NAMES,
  ToolArgumentError,
  routeCatalogCall,
} from "./mcp/catalog.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

function tool(name: string) {
  const found = CATALOG_TOOLS.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`No tool ${name}`)
  return found
}

/** The operations a call runs, by id. */
function routes(name: string, args: Record<string, unknown>): string[] {
  return routeCatalogCall(tool(name), args).operations.map(({ id }) => id)
}

function rejects(name: string, args: Record<string, unknown>): string {
  try {
    routeCatalogCall(tool(name), args)
  } catch (error) {
    expect(error).toBeInstanceOf(ToolArgumentError)
    return (error as Error).message
  }
  throw new Error(`${name} accepted ${JSON.stringify(args)}`)
}

describe("the listed tools", () => {
  it("each choose one operation from their arguments", () => {
    const space = { spaceId: "s" }
    const file = { ...space, path: "notes.md" }
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ["worktable_state", {}, ["workspace.state"]],
      ["worktable_state", { ...space, index: true }, ["workspace.space_index"]],
      ["worktable_search", { query: "q" }, ["workspace.search"]],
      ["worktable_search", { query: "q", exact: true }, ["docs.grep"]],
      ["worktable_search", { query: "a+", regex: true }, ["docs.grep"]],
      ["worktable_spaces_write", { name: "Plans" }, ["spaces.create"]],
      ["worktable_spaces_write", { ...space, name: "Plans" }, ["spaces.update"]],
      ["worktable_spaces_write", { ...space, archived: true }, ["spaces.archive"]],
      ["worktable_spaces_write", { ...space, archived: false }, ["spaces.restore"]],
      ["worktable_files_read", space, ["documents.list"]],
      ["worktable_files_read", file, ["documents.read"]],
      ["worktable_files_read", { ...file, source: true }, ["documents.read_source"]],
      ["worktable_files_read", { ...file, versions: true }, ["documents.versions"]],
      ["worktable_files_read", { ...file, from: "rev_1" }, ["documents.diff"]],
      ["worktable_files_write", { ...file, source: "x", format: { id: "worktable.file", sourceVersion: 1 }, lifetime: "durable" }, ["documents.create"]],
      ["worktable_files_write", { ...file, source: "x", expectedRevision: "rev_1" }, ["documents.replace"]],
      ["worktable_files_write", { ...file, fromVersionId: "v1", expectedRevision: "rev_1" }, ["documents.restore_version"]],
      ["worktable_files_write", file, ["documents.upload"]],
      ["worktable_files_write", { ...file, file: { download_url: "https://example.com/f", file_id: "f1" } }, ["documents.upload"]],
      ["worktable_files_update", { ...file, newPath: "plans/notes.md" }, ["documents.move"]],
      ["worktable_files_update", { ...space, path: "plans", folder: true, newPath: "old" }, ["documents.move_folder"]],
      ["worktable_files_update", { ...file, archived: true }, ["documents.archive"]],
      ["worktable_files_update", { ...file, archived: false }, ["documents.restore"]],
      ["worktable_files_update", { ...space, path: "plans", folder: true, archived: true }, ["documents.archive_folder"]],
      ["worktable_files_update", { ...file, lifetime: "temporary" }, ["documents.set_lifetime"]],
      ["worktable_files_update", { ...space, path: "plans", folder: true, lifetime: "durable" }, ["documents.set_folder_lifetime"]],
      ["worktable_files_update", { ...file, checkpoint: true, expectedRevision: "rev_1" }, ["documents.checkpoint"]],
      ["worktable_docs_write", { ...space, docPath: "d", content: "# D", lifetime: "durable" }, ["docs.write"]],
      ["worktable_docs_write", { ...space, docPath: "d", edits: [{ oldText: "a", newText: "b" }] }, ["docs.edit"]],
      ["worktable_html_write", { ...space, name: "App", lifetime: "durable", html: "<!doctype html>" }, ["html.create"]],
      ["worktable_html_write", { ...space, htmlId: "app", html: "<!doctype html>" }, ["html.update"]],
      ["worktable_html_write", { ...space, htmlId: "app", name: "Renamed" }, ["html.rename"]],
      ["worktable_drawings_read", { ...space, path: "flow" }, ["drawings.inspect"]],
      ["worktable_drawings_read", { ...space, path: "flow", changes: true }, ["drawings.changes"]],
      ["worktable_drawings_write", { ...space, path: "flow", requestId: "r", title: "Flow", lifetime: "durable" }, ["drawings.create"]],
      ["worktable_drawings_write", { ...space, path: "flow", requestId: "r", expectedRevision: "rev_1", operations: [{ op: "remove", id: "shape:a" }] }, ["drawings.edit"]],
      ["worktable_drawings_write", { ...space, path: "flow", requestId: "r", expectedRevision: "rev_1", undoChangeId: "c1" }, ["drawings.undo"]],
      ["worktable_drawings_write", { ...space, path: "flow", requestId: "r", expectedRevision: "rev_1", undoChangeId: "c1", redo: true }, ["drawings.redo"]],
      ["worktable_records_query", space, ["records.list_collections"]],
      ["worktable_records_query", { ...space, collectionId: "tasks" }, ["records.query"]],
      ["worktable_records_query", { ...space, collectionId: "tasks", recordId: "t1" }, ["records.read"]],
      ["worktable_records_create", { ...space, collectionId: "tasks", data: { title: "T" } }, ["records.create"]],
      ["worktable_records_create", { ...space, collectionId: "tasks", records: [{ data: { title: "T" } }] }, ["records.create_many"]],
      ["worktable_records_create", { ...space, collectionId: "tasks", importPath: "tasks.csv", dryRun: true }, ["records.import"]],
      ["worktable_records_update", { ...space, collectionId: "tasks", recordId: "t1", data: { done: true } }, ["records.update"]],
      ["worktable_records_update", { ...space, collectionId: "tasks", recordIds: ["t1"], data: { done: true } }, ["records.update_many"]],
      ["worktable_annotations_read", space, ["annotations.list"]],
      ["worktable_annotations_read", { ...space, annotationId: "a1", includeTargetContext: true }, ["annotations.read"]],
      ["worktable_annotations_write", { ...space, body: "Hi", target: { type: "doc", docPath: "d" } }, ["annotations.create"]],
      ["worktable_annotations_write", { ...space, replyTo: "a1", body: "Hi" }, ["annotations.reply"]],
      ["worktable_annotations_write", { ...space, annotationId: "a1", patch: { body: "Edited" } }, ["annotations.update"]],
      ["worktable_annotations_write", { ...space, annotationId: "a1", resolved: true }, ["annotations.resolve"]],
      ["worktable_threads_read", { participants: true }, ["threads.participants"]],
      ["worktable_threads_read", {}, ["threads.list"]],
      ["worktable_threads_read", { threadId: "t1" }, ["threads.read"]],
      ["worktable_threads_read", { threadId: "t1", messageId: "msg_0123456789ab" }, ["threads.message"]],
      ["worktable_threads_read", { threadId: "t1", after: 3, wait: true }, ["threads.wait"]],
      ["worktable_threads_update", { location: { kind: "space", spaceId: "s" }, threadId: "t1", title: "Plans" }, ["threads.rename"]],
      ["worktable_threads_update", { location: { kind: "space", spaceId: "s" }, threadId: "t1", assignResponse: { messageId: "msg_0123456789ab", identityId: null } }, ["threads.assign_response"]],
      ["worktable_delivery_claim", {}, ["thread_delivery.claim"]],
      ["worktable_delivery_claim", { registerAs: "Atlas" }, ["thread_delivery.register_participant", "thread_delivery.claim"]],
      ["worktable_delivery_report", { messageId: "m", leaseId: "l", status: "accepted" }, ["thread_delivery.accept"]],
      ["worktable_delivery_report", { messageId: "m", leaseId: "l", status: "progress", phase: "working" }, ["thread_delivery.progress"]],
      ["worktable_delivery_report", { messageId: "m", leaseId: "l", status: "failed", retryable: false, code: "x", message: "y" }, ["thread_delivery.fail"]],
      ["worktable_delete", file, ["documents.delete"]],
      ["worktable_delete", { ...space, path: "plans", folder: true }, ["documents.delete_folder"]],
      ["worktable_delete", { ...space, collectionId: "tasks", recordId: "t1" }, ["records.delete"]],
      ["worktable_guidance", { topic: "format_spec" }, ["guidance.format_spec"]],
      ["worktable_guidance", { topic: "drawings" }, ["guidance.drawings"]],
      ["worktable_guidance", { topic: "html" }, ["html.guide"]],
      ["worktable_mermaid", { source: "flowchart TD\nA-->B" }, ["mermaid.validate"]],
      ["worktable_mermaid", { source: "flowchart TD\nA-->B", preview: true }, ["mermaid.preview"]],
    ]
    for (const [name, args, expected] of cases) {
      expect({ name, args, ops: routes(name, args) }).toEqual({ name, args, ops: expected })
    }
  })

  it("explain arguments that don't describe one thing to do", () => {
    const file = { spaceId: "s", path: "notes.md" }
    expect(rejects("worktable_files_update", { ...file, newPath: "a.md", archived: true })).toContain("one change per call")
    expect(rejects("worktable_files_update", file)).toContain("one change per call")
    expect(rejects("worktable_files_update", { spaceId: "s", path: "plans", folder: true, checkpoint: true, expectedRevision: "rev_1" })).toContain("not a folder")
    expect(rejects("worktable_files_read", { spaceId: "s", source: true })).toContain("need path")
    expect(rejects("worktable_annotations_write", { spaceId: "s", annotationId: "a1", replyTo: "a2", body: "x" })).toContain("not both")
    expect(rejects("worktable_threads_update", { location: { kind: "space", spaceId: "s" }, threadId: "t", title: "T", assignResponse: { messageId: "msg_0123456789ab", identityId: null } })).toContain("separate calls")
    expect(rejects("worktable_delete", { spaceId: "s" })).toContain("Pass path")
    expect(rejects("worktable_html_write", { spaceId: "s", htmlId: "app", permissions: {} })).toContain("needs html")
    // Fields of a different operation are refused by that operation's schema.
    expect(rejects("worktable_files_update", { ...file, newPath: "a.md", reason: "tidy" })).toContain("reason")
    // So are missing fields, named as the caller sent them.
    expect(rejects("worktable_files_write", { ...file, source: "x" })).toContain("lifetime")
  })
})

describe("listed tools through MCP", () => {
  let root = ""
  let client: Client | null = null

  async function connect(): Promise<Client> {
    const server = createWorktableMcpServer({
      version: "test",
      scopes: ["*"],
      urlOrigin: "http://127.0.0.1:7480",
    })
    client = new Client({ name: "catalog-test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    // Listing first lets the client check each result against its output schema.
    await client.listTools()
    return client
  }

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client!.callTool({ name, arguments: args })
    if (result.isError) {
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`)
    }
    return result.structuredContent as Record<string, unknown>
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worktable-mcp-catalog-"))
    setWorkspaceRootOverride(root)
    ensureWorkspaceManifest()
    invalidateSearchIndex()
    await connect()
  })

  afterEach(async () => {
    await client?.close()
    client = null
    setWorkspaceRootOverride(null)
    invalidateSearchIndex()
    await rm(root, { recursive: true, force: true })
  })

  it("lists exactly the flat tools, each with a distinct title", async () => {
    const { tools } = await client!.listTools()
    expect(tools.map((listed) => listed.name)).toEqual([...PUBLIC_TOOL_NAMES])
    expect(new Set(tools.map((listed) => listed.title)).size).toBe(tools.length)
    for (const listed of tools) {
      expect(listed.inputSchema.properties ?? {}).not.toHaveProperty("request")
      expect(listed.inputSchema.properties ?? {}).not.toHaveProperty("action")
    }
  })

  it("covers a Space, Docs, files, Records and comments end to end", async () => {
    const { spaceId } = await call("worktable_spaces_write", { name: "Plans" })
    expect(spaceId).toBeTruthy()

    await call("worktable_docs_write", { spaceId, docPath: "brief", content: "# Brief\n\nHello there", lifetime: "durable" })
    const read = await call("worktable_docs_read", { spaceId, docPath: "brief" })
    expect(read.content).toContain("Hello there")
    await call("worktable_docs_write", { spaceId, docPath: "brief", edits: [{ oldText: "Hello there", newText: "Hi there" }] })
    expect((await call("worktable_docs_read", { spaceId, docPath: "brief" })).content).toContain("Hi there")

    const listed = await call("worktable_files_read", { spaceId })
    expect(JSON.stringify(listed)).toContain("brief")
    expect(await call("worktable_files_read", { spaceId, path: "brief", versions: true })).toBeDefined()

    await call("worktable_files_update", { spaceId, path: "brief", newPath: "plans/brief" })
    await call("worktable_files_update", { spaceId, path: "plans/brief", archived: true })
    await call("worktable_files_update", { spaceId, path: "plans/brief", archived: false })
    await call("worktable_files_update", { spaceId, path: "plans/brief", lifetime: "temporary" })
    expect((await call("worktable_docs_read", { spaceId, docPath: "plans/brief" })).content).toContain("Hi there")

    await call("worktable_files_write", {
      spaceId,
      path: "notes.txt",
      format: { id: "worktable.file", sourceVersion: 1 },
      lifetime: "durable",
      source: "plain notes",
    })
    expect(await call("worktable_files_read", { spaceId, path: "notes.txt", source: true })).toMatchObject({ source: "plain notes" })

    expect(await call("worktable_search", { query: "Hi there", exact: true })).toBeDefined()
    expect(await call("worktable_state", {})).toBeDefined()
    expect(await call("worktable_state", { spaceId, index: true })).toHaveProperty("index")

    await call("worktable_records_upsert_collection", { spaceId, collectionId: "tasks", name: "Tasks", fields: { title: { type: "string" }, done: { type: "boolean" } } })
    await call("worktable_records_create", { spaceId, collectionId: "tasks", recordId: "t1", data: { title: "First" } })
    await call("worktable_records_create", { spaceId, collectionId: "tasks", records: [{ recordId: "t2", data: { title: "Second" } }] })
    expect(JSON.stringify(await call("worktable_records_query", { spaceId }))).toContain("tasks")
    expect((await call("worktable_records_query", { spaceId, collectionId: "tasks" })).total).toBe(2)
    expect(await call("worktable_records_query", { spaceId, collectionId: "tasks", recordId: "t1" })).toBeDefined()
    await call("worktable_records_update", { spaceId, collectionId: "tasks", recordId: "t1", data: { done: true } })
    await call("worktable_delete", { spaceId, collectionId: "tasks", recordId: "t2" })
    expect((await call("worktable_records_query", { spaceId, collectionId: "tasks" })).total).toBe(1)

    const created = await call("worktable_annotations_write", { spaceId, body: "Tighten this", target: { type: "doc", docPath: "plans/brief" } })
    const annotationId = (created.annotation as { id: string }).id
    await call("worktable_annotations_write", { spaceId, replyTo: annotationId, body: "Done" })
    expect(await call("worktable_annotations_read", { spaceId, annotationId, includeTargetContext: true })).toBeDefined()
    await call("worktable_annotations_write", { spaceId, annotationId, resolved: true })
    expect(await call("worktable_annotations_read", { spaceId, includeResolved: true })).toBeDefined()

    expect(await call("worktable_guidance", { topic: "html" })).toHaveProperty("guide")
    expect(await call("worktable_mermaid", { source: "flowchart TD\nA-->B", preview: true })).toMatchObject({ ok: true })

    await call("worktable_delete", { spaceId, path: "notes.txt" })
    await call("worktable_spaces_write", { spaceId, archived: true })
    await call("worktable_spaces_write", { spaceId, archived: false })
  })

  it("renames an HTML Doc without its HTML", async () => {
    const { spaceId } = await call("worktable_spaces_write", { name: "Apps" })
    const created = await call("worktable_html_write", {
      spaceId,
      name: "Tracker",
      lifetime: "durable",
      html: "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width\"></head><body>Hi</body></html>",
    })
    const htmlId = created.htmlId as string
    await call("worktable_html_write", { spaceId, htmlId, name: "Team tracker" })
    expect(await call("worktable_html_read", { spaceId, htmlId })).toMatchObject({ htmlDoc: { name: "Team tracker" } })
  })

  it("still answers calls in the earlier surface's shape, unlisted", async () => {
    const { tools } = await client!.listTools()
    expect(tools.map((listed) => listed.name)).not.toContain("worktable_discover")
    const { spaceId } = await call("worktable_spaces_write", { name: "Legacy" })
    await call("worktable_docs_write", { spaceId, docPath: "a", content: "# A", lifetime: "durable" })

    // A grouped tool that is no longer listed.
    expect(await call("worktable_discover", { request: { action: "state" } })).toBeDefined()
    // A listed name, called with its earlier request shape: the result still
    // passes the client's check against the listed output schema.
    const docs = await call("worktable_docs_read", { request: { action: "list", spaceId } })
    expect(JSON.stringify(docs)).toContain("\"a\"")
    // An individual tool that was folded into another.
    expect(await call("worktable_space_index", { spaceId })).toHaveProperty("index")
    // Earlier calls are checked against their earlier schema.
    const invalid = await client!.callTool({ name: "worktable_thread_delivery", arguments: { request: { action: "claim", waitSeconds: 99 } } })
    expect(invalid.isError).toBe(true)
    expect(JSON.stringify(invalid.content)).toContain("waitSeconds")
  })
})

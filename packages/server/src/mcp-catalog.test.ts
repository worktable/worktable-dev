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
import { readWidgetDocument } from "./widget-store.ts"
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
      ["worktable_guidance", { topic: "workflow", name: "worktable-create-or-update-docs" }, ["guidance.workflow"]],
      ["worktable_mermaid", { source: "flowchart TD\nA-->B" }, ["mermaid.validate"]],
      ["worktable_mermaid", { source: "flowchart TD\nA-->B", preview: true }, ["mermaid.preview"]],
    ]
    for (const [name, args, expected] of cases) {
      expect({ name, args, ops: routes(name, args) }).toEqual({ name, args, ops: expected })
    }
  })

  it("accept what any of their operations accepts", () => {
    // Creating a drawing takes an empty batch; only edits need an operation.
    const drawings = tool("worktable_drawings_write")
    const created = drawings.inputSchema.parse({
      spaceId: "s",
      path: "flow",
      requestId: "r",
      title: "Flow",
      lifetime: "durable",
      operations: [],
    })
    expect(routeCatalogCall(drawings, created).operations.map(({ id }) => id)).toEqual(["drawings.create"])
    // Renaming an HTML Doc clears its description with null.
    const html = tool("worktable_html_write")
    const renamed = html.inputSchema.parse({ spaceId: "s", htmlId: "app", name: "App", description: null })
    expect(routeCatalogCall(html, renamed).operations.map(({ id }) => id)).toEqual(["html.rename"])
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
    expect(rejects("worktable_html_write", { spaceId: "s", htmlId: "app", html: "<p>", edits: [] })).toContain("one of html, edits or upload")
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

  it("takes the arguments agents commonly send", async () => {
    const { spaceId } = await call("worktable_spaces_write", { name: "Plans" })

    // State, pins and the file tools say path, so agents send it to the Doc
    // tools too. Links in Docs start with a slash, so their paths do as well.
    await call("worktable_docs_write", { spaceId, path: "/notes/first", content: "# First\n\nAlpha line", lifetime: "durable" })
    expect((await call("worktable_docs_read", { spaceId, path: "notes/first" })).content).toContain("Alpha line")
    await call("worktable_docs_write", { spaceId, docPath: "/notes/first", edits: [{ oldText: "Alpha", newText: "Beta" }] })
    expect((await call("worktable_docs_read", { spaceId, docPath: "/notes/first" })).content).toContain("Beta line")
    expect(await call("worktable_files_read", { spaceId, path: "/notes/first" })).toBeDefined()
    await call("worktable_files_write", {
      spaceId,
      path: "/notes/data.csv",
      format: { id: "worktable.file", sourceVersion: 1 },
      lifetime: "durable",
      source: "a\n1\n",
    })
    await call("worktable_html_write", {
      spaceId,
      id: "/notes/page",
      name: "Page",
      lifetime: "durable",
      html: "<!doctype html><html><head><title>Page</title></head><body>Page</body></html>",
    })
    await call("worktable_annotations_write", { spaceId, body: "Tighten this", target: { type: "doc", docPath: "/notes/first" } })
    await call("worktable_files_update", { spaceId, path: "/notes/first", newPath: "/notes/second" })
    const listed = JSON.stringify(await call("worktable_files_read", { spaceId, pathPrefix: "/notes" }))
    for (const path of ["notes/second", "notes/data.csv", "notes/page"]) expect(listed).toContain(path)

    // A search by meaning takes the options the tool lists for an exact one.
    await call("worktable_docs_write", { spaceId, docPath: "notes/third", content: "# Third\n\nBeta line again", lifetime: "durable" })
    const found = await call("worktable_search", { query: "Beta line", spaceId, maxResults: 1, caseSensitive: false, context: 2 })
    expect(found.results).toHaveLength(1)

    // A list of comments has no one target to give context for.
    const comments = await call("worktable_annotations_read", { spaceId, includeTargetContext: true })
    expect(comments.annotations).toHaveLength(1)
  })

  it("renames an HTML Doc without its HTML, and keeps how its page is served to itself", async () => {
    const { spaceId } = await call("worktable_spaces_write", { name: "Apps" })
    const created = await call("worktable_html_write", {
      spaceId,
      name: "Tracker",
      lifetime: "durable",
      html: "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width\"></head><body>Hi</body></html>",
    })
    const htmlId = created.htmlId as string
    const renamed = await call("worktable_html_write", { spaceId, htmlId, name: "Team tracker" })
    const read = await call("worktable_html_read", { spaceId, htmlId })
    expect(read).toMatchObject({ htmlDoc: { name: "Team tracker" } })
    // How Worktable serves the page is kept with it, and stays out of what
    // agents read.
    expect((await readWidgetDocument(spaceId as string, htmlId)).data?.widget.spaceImages).toBe(true)
    // Listing HTML Docs is answered in the earlier surface's shape.
    const listed = await call("worktable_html_read", { request: { action: "list", spaceId } })
    expect(listed.htmlDocs).toHaveLength(1)
    for (const result of [created, renamed, read, listed]) {
      expect(JSON.stringify(result)).not.toContain("spaceImages")
    }
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

describe("the preview tools", () => {
  let root = ""
  let client: Client | null = null

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client!.callTool({ name, arguments: args })
    if (result.isError) {
      throw new Error(`${name} failed: ${JSON.stringify(result.content)}`)
    }
    return result.structuredContent as Record<string, unknown>
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "worktable-mcp-preview-"))
    setWorkspaceRootOverride(root)
    ensureWorkspaceManifest()
    invalidateSearchIndex()
    const server = createWorktableMcpServer({
      version: "test",
      scopes: ["*"],
      urlOrigin: "http://127.0.0.1:7480",
      surface: "preview",
    })
    client = new Client({ name: "catalog-preview-test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    await client.listTools()
  })

  afterEach(async () => {
    await client?.close()
    client = null
    setWorkspaceRootOverride(null)
    invalidateSearchIndex()
    await rm(root, { recursive: true, force: true })
  })

  it("tell an agent about a Space without listing its files", async () => {
    const { spaceId } = await call("worktable_spaces_write", { name: "Plans" })
    for (const docPath of ["start-here", "plans/q1", "plans/q2", "research/interviews/anna"]) {
      await call("worktable_docs_write", { spaceId, docPath, content: `# ${docPath}\n\n## One\n\n## Two`, lifetime: "durable" })
    }
    await call("worktable_spaces_write", { spaceId, pins: [{ path: "start-here", note: "Read first" }, { path: "plans/q1" }] })
    await call("worktable_files_update", { spaceId, path: "plans/q1", archived: true })

    expect(((await call("worktable_state", {})).spaces as unknown[]).length).toBe(1)
    const told = await call("worktable_state", { spaceId })
    expect(told.space).toEqual({ id: spaceId, name: "Plans" })
    // Pins are said once, and only those whose doc is still there.
    expect((told.pins as Array<{ path: string }>).map((pin) => pin.path)).toEqual(["start-here"])
    expect(told.items).toBe(3)
    expect((told.folders as Array<{ path: string; items: number }>).map(({ path, items }) => [path, items]).sort()).toEqual([
      ["plans", 1],
      ["research", 1],
    ])
    expect((told.recent as unknown[]).length).toBe(3)
    expect(told.hint).toContain("worktable_files_read")
    for (const gone of ["docs", "documents", "startHere", "index"]) expect(told).not.toHaveProperty(gone)

    // There is no index to ask for; an agent used to asking gets the same answer.
    const { tools } = await client!.listTools()
    const state = tools.find((listed) => listed.name === "worktable_state")!
    expect(state.inputSchema.properties ?? {}).not.toHaveProperty("index")
    expect(state.outputSchema?.properties ?? {}).not.toHaveProperty("documents")
    expect(await call("worktable_state", { spaceId, index: true })).toMatchObject({ items: 3 })

    // The list is where the files are: a row says what a file is picked by.
    const listed = await call("worktable_files_read", { spaceId })
    const rows = listed.documents as Array<Record<string, unknown>>
    expect(rows.map((row) => row.path).sort()).toEqual(["plans/q2", "research/interviews/anna", "start-here"])
    for (const row of rows) {
      expect(row).toHaveProperty("title")
      expect(row).not.toHaveProperty("folderOperations")
      expect(row).not.toHaveProperty("createdAt")
    }
  })

  it("let an agent archive a Record, read what changed in it and learn what its own write changed", async () => {
    const { spaceId } = await call("worktable_spaces_write", { name: "Queue" })
    const at = { spaceId, collectionId: "replies" }
    await call("worktable_records_upsert_collection", {
      ...at,
      name: "Replies",
      fields: { title: { type: "string" }, status: { type: "select", values: ["pending", "approved"] } },
    })
    for (const recordId of ["r1", "r2"]) {
      await call("worktable_records_create", { ...at, recordId, data: { title: recordId, status: "pending" } })
    }

    // A write says which fields it changed, or that it changed nothing.
    const approve = { ...at, recordId: "r1", data: { title: "r1", status: "approved" } }
    expect(await call("worktable_records_update", approve)).toMatchObject({ changed: ["status"] })
    expect(await call("worktable_records_update", approve)).toMatchObject({ unchanged: true })

    // Archiving keeps the Record and takes it out of queries; it is brought back the same way.
    const archived = await call("worktable_records_update", { ...at, recordId: "r1", archived: true, reason: "Posted elsewhere" })
    expect(archived).toMatchObject({ archived: true })
    expect(archived).not.toHaveProperty("changed")
    expect((await call("worktable_records_query", at)).total).toBe(1)
    const many = await call("worktable_records_update", { ...at, recordIds: ["r1", "r2"], archived: true })
    expect(many.counts).toEqual({ updated: 2, failed: 0 })
    expect((await call("worktable_records_query", at)).total).toBe(0)
    await call("worktable_records_update", { ...at, where: { title: "r2" }, archived: false })
    expect(((await call("worktable_records_query", at)).records as Array<{ id: string }>).map((record) => record.id)).toEqual(["r2"])
    await expect(call("worktable_records_update", { ...at, recordId: "r2", reason: "No archive asked" })).rejects.toThrow("reason goes with archived")

    // The history says who changed what, newest first, and pages to the oldest.
    const read = await call("worktable_records_query", { ...at, recordId: "r1", history: true })
    const history = read.history as { changes: Array<Record<string, unknown>>; total: number; nextCursor?: string }
    // Archived once: asking again for a Record already archived writes nothing.
    expect(history.changes.map((change) => change.kind)).toEqual(["archived", "changed", "added"])
    expect(history.total).toBe(3)
    expect(history.changes[0]).toMatchObject({ reason: "Posted elsewhere", by: { kind: "agent" } })
    expect(read.record).toMatchObject({ archive: { reason: "Posted elsewhere" } })
    expect(history.changes[1]!.fields).toEqual({ status: { before: "pending", after: "approved" } })
    // A change made by a call on several Records carries that call's id.
    const other = (await call("worktable_records_query", { ...at, recordId: "r2", history: true })).history as typeof history
    expect(other.changes.map((change) => change.kind)).toEqual(["restored", "archived", "added"])
    expect(other.changes[0]!.call).toBeDefined()
    expect(other.changes[1]!.call).not.toBe(other.changes[0]!.call)
    const first = (await call("worktable_records_query", { ...at, recordId: "r1", history: true, limit: 2 })).history as typeof history
    expect(first.changes.length).toBe(2)
    const rest = (await call("worktable_records_query", { ...at, recordId: "r1", history: true, cursor: first.nextCursor })).history as typeof history
    expect(rest.changes.map((change) => change.kind)).toEqual(["added"])
    expect(rest.nextCursor).toBeUndefined()
    // These changes reach back to the Record being added, so none is missing.
    expect(rest).not.toHaveProperty("earlierNotKept")
    // Asking for archived Records too is no reason to refuse a read by id.
    expect(await call("worktable_records_query", { ...at, recordId: "r1", history: true, includeArchived: true })).toHaveProperty("history")
    // Without history a read is what it was.
    expect(await call("worktable_records_query", { ...at, recordId: "r1" })).not.toHaveProperty("history")
    await expect(call("worktable_records_query", { ...at, history: true })).rejects.toThrow("history reads one Record")
    // Values already stored, but the Record is archived: the call changed something.
    const put = await call("worktable_records_update", { ...at, recordId: "r2", data: { title: "r2" }, archived: true })
    expect(put).toMatchObject({ archived: true, changed: [] })
    expect(put).not.toHaveProperty("unchanged")
  })
})

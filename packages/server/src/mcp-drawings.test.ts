import { previewTest as it } from "./test-support/synthetic-preview.ts"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktableMcpServer } from "./mcp/server.ts"
import {
  setWorkspaceRootOverride,
  ensureWorkspaceManifest,
} from "./workspace.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { writeSpace } from "./store.ts"
import { recordIndex } from "./record-index.ts"
import { invalidateSearchIndex } from "./search-index.ts"

let root = ""
const clients: Client[] = []
const address = { spaceId: "drawings", path: "flow" }
async function connect(
  scopes = ["search:read", "documents:read", "documents:write"],
  principalId = "drawing-owner"
) {
  const server = createWorktableMcpServer({
    version: "test",
    scopes,
    principal: { id: principalId, type: "agent", displayName: "Drawing agent" },
    urlOrigin: "http://127.0.0.1:7481",
  })
  const client = new Client({ name: "drawing-test", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(b), client.connect(a)])
  clients.push(client)
  return client
}
const call = (
  client: Client,
  name: "read" | "write",
  request: Record<string, unknown>
) =>
  client.callTool({
    name: `worktable_drawings_${name}`,
    arguments: { request: { ...address, ...request } },
  })
function data(result: Awaited<ReturnType<typeof call>>) {
  expect(result.isError).not.toBe(true)
  return result.structuredContent as Record<string, any>
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-drawings-mcp-"))
  setWorkspaceRootOverride(join(root, "workspace"))
  setAppDirOverride(join(root, "app"))
  ensureWorkspaceManifest()
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: address.spaceId,
    name: "Drawings",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  recordIndex.stop()
  invalidateSearchIndex()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("drawing tools through MCP", () => {
  it("discovers drawings and dispatches image, read, edit and history results through MCP", async () => {
    const client = await connect()
    const created = await call(client, "write", {
      action: "create",
      lifetime: "durable",
      title: "Request flow",
      requestId: "create",
      operations: [
        {
          op: "add",
          ref: "browser",
          object: { type: "rectangle", text: "Browser", x: 0, y: 0 },
        },
        {
          op: "add",
          ref: "api",
          object: { type: "rectangle", text: "API", x: 300, y: 0 },
        },
      ],
    })
    const saved = data(created)
    expect(saved.preview).toMatchObject({
      status: "ready",
      kind: "saved",
      sourceRevision: saved.sourceRevision,
    })
    const images = (
      created.content as Array<{ type: string; data?: string }>
    ).filter((item) => item.type === "image")
    expect(images).toHaveLength(1)
    const png = images[0]!.data!
    expect(Buffer.from(png, "base64").subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a"
    )
    expect(JSON.stringify(saved)).not.toContain(png)
    expect(saved.drawing).toBeUndefined()
    const listed = await client.callTool({
      name: "worktable_documents_read",
      arguments: {
        request: {
          action: "list",
          spaceId: address.spaceId,
          format: "worktable.quickdraw",
        },
      },
    })
    expect((listed.structuredContent as any).documents).toHaveLength(1)
    const detail = await client.callTool({
      name: "worktable_discover",
      arguments: { request: { action: "state", spaceId: address.spaceId } },
    })
    expect((detail.structuredContent as any).documents).toHaveLength(1)
    const inspected = data(
      await call(client, "read", {
        action: "inspect",
        preview: { mode: "none" },
      })
    )
    expect(inspected.sourceRevision).toBe(saved.sourceRevision)
    expect(inspected.objects).toHaveLength(2)
    const queried = await call(client, "read", {
      action: "query",
      text: "API",
      limit: 1,
    })
    expect(data(queried).objects[0].id).toBe(saved.references.api)
    expect(
      (queried.content as any[]).some((item) => item.type === "image")
    ).toBe(false)
    const svg = await call(client, "read", {
      action: "render",
      preview: { format: "svg", theme: "dark", ids: [saved.references.api] },
    })
    const resource = (svg.content as any[]).find(
      (item) => item.type === "resource"
    )
    expect(resource.resource.text).toContain("API")
    expect(resource.resource.text).not.toContain(">Browser<")
    const changed = data(
      await call(client, "write", {
        action: "edit",
        expectedRevision: saved.sourceRevision,
        requestId: "rename",
        preview: { mode: "none" },
        operations: [
          {
            op: "update",
            id: saved.references.api,
            changes: { text: "Gateway" },
          },
        ],
      })
    )
    expect(changed.sourceRevision).not.toBe(saved.sourceRevision)
    // Identical display names do not give a different principal ownership of
    // another agent's receipts, even when it has drawing write scope.
    const other = await connect(undefined, "another-agent")
    const deniedUndo = await call(other, "write", {
      action: "undo",
      expectedRevision: changed.sourceRevision,
      requestId: "undo",
      changeId: changed.changeId,
      preview: { mode: "none" },
    })
    expect(deniedUndo.isError).toBe(true)
    expect(JSON.stringify(deniedUndo.content)).toContain("original actor")
    const undo = data(
      await call(client, "write", {
        action: "undo",
        expectedRevision: changed.sourceRevision,
        requestId: "undo",
        changeId: changed.changeId,
        preview: { mode: "none" },
      })
    )
    const deniedRedo = await call(other, "write", {
      action: "redo",
      expectedRevision: undo.sourceRevision,
      requestId: "redo",
      changeId: undo.changeId,
      preview: { mode: "none" },
    })
    expect(deniedRedo.isError).toBe(true)
    expect(JSON.stringify(deniedRedo.content)).toContain("original actor")
    const redo = data(
      await call(client, "write", {
        action: "redo",
        expectedRevision: undo.sourceRevision,
        requestId: "redo",
        changeId: undo.changeId,
        preview: { mode: "none" },
      })
    )
    const history = data(
      await call(client, "read", { action: "changes" })
    ).changes
    expect(history).toHaveLength(4)
    expect(
      history.find((entry: any) => entry.changeId === undo.changeId)
    ).toMatchObject({
      reverses: changed.changeId,
    })
    expect(
      history.find((entry: any) => entry.changeId === redo.changeId)
    ).toMatchObject({
      reverses: undo.changeId,
    })
    expect(
      data(await call(client, "read", { action: "query", text: "Gateway" }))
        .objects[0].id
    ).toBe(saved.references.api)
  })

  it("keeps a saved edit successful when preview rendering fails, and supports unsaved proposals", async () => {
    const client = await connect()
    const proposal = data(
      await call(client, "write", {
        action: "create",
        lifetime: "durable",
        title: "Proposal",
        requestId: "proposal",
        previewOnly: true,
      })
    )
    expect(proposal).toMatchObject({
      previewOnly: true,
      sourceRevision: null,
      preview: { status: "ready" },
    })
    expect(proposal.urlToSendInChat).toBeUndefined()
    const result = data(
      await call(client, "write", {
        action: "create",
        lifetime: "durable",
        title: "Large stroke",
        requestId: "large",
        operations: [
          {
            op: "add",
            object: {
              type: "draw",
              points: Array.from({ length: 210_000 }, (_, i) =>
                i % 3 === 2 ? 0.5 : i % 100
              ),
            },
          },
        ],
      })
    )
    expect(result.preview).toMatchObject({
      status: "failed",
      sourceRevision: result.sourceRevision,
    })
    expect(result.changeId).toBeString()
    const read = data(await call(client, "read", { action: "query" }))
    expect(read.objects[0].pointCount).toBe(70_000)
    expect(read.objects[0].pts).toBeUndefined()
  })

  it("requires both scopes for drawing writes and supplies an authorization challenge", async () => {
    const client = await connect(["documents:write"])
    const denied = await call(client, "write", {
      action: "create",
      lifetime: "durable",
      title: "Denied",
      requestId: "denied",
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain("documents:read")
    expect(denied._meta?.["mcp/www_authenticate"]).toBeDefined()
    const guide = await client.callTool({
      name: "worktable_guidance",
      arguments: { request: { action: "drawings" } },
    })
    expect(guide.isError).not.toBe(true)
    expect((guide.structuredContent as any).guide).toContain("expectedRevision")
  })
})

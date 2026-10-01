import { afterEach, beforeEach, expect, it } from "bun:test"
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
import { readRegisteredDocumentSource } from "./document-write-service.ts"
import { recordIndex } from "./record-index.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { closePreviewBrowsers } from "./document-preview-browser.ts"

let root: string
let previousRelease: string | undefined
const clients: Client[] = []
async function connect(
  scopes = ["documents:read", "widgets:read", "widgets:write"]
) {
  const server = createWorktableMcpServer({
    version: "test",
    scopes,
    urlOrigin: "http://127.0.0.1:7481",
  })
  const client = new Client({ name: "preview-test", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(b), client.connect(a)])
  clients.push(client)
  return client
}
function call(client: Client, tool: string, request: Record<string, unknown>) {
  return client.callTool({
    name: tool,
    arguments: { request: { spaceId: "preview", ...request } },
  })
}
beforeEach(async () => {
  await closePreviewBrowsers()
  root = await mkdtemp(join(tmpdir(), "worktable-preview-mcp-"))
  setWorkspaceRootOverride(join(root, "workspace"))
  setAppDirOverride(join(root, "app"))
  // A deliberately minimal installation: no ambient developer browser may be used.
  previousRelease = process.env.WORKTABLE_RELEASE_DIR
  process.env.WORKTABLE_RELEASE_DIR = join(root, "minimal-release")
  ensureWorkspaceManifest()
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "preview",
    name: "Preview",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
})
afterEach(async () => {
  await closePreviewBrowsers()
  await Promise.all(clients.splice(0).map((client) => client.close()))
  if (previousRelease === undefined) delete process.env.WORKTABLE_RELEASE_DIR
  else process.env.WORKTABLE_RELEASE_DIR = previousRelease
  recordIndex.stop()
  invalidateSearchIndex()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

it("keeps HTML saved when preview runtime is unavailable and fences standalone captures to the source revision", async () => {
  const client = await connect()
  const first = await call(client, "worktable_html_write", {
    action: "create",
    id: "dashboard",
    name: "Dashboard",
    html: "<!doctype html><html><body><h1>First</h1></body></html>",
    preview: {},
  })
  expect(first.isError).not.toBe(true)
  const firstData = first.structuredContent as any
  expect(firstData.preview.status).toBe("unavailable")
  expect(firstData.preview.sourceRevision).toBe(firstData.sourceRevision)
  const source = await readRegisteredDocumentSource({
    spaceId: "preview",
    path: "dashboard",
  })
  expect(source.sourceRevision).toBe(firstData.sourceRevision)
  expect(new TextDecoder().decode(source.bytes)).toContain("First")
  expect(first.content).toHaveLength(1)

  const second = await call(client, "worktable_html_write", {
    action: "update",
    htmlId: "dashboard",
    html: "<!doctype html><html><body><h1>Second</h1></body></html>",
    preview: {},
  })
  expect(second.isError).not.toBe(true)
  const secondData = second.structuredContent as any
  expect(secondData.preview.status).toBe("unavailable")
  expect(secondData.sourceRevision).not.toBe(firstData.sourceRevision)
  const stale = await call(client, "worktable_documents_read", {
    action: "render",
    path: "dashboard",
    expectedRevision: firstData.sourceRevision,
  })
  expect(stale.isError).toBe(true)
  expect(JSON.stringify(stale.content)).toContain("REVISION_CONFLICT")
  for (const [tool, address] of [
    ["worktable_documents_read", { path: "dashboard" }],
    ["worktable_html_read", { htmlId: "dashboard" }],
  ] as const) {
    const rendered = await call(client, tool, {
      action: "render",
      ...address,
      expectedRevision: secondData.sourceRevision,
    })
    expect(rendered.isError).not.toBe(true)
    expect((rendered.structuredContent as any).preview.status).toBe(
      "unavailable"
    )
    expect((rendered.structuredContent as any).sourceRevision).toBe(
      secondData.sourceRevision
    )
  }
}, 30_000)

it("does not grant preview reads to a write-only HTML connection", async () => {
  const client = await connect(["widgets:write"])
  const denied = await call(client, "worktable_html_write", {
    action: "create",
    id: "private",
    name: "Private",
    html: "<html><body>Secret</body></html>",
    preview: {},
  })
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied)).toContain("widgets:read")
  const allowed = await call(client, "worktable_html_write", {
    action: "create",
    id: "private",
    name: "Private",
    html: "<html><body>Secret</body></html>",
  })
  expect(allowed.isError).not.toBe(true)
  expect((allowed.structuredContent as any).preview).toBeUndefined()
})

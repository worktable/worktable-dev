import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { Hono } from "hono"
import type { SpaceFile } from "@worktable/types"

import { setAppDirOverride } from "./app-storage.ts"
import { addUrlToSendInChat, docUrlToSendInChat } from "./mcp/chat-links.ts"
import { mcpRouter } from "./routes/mcp.ts"
import { invalidateServerSettingsCache } from "./settings-store.ts"
import { readSpace, writeSpace } from "./store.ts"
import { createToken } from "./token-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

const VALID_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-text:#111}html[data-theme="dark"]{--ad-bg:#111;--ad-text:#eee}body{background:var(--ad-bg);color:var(--ad-text)}</style></head><body><p>hello</p></body></html>`
const ENV_KEYS = [
  "HOST",
  "PORT",
  "WORKTABLE_PUBLIC_URL",
  "WORKTABLE_RESOURCE_URL",
  "WORKTABLE_REQUIRE_AUTH",
  "WORKTABLE_MCP_TOKEN",
] as const

let tempDir: string
let savedEnv: Record<string, string | undefined>
let app: Hono

function makeSpace(id: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const response = await app.fetch(
    // This suite exercises the compatibility path of a local Worktable. Keep
    // the synthetic request on a literal loopback URL so it matches the
    // production trust boundary: bare MCP is never accepted for a non-loopback
    // request host, even when the in-memory Hono app has no real socket.
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })
  )
  const envelope = (await response.json()) as {
    error?: { message?: string }
    result?: {
      isError?: boolean
      content?: Array<{ type: string; text?: string }>
      structuredContent?: Record<string, unknown>
    }
  }
  expect(response.status).toBe(200)
  expect(envelope.error).toBeUndefined()
  expect(envelope.result?.isError).not.toBe(true)
  const text = envelope.result?.content?.find(
    (item) => item.type === "text"
  )?.text
  if (!text) throw new Error(`Missing text result for ${name}`)
  const parsed = JSON.parse(text) as Record<string, unknown>
  expect(envelope.result?.structuredContent).toEqual(parsed)
  return parsed
}

beforeEach(async () => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  tempDir = mkdtempSync(join(tmpdir(), "worktable-mcp-chat-links-"))
  setAppDirOverride(join(tempDir, "app"))
  setWorkspaceRootOverride(join(tempDir, "workspace"))
  invalidateServerSettingsCache()
  await writeSpace(makeSpace("shared-space"))
  app = new Hono()
  app.route("/mcp", mcpRouter)
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  invalidateServerSettingsCache()
  rmSync(tempDir, { recursive: true, force: true })
})

describe("MCP URLs to send in chat", () => {
  it("attributes compatibility MCP callers to the default agent and preserves authenticated agents", async () => {
    const implicit = await callTool("worktable_spaces", {
      request: { action: "create", name: "Implicit Agent" },
    })
    expect(
      (await readSpace(implicit["spaceId"] as string)).data?.createdBy
    ).toBe("worktable-agent")

    process.env["WORKTABLE_MCP_TOKEN"] = "legacy-secret"
    const legacy = await callTool(
      "worktable_spaces",
      { request: { action: "create", name: "Legacy Agent" } },
      { Authorization: "Bearer legacy-secret" }
    )
    expect((await readSpace(legacy["spaceId"] as string)).data?.createdBy).toBe(
      "worktable-agent"
    )

    const minted = await createToken({ scopes: ["*"], agent: "codex" })
    const authenticated = await callTool(
      "worktable_spaces",
      { request: { action: "create", name: "Authenticated Agent" } },
      { Authorization: `Bearer ${minted.token}` }
    )
    expect(
      (await readSpace(authenticated["spaceId"] as string)).data?.createdBy
    ).toBe(minted.metadata.principal.id)
  })

  it("uses the HTTP-facing origin for single docs and keeps bulk results path-only", async () => {
    const proxyHeaders = {
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "worktable.example.test",
    }
    const docPath = "Research & plans/α #1"

    const written = await callTool(
      "worktable_docs_write",
      {
        request: {
          action: "write",
          spaceId: "shared-space",
          docPath,
          content: "# Research",
        },
      },
      proxyHeaders
    )
    expect(written["docPath"]).toBe(docPath)
    expect(written["urlToSendInChat"]).toBe(
      "https://worktable.example.test/spaces/shared-space/documents/Research%20%26%20plans/%CE%B1%20%231"
    )

    const read = await callTool(
      "worktable_docs_read",
      {
        request: { action: "read", spaceId: "shared-space", docPath },
      },
      proxyHeaders
    )
    expect(read["urlToSendInChat"]).toBe(written["urlToSendInChat"])

    const listed = await callTool(
      "worktable_docs_read",
      {
        request: { action: "list", spaceId: "shared-space" },
      },
      proxyHeaders
    )
    expect(JSON.stringify(listed)).not.toContain("urlToSendInChat")

    const searched = await callTool(
      "worktable_discover",
      {
        request: {
          action: "search",
          query: "Research",
          spaceId: "shared-space",
        },
      },
      proxyHeaders
    )
    expect(JSON.stringify(searched)).not.toContain("urlToSendInChat")

    const state = await callTool(
      "worktable_discover",
      {
        request: { action: "state", spaceId: "shared-space" },
      },
      proxyHeaders
    )
    expect(JSON.stringify(state)).not.toContain("urlToSendInChat")
  })

  it("returns a chat URL for an HTML doc without adding one to widget lists", async () => {
    process.env["WORKTABLE_PUBLIC_URL"] =
      "https://configured.example.test/a/path"
    const { token } = await createToken({ scopes: ["*"] })
    const authorization = { Authorization: `Bearer ${token}` }
    const created = await callTool(
      "worktable_html_write",
      {
        request: {
          action: "create",
          spaceId: "shared-space",
          id: "plans/overview",
          name: "Overview",
          html: VALID_HTML,
        },
      },
      authorization
    )
    expect(created["htmlId"]).toBe("plans/overview")
    expect(created["widgetId"]).toBeUndefined()
    expect(created["urlToSendInChat"]).toBe(
      "https://configured.example.test/spaces/shared-space/documents/plans/overview"
    )

    const listed = await callTool(
      "worktable_html_read",
      {
        request: { action: "list", spaceId: "shared-space" },
      },
      authorization
    )
    expect(JSON.stringify(listed)).not.toContain("urlToSendInChat")
  })

  it("publicizes HTML annotation targets without rewriting metadata keys", async () => {
    const created = await callTool("worktable_annotations_write", {
      request: {
        action: "create",
        spaceId: "shared-space",
        target: { type: "html", htmlId: "plans/overview" },
        category: "comment",
        body: "Review this briefing",
        metadata: {
          widgetId: "user-defined",
          nested: { widgetId: "also-user-defined" },
        },
      },
    })
    const annotation = created["annotation"] as Record<string, unknown>
    expect(annotation["target"]).toEqual({
      type: "html",
      htmlId: "plans/overview",
    })
    expect(annotation["metadata"]).toEqual({
      widgetId: "user-defined",
      nested: { widgetId: "also-user-defined" },
    })

    const read = await callTool("worktable_annotations_read", {
      request: {
        action: "read",
        spaceId: "shared-space",
        annotationId: created["annotationId"],
      },
    })
    expect((read["annotation"] as Record<string, unknown>)["metadata"]).toEqual(
      annotation["metadata"]
    )
  })

  it("keeps record results structured across a complete MCP journey", async () => {
    const collection = await callTool("worktable_records_write", {
      request: {
        action: "upsert_collection",
        spaceId: "shared-space",
        collectionId: "tasks",
        name: "Tasks",
        fields: {
          title: { type: "string", required: true },
          done: { type: "boolean" },
        },
      },
    })
    expect((collection["collection"] as Record<string, unknown>)["id"]).toBe(
      "tasks"
    )

    const created = await callTool("worktable_records_write", {
      request: {
        action: "create",
        spaceId: "shared-space",
        collectionId: "tasks",
        recordId: "ship-plugin",
        data: { title: "Ship plugin", done: false },
      },
    })
    expect((created["record"] as Record<string, unknown>)["id"]).toBe(
      "ship-plugin"
    )

    const listed = await callTool("worktable_records_read", {
      request: { action: "list_collections", spaceId: "shared-space" },
    })
    expect(listed["collections"]).toHaveLength(1)

    const queried = await callTool("worktable_records_read", {
      request: {
        action: "query",
        spaceId: "shared-space",
        collectionId: "tasks",
        where: { done: false },
      },
    })
    expect(queried["records"]).toHaveLength(1)

    const read = await callTool("worktable_records_read", {
      request: {
        action: "read",
        spaceId: "shared-space",
        collectionId: "tasks",
        recordId: "ship-plugin",
      },
    })
    expect((read["record"] as Record<string, unknown>)["data"]).toEqual({
      title: "Ship plugin",
      done: false,
    })

    const updated = await callTool("worktable_records_write", {
      request: {
        action: "update",
        spaceId: "shared-space",
        collectionId: "tasks",
        recordId: "ship-plugin",
        data: { done: true },
      },
    })
    expect(
      (
        (updated["record"] as Record<string, unknown>)["data"] as Record<
          string,
          unknown
        >
      )["done"]
    ).toBe(true)

    const deleted = await callTool("worktable_delete", {
      request: {
        action: "record",
        spaceId: "shared-space",
        collectionId: "tasks",
        recordId: "ship-plugin",
      },
    })
    expect(deleted).toEqual({ ok: true })
  })

  it("uses the hosted resource origin instead of the internal request origin", async () => {
    process.env["WORKTABLE_RESOURCE_URL"] =
      "https://tenant.example.test/api/mcp"
    const written = await callTool("worktable_docs_write", {
      request: {
        action: "write",
        spaceId: "shared-space",
        docPath: "hosted/result",
        content: "# Hosted",
      },
    })
    expect(written["urlToSendInChat"]).toBe(
      "https://tenant.example.test/spaces/shared-space/documents/hosted/result"
    )
  })

  it("rejects a non-HTTP forwarded protocol before dispatch and still returns the persisted write", async () => {
    const written = await callTool(
      "worktable_docs_write",
      {
        request: {
          action: "write",
          spaceId: "shared-space",
          docPath: "safe/result",
          content: "# Safe",
        },
      },
      {
        "X-Forwarded-Proto": "javascript",
        "X-Forwarded-Host": "attacker.example.test",
      }
    )
    expect(written["urlToSendInChat"]).toBe(
      "http://127.0.0.1/spaces/shared-space/documents/safe/result"
    )

    const read = await callTool("worktable_docs_read", {
      request: {
        action: "read",
        spaceId: "shared-space",
        docPath: "safe/result",
      },
    })
    expect(read["content"]).toBe("# Safe")
  })

  it("uses the renamed document destination", () => {
    expect(
      addUrlToSendInChat(
        "renamed_doc",
        { spaceId: "space" },
        { ok: true, oldPath: "old", newPath: "folder/new" },
        "https://worktable.example"
      )
    ).toEqual({
      ok: true,
      oldPath: "old",
      newPath: "folder/new",
      urlToSendInChat:
        "https://worktable.example/spaces/space/documents/folder/new",
    })
  })

  it("round-trips reserved and international path segments through URL encoding", () => {
    const segment = fc.constantFrom(
      "plain",
      "with space",
      "hash#mark",
      "query?mark",
      "percent%mark",
      "ünicode",
      "東京"
    )
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 1, maxLength: 5 }),
        (segments) => {
          const docPath = segments.join("/")
          const url = new URL(
            docUrlToSendInChat(
              "https://worktable.example",
              "space & one",
              docPath
            )
          )
          const encodedSegments = url.pathname.split("/").slice(4)
          expect(encodedSegments.map(decodeURIComponent)).toEqual(segments)
          expect(decodeURIComponent(url.pathname.split("/")[2]!)).toBe(
            "space & one"
          )
        }
      )
    )
  })
})

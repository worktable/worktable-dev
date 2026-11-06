import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { ownerIdentity } from "./auth.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { clearFileTickets } from "./file-tickets.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { fileLinksRouter } from "./routes/file-links.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import type { TokenIdentity } from "./token-store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const testDir = join(tmpdir(), `worktable-html-links-${Date.now()}`)
const appDir = join(tmpdir(), `worktable-html-links-app-${Date.now()}`)
const page = (title: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><h1>${title}</h1>${"<p>row</p>".repeat(2000)}</body></html>`

const agent: TokenIdentity = {
  user: "owner",
  workspace: testDir,
  credentialClass: "resource",
  scopes: ["*"],
  agent: "claude-code",
  principal: { id: "agent:claude-code", type: "agent", displayName: "Claude Code", authorizedBy: "local:owner" },
}

type Result = Record<string, unknown>

describe("HTML Docs through file links", () => {
  let app: Hono

  const mcp = (operation: Parameters<typeof dispatchOperation>[0], args: Record<string, unknown>, surface: "preview" | "released" = "preview") =>
    dispatchOperation(operation, { spaceId: "meta", ...args }, {
      surface,
      identity: agent,
      principal: agent.principal,
      fileLinkOrigin: "http://localhost",
    }) as Promise<Result>
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: Error & { code?: string }) => error
    )
  const send = async (url: unknown, body: string) => {
    const res = await app.request(new URL(url as string).pathname, { method: "PUT", body })
    return { status: res.status, json: (await res.json()) as Result }
  }
  const read = () => mcp("html.read", { widgetId: "plan" }) as Promise<Result & { html: string; revision: string; downloadUrl: string }>

  beforeEach(async () => {
    setWorkspaceRootOverride(testDir)
    setAppDirOverride(appDir)
    ensureWorkspaceManifest()
    mkdirSync(join(testDir, "spaces"), { recursive: true })
    app = new Hono()
    app.use("*", async (c, next) => {
      c.set("identity", ownerIdentity())
      await next()
    })
    app.route("/api/spaces", spacesRouter)
    app.route("/api/file-links", fileLinksRouter)
    await app.request("/api/spaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Meta" }),
    })
  })

  afterEach(() => {
    clearFileTickets()
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    invalidateSearchIndex()
    rmSync(testDir, { recursive: true, force: true })
    rmSync(appDir, { recursive: true, force: true })
  })

  it("creates and replaces a page sent through a one-time link, on the revision that was read", async () => {
    const link = await mcp("html.create", { id: "plan", name: "Plan", lifetime: "durable", upload: true })
    expect(link).toMatchObject({ ok: true, method: "PUT" })
    expect(link.command).toContain(link.uploadUrl as string)

    const created = await send(link.uploadUrl, page("Q3"))
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ ok: true, htmlId: "plan" })
    const first = await read()
    expect(first.html).toBe(page("Q3"))
    expect(created.json.revision).toBe(first.revision)
    // A link works once.
    expect((await send(link.uploadUrl, page("again"))).status).toBe(410)

    // A replace names the revision it is based on, before any bytes move.
    expect((await failure(mcp("html.update", { widgetId: "plan", upload: true })))?.code).toBe("revision_required")
    const replace = await mcp("html.update", { widgetId: "plan", upload: true, expectedRevision: first.revision })
    expect(replace).toMatchObject({ ok: true, widgetId: "plan" })
    const replaced = await send(replace.uploadUrl, page("Q4"))
    expect(replaced.status).toBe(200)
    expect((await read()).html).toBe(page("Q4"))

    // A change made after the link was made wins: the upload is refused.
    const second = await read()
    const stale = await mcp("html.update", { widgetId: "plan", upload: true, expectedRevision: second.revision })
    await mcp("html.update", { widgetId: "plan", edits: [{ oldText: "<h1>Q4</h1>", newText: "<h1>Q4 final</h1>" }] })
    const refused = await send(stale.uploadUrl, page("overwrite"))
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe("REVISION_CHANGED")
    expect((await read()).html).toContain("<h1>Q4 final</h1>")
  })

  it("says the link is used up when the page it took is refused", async () => {
    const link = await mcp("html.create", { id: "plan", name: "Plan", lifetime: "durable", upload: true })
    const refused = await send(link.uploadUrl, '<!doctype html><html><head></head><body><script src="https://example.com/x.js"></script></body></html>')
    expect(refused.status).toBe(400)
    expect(refused.json.error).toContain("ask worktable_html_write for a new one")
    expect((await send(link.uploadUrl, page("Q3"))).status).toBe(410)
    expect(await failure(read())).not.toBeNull()
  })

  it("downloads the source at the revision a read gave, sandboxed so it never runs", async () => {
    await mcp("html.create", { id: "plan", name: "Plan", lifetime: "durable", html: page("Q3") })
    const { downloadUrl } = await read()
    const res = await app.request(new URL(downloadUrl).pathname)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(page("Q3"))
    expect(res.headers.get("content-security-policy")).toContain("sandbox")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")

    const { revision } = await read()
    await mcp("html.update", { widgetId: "plan", html: page("Q4"), expectedRevision: revision })
    expect((await app.request(new URL(downloadUrl).pathname)).status).toBe(409)
  })

  it("gives links on the released surface too", async () => {
    expect(await mcp("html.create", { id: "plan", name: "Plan", lifetime: "durable", upload: true }, "released")).toHaveProperty("uploadUrl")
    await mcp("html.create", { id: "notes", name: "Notes", lifetime: "durable", html: page("Q3") }, "released")
    expect((await mcp("html.read", { widgetId: "notes" }, "released")).downloadUrl).toBeDefined()
  })
})

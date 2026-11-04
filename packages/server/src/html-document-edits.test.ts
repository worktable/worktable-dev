import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { ownerIdentity } from "./auth.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { catalogTools, routeCatalogCall } from "./mcp/catalog.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { widgetsRouter } from "./routes/widgets.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import type { TokenIdentity } from "./token-store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const testDir = join(tmpdir(), `worktable-html-edits-${Date.now()}`)
const appDir = join(tmpdir(), `worktable-html-edits-app-${Date.now()}`)
// Generated pages are often one long line.
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Plan</title></head><body>${"<p>filler</p>".repeat(300)}<h1>Q3 Plan</h1><p class="status">Status: draft</p>${"<p>filler</p>".repeat(300)}</body></html>`

const agent: TokenIdentity = {
  user: "owner",
  workspace: testDir,
  credentialClass: "resource",
  scopes: ["*"],
  agent: "claude-code",
  principal: { id: "agent:claude-code", type: "agent", displayName: "Claude Code", authorizedBy: "local:owner" },
}

type Result = Record<string, unknown> & { revision?: string; html?: string }

describe("changing an HTML Doc", () => {
  let app: Hono
  let caller: TokenIdentity

  /** An MCP call as an agent on the given surface. */
  const mcp = (operation: Parameters<typeof dispatchOperation>[0], args: Record<string, unknown>, surface: "preview" | "released" = "preview") =>
    dispatchOperation(operation, { spaceId: "meta", ...args }, { surface, identity: agent, principal: agent.principal }) as Promise<Result>
  const read = () => mcp("html.read", { widgetId: "plan" })
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: Error & { code?: string; details?: Record<string, unknown> }) => error
    )

  async function req(method: string, path: string, body?: unknown) {
    const res = await app.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }))
    const text = await res.text()
    const json = (res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : null
    return { status: res.status, json, headers: res.headers }
  }

  beforeEach(async () => {
    setWorkspaceRootOverride(testDir)
    setAppDirOverride(appDir)
    ensureWorkspaceManifest()
    mkdirSync(join(testDir, "spaces"), { recursive: true })
    caller = ownerIdentity()
    app = new Hono()
    app.use("*", async (c, next) => {
      c.set("identity", caller)
      await next()
    })
    app.onError((err, c) => c.json({ error: err.message, code: "INTERNAL_ERROR" }, 500))
    app.route("/api/spaces", spacesRouter)
    app.route("/api/spaces/:spaceId/widgets", widgetsRouter)
    await req("POST", "/api/spaces", { name: "Meta" })
    await mcp("html.create", { id: "plan", name: "Plan", html: page, lifetime: "durable" })
  })

  afterEach(() => {
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    invalidateSearchIndex()
    rmSync(testDir, { recursive: true, force: true })
    rmSync(appDir, { recursive: true, force: true })
  })

  it("changes part of a page with edits, and never overwrites a change made since it was read", async () => {
    const first = await read()
    expect(first.revision).toMatch(/^html:sha256:/)

    const edited = await mcp("html.update", {
      widgetId: "plan",
      edits: [{ oldText: "Status: draft", newText: "Status: approved" }],
      expectedRevision: first.revision,
    })
    const second = await read()
    expect(second.html).toBe(page.replace("Status: draft", "Status: approved"))
    expect(edited.revision).toBe(second.revision!)

    // A write based on the first read is refused, edits or a whole page.
    const stale = await failure(mcp("html.update", {
      widgetId: "plan",
      edits: [{ oldText: "Q3 Plan", newText: "Q4 Plan" }],
      expectedRevision: first.revision,
    }))
    expect(stale?.code).toBe("revision_conflict")
    const unread = await failure(mcp("html.update", { widgetId: "plan", html: page }))
    expect(unread?.code).toBe("revision_required")
    expect((await read()).html).toBe(second.html!)

    await mcp("html.update", { widgetId: "plan", html: page, expectedRevision: second.revision })
    expect((await read()).html).toBe(page)
  })

  it("shows where an edit stops matching on a one-line page", async () => {
    const missed = await failure(mcp("html.update", {
      widgetId: "plan",
      edits: [{ oldText: '<p class="status">Status: final</p>', newText: "" }],
    }))
    expect(missed?.code).toBe("no_match")
    expect(missed?.message).toContain("line 1")
    expect(missed?.message).toContain("Status: draft")
    expect((await read()).html).toBe(page)
  })

  it("changes permissions without the page, and keeps whole-page writes where edits aren't offered", async () => {
    const write = catalogTools("preview").find((tool) => tool.name === "worktable_html_write")!
    const routed = routeCatalogCall(write, { spaceId: "meta", htmlId: "plan", permissions: { network: false, records: { tasks: { read: true } } } })
    expect(routed.operations.map((operation) => operation.id)).toEqual(["html.update"])
    // A description alone is a change of properties too; a name is a rename.
    expect(routeCatalogCall(write, { spaceId: "meta", htmlId: "plan", description: "Q3" }).operations[0]!.id).toBe("html.update")
    expect(routeCatalogCall(write, { spaceId: "meta", htmlId: "plan", name: "Plan v2" }).operations[0]!.id).toBe("html.rename")
    await mcp("html.update", routed.operations[0]!.args)
    expect((await mcp("html.read", { widgetId: "plan", includeHtml: false })).widget).toMatchObject({
      permissions: { records: { tasks: { read: true } } },
    })
    expect((await read()).html).toBe(page)

    // The released surface lists neither edits nor revisions.
    const released = catalogTools("released").find((tool) => tool.name === "worktable_html_write")!
    expect(Object.keys(released.inputSchema.shape)).not.toContain("edits")
    expect(await failure(mcp("html.update", { widgetId: "plan", edits: [{ oldText: "Q3", newText: "Q4" }] }, "released"))).not.toBeNull()
    await mcp("html.update", { widgetId: "plan", html: page.replace("Q3", "Q4") }, "released")
    expect((await mcp("html.read", { widgetId: "plan" }, "released")).html).toBe(page.replace("Q3", "Q4"))
  })

  it("finds text in HTML Docs with an excerpt to copy an edit from", async () => {
    const grep = (surface: "preview" | "released") =>
      mcp("docs.grep", { pattern: "Status: draft" }, surface) as Promise<{ matches: Array<Record<string, unknown>> }>
    const { matches } = await grep("preview")
    expect(matches).toHaveLength(1)
    const [match] = matches
    expect(match).toMatchObject({ docPath: "plan", type: "html", line: 1, revision: (await read()).revision })
    expect(match!.text).toContain('<p class="status">Status: draft</p>')
    expect((match!.text as string).length).toBeLessThan(600)
    expect(page.slice((match!.column as number) - 1).startsWith(match!.text as string)).toBe(true)
    expect((await grep("released")).matches).toHaveLength(0)

    // A regex match gets its excerpt too, around where it matched.
    const pattern = await mcp("docs.grep", { pattern: "Status: (draft|final)", regex: true }) as { matches: Array<Record<string, unknown>> }
    expect(pattern.matches[0]!.text).toContain("Status: draft")
    // HTML source needs the scope that reads HTML Docs.
    const docsOnly = await dispatchOperation("docs.grep", { pattern: "Status: draft" }, {
      surface: "preview",
      identity: agent,
      principal: agent.principal,
      scopes: ["docs:read"],
    }) as { matches: unknown[] }
    expect(docsOnly.matches).toHaveLength(0)
  })

  it("keeps the description over REST when a replace leaves it out", async () => {
    await mcp("html.update", { widgetId: "plan", description: "The plan for Q3" })
    const revision = (await read()).revision
    const saved = await req("PUT", "/api/spaces/meta/widgets/plan", { name: "Plan", html: page.replace("Q3", "Q4"), expectedRevision: revision })
    expect(saved.status).toBe(200)
    expect(saved.json.widget.description).toBe("The plan for Q3")
    expect(saved.json.revision).toBe((await read()).revision!)
  })
})

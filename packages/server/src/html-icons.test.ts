import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { renderPublicHtmlProjection } from "./public-share-renderer.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { widgetsRouter } from "./routes/widgets.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const SPACE = "meta"
const previousPreview = process.env["WORKTABLE_MCP_PREVIEW"]
let root = ""
let app: Hono

function preview(on: boolean): void {
  process.env["WORKTABLE_MCP_PREVIEW"] = on ? "1" : "0"
}

const page = (body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${body}</body></html>`

const BODY = [
  '<p><svg data-icon="circle-check" class="ok" width="20"></svg> Shipped</p>',
  // Former names and other spellings still answer.
  '<p><svg data-icon="AlertTriangle" aria-label="Blocked"/> Blocked</p>',
  // The page's own drawing, a name the library lacks, and script text stay.
  '<svg data-icon="mine"><circle cx="5" cy="5" r="3"/></svg>',
  '<svg data-icon="tick-mark"></svg>',
  "<script>const tag = '<svg data-icon=\"x\"></svg>'</script>",
].join("")

async function frame(path: string): Promise<string> {
  const response = await app.request(
    `/api/spaces/${SPACE}/widgets/${path}/content?theme=light`
  )
  expect(response.status).toBe(200)
  return response.text()
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "worktable-html-icons-"))
  setWorkspaceRootOverride(join(root, "workspace"))
  setAppDirOverride(join(root, "app"))
  mkdirSync(join(root, "workspace"), { recursive: true })
  ensureWorkspaceManifest()
  app = new Hono()
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity())
    await next()
  })
  app.route("/api/spaces", spacesRouter)
  app.route("/api/spaces/:spaceId/widgets", widgetsRouter)
  const created = await app.request("/api/spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Meta" }),
  })
  expect(created.status).toBe(201)
  preview(true)
})

afterEach(() => {
  if (previousPreview === undefined) delete process.env["WORKTABLE_MCP_PREVIEW"]
  else process.env["WORKTABLE_MCP_PREVIEW"] = previousPreview
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  rmSync(root, { recursive: true, force: true })
})

describe("Icons in HTML Docs", () => {
  it("draws the icons a page names when it is served, and warns about names the library lacks", async () => {
    const created = (await dispatchOperation("html.create", {
      spaceId: SPACE,
      id: "status",
      name: "Status",
      html: page(BODY),
    })) as { warnings: Array<{ code: string; message: string }> }
    const unknown = created.warnings.filter((warning) =>
      warning.code.startsWith("html_icon")
    )
    expect(unknown.map((warning) => warning.code)).toEqual([
      "html_icon_unknown",
    ])
    // Only the name the library lacks, with close ones to try.
    expect(unknown[0]!.message).toMatch(
      /stays empty: "tick-mark" \(try [a-z-]+(, [a-z-]+)*\)\.$/
    )

    const served = await frame("status")
    // The page's attributes stay; Worktable adds what's missing.
    expect(served).toContain(
      '<svg data-icon="circle-check" class="ok" width="20" viewBox="0 0 24 24" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg> Shipped'
    )
    expect(served).toMatch(
      /<svg data-icon="AlertTriangle" aria-label="Blocked" [^>]*role="img"><path d="m21\.73 18-8-14/
    )
    expect(served).toContain(
      '<svg data-icon="mine"><circle cx="5" cy="5" r="3"/></svg>'
    )
    expect(served).toContain('<svg data-icon="tick-mark"></svg>')
    expect(served).toContain("const tag = '<svg data-icon=\"x\"></svg>'")

    // The scriptless share view keeps the drawing through its sanitizer.
    const shared = renderPublicHtmlProjection(page(BODY))
    expect(shared).toMatch(
      /<svg data-icon="circle-check"[^>]*viewBox="0 0 24 24"[^>]*><circle cx="12" cy="12" r="10"><\/circle><path d="m9 12 2 2 4-4"><\/path><\/svg>/
    )

    // Off outside the preview: the page as written, and no warning.
    preview(false)
    expect(await frame("status")).toContain(
      '<svg data-icon="circle-check" class="ok" width="20"></svg>'
    )
    const off = (await dispatchOperation("html.update", {
      spaceId: SPACE,
      widgetId: "status",
      html: page(BODY),
    })) as { warnings: Array<{ code: string }> }
    expect(
      off.warnings.filter((warning) => warning.code.startsWith("html_icon"))
    ).toEqual([])
  })
})

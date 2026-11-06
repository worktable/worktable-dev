import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brotliDecompressSync } from "node:zlib"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import type { TokenIdentity } from "./token-store.ts"
import { ownerIdentity } from "./auth.ts"
import { usesAtOrBelow } from "./document-uses.ts"
import {
  moveRegisteredDocument,
  setRegisteredDocumentArchived,
} from "./document-write-service.ts"
import { compressApiResponse } from "./http-compression.ts"
import { invalidateLinkGraph } from "./link-graph.ts"
import { settleLinkRewrites } from "./link-rewrite.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { documentsRouter } from "./routes/documents.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { widgetsRouter } from "./routes/widgets.ts"
import { listWidgetVersions } from "./widget-version-store.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const SPACE = "meta"
const previousFiles = process.env["WORKTABLE_FILES"]
let root = ""
let app: Hono
let caller: TokenIdentity | null = null

/** An agent's token with these scopes. */
function token(scopes: string[]): TokenIdentity {
  return {
    user: "owner",
    workspace: root,
    credentialClass: "resource",
    scopes,
    agent: "claude-code",
    principal: { id: "agent:claude-code", type: "agent", displayName: "Claude Code", authorizedBy: "local:owner" },
  }
}

function buildApp(): Hono {
  const next = new Hono()
  next.use("*", async (c, proceed) => {
    c.set("identity", caller ?? ownerIdentity())
    await proceed()
  })
  next.use("/api/*", compressApiResponse)
  next.route("/api/spaces", spacesRouter)
  next.route("/api/spaces/:spaceId/widgets", widgetsRouter)
  next.route("/api/spaces/:spaceId/documents", documentsRouter)
  return next
}

async function call(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return app.request(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  })
}

/** Space images follow the file features. */
function files(on: boolean): void {
  process.env["WORKTABLE_FILES"] = on ? "1" : "0"
}

const docs = () => join(root, "workspace", "spaces", SPACE, "docs")

/** A file in the Space, written as another process would write it. */
function putFile(path: string, bytes: string | Buffer): void {
  const absolute = join(docs(), ...path.split("/"))
  mkdirSync(join(absolute, ".."), { recursive: true })
  writeFileSync(absolute, bytes)
  noteSpaceChanged(SPACE)
}

const base64 = (text: string) => Buffer.from(text).toString("base64")

const page = (body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${body}</body></html>`

async function createHtml(id: string, body: string): Promise<void> {
  const created = await call("POST", `/api/spaces/${SPACE}/widgets`, {
    id,
    name: id,
    html: page(body),
  })
  expect(created.status).toBe(201)
}

async function frame(path: string, rev?: string): Promise<string> {
  const response = await call(
    "GET",
    `/api/spaces/${SPACE}/widgets/${path}/content?theme=light${rev ? `&rev=${encodeURIComponent(rev)}` : ""}`
  )
  expect(response.status).toBe(200)
  return response.text()
}

async function pageRevision(path: string): Promise<string> {
  const response = await call(
    "GET",
    `/api/spaces/${SPACE}/documents/page?path=${encodeURIComponent(path)}`
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { page: { revision: string } }).page
    .revision
}

async function listedRevision(path: string): Promise<string | undefined> {
  const response = await call("GET", `/api/spaces/${SPACE}/documents`)
  const { documents } = (await response.json()) as {
    documents: Array<{ path: string; revision?: string }>
  }
  return documents.find((document) => document.path === path)?.revision
}

async function source(path: string): Promise<string> {
  return readFile(join(docs(), `${path}.html`), "utf8")
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "worktable-html-space-images-"))
  setWorkspaceRootOverride(join(root, "workspace"))
  setAppDirOverride(join(root, "app"))
  mkdirSync(join(root, "workspace"), { recursive: true })
  ensureWorkspaceManifest()
  caller = null
  app = buildApp()
  expect((await call("POST", "/api/spaces", { name: "Meta" })).status).toBe(
    201
  )
  invalidateLinkGraph()
  files(true)
})

afterEach(async () => {
  await settleLinkRewrites()
  if (previousFiles === undefined) delete process.env["WORKTABLE_FILES"]
  else process.env["WORKTABLE_FILES"] = previousFiles
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  rmSync(root, { recursive: true, force: true })
})

describe("Space images in HTML Docs", () => {
  it("places only the images a page names literally in its frame", async () => {
    putFile("report/img/chart.png", "chart bytes")
    putFile("report/img/secret.png", "secret bytes")
    await createHtml(
      "report/summary",
      [
        '<img src="img/chart.png" alt="Chart">',
        "<img src='/report/img/chart.png'>",
        '<img src="img/missing.png" alt="Missing">',
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
        `<script>const later = '<img src="img/secret.png">'</script>`,
      ].join("")
    )

    const html = await frame("report/summary")
    // Relative to the Doc's folder and from the Space root alike.
    expect(html.split(base64("chart bytes")).length - 1).toBe(2)
    expect(html).toContain('data-worktable-src="img/chart.png"')
    expect(html).toContain('data-worktable-src="/report/img/chart.png"')
    // A missing image keeps its path and shows broken, as before.
    expect(html).toContain('src="img/missing.png"')
    // Script text and data URLs are left alone; nothing else is reachable.
    expect(html).toContain(`'<img src="img/secret.png">'`)
    expect(html).not.toContain(base64("secret bytes"))
    expect(html).toContain("R0lGODlhAQABAAAAACw=")

    // A token needs the scope that reads files, not only the HTML Doc's.
    caller = token(["widgets:read"])
    expect(await frame("report/summary")).not.toContain(base64("chart bytes"))
    caller = token(["widgets:read", "documents:read"])
    expect(await frame("report/summary")).toContain(base64("chart bytes"))
    caller = null

    // Off, the frame is what it always was.
    files(false)
    expect(await frame("report/summary")).not.toContain(base64("chart bytes"))
  })

  it("gives a page a new frame revision when an image it names changes, in its rows too", async () => {
    putFile("gallery/one.png", "first version")
    await createHtml("gallery", '<img src="gallery/one.png" alt="One">')
    files(false)
    const off = await pageRevision("gallery")
    files(true)
    const first = await pageRevision("gallery")
    expect(first).not.toBe(off)
    // Rows name the frame the page check names, so it loads once.
    expect(await listedRevision("gallery")).toBe(first)

    // The frame at its current revision is kept by the browser, compressed.
    const response = await app.request(
      `/api/spaces/${SPACE}/widgets/gallery/content?theme=dark&rev=${encodeURIComponent(first)}`,
      { headers: { "Accept-Encoding": "br" } }
    )
    expect(response.headers.get("Content-Encoding")).toBe("br")
    expect(response.headers.get("Cache-Control")).toContain("immutable")
    expect(response.headers.get("Vary")).toContain("Accept-Encoding")
    expect(
      brotliDecompressSync(Buffer.from(await response.arrayBuffer())).toString()
    ).toContain(base64("first version"))

    putFile("gallery/one.png", "second version, longer")
    const second = await pageRevision("gallery")
    expect(second).not.toBe(first)
    expect(await listedRevision("gallery")).toBe(second)
    expect(await frame("gallery", second)).toContain(
      base64("second version, longer")
    )

    // Archived, it leaves the page; the revision says so.
    await setRegisteredDocumentArchived({
      spaceId: SPACE,
      path: "gallery/one.png",
      archived: true,
      archivedBy: "test",
    })
    const archived = await pageRevision("gallery")
    expect(archived).not.toBe(second)
    expect(await frame("gallery", archived)).not.toContain(
      base64("second version, longer")
    )

    // Off, an image's changes leave the revision as it always was.
    files(false)
    const offAgain = await pageRevision("gallery")
    putFile("gallery/one.png", "third")
    expect(await pageRevision("gallery")).toBe(offAgain)
  })

  it("shows a page's images only when its writer could read the Space's files", async () => {
    putFile("report/img/chart.png", "chart bytes")
    const body = '<img src="img/chart.png" alt="Chart"><script>worktable.state.set({ copy: document.images[0].src })</script>'
    // An agent that can write HTML Docs but not read files: nothing to copy.
    const written = await dispatchOperation(
      "html.create",
      { spaceId: SPACE, id: "report/summary", name: "Summary", html: page(body), lifetime: "durable" },
      { scopes: ["widgets:write", "widgets:read"], identity: token(["widgets:write", "widgets:read"]), principal: token([]).principal }
    ) as { warnings: Array<{ code: string }> }
    expect(written.warnings.map((warning) => warning.code)).toContain("space_images_need_file_access")
    // Not even for a person who opens it.
    expect(await frame("report/summary")).not.toContain(base64("chart bytes"))
    const before = await pageRevision("report/summary")
    // Once a person saves it, its images show, in a new frame revision.
    const raw = await call("GET", `/api/spaces/${SPACE}/widgets/report/summary/content?format=raw`)
    const saved = await call("PUT", `/api/spaces/${SPACE}/widgets/report/summary`, {
      name: "Summary",
      html: page(body),
      expectedRevision: raw.headers.get("etag")?.replaceAll('"', ""),
    })
    expect(saved.status).toBe(200)
    expect(await frame("report/summary")).toContain(base64("chart bytes"))
    expect(await pageRevision("report/summary")).not.toBe(before)
  })

  it("warns an agent's write about images that will show broken", async () => {
    putFile("deck/ok.png", "small")
    putFile("deck/huge.png", Buffer.alloc(2.5 * 1024 * 1024, 1))
    for (const name of ["a", "b", "c"]) {
      putFile(`deck/${name}.png`, Buffer.alloc(1.5 * 1024 * 1024, 2))
    }
    const html = page(
      [
        "ok.png",
        "nowhere.png",
        "logo.svg",
        "huge.png",
        "a.png",
        "b.png",
        "c.png",
      ]
        .map((name) => `<img src="${name}" alt="">`)
        .join("")
    )
    const codes = async (result: unknown) =>
      (result as { warnings: Array<{ code: string; message: string }> })
        .warnings
        .filter((warning) => warning.code.startsWith("space_image"))
        .map((warning) => [warning.code, warning.message])
    const created = await dispatchOperation("html.create", {
      spaceId: SPACE,
      id: "deck/slides",
      name: "Slides",
      html,
    })
    expect(await codes(created)).toEqual([
      [
        "space_image_missing",
        "Not a file in this Space, so it shows as a broken image: nowhere.png.",
      ],
      [
        "space_image_unsupported",
        "Not an image type HTML Docs show from the Space: logo.svg.",
      ],
      [
        "space_image_too_large",
        "Larger than 2 MiB, so it shows as a broken image: huge.png (2.5 MiB).",
      ],
      [
        "space_images_over_budget",
        "The page's images pass 4 MiB together, so these show as broken images: c.png.",
      ],
    ])
    // The revision each replace names.
    const revision = async () =>
      ((await dispatchOperation("html.read", { spaceId: SPACE, widgetId: "deck/slides", includeHtml: false })) as { revision: string }).revision
    const updated = await dispatchOperation("html.update", {
      spaceId: SPACE,
      widgetId: "deck/slides",
      html: page('<img src="ok.png" alt="">'),
      expectedRevision: await revision(),
    })
    expect(await codes(updated)).toEqual([])
    // Without file read access, one notice, which names no file: the
    // warnings would otherwise say which files exist.
    const unread = await dispatchOperation(
      "html.update",
      { spaceId: SPACE, widgetId: "deck/slides", html, expectedRevision: await revision() },
      { scopes: ["widgets:write", "widgets:read"] }
    )
    expect((await codes(unread)).map(([code]) => code)).toEqual(["space_images_need_file_access"])

    files(false)
    const off = await dispatchOperation("html.update", {
      spaceId: SPACE,
      widgetId: "deck/slides",
      html: page('<img src="gone.png" alt="">'),
      expectedRevision: await revision(),
    })
    expect(await codes(off)).toEqual([])
  })

  it("finds an image under a path it had before it moved, and caps what a page names", async () => {
    putFile("brand/logo.png", "logo")
    await moveRegisteredDocument({ spaceId: SPACE, path: "brand/logo.png", to: "assets/logo.png" })
    await settleLinkRewrites()
    // Written after the move with the old path, as a page the rewrite missed.
    await createHtml("site/home", '<img src="../brand/logo.png" alt="Logo">')
    expect(await frame("site/home")).toContain(base64("logo"))

    const many = Array.from({ length: 300 }, (_, i) => `<img src="img/missing-${i}.png" alt="">`).join("")
    const written = (await dispatchOperation("html.create", {
      spaceId: SPACE,
      id: "site/gallery",
      name: "Gallery",
      html: page(many),
    })) as { warnings: Array<{ code: string }> }
    expect(written.warnings.map((warning) => warning.code)).toContain("space_images_too_many")
    // One image repeated past the cap on img elements says so too.
    const repeated = (await dispatchOperation("html.create", {
      spaceId: SPACE,
      id: "site/wall",
      name: "Wall",
      html: page('<img src="/assets/logo.png" alt="">'.repeat(5000)),
    })) as { warnings: Array<{ code: string }> }
    expect(repeated.warnings.map((warning) => warning.code)).toContain("space_images_too_many")
    expect((await frame("site/wall")).split(base64("logo")).length - 1).toBe(4096)
  })

  it("drops its Space images once its source changes outside Worktable", async () => {
    putFile("report/img/chart.png", "chart bytes")
    await createHtml("report/summary", '<img src="img/chart.png" alt="Chart">')
    expect(await frame("report/summary")).toContain(base64("chart bytes"))
    writeFileSync(
      join(docs(), "report", "summary.html"),
      page('<img src="img/chart.png" alt="Chart"><p>Edited on disk</p>')
    )
    noteSpaceChanged(SPACE)
    const edited = await frame("report/summary")
    expect(edited).toContain("Edited on disk")
    expect(edited).not.toContain(base64("chart bytes"))
  })

  it("counts an HTML Doc's images as uses, and keeps them true when they move", async () => {
    putFile("brand/logo.png", "logo")
    await createHtml(
      "site/home",
      '<img src="../brand/logo.png" alt="Logo"><img src="/brand/logo.png" alt="">'
    )
    const uses = await usesAtOrBelow(SPACE, "brand")
    expect(
      uses.find((use) => use.path === "brand/logo.png")?.usedBy
    ).toEqual(["site/home"])

    const versions = (await listWidgetVersions(SPACE, "site/home")).length
    await moveRegisteredDocument({
      spaceId: SPACE,
      path: "brand/logo.png",
      to: "assets/logo.png",
    })
    await settleLinkRewrites()
    expect(await source("site/home")).toContain(
      '<img src="../assets/logo.png" alt="Logo"><img src="/assets/logo.png" alt="">'
    )
    expect((await listWidgetVersions(SPACE, "site/home")).length).toBe(
      versions + 1
    )
    expect(await frame("site/home")).toContain(base64("logo"))

    // The HTML Doc moving alone keeps its relative image true.
    await moveRegisteredDocument({
      spaceId: SPACE,
      path: "site/home",
      to: "site/old/home",
    })
    expect(await source("site/old/home")).toContain(
      '<img src="../../assets/logo.png" alt="Logo">'
    )
  }, 30_000)
})

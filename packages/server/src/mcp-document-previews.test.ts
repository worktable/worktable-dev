import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
import { OpenFileRevision } from "./file-revision.ts"
import { MAX_DOCUMENT_PREVIEW_PIXELS } from "@worktable/types"
import type { McpSurface } from "./mcp/surface.ts"
import { withSyntheticPreview } from "./test-support/synthetic-preview.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"
import sharp from "sharp"
import { Hono } from "hono"
import type { HomeFeed } from "@worktable/types"
import { ownerIdentity } from "./auth.ts"
import { documentsRouter } from "./routes/documents.ts"
import { homeRouter } from "./routes/home.ts"

let root: string
let previousRelease: string | undefined
const clients: Client[] = []
async function connect(
  scopes = ["documents:read", "widgets:read", "widgets:write"],
  surface: McpSurface = "released"
) {
  const server = createWorktableMcpServer({
    version: "test",
    scopes,
    surface,
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
    lifetime: "durable",
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

  const read = await call(client, "worktable_html_read", { action: "read", htmlId: "dashboard", includeHtml: false })
  const second = await call(client, "worktable_html_write", {
    action: "update",
    htmlId: "dashboard",
    html: "<!doctype html><html><body><h1>Second</h1></body></html>",
    expectedRevision: (read.structuredContent as { revision: string }).revision,
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
    lifetime: "durable",
    id: "private",
    name: "Private",
    html: "<html><body>Secret</body></html>",
    preview: {},
  })
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied)).toContain("needs Read workspace access")
  const allowed = await call(client, "worktable_html_write", {
    action: "create",
    lifetime: "durable",
    id: "private",
    name: "Private",
    html: "<html><body>Secret</body></html>",
  })
  expect(allowed.isError).not.toBe(true)
  expect((allowed.structuredContent as any).preview).toBeUndefined()
})

/** A PDF of one text line per page, in a standard font it doesn't embed. */
function pdfOf(pages: string[], encrypted = false): Uint8Array {
  const objects: string[] = [
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  for (const [index, text] of pages.entries()) {
    const stream = `BT /F1 48 Tf 72 700 Td (${text}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    )
  }
  if (encrypted)
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /O <${"11".repeat(32)}> /U <${"22".repeat(32)}> /P -44 >>`
    )
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  for (let number = 1; number < objects.length; number += 1) {
    offsets.push(out.length)
    out += `${number} 0 obj\n${objects[number]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  out += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R${
    encrypted
      ? ` /Encrypt ${objects.length - 1} 0 R /ID [<${"ab".repeat(16)}> <${"ab".repeat(16)}>]`
      : ""
  } >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

it("shows agents a PDF's page and an image scaled down, on the preview surface, and says why a file has no preview", async () => {
  const docs = join(root, "workspace", "spaces", "preview", "docs", "files")
  await mkdir(docs, { recursive: true })
  await writeFile(join(docs, "report.pdf"), pdfOf(["First page", "Second page"]))
  await writeFile(join(docs, "locked.pdf"), pdfOf(["Secret"], true))
  await writeFile(join(docs, "broken.pdf"), "%PDF-1.4\nnot a pdf at all\n")
  await writeFile(
    join(docs, "photo.png"),
    await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer()
  )
  // A few hundred bytes that declare a picture past the limits.
  await writeFile(
    join(docs, "wide.png"),
    await sharp({
      create: { width: 9000, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer()
  )
  await writeFile(
    join(docs, "shot.avif"),
    await sharp({
      create: { width: 640, height: 400, channels: 3, background: { r: 40, g: 120, b: 200 } },
    })
      .avif()
      .toBuffer()
  )
  await writeFile(
    join(docs, "tall.png"),
    await sharp({
      create: { width: 1000, height: 8000, channels: 3, background: { r: 30, g: 30, b: 30 } },
    })
      .png()
      .toBuffer()
  )
  await writeFile(join(docs, "bundle.zip"), new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]))
  noteSpaceChanged("preview")

  const client = await connect(["documents:read"], "preview")
  const render = (args: Record<string, unknown>) =>
    withSyntheticPreview(() =>
      client.callTool({
        name: "worktable_files_render",
        arguments: { spaceId: "preview", ...args },
      })
    )
  const picture = async (result: Awaited<ReturnType<typeof render>>) => {
    const block = (
      result.content as Array<{ type: string; mimeType?: string; data?: string }>
    ).find((item) => item.type === "image")
    expect(block?.mimeType).toBe("image/png")
    return sharp(Buffer.from(block!.data!, "base64")).metadata()
  }
  const preview = (result: Awaited<ReturnType<typeof render>>) => {
    expect(result.isError).not.toBe(true)
    return (result.structuredContent as { preview: Record<string, unknown> }).preview
  }

  // A page of a PDF, at the width asked for, with how many pages it has.
  const first = await render({ path: "files/report.pdf", preview: { width: 612 } })
  expect(preview(first)).toMatchObject({
    status: "ready",
    mimeType: "image/png",
    width: 612,
    height: 792,
    page: 1,
    pageCount: 2,
  })
  expect(await picture(first)).toMatchObject({ format: "png", width: 612, height: 792 })
  // Its text is drawn: the page isn't blank, though it embeds no font.
  const firstBlock = (first.content as Array<{ type: string; data?: string }>).find(
    (item) => item.type === "image"
  )!
  const { channels } = await sharp(Buffer.from(firstBlock.data!, "base64")).stats()
  expect(channels[0]!.min).toBeLessThan(80)
  const second = await render({ path: "files/report.pdf", page: 2, preview: { width: 612 } })
  expect(preview(second)).toMatchObject({ status: "ready", page: 2, pageCount: 2 })
  expect(preview(second)["contentHash"]).not.toBe(preview(first)["contentHash"])
  // A picture is of one revision: the one the file is at.
  const revision = (first.structuredContent as { sourceRevision: string }).sourceRevision
  expect(preview(second)["sourceRevision"]).toBe(revision)
  const stale = await render({ path: "files/report.pdf", expectedRevision: "rev_other" })
  expect(stale.isError).toBe(true)
  expect(JSON.stringify(stale.content)).toContain("REVISION_CONFLICT")

  // A page it doesn't have, a password, damage and a type with no picture
  // each say so, and none is an error: the file still reads and downloads.
  expect(preview(await render({ path: "files/report.pdf", page: 3 }))).toMatchObject({
    status: "unavailable",
    pageCount: 2,
  })
  expect(preview(await render({ path: "files/locked.pdf" }))).toMatchObject({
    status: "unavailable",
    error: expect.stringContaining("password"),
  })
  expect(preview(await render({ path: "files/broken.pdf" }))["status"]).toBe("unavailable")
  expect(preview(await render({ path: "files/bundle.zip" }))).toMatchObject({
    status: "unavailable",
    error: "No preview for this file type.",
  })

  // An image comes scaled to the width asked for, never larger than it is.
  const small = await render({ path: "files/photo.png", preview: { width: 500 } })
  expect(preview(small)).toMatchObject({ status: "ready", width: 500, height: 250 })
  expect(await picture(small)).toMatchObject({ width: 500, height: 250 })
  expect(
    preview(await render({ path: "files/photo.png", preview: { width: 2048 } }))
  ).toMatchObject({ width: 2000, height: 1000 })
  // An AVIF is drawn too; its declared size comes from its header alone.
  expect(
    preview(await render({ path: "files/shot.avif", preview: { width: 320 } }))
  ).toMatchObject({ status: "ready", width: 320, height: 200 })
  // A tall one is drawn smaller than asked, to stay within a picture's
  // pixel limit, and says so.
  const tall = preview(await render({ path: "files/tall.png" }))
  expect(tall).toMatchObject({ status: "ready", warnings: [expect.stringContaining("limit")] })
  expect((tall["width"] as number) * (tall["height"] as number)).toBeLessThanOrEqual(
    MAX_DOCUMENT_PREVIEW_PIXELS
  )
  expect((tall["height"] as number) / (tall["width"] as number)).toBeCloseTo(8, 1)
  // One whose header declares a size past the limits is never decoded.
  expect(preview(await render({ path: "files/wide.png" }))).toMatchObject({
    status: "unavailable",
    error: expect.stringContaining("too large"),
  })

  // A file that changes while its page is drawn fails the preview: the
  // picture never mixes two revisions.
  const readPiece = OpenFileRevision.prototype.read
  let reads = 0
  const changing = spyOn(OpenFileRevision.prototype, "read").mockImplementation(
    async function (this: OpenFileRevision, position: number, length: number) {
      reads += 1
      // The first read names the file's revision; the next is the page's.
      if (reads === 2)
        await writeFile(join(docs, "report.pdf"), pdfOf(["Changed", "Changed", "Changed"]))
      return readPiece.call(this, position, length)
    }
  )
  try {
    expect(preview(await render({ path: "files/report.pdf" }))).toMatchObject({
      status: "failed",
      error: expect.stringContaining("changed"),
    })
  } finally {
    changing.mockRestore()
  }

  // The released surface lists no page, and has no picture of a plain file.
  const released = await connect(["documents:read"])
  const listed = async (connected: typeof client) =>
    Object.keys(
      (await connected.listTools()).tools.find(
        (tool) => tool.name === "worktable_files_render"
      )!.inputSchema.properties as Record<string, unknown>
    )
  expect(await listed(client)).toContain("page")
  expect(await listed(released)).not.toContain("page")
  const before = await withSyntheticPreview(() =>
    released.callTool({
      name: "worktable_files_render",
      arguments: { spaceId: "preview", path: "files/photo.png" },
    })
  )
  expect(preview(before)).toMatchObject({
    status: "unavailable",
    error: "Visual previews are not available for worktable.file.",
  })
}, 120_000)

it("shows a pinned PDF, image and drawing as a picture of its version, and a Doc as its icon", async () => {
  const docs = join(root, "workspace", "spaces", "preview", "docs")
  await mkdir(join(docs, "files"), { recursive: true })
  await writeFile(join(docs, "files", "report.pdf"), pdfOf(["Quarterly"]))
  await writeFile(
    join(docs, "files", "shot.png"),
    await sharp({
      create: { width: 1600, height: 1000, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer()
  )
  await writeFile(join(docs, "files", "notes.zip"), new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]))
  noteSpaceChanged("preview")
  const client = await connect(["documents:read", "documents:write"])
  const drawn = await withSyntheticPreview(() =>
    client.callTool({
      name: "worktable_drawings_write",
      arguments: {
        request: {
          spaceId: "preview",
          path: "flow",
          action: "create",
          lifetime: "durable",
          title: "Flow",
          requestId: "flow",
          operations: [
            { op: "add", ref: "a", object: { type: "rectangle", text: "Start", x: 0, y: 0 } },
          ],
        },
      },
    })
  )
  expect(drawn.isError).not.toBe(true)
  await writeFile(join(docs, "plan.md"), "# Plan\n")
  noteSpaceChanged("preview")

  const server = new Hono()
  server.use("*", async (c, next) => {
    c.set("identity", ownerIdentity())
    return next()
  })
  server.route("/api/spaces/:spaceId/documents", documentsRouter)
  server.route("/api/home", homeRouter)
  const get = (path: string) =>
    withSyntheticPreview(async () => server.fetch(new Request(`http://localhost${path}`)))
  const pinned = ["files/report.pdf", "files/shot.png", "flow", "plan", "files/notes.zip"]
  const saved = await server.fetch(
    new Request("http://localhost/api/home/pins", {
      method: "PUT",
      body: JSON.stringify({ pins: pinned.map((path) => ({ spaceId: "preview", path })) }),
      headers: { "Content-Type": "application/json" },
    })
  )
  expect(saved.status).toBeLessThan(300)
  const home = (await (await server.fetch(new Request("http://localhost/api/home"))).json()) as HomeFeed
  const version = (path: string) => home.pins!.find((pin) => pin.path === path)!.picture

  // A PDF, an image and a drawing name the version their picture is of; a
  // Doc and a file with no picture don't, and keep their icon.
  for (const path of ["files/report.pdf", "files/shot.png", "flow"])
    expect(version(path), path).toEqual(expect.any(String))
  expect(version("plan")).toBeUndefined()
  expect(version("files/notes.zip")).toBeUndefined()

  const picture = (path: string, v: string, theme = "light") =>
    get(
      `/api/spaces/preview/documents/picture?path=${encodeURIComponent(path)}&v=${encodeURIComponent(v)}&theme=${theme}`
    )
  for (const path of ["files/report.pdf", "files/shot.png"]) {
    const response = await picture(path, version(path)!)
    expect(response.status, path).toBe(200)
    // Kept for good: the address names the version.
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
    // Kept for this signed-in reader only.
    expect(response.headers.get("vary")).toBe("Cookie, Authorization")
    expect(response.headers.get("content-type")).toBe("image/webp")
    const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
    expect(meta).toMatchObject({ format: "webp", width: 480 })
  }
  const drawing = await picture("flow", version("flow")!, "dark")
  expect(drawing.status).toBe(200)
  expect(drawing.headers.get("content-type")).toBe("image/png")

  // A version the file is no longer at has no picture, so a picture
  // never shows another version's content under its address.
  const old = version("files/shot.png")!
  await writeFile(
    join(docs, "files", "shot.png"),
    await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 0, g: 0, b: 200 } },
    })
      .png()
      .toBuffer()
  )
  noteSpaceChanged("preview")
  expect((await picture("files/shot.png", old)).status).toBe(404)
  // A drawing changed on disk is at a new version too.
  const drawingFile = join(docs, "flow.quickdraw")
  await writeFile(drawingFile, `${await Bun.file(drawingFile).text()}\n`)
  noteSpaceChanged("preview")
  expect((await picture("flow", version("flow")!)).status).toBe(404)
  // Nor do a Doc, or a file of a type that has no picture.
  expect((await picture("plan", "x")).status).toBe(404)
  expect((await picture("files/notes.zip", "x")).status).toBe(404)
}, 120_000)

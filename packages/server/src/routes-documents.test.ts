import { writeManagedFixtureHtml as writeWidget } from "./fixtures/managed-content.ts"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
  spyOn,
} from "bun:test"
import {
  access,
  mkdir,
  readdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { FILE_UPLOAD_MAX_BYTES } from "./file-uploads.ts"
import { removeLeftoverStagedFiles, stagingDirectory } from "./staged-file.ts"
import { FOLDER_OPERATION_MAX_ENTRIES } from "./folder-operation-limit.ts"
import { join } from "node:path"
import { Hono } from "hono"
import {
  DOCUMENT_ARCHIVE_REASON_MAX_LENGTH,
  type SpaceFile,
  type WidgetFile,
} from "@worktable/types"
import { setLinkedSharing } from "./linked-sharing.ts"
import { ownerIdentity } from "./auth.ts"
import { createAnnotation } from "./annotation-store.ts"
import { HOSTED_BROWSER_RUNTIME_SCOPES } from "./hosted-auth.ts"
import { documentsRouter } from "./routes/documents.ts"
import { docsRouter } from "./routes/docs.ts"
import { FILE_READ_CHUNK_BYTES, OpenFileRevision } from "./file-revision.ts"
import { FILE_VERSION_MAX_BYTES } from "./file-limits.ts"
import { renameDocAndSync } from "./doc-rename.ts"
import { recordDocAlias, resolveDocAlias } from "./doc-aliases.ts"
import { deleteHtmlDocument } from "./html-document-delete.ts"
import { moveHtmlDocument } from "./html-document-move.ts"
import { getSpaceLinkGraph } from "./link-graph.ts"
import {
  createRegisteredDocument,
  readRegisteredDocumentSource,
  recordExternalFileChanges,
  replaceRegisteredDocument,
} from "./document-write-service.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts"
import {
  getDocArchiveInfo,
  listDocsDetailed,
  readDoc,
  readSpace,
  setDocArchived,
  writeDoc,
  writeSpace,
} from "./store.ts"
import { readWidget, setWidgetArchived} from "./widget-store.ts"
import { yjsManager } from "./yjs-manager.ts"
import { WsManager } from "./ws.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const spaceId = "document-route"
let root = ""

function space(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Documents",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

function htmlDocument(): WidgetFile {
  const now = new Date().toISOString()
  return {
    version: 1,
    kind: "worktable.widget",
    id: "boards/status",
    name: "Status",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    metadata: {},
    runtime: { type: "html", entry: "index.html" },
    permissions: {
      network: false,
      records: {},
      state: { read: true, write: true },
    },
  }
}

async function writeCoreMarkdownBundle(path = "bundled"): Promise<void> {
  const relativePath = `docs/${path}.wtdoc`
  const bundle = join(root, "spaces", spaceId, relativePath)
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, "content.md"), "# Bundled")
  const bundleId = mintDocumentId()
  await writeFile(
    join(bundle, "manifest.json"),
    JSON.stringify({
      type: "worktable.document-bundle",
      version: 1,
      documentId: bundleId,
      format: { id: "worktable.markdown", sourceVersion: 1 },
      content: "content.md",
    })
  )
  await updateDocumentInventory(spaceId, {
    upsert: [
      {
        documentId: bundleId,
        path,
        format: { id: "worktable.markdown", sourceVersion: 1 },
        source: {
          kind: "bundle",
          relativePath,
          manifestPath: `${relativePath}/manifest.json`,
        },
      },
    ],
  })
}

function app() {
  const instance = new Hono()
  instance.use("*", async (c, next) => {
    const scopes = c.req.header("x-test-scopes")?.split(",") ?? ["*"]
    c.set("identity", { ...ownerIdentity(), scopes })
    return next()
  })
  instance.route("/api/spaces/:spaceId/documents", documentsRouter)
  instance.route("/api/spaces/:spaceId/docs", docsRouter)
  return instance
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-document-route-"))
  setWorkspaceRootOverride(root)
  await ensureWorkspaceManifest()
  await writeSpace(space())
  await writeDoc(spaceId, "notes/readme", "# Readme", {
    updatedBy: "test",
    source: "rest-api",
  })
  const written = await writeWidget(spaceId, htmlDocument(), "<h1>Status</h1>")
  written.release?.()
  const nested = await writeWidget(
    spaceId,
    { ...htmlDocument(), id: "notes/status", name: "Notes status" },
    "<h1>Notes status</h1>"
  )
  nested.release?.()
  await setWidgetArchived(spaceId, "boards/status", true, "test")
  await writeDoc(spaceId, "notes/old", "# Old note", {
    updatedBy: "test",
    source: "rest-api",
  })
  await setDocArchived(spaceId, "notes/old", true, "test")
})

afterEach(async () => {
  setSystemTime()
  setLinkedSharing(null)
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("format-neutral document route", () => {
  it("lists the common namespace only for documents:read and honors archived inclusion", async () => {
    const instance = app()
    for (const [scopes, status] of [
      [undefined, 200],
      ["documents:read", 200],
      [HOSTED_BROWSER_RUNTIME_SCOPES.join(","), 200],
      ["docs:read", 403],
      ["widgets:read", 403],
    ] as const) {
      const response = await instance.request(
        `/api/spaces/${spaceId}/documents`,
        scopes ? { headers: { "x-test-scopes": scopes } } : undefined
      )
      expect(response.status).toBe(status)
    }

    const active = await instance.request(`/api/spaces/${spaceId}/documents`, {
      headers: { "x-test-scopes": "documents:read" },
    })
    expect((await active.json()).documents).toEqual([
      expect.objectContaining({
        kind: "document",
        path: "notes/readme",
        format: expect.objectContaining({ id: "worktable.markdown" }),
        folderOperations: { move: true, archive: true, delete: true },
      }),
      expect.objectContaining({
        kind: "document",
        path: "notes/status",
        format: expect.objectContaining({ id: "worktable.html" }),
        folderOperations: { move: true, archive: true, delete: true },
      }),
    ])

    const includingArchived = await instance.request(
      `/api/spaces/${spaceId}/documents?includeArchived=true`,
      { headers: { "x-test-scopes": "documents:read" } }
    )
    const body = (await includingArchived.json()) as {
      documents: Array<Record<string, unknown>>
    }
    expect(
      body.documents.map((document) => ({
        path: document["path"],
        format: (document["format"] as { id: string }).id,
        archived: document["archived"],
      }))
    ).toEqual([
      {
        path: "boards/status",
        format: "worktable.html",
        archived: true,
      },
      {
        path: "notes/old",
        format: "worktable.markdown",
        archived: true,
      },
      {
        path: "notes/readme",
        format: "worktable.markdown",
        archived: undefined,
      },
      {
        path: "notes/status",
        format: "worktable.html",
        archived: undefined,
      },
    ])
    expect(JSON.stringify(body)).not.toMatch(/documentId|relativePath/)

    await writeCoreMarkdownBundle()
    const withCoreBundle = await instance.request(
      `/api/spaces/${spaceId}/documents`,
      { headers: { "x-test-scopes": "documents:read" } }
    )
    expect((await withCoreBundle.json()).documents).toContainEqual(
      expect.objectContaining({
        kind: "document",
        path: "bundled",
        health: "supported",
        format: expect.objectContaining({ id: "worktable.markdown" }),
        folderOperations: { move: false, archive: false, delete: false },
      })
    )
  })

  it("serves exact documents through aliases and enforces capability boundaries", async () => {
    const instance = app()
    const resolve = (path: string, scopes = "documents:read") =>
      instance.request(
        `/api/spaces/${spaceId}/documents/resolve?path=${encodeURIComponent(path)}`,
        { headers: { "x-test-scopes": scopes } }
      )

    expect((await resolve("notes/readme", "docs:read")).status).toBe(403)

    const markdown = await resolve("notes/readme")
    expect(markdown.status).toBe(200)
    expect(await markdown.json()).toEqual({
      target: { path: "notes/readme", view: "doc" },
    })

    const html = await resolve("notes/status")
    expect(html.status).toBe(200)
    expect(await html.json()).toEqual({
      target: { path: "notes/status", view: "html" },
    })

    const markdownPage = await instance.request(
      `/api/spaces/${spaceId}/documents/page?path=${encodeURIComponent(
        "notes/readme"
      )}`,
      { headers: { "x-test-scopes": "documents:read" } }
    )
    expect(markdownPage.status).toBe(200)
    expect(await markdownPage.json()).toMatchObject({
      page: {
        kind: "document",
        document: { path: "notes/readme" },
        renderer: {
          key: "doc",
          disposition: "trusted-component",
        },
        capabilities: {
          rawSource: false,
          versions: true,
          annotations: false,
          sharing: false,
        },
      },
    })

    const htmlPage = await instance.request(
      `/api/spaces/${spaceId}/documents/page?path=${encodeURIComponent(
        "notes/status"
      )}`,
      { headers: { "x-test-scopes": "documents:read" } }
    )
    expect(htmlPage.status).toBe(200)
    expect(await htmlPage.json()).toMatchObject({
      page: {
        kind: "document",
        document: { path: "notes/status" },
        renderer: { key: "html", disposition: "opaque-sandbox" },
        capabilities: {
          rawSource: false,
          versions: true,
          annotations: false,
          sharing: false,
        },
      },
    })

    setLinkedSharing({
      workspaceId: "d-test",
      shareOrigin: "https://share.worktable.cloud",
      htmlShareOrigin: "https://html.worktable.cloud",
    })
    for (const path of ["notes/readme", "notes/status"]) {
      for (const [scopes, sharing] of [
        ["*", true],
        ["documents:read", false],
      ] as const) {
        const response = await instance.request(
          `/api/spaces/${spaceId}/documents/page?path=${encodeURIComponent(path)}`,
          { headers: { "x-test-scopes": scopes } }
        )
        expect((await response.json()).page.capabilities.sharing).toBe(sharing)
      }
    }
    setLinkedSharing(null)
    const scopedSource = await instance.request(
      `/api/spaces/${spaceId}/documents/source?path=${encodeURIComponent(
        "notes/readme"
      )}`,
      { headers: { "x-test-scopes": "documents:read" } }
    )
    expect(scopedSource.status).toBe(403)
    const ownerSource = await instance.request(
      `/api/spaces/${spaceId}/documents/source?path=${encodeURIComponent(
        "notes/readme"
      )}`
    )
    expect(ownerSource.status).toBe(200)
    expect(ownerSource.headers.get("content-disposition")).toContain(
      "readme.md"
    )
    expect(await ownerSource.text()).toBe("# Readme")
    await writeDoc(spaceId, "notes/計画(1)", "# Plan", {
      updatedBy: "test",
      source: "rest-api",
    })
    const unicodeSource = await instance.request(
      `/api/spaces/${spaceId}/documents/source?path=${encodeURIComponent(
        "notes/計画(1)"
      )}`
    )
    expect(unicodeSource.status).toBe(200)
    expect(unicodeSource.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''%E8%A8%88%E7%94%BB%281%29.md"
    )

    const versions = await instance.request(
      `/api/spaces/${spaceId}/documents/versions?path=${encodeURIComponent(
        "notes/readme"
      )}&all=true`,
      { headers: { "x-test-scopes": "documents:read" } }
    )
    expect(versions.status).toBe(200)
    expect((await versions.json()).versions).toEqual(expect.any(Array))

    const restrictedAnnotations = await instance.request(
      `/api/spaces/${spaceId}/documents/annotations?path=${encodeURIComponent(
        "notes/status"
      )}`,
      { headers: { "x-test-scopes": "documents:read" } }
    )
    expect(restrictedAnnotations.status).toBe(403)
    const firstAnnotation = await createAnnotation(spaceId, {
      target: { type: "widget", widgetId: "notes/status" },
      category: "comment",
      body: "First",
    })
    const secondAnnotation = await createAnnotation(spaceId, {
      target: { type: "widget", widgetId: "notes/status" },
      category: "comment",
      body: "Second",
    })
    const annotations = await instance.request(
      `/api/spaces/${spaceId}/documents/annotations?path=${encodeURIComponent(
        "notes/status"
      )}&limit=1`,
      {
        headers: {
          "x-test-scopes": "documents:read,annotations:read",
        },
      }
    )
    expect(annotations.status).toBe(200)
    const firstPage = await annotations.json()
    expect(firstPage).toMatchObject({
      total: 2,
      nextOffset: 1,
    })
    expect(firstPage.annotations).toHaveLength(1)
    const remainingAnnotations = await instance.request(
      `/api/spaces/${spaceId}/documents/annotations?path=${encodeURIComponent(
        "notes/status"
      )}&limit=1&offset=1`,
      {
        headers: {
          "x-test-scopes": "documents:read,annotations:read",
        },
      }
    )
    expect(remainingAnnotations.status).toBe(200)
    const secondPage = await remainingAnnotations.json()
    expect(secondPage).toMatchObject({
      total: 2,
    })
    expect(secondPage.annotations).toHaveLength(1)
    expect(secondPage).not.toHaveProperty("nextOffset")
    expect(
      new Set([firstPage.annotations[0].id, secondPage.annotations[0].id])
    ).toEqual(
      new Set([firstAnnotation.annotation.id, secondAnnotation.annotation.id])
    )

    const docsRoot = join(root, "spaces", spaceId, "docs", "research")
    await mkdir(docsRoot, { recursive: true })
    await writeFile(join(docsRoot, "draft..v2.md"), "# Exact unusual path")
    await writeFile(join(docsRoot, "draftv2.md"), "# Different neighbor")
    const unusualPage = await instance.request(
      `/api/spaces/${spaceId}/documents/page?path=${encodeURIComponent(
        "research/draft..v2"
      )}`
    )
    expect(unusualPage.status).toBe(200)
    expect(await unusualPage.json()).toMatchObject({
      page: {
        document: { path: "research/draft..v2" },
        renderer: null,
        capabilities: {
          rawSource: true,
          versions: false,
          annotations: false,
          sharing: false,
        },
      },
    })
    const unusualSource = await instance.request(
      `/api/spaces/${spaceId}/documents/source?path=${encodeURIComponent(
        "research/draft..v2"
      )}`
    )
    expect(unusualSource.status).toBe(200)
    expect(await unusualSource.text()).toBe("# Exact unusual path")

    for (const endpoint of ["page", "versions", "annotations", "source"]) {
      const absentSpace = await instance.request(
        `/api/spaces/absent/documents/${endpoint}?path=missing`
      )
      expect(absentSpace.status).toBe(404)
      expect(await absentSpace.json()).toMatchObject({ code: "NOT_FOUND" })
    }

    const archived = await resolve("boards/status")
    expect(archived.status).toBe(200)
    expect(await archived.json()).toEqual({
      target: { path: "boards/status", view: "html" },
    })

    const durableId = mintDocumentId()
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: durableId,
          path: "notes/readme",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/notes/readme.md" },
        },
      ],
    })
    const commonWrite = await instance.request(
      `/api/spaces/${spaceId}/documents/annotations`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "annotations:write",
        },
        body: JSON.stringify({
          path: "notes/readme",
          category: "comment",
          body: "A comment in the current document store",
        }),
      }
    )
    expect(commonWrite.status).toBe(200)
    await expect(
      access(
        join(
          root,
          "spaces",
          spaceId,
          "document-data",
          durableId,
          "annotations.json"
        )
      )
    ).resolves.toBeNull()

    const missing = await resolve("missing")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" })

    const invalid = await resolve("../notes/readme")
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" })

    await writeCoreMarkdownBundle("bundled")
    const commonFallback = await resolve("bundled")
    expect(commonFallback.status).toBe(200)
    expect(await commonFallback.json()).toEqual({
      target: { path: "bundled" },
    })

    const moved = await instance.request(
      `/api/spaces/${spaceId}/documents/move-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({ oldPath: "notes", newPath: "library" }),
      }
    )
    expect(moved.status).toBe(200)

    const alias = await resolve("notes/readme")
    expect(alias.status).toBe(200)
    expect(await alias.json()).toEqual({
      target: {
        path: "library/readme",
        view: "doc",
        resolvedFrom: "notes/readme",
      },
    })

    // Simulate a conflicting file arriving from an external filesystem writer;
    // managed writes correctly reject this collision before creating anything.
    await writeFile(join(root, "spaces", spaceId, "docs", "library", "readme.html"), "<h1>Conflict</h1>")
    // This route-only fixture has no watcher; report its external file change.
    noteSpaceChanged(spaceId)
    const conflict = await resolve("notes/readme")
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: "CONFLICT" })
  }, 15_000)

  it("serves content by revision, refusing a revision an outside edit or a move replaced", async () => {
    const instance = app()
    const read = (path: string) =>
      instance.request(`/api/spaces/${spaceId}/documents${path}`, {
        headers: { "x-test-scopes": "documents:read" },
      })
    const page = async (path: string) =>
      (await (await read(`/page?path=${encodeURIComponent(path)}`)).json())
        .page
    const rows = async () =>
      new Map(
        (
          (await (await read("?includeArchived=true")).json()).documents as {
            path: string
            revision?: string
          }[]
        ).map((row) => [row.path, row.revision])
      )
    const content = (path: string, revision: string) =>
      read(
        `/content?path=${encodeURIComponent(path)}&rev=${encodeURIComponent(revision)}`
      )
    const write = (path: string, body: unknown) =>
      instance.request(`/api/spaces/${spaceId}/documents/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

    // Rows and the page check name the revision; its content is kept.
    const opened = await page("notes/readme")
    const html = await page("notes/status")
    expect(opened.renderer.key).toBe("doc")
    expect(typeof opened.revision).toBe("string")
    expect(typeof html.revision).toBe("string")
    expect(opened.collaboration.cacheEpoch).toBe("legacy")
    expect(typeof opened.collaboration.epoch).toBe("string")
    const listed = await rows()
    expect(listed.get("notes/readme")).toBe(opened.revision)
    expect(listed.get("notes/status")).toBe(html.revision)
    const kept = await content("notes/readme", opened.revision)
    expect(kept.status).toBe(200)
    expect(kept.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable"
    )
    expect(await kept.json()).toEqual({
      revision: opened.revision,
      format: "markdown",
      content: "# Readme",
    })

    // Another process edits the file. The page check, the row and the
    // socket's change name a new revision, and the old one is refused with
    // it, never served again.
    const edited = "# Readme\n\nEdited outside.\n"
    await writeFile(
      join(root, "spaces", spaceId, "docs", "notes", "readme.md"),
      edited
    )
    // The page check reads the source itself; lists learn of the edit from
    // the watcher, which reports any file activity in the Space.
    const outside = await page("notes/readme")
    expect(outside.revision).not.toBe(opened.revision)
    noteSpaceChanged(spaceId)
    expect((await rows()).get("notes/readme")).toBe(outside.revision)
    const messages: unknown[] = []
    const sockets = new WsManager()
    sockets.subscribe(
      {
        data: { spaceId, canReadDocs: true },
        send: (value: string) => messages.push(JSON.parse(value)),
        close() {},
      },
      spaceId
    )
    await sockets.handleChange({ type: "doc", spaceId, docPath: "notes/readme" })
    expect(messages).toMatchObject([
      {
        type: "doc_update",
        docPath: "notes/readme",
        data: { content: edited, revision: outside.revision },
      },
    ])
    const stale = await content("notes/readme", opened.revision)
    expect(stale.status).toBe(409)
    expect(stale.headers.get("cache-control")).toBe("private, no-store")
    expect(await stale.json()).toEqual({
      error: expect.any(String),
      code: "REVISION_CHANGED",
      revision: outside.revision,
    })
    expect(await (await content("notes/readme", outside.revision)).json())
      .toMatchObject({ content: edited })

    // Another document takes the path: its content is never served for
    // the revision the path had.
    await writeDoc(spaceId, "notes/other", "# Other", {
      updatedBy: "test",
      source: "rest-api",
    })
    expect((await write("delete", { path: "notes/readme" })).status).toBe(200)
    expect(
      (await write("move", { path: "notes/other", to: "notes/readme" })).status
    ).toBe(200)
    const replaced = await page("notes/readme")
    expect(replaced.revision).not.toBe(outside.revision)
    const refused = await content("notes/readme", outside.revision)
    expect(refused.status).toBe(409)
    expect((await refused.json()).revision).toBe(replaced.revision)
    expect(await (await content("notes/readme", replaced.revision)).json())
      .toMatchObject({ content: "# Other" })
    expect((await content("notes/readme", "")).status).toBe(400)
  }, 15_000)

  it("moves mixed folders with common write authority", async () => {
    const instance = app()
    const forbidden = await instance.request(
      `/api/spaces/${spaceId}/documents/move-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:read",
        },
        body: JSON.stringify({ oldPath: "notes", newPath: "library" }),
      }
    )
    expect(forbidden.status).toBe(403)

    const moved = await instance.request(
      `/api/spaces/${spaceId}/documents/move-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({ oldPath: "notes", newPath: "library" }),
      }
    )
    expect(moved.status).toBe(200)
    const movedBody = (await moved.json()) as {
      renamed: Array<{ from: string; to: string }>
    }
    expect(movedBody.renamed).toHaveLength(3)
    expect(movedBody).toMatchObject({
      ok: true,
      oldPath: "notes",
      newPath: "library",
      count: 3,
      renamed: expect.arrayContaining([
        { from: "notes/old", to: "library/old" },
        { from: "notes/readme", to: "library/readme" },
        { from: "notes/status", to: "library/status" },
      ]),
    })
    expect((await readDoc(spaceId, "library/readme")).data).toBe("# Readme")
    expect((await readWidget(spaceId, "library/status")).data?.id).toBe(
      "library/status"
    )
  }, 10_000)

  it("refuses a folder over the limit with how many it holds, and moves nothing", async () => {
    // Written on disk, as an agent might: one more than a folder operation takes.
    const big = join(root, "spaces", spaceId, "docs", "big")
    await mkdir(big, { recursive: true })
    await Promise.all(
      Array.from({ length: FOLDER_OPERATION_MAX_ENTRIES + 1 }, (_, i) =>
        writeFile(join(big, `doc-${i}.md`), `# Doc ${i}`)
      )
    )
    const refused = await app().request(
      `/api/spaces/${spaceId}/documents/move-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({ oldPath: "big", newPath: "huge" }),
      }
    )
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toBe(
      "1,001 Docs and files are inside. Worktable can move up to 1,000 at a time, so move some of them out first."
    )
    expect((await readDoc(spaceId, "big/doc-0")).data).toBe("# Doc 0")
  }, 30_000)

  it("archives and restores mixed folders with common write authority", async () => {
    const instance = app()
    const originalOldArchive = await getDocArchiveInfo(spaceId, "notes/old")
    const forbiddenArchive = await instance.request(
      `/api/spaces/${spaceId}/documents/archive-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:read",
        },
        body: JSON.stringify({ path: "notes" }),
      }
    )
    expect(forbiddenArchive.status).toBe(403)

    const oversizedReason = await instance.request(
      `/api/spaces/${spaceId}/documents/archive-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({
          path: "notes",
          reason: "x".repeat(DOCUMENT_ARCHIVE_REASON_MAX_LENGTH + 1),
        }),
      }
    )
    expect(oversizedReason.status).toBe(400)
    expect(await getDocArchiveInfo(spaceId, "notes/readme")).toBeUndefined()
    expect(
      (await readWidget(spaceId, "notes/status")).data?.archive ?? undefined
    ).toBeUndefined()

    const archived = await instance.request(
      `/api/spaces/${spaceId}/documents/archive-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({
          path: "notes",
          reason: "Quarter complete",
        }),
      }
    )
    expect(archived.status).toBe(200)
    const archivedBody = (await archived.json()) as {
      count: number
      paths: string[]
    }
    expect(archivedBody).toMatchObject({
      ok: true,
      path: "notes",
      archived: true,
      count: 3,
    })
    expect(archivedBody.paths).toHaveLength(3)
    expect(archivedBody.paths).toEqual(
      expect.arrayContaining(["notes/old", "notes/readme", "notes/status"])
    )
    expect(await getDocArchiveInfo(spaceId, "notes/old")).toEqual(
      originalOldArchive
    )
    expect(await getDocArchiveInfo(spaceId, "notes/readme")).toMatchObject({
      archivedBy: "local:owner",
      reason: "Quarter complete",
    })
    expect(
      (await readWidget(spaceId, "notes/status")).data?.archive
    ).toMatchObject({
      archivedBy: "local:owner",
      reason: "Quarter complete",
    })

    const restored = await instance.request(
      `/api/spaces/${spaceId}/documents/restore-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({ path: "notes" }),
      }
    )
    expect(restored.status).toBe(200)
    const restoredBody = (await restored.json()) as {
      count: number
      paths: string[]
    }
    expect(restoredBody).toMatchObject({
      ok: true,
      path: "notes",
      archived: false,
      count: 3,
    })
    expect(restoredBody.paths).toHaveLength(3)
    expect(restoredBody.paths).toEqual(
      expect.arrayContaining(["notes/old", "notes/readme", "notes/status"])
    )
    expect(await getDocArchiveInfo(spaceId, "notes/old")).toBeUndefined()
    expect(await getDocArchiveInfo(spaceId, "notes/readme")).toBeUndefined()
    expect((await readWidget(spaceId, "notes/status")).data?.archive).toBeNull()
  }, 10_000)

  it("refuses unsupported mixed-folder archive and delete without changing source", async () => {
    const instance = app()
    await writeDoc(spaceId, "blocked/managed", "# Managed")
    await writeCoreMarkdownBundle("blocked/bundled")
    const rejected = await instance.request(
      `/api/spaces/${spaceId}/documents/archive-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({ path: "blocked" }),
      }
    )
    expect(rejected.status).toBe(409)
    expect(await getDocArchiveInfo(spaceId, "blocked/managed")).toBeUndefined()

    const unsupportedDelete = await instance.request(
      `/api/spaces/${spaceId}/documents/delete-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({ path: "blocked" }),
      }
    )
    expect(unsupportedDelete.status).toBe(409)
    expect((await readDoc(spaceId, "blocked/managed")).data).toBe("# Managed")
    expect(
      await readFile(
        join(
          root,
          "spaces",
          spaceId,
          "docs",
          "blocked",
          "bundled.wtdoc",
          "content.md"
        ),
        "utf8"
      )
    ).toBe("# Bundled")
  }, 10_000)

  it("preserves HTML folders when shared metadata is corrupt and resumes after repair", async () => {
    const instance = app()
    const htmlOnly = await writeWidget(
      spaceId,
      { ...htmlDocument(), id: "dashboards/live", name: "Live" },
      "<h1>Live</h1>"
    )
    htmlOnly.release?.()
    const docsMetaPath = join(root, "spaces", spaceId, "docs.meta.json")
    const validDocMeta = await readFile(docsMetaPath)
    await writeFile(docsMetaPath, "not json")
    const movedHtmlOnly = await instance.request(
      `/api/spaces/${spaceId}/documents/move-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({
          oldPath: "dashboards",
          newPath: "reports",
        }),
      }
    )
    expect(movedHtmlOnly.status).toBe(409)
    expect((await readWidget(spaceId, "dashboards/live")).data?.name).toBe("Live")
    await writeFile(docsMetaPath, validDocMeta)
    const repairedMove = await instance.request(`/api/spaces/${spaceId}/documents/move-folder`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-scopes": "documents:write" },
      body: JSON.stringify({ oldPath: "dashboards", newPath: "reports" }),
    })
    expect(repairedMove.status).toBe(200)

    const archivedHtmlOnly = await instance.request(
      `/api/spaces/${spaceId}/documents/archive-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({ path: "reports" }),
      }
    )
    expect(archivedHtmlOnly.status).toBe(200)
    expect((await readWidget(spaceId, "reports/live")).data?.archive).toEqual(
      expect.objectContaining({ archivedBy: "local:owner" })
    )
    await writeFile(docsMetaPath, validDocMeta)
  }, 10_000)

  it("moves, archives, restores and deletes a plain file once files are on", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      const instance = app()
      setSystemTime(new Date("2026-10-20T09:00:00.000Z"))
      const docs = join(root, "spaces", spaceId, "docs")
      await mkdir(join(docs, "notes", "readme"), { recursive: true })
      await writeFile(join(docs, "notes", "readme", "error.png"), "png bytes")
      noteSpaceChanged(spaceId)
      const post = (action: string, body: unknown) =>
        instance.request(`/api/spaces/${spaceId}/documents/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const fileEntry = async (path: string) =>
        (
          await buildDocumentCatalog({ workspaceRoot: root, spaceId })
        ).entries.find(
          (entry) => entry.kind === "document" && entry.descriptor.path === path
        )

      // Nothing under a hidden name is a file, so a file can't move there.
      const hiddenMove = await post("move", {
        path: "notes/readme/error.png",
        to: ".private/error.png",
      })
      expect(hiddenMove.status).toBe(409)
      expect(
        await readFile(join(docs, "notes", "readme", "error.png"), "utf8")
      ).toBe("png bytes")

      const moved = await post("move", {
        path: "notes/readme/error.png",
        to: "design/error.png",
      })
      expect(moved.status).toBe(200)
      expect(await readFile(join(docs, "design", "error.png"), "utf8")).toBe(
        "png bytes"
      )
      expect(await fileEntry("notes/readme/error.png")).toBeUndefined()
      const entry = await fileEntry("design/error.png")
      expect(entry?.kind === "document" && entry.descriptor.format.id).toBe(
        "worktable.file"
      )

      expect((await post("archive", { path: "design/error.png" })).status).toBe(
        200
      )
      expect((await post("restore", { path: "design/error.png" })).status).toBe(
        200
      )
      expect((await post("delete", { path: "design/error.png" })).status).toBe(
        200
      )
      await expect(access(join(docs, "design", "error.png"))).rejects.toThrow()
      expect(await fileEntry("design/error.png")).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("uploads, serves and replaces files, keeping each version", async () => {
    const instance = app()
    const fileUrl = (path: string, query = "") =>
      `/api/spaces/${spaceId}/documents/file?path=${encodeURIComponent(path)}${query}`
    const upload = (
      path: string,
      body: string,
      headers: Record<string, string> = {},
      query = ""
    ) =>
      instance.request(fileUrl(path, query), {
        method: "PUT",
        headers,
        body,
      })

    const previous = process.env["WORKTABLE_FILES"]
    try {
      process.env["WORKTABLE_FILES"] = "0"
      expect((await upload("design/error.png", "png")).status).toBe(404)

      process.env["WORKTABLE_FILES"] = "1"
      expect(
        (
          await upload("design/error.png", "png", {
            "x-test-scopes": "documents:read",
          })
        ).status
      ).toBe(403)
      // A Doc's name is for the Doc tools.
      expect((await upload("design/notes.md", "# Notes")).status).toBe(415)
      // JSON is a file unless it holds Doc blocks, whoever writes it.
      const config = '{"theme":"dark"}\n'
      expect((await upload("data/config.json", config)).status).toBe(201)
      expect(
        (await upload("data/notes.json", '[{"type":"paragraph","content":"Hi"}]'))
          .status
      ).toBe(409)
      // Large uploads are decided the same way without parsing more than
      // they must. Doc blocks past the first megabyte are still a Doc; data
      // whose first element isn't a block is a file from its start alone;
      // blocks that stop being blocks later on are a file.
      const many = (element: string, count: number) =>
        `[${Array.from({ length: count }, () => element).join(",")}]`
      const paragraph = '{"type":"paragraph","content":"Line of a long plan"}'
      expect((await upload("data/long-plan.json", many(paragraph, 40_000))).status).toBe(409)
      const parses = spyOn(JSON, "parse")
      const records = many('{"note":"a \\"}\\" b","id":1,"tags":["x"]}', 60_000)
      expect(records.length).toBeGreaterThan(2 * 1024 * 1024)
      expect((await upload("data/records.json", records)).status).toBe(201)
      const longest = Math.max(
        0,
        ...parses.mock.calls.map(([text]) => (typeof text === "string" ? text.length : 0))
      )
      parses.mockRestore()
      expect(longest).toBeLessThan(records.length / 2)
      expect(
        (await upload("data/mixed.json", `${many(paragraph, 40_000).slice(0, -1)},{"id":1}]`))
          .status
      ).toBe(201)
      const docs = join(root, "spaces", spaceId, "docs")
      const data = '[{"id":1,"name":"a"},{"id":2,"name":"b"}]'
      await mkdir(join(docs, "agent-out"), { recursive: true })
      await writeFile(join(docs, "agent-out", "data.json"), data)
      await writeFile(join(docs, "package.json"), '{"name":"tool"}')
      noteSpaceChanged(spaceId)
      for (const [path, bytes] of [
        ["data/config.json", config],
        ["agent-out/data.json", data],
        ["package.json", '{"name":"tool"}'],
      ] as const) {
        const served = await instance.request(fileUrl(path))
        expect(served.status).toBe(200)
        expect(await served.text()).toBe(bytes)
      }
      // A kept file stays a file whatever is written into it: Doc blocks in
      // it are not a Doc the Doc scope can read or list.
      const blocks = '[{"type":"paragraph","content":"Secret plan"}]'
      await writeFile(join(docs, "data", "config.json"), blocks)
      noteSpaceChanged(spaceId)
      const docsOnly = { "x-test-scopes": "docs:read" }
      expect(
        (await instance.request(`/api/spaces/${spaceId}/docs/data/config`, { headers: docsOnly }))
          .status
      ).toBe(404)
      const docList = (await (
        await instance.request(`/api/spaces/${spaceId}/docs`, { headers: docsOnly })
      ).json()) as { docs: Array<{ path: string }> }
      expect(docList.docs.map((doc) => doc.path)).not.toContain("data/config")
      expect(
        (await instance.request(fileUrl("data/config.json"), { headers: docsOnly })).status
      ).toBe(403)
      expect(
        await (
          await instance.request(fileUrl("data/config.json"), {
            headers: { "x-test-scopes": "documents:read" },
          })
        ).text()
      ).toBe(blocks)
      // A plain file beside a Markdown Doc of the same name leaves the Doc
      // readable and listed.
      expect((await upload("notes/readme.json", '{"owner":"docs"}')).status).toBe(201)
      expect((await readDoc(spaceId, "notes/readme")).data).toBe("# Readme")
      expect((await listDocsDetailed(spaceId)).map((doc) => doc.path)).toContain(
        "notes/readme"
      )
      // Lifecycle checks take the file for a file: archiving the Doc beside
      // it is not mistaken for two Docs at one path.
      await writeDoc(spaceId, "plan", "# Plan", {
        updatedBy: "test",
        source: "rest-api",
        managedIdentity: true,
      })
      await writeFile(join(docs, "plan.json"), '[{"id":1}]')
      noteSpaceChanged(spaceId)
      const archived = await instance.request(`/api/spaces/${spaceId}/documents/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "plan" }),
      })
      expect(archived.status).toBe(200)
      // A moved Doc's alias holds its old name, not a new file's whole name.
      await writeDoc(spaceId, "setup", "# Setup", {
        updatedBy: "test",
        source: "rest-api",
        managedIdentity: true,
      })
      const moved = await instance.request(`/api/spaces/${spaceId}/documents/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "setup", to: "archive/setup" }),
      })
      expect(moved.status).toBe(200)
      expect((await resolveDocAlias(spaceId, "setup")).path).toBe("archive/setup")
      await writeFile(join(docs, "setup.json"), '{"theme":"light"}')
      noteSpaceChanged(spaceId)
      const listed = (await (
        await instance.request(`/api/spaces/${spaceId}/documents`)
      ).json()) as { documents: Array<{ path?: string; format?: { id: string } }> }
      expect(listed.documents).toContainEqual(
        expect.objectContaining({
          path: "setup.json",
          format: expect.objectContaining({ id: "worktable.file" }),
        })
      )
      expect(await (await instance.request(fileUrl("setup.json"))).text()).toBe(
        '{"theme":"light"}'
      )

      const created = await upload("design/error.png", "first")
      expect(created.status).toBe(201)
      const first = (await created.json()) as {
        path: string
        sourceRevision: string
        contentHash: string
      }
      expect(first.path).toBe("design/error.png")
      // A taken name is refused unless both are kept.
      expect((await upload("design/error.png", "other")).status).toBe(409)
      const kept = await upload("design/error.png", "other", {}, "&keepBoth=1")
      expect(((await kept.json()) as { path: string }).path).toBe(
        "design/error-2.png"
      )

      const read = await instance.request(
        fileUrl("design/error.png"),
        { headers: { "x-test-scopes": "documents:read" } }
      )
      expect(read.status).toBe(200)
      expect(await read.text()).toBe("first")
      expect(read.headers.get("content-type")).toBe("image/png")
      expect(read.headers.get("content-disposition")).toStartWith(
        'inline; filename="error.png";'
      )
      expect(read.headers.get("x-content-type-options")).toBe("nosniff")
      expect(read.headers.get("content-security-policy")).toContain("sandbox")
      expect(read.headers.get("cache-control")).toBe("private, no-cache")
      const pinned = await instance.request(
        fileUrl("design/error.png", `&v=${first.contentHash}`)
      )
      expect(pinned.headers.get("cache-control")).toContain("immutable")
      const revisit = await instance.request(fileUrl("design/error.png"), {
        headers: { "if-none-match": `"${first.contentHash}"` },
      })
      expect(revisit.status).toBe(304)

      await upload("data/feedback.csv", "id,score\n007,5\n")
      const csv = await instance.request(fileUrl("data/feedback.csv"))
      expect(csv.headers.get("content-disposition")).toStartWith("attachment;")
      expect(await csv.text()).toBe("id,score\n007,5\n")

      // Replacing needs the revision it read, and keeps the old version.
      expect(
        (await upload("design/error.png", "second", { "if-match": "rev_stale" }))
          .status
      ).toBe(409)
      const replaced = await upload("design/error.png", "second", {
        "if-match": first.sourceRevision,
      })
      expect(replaced.status).toBe(200)
      expect(await (await instance.request(fileUrl("design/error.png"))).text()).toBe(
        "second"
      )
      // Each upload is a version of its own, however quickly they follow.
      const second = (await replaced.json()) as { sourceRevision: string }
      expect(
        (
          await upload("design/error.png", "third", {
            "if-match": second.sourceRevision,
          })
        ).status
      ).toBe(200)
      const versions = await instance.request(
        `/api/spaces/${spaceId}/documents/versions?path=design/error.png&all=true`
      )
      expect(
        ((await versions.json()) as { versions: unknown[] }).versions.length
      ).toBe(3)

      // Upload New Version replaces whatever the file holds now.
      expect(
        (await upload("design/error.png", "fourth", {}, "&replace=1")).status
      ).toBe(200)
      expect(await (await instance.request(fileUrl("design/error.png"))).text()).toBe(
        "fourth"
      )
      expect((await upload("design/missing.png", "x", {}, "&replace=1")).status).toBe(404)

      // A Doc's path is not a file's, whatever revision is offered.
      const docRevision = (
        await readRegisteredDocumentSource({ spaceId, path: "notes/readme" })
      ).sourceRevision
      expect(
        (await upload("notes/readme", "replaced", { "if-match": docRevision }))
          .status
      ).toBe(409)
      expect((await readDoc(spaceId, "notes/readme")).data).toBe("# Readme")
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("streams an upload to disk as it arrives, and saves only a whole one", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      const instance = app()
      const url = (path: string, query = "") =>
        `/api/spaces/${spaceId}/documents/file?path=${encodeURIComponent(path)}${query}`
      const staged = () => readdir(stagingDirectory()).catch(() => [])
      const piece = 1024 * 1024
      const pattern = new Uint8Array(piece).map((_, i) => i % 251)
      // A body without Content-Length, a piece at a time as it is asked for.
      // `hold` keeps back the last piece until it resolves; `failAt` cuts the
      // body off before that piece.
      const body = (
        size: number,
        options: { hold?: Promise<void>; failAt?: number } = {}
      ) => {
        let sent = 0
        let reachedLast!: () => void
        const lastAsked = new Promise<void>((resolve) => (reachedLast = resolve))
        const stream = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              if (sent >= size) return controller.close()
              if (options.failAt !== undefined && sent >= options.failAt) {
                return controller.error(new Error("connection lost"))
              }
              const length = Math.min(piece, size - sent)
              if (sent + length >= size) {
                reachedLast()
                await options.hold
              }
              controller.enqueue(pattern.slice(0, length))
              sent += length
            },
          },
          { highWaterMark: 0 }
        )
        return { stream, lastAsked }
      }
      const expected = (size: number) => {
        const hash = createHash("sha256")
        for (let at = 0; at < size; at += piece) {
          hash.update(pattern.subarray(0, Math.min(piece, size - at)))
        }
        return hash.digest("base64url")
      }

      // A file at the limit is written to disk as it arrives, never gathered
      // in memory first.
      let release!: () => void
      const hold = new Promise<void>((resolve) => (release = resolve))
      const whole = body(FILE_UPLOAD_MAX_BYTES, { hold })
      const saving = instance.request(url("data/archive.bin"), {
        method: "PUT",
        body: whole.stream,
      })
      await whole.lastAsked
      const [inProgress] = await staged()
      expect(inProgress).toBeDefined()
      expect((await stat(join(stagingDirectory(), inProgress!))).size).toBeGreaterThanOrEqual(
        FILE_UPLOAD_MAX_BYTES - 4 * piece
      )
      release()
      const saved = await saving
      expect(saved.status).toBe(201)
      const first = (await saved.json()) as { sourceRevision: string; contentHash: string }
      expect(first.contentHash).toBe(expected(FILE_UPLOAD_MAX_BYTES))
      const served = await instance.request(url("data/archive.bin"))
      expect(
        createHash("sha256")
          .update(new Uint8Array(await served.arrayBuffer()))
          .digest("base64url")
      ).toBe(first.contentHash)
      expect(await staged()).toEqual([])
      const versions = async () =>
        (
          (await (
            await instance.request(
              `/api/spaces/${spaceId}/documents/versions?path=data/archive.bin&all=true`
            )
          ).json()) as { versions: unknown[] }
        ).versions.length
      expect(await versions()).toBe(1)

      // One byte more is refused, without Content-Length too, and leaves
      // nothing: no file, no staged bytes.
      const over = await instance.request(url("data/too-big.bin"), {
        method: "PUT",
        body: body(FILE_UPLOAD_MAX_BYTES + 1).stream,
      })
      expect(over.status).toBe(413)
      expect((await instance.request(url("data/too-big.bin"))).status).toBe(404)
      expect(await staged()).toEqual([])

      // A replacement cut off partway leaves the file and its versions as
      // they were.
      const cut = await instance.request(url("data/archive.bin"), {
        method: "PUT",
        headers: { "if-match": first.sourceRevision },
        body: body(8 * piece, { failAt: 3 * piece }).stream,
      })
      expect(cut.status).toBeGreaterThanOrEqual(400)
      const after = await instance.request(url("data/archive.bin"), {
        method: "HEAD",
      })
      expect(after.headers.get("etag")).toBe(`"${first.contentHash}"`)
      expect(await versions()).toBe(1)
      expect(await staged()).toEqual([])

      // A whole replacement keeps the large file as a version of its own.
      const replaced = await instance.request(url("data/archive.bin"), {
        method: "PUT",
        headers: { "if-match": first.sourceRevision },
        body: body(2 * piece).stream,
      })
      expect(replaced.status).toBe(200)
      const second = (await replaced.json()) as {
        documentId: string
        versionId: string
        sourceRevision: string
        contentHash: string
      }
      expect(second.contentHash).toBe(expected(2 * piece))
      expect(await versions()).toBe(2)
      expect(await staged()).toEqual([])

      // A newest version whose stored copy was damaged isn't trusted to hold
      // the file: replacing it first keeps what the file held as a recovery
      // point, so those bytes stay readable.
      const kept = join(
        root,
        "versions",
        spaceId,
        "documents",
        second.documentId,
        second.versionId,
        "source"
      )
      const [entry] = await readdir(kept)
      await writeFile(join(kept, entry!), "damaged")
      const afterDamage = await instance.request(url("data/archive.bin"), {
        method: "PUT",
        headers: { "if-match": second.sourceRevision },
        body: body(piece).stream,
      })
      expect(afterDamage.status).toBe(200)
      const listed = (await (
        await instance.request(
          `/api/spaces/${spaceId}/documents/versions?path=data/archive.bin&all=true`
        )
      ).json()) as { versions: Array<{ reason?: string; createdAt: string }> }
      expect(listed.versions).toHaveLength(4)
      const recovery = listed.versions.find(
        (version) => version.reason === "Pre-edit recovery point"
      )
      expect(recovery).toBeDefined()
      const recovered = await instance.request(
        url("data/archive.bin", `&at=${encodeURIComponent(recovery!.createdAt)}`)
      )
      expect(
        createHash("sha256")
          .update(new Uint8Array(await recovered.arrayBuffer()))
          .digest("base64url")
      ).toBe(expected(2 * piece))

      // Bytes a stopped server was staging are removed when the next starts.
      await mkdir(stagingDirectory(), { recursive: true })
      await writeFile(
        join(stagingDirectory(), `${2 ** 30}-${"0".repeat(32)}.staged`),
        "partial"
      )
      expect(await removeLeftoverStagedFiles()).toBe(1)
      expect(await staged()).toEqual([])
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  }, 60_000)

  it("keeps a Doc overwritten with plain JSON as the same unreadable item, with its history", async () => {
    const instance = app()
    const blocks = (text: string) =>
      new TextEncoder().encode(
        JSON.stringify([{ type: "paragraph", content: text }])
      )
    const created = await createRegisteredDocument({
      spaceId,
      path: "plan",
      format: { id: "worktable.rich-text", sourceVersion: 1 },
      bytes: blocks("First draft"),
      createdBy: "test",
      source: "test",
    })
    await replaceRegisteredDocument({
      spaceId,
      path: "plan",
      bytes: blocks("Second draft"),
      expectedRevision: created.sourceRevision,
      updatedBy: "test",
      source: "test",
    })
    const request = async (route: string) =>
      instance.request(`/api/spaces/${spaceId}/documents/${route}`)
    const versions = async () =>
      ((await (await request("versions?path=plan&all=true")).json()) as {
        versions: unknown[]
      }).versions.length
    const kept = await versions()
    expect(kept).toBe(2)

    // A shell agent writes data over the Doc's file.
    const data = '[{"id":1,"name":"a"},{"id":2,"name":"b"}]'
    await writeFile(join(root, "spaces", spaceId, "docs", "plan.json"), data)
    noteSpaceChanged(spaceId)

    const page = (await (await request("page?path=plan")).json()) as {
      page: unknown
    }
    expect(page.page).toMatchObject({
      document: { path: "plan", health: "invalid" },
      renderer: null,
      capabilities: { rawSource: true, versions: true },
    })
    const current = await readRegisteredDocumentSource({ spaceId, path: "plan" })
    expect(current.documentId).toBe(created.documentId)
    expect(await versions()).toBe(kept)
    // Lists keep it, as unreadable.
    expect(
      (await listDocsDetailed(spaceId)).find((doc) => doc.path === "plan")
    ).toMatchObject({ unreadable: true })
    expect(await (await request("source?path=plan")).text()).toBe(data)
    // The editor never imports it, so nothing can save over the bytes.
    expect((await readDoc(spaceId, "plan")).data).toBeNull()
    await expect(
      yjsManager.handleConnection(
        { send() {}, close() {} } as never,
        spaceId,
        "plan"
      )
    ).rejects.toThrow()
    expect(
      await readFile(join(root, "spaces", spaceId, "docs", "plan.json"), "utf8")
    ).toBe(data)

    // Replacing it with Doc blocks repairs it, keeping the agent's bytes.
    await expect(
      replaceRegisteredDocument({
        spaceId,
        path: "plan",
        bytes: new TextEncoder().encode('[{"id":3}]'),
        expectedRevision: current.sourceRevision,
        updatedBy: "test",
        source: "test",
      })
    ).rejects.toThrow("Doc blocks")
    await replaceRegisteredDocument({
      spaceId,
      path: "plan",
      bytes: blocks("Repaired"),
      expectedRevision: current.sourceRevision,
      updatedBy: "test",
      source: "test",
    })
    expect(
      ((await (await request("page?path=plan")).json()) as {
        page: { document: { health: string } }
      }).page.document.health
    ).toBe("supported")
    expect(
      (await readRegisteredDocumentSource({ spaceId, path: "plan" })).documentId
    ).toBe(created.documentId)
    expect(await versions()).toBe(kept + 2)
  })

  it("gives two same-size writes in one clock tick their own ETags", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      const instance = app()
      const url = `/api/spaces/${spaceId}/documents/file?path=${encodeURIComponent("data/tick.bin")}`
      expect((await instance.request(url, { method: "PUT", body: "first!" })).status).toBe(201)
      // Both writes keep one size and one modification time, and the clock
      // stays within the two seconds a revision takes to settle.
      setSystemTime(new Date())
      const onDisk = join(root, "spaces", spaceId, "docs", "data", "tick.bin")
      const tick = new Date("2026-01-01T00:00:00Z")
      await utimes(onDisk, tick, tick)
      const first = await instance.request(url)
      expect(await first.text()).toBe("first!")
      await writeFile(onDisk, "other!")
      await utimes(onDisk, tick, tick)
      noteSpaceChanged(spaceId)
      const second = await instance.request(url)
      expect(await second.text()).toBe("other!")
      expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"))
    } finally {
      setSystemTime()
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("serves ranges of a file, streamed at one revision without holding its Space", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    const opens = spyOn(OpenFileRevision, "open")
    try {
      const instance = app()
      const url = (path: string) =>
        `/api/spaces/${spaceId}/documents/file?path=${encodeURIComponent(path)}`
      const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
        instance.request(url(path), { method, headers })
      const bytes = new Uint8Array(4 * FILE_READ_CHUNK_BYTES + 7).map((_, i) => i % 251)
      const created = await instance.request(url("data/archive.bin"), {
        method: "PUT",
        body: bytes,
      })
      const { contentHash } = (await created.json()) as { contentHash: string }
      const etag = `"${contentHash}"`
      const securityHeaders = (response: Response) => {
        expect(response.headers.get("content-security-policy")).toContain("sandbox")
        expect(response.headers.get("x-content-type-options")).toBe("nosniff")
        expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin")
        expect(response.headers.get("content-disposition")).toStartWith("attachment;")
      }

      const part = await get("data/archive.bin", { range: "bytes=10-19" })
      expect(part.status).toBe(206)
      expect(part.headers.get("content-range")).toBe(`bytes 10-19/${bytes.length}`)
      expect(part.headers.get("accept-ranges")).toBe("bytes")
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(10, 20))
      securityHeaders(part)
      const tail = await get("data/archive.bin", { range: "bytes=-5" })
      expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(-5))
      const past = await get("data/archive.bin", { range: `bytes=${bytes.length}-` })
      expect(past.status).toBe(416)
      expect(past.headers.get("content-range")).toBe(`bytes */${bytes.length}`)
      securityHeaders(past)
      // A range of other content than the client's sends the whole file.
      const stale = await get("data/archive.bin", { range: "bytes=0-0", "if-range": '"other"' })
      expect(stale.status).toBe(200)
      expect((await stale.arrayBuffer()).byteLength).toBe(bytes.length)
      expect(
        (await get("data/archive.bin", { range: "bytes=0-0", "if-range": etag })).status
      ).toBe(206)
      // Once the file's clock has moved past its write, its hash is kept.
      setSystemTime(new Date(Date.now() + 3_000))
      const head = await get("data/archive.bin", {}, "HEAD")
      expect(head.status).toBe(200)
      expect(head.headers.get("content-length")).toBe(String(bytes.length))
      expect(head.headers.get("etag")).toBe(etag)

      // A copy the client has is confirmed without opening the file.
      opens.mockClear()
      const revisit = await get("data/archive.bin", { "if-none-match": etag })
      expect(revisit.status).toBe(304)
      securityHeaders(revisit)
      expect(opens).not.toHaveBeenCalled()
      setSystemTime()

      // The bytes arrive a chunk at a time, and the Space is free meanwhile.
      const whole = await get("data/archive.bin")
      const reader = whole.body!.getReader()
      const first = await reader.read()
      expect(first.value?.byteLength).toBe(FILE_READ_CHUNK_BYTES)
      expect(
        (await instance.request(url("data/other.bin"), { method: "PUT", body: "x" })).status
      ).toBe(201)
      // A new version saved meanwhile leaves this transfer whole and as it was.
      expect(
        (
          await instance.request(`${url("data/archive.bin")}&replace=1`, {
            method: "PUT",
            body: bytes.slice(0, 100),
          })
        ).status
      ).toBe(200)
      const received = [first.value!]
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        received.push(next.value)
      }
      expect(new Uint8Array(await new Blob(received).arrayBuffer())).toEqual(bytes)

      // A file changed in place partway fails the transfer, never mixing.
      const docs = join(root, "spaces", spaceId, "docs")
      await writeFile(join(docs, "data", "archive.bin"), bytes)
      const changing = (await get("data/archive.bin")).body!.getReader()
      await changing.read()
      // Rewritten where it is, as an editor saving in place does.
      await writeFile(join(docs, "data", "archive.bin"), bytes.subarray(1))
      const rest = (async () => {
        for (let next = await changing.read(); !next.done; next = await changing.read());
      })()
      await expect(rest).rejects.toThrow()

      // A file renamed partway, as an editor keeping a backup does, finishes
      // from what it was.
      await writeFile(join(docs, "data", "archive.bin"), bytes)
      const renaming = (await get("data/archive.bin")).body!.getReader()
      const renamedFirst = await renaming.read()
      await rename(join(docs, "data", "archive.bin"), join(docs, "data", "archive.bak"))
      const renamedParts = [renamedFirst.value!]
      for (let next = await renaming.read(); !next.done; next = await renaming.read()) {
        renamedParts.push(next.value)
      }
      expect(new Uint8Array(await new Blob(renamedParts).arrayBuffer())).toEqual(bytes)
      await rename(join(docs, "data", "archive.bak"), join(docs, "data", "archive.bin"))

      // A rename explains one change, not a later same-size write that puts
      // the time back.
      const moved = join(docs, "data", "archive.moved")
      await writeFile(join(docs, "data", "archive.bin"), bytes)
      const pinnedTime = new Date("2026-10-20T09:00:00.000Z")
      await utimes(join(docs, "data", "archive.bin"), pinnedTime, pinnedTime)
      const departing = (await get("data/archive.bin")).body!.getReader()
      await departing.read()
      await rename(join(docs, "data", "archive.bin"), moved)
      await departing.read()
      const overwritten = bytes.slice()
      overwritten[overwritten.length - 1] = overwritten[overwritten.length - 1]! ^ 0xff
      await writeFile(moved, overwritten)
      await utimes(moved, pinnedTime, pinnedTime)
      const leftover = (async () => {
        for (let next = await departing.read(); !next.done; next = await departing.read());
      })()
      await expect(leftover).rejects.toThrow()
      await rename(moved, join(docs, "data", "archive.bin"))

      // So does one of the same size whose writer puts the time back.
      const archive = join(docs, "data", "archive.bin")
      await writeFile(archive, bytes)
      const when = new Date("2026-10-20T09:00:00.000Z")
      await utimes(archive, when, when)
      const sneaky = (await get("data/archive.bin")).body!.getReader()
      await sneaky.read()
      const altered = bytes.slice()
      altered[altered.length - 1] = altered[altered.length - 1]! ^ 0xff
      await writeFile(archive, altered)
      await utimes(archive, when, when)
      const remainder = (async () => {
        for (let next = await sneaky.read(); !next.done; next = await sneaky.read());
      })()
      await expect(remainder).rejects.toThrow()
    } finally {
      opens.mockRestore()
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("keeps a version when a file with history changes on disk", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      const instance = app()
      setSystemTime(new Date("2026-10-20T09:00:00.000Z"))
      const docs = join(root, "spaces", spaceId, "docs")
      const versions = async (path: string) =>
        (
          (await (
            await instance.request(
              `/api/spaces/${spaceId}/documents/versions?path=${path}&all=true`
            )
          ).json()) as { versions?: Array<{ source: string }> }
        ).versions ?? []
      const uploaded = await instance.request(
        `/api/spaces/${spaceId}/documents/file?path=data/feedback.csv`,
        { method: "PUT", body: "id\n1\n" }
      )
      expect(uploaded.status).toBe(201)
      const before = (await versions("data/feedback.csv")).length

      // An agent rewrites it straight on disk.
      await writeFile(join(docs, "data", "feedback.csv"), "id\n1\n2\n")
      noteSpaceChanged(spaceId)
      expect(
        await recordExternalFileChanges({ spaceId, paths: ["data/feedback.csv"] })
      ).toEqual({ recorded: ["data/feedback.csv"], tooLarge: [] })
      const after = await versions("data/feedback.csv")
      expect(after.length).toBe(before + 1)
      expect(after[0]?.source).toBe("filesystem")
      // The same bytes again keep nothing new.
      expect(
        await recordExternalFileChanges({ spaceId, paths: ["data/feedback.csv"] })
      ).toEqual({ recorded: [], tooLarge: [] })
      // A quick further change, saved atomically and reported only by its
      // temporary name, continues that version rather than adding one.
      await writeFile(join(docs, "data", "feedback.csv"), "id\n1\n2\n3\n")
      noteSpaceChanged(spaceId)
      expect(
        await recordExternalFileChanges({
          spaceId,
          paths: ["data/feedback.csv.tmp"],
        })
      ).toEqual({ recorded: ["data/feedback.csv"], tooLarge: [] })
      expect((await versions("data/feedback.csv")).length).toBe(before + 1)

      // A file nobody has kept yet has no history to add to.
      await writeFile(join(docs, "data", "dropped.csv"), "id\n")
      noteSpaceChanged(spaceId)
      expect(
        await recordExternalFileChanges({ spaceId, paths: ["data/dropped.csv"] })
      ).toEqual({ recorded: [], tooLarge: [] })

      // Grown past what a version holds, it is marked rather than read: it
      // keeps no version, and its page says why.
      const onDisk = join(docs, "data", "feedback.csv")
      const size = FILE_VERSION_MAX_BYTES + FILE_READ_CHUNK_BYTES + 3
      const end = new TextEncoder().encode("end\n")
      await truncate(onDisk, size)
      const handle = await open(onDisk, "r+")
      await handle.write(end, 0, end.length, size - end.length)
      await handle.close()
      noteSpaceChanged(spaceId)
      const kept = (await versions("data/feedback.csv")).length
      expect(
        await recordExternalFileChanges({ spaceId, paths: ["data/feedback.csv"] })
      ).toEqual({ recorded: [], tooLarge: ["data/feedback.csv"] })
      expect((await versions("data/feedback.csv")).length).toBe(kept)
      const page = async () =>
        (
          (await (
            await instance.request(`/api/spaces/${spaceId}/documents/page?path=data/feedback.csv`)
          ).json()) as { page: { byteLength?: number; noHistory?: unknown } }
        ).page
      expect(await page()).toMatchObject({
        byteLength: size,
        noHistory: { reason: "too-large", maxBytes: FILE_VERSION_MAX_BYTES },
      })
      // It still lists, and downloads whole or in part, byte for byte.
      const listed = (await (
        await instance.request(`/api/spaces/${spaceId}/documents`)
      ).json()) as { documents: Array<{ path?: string }> }
      expect(listed.documents.map((document) => document.path)).toContain("data/feedback.csv")
      const file = `/api/spaces/${spaceId}/documents/file?path=data/feedback.csv`
      const whole = await instance.request(file)
      expect(whole.status).toBe(200)
      expect(whole.headers.get("content-length")).toBe(String(size))
      const sha256 = (bytes: ArrayBuffer | Uint8Array) =>
        createHash("sha256").update(new Uint8Array(bytes)).digest("hex")
      expect(sha256(await whole.arrayBuffer())).toBe(sha256(await readFile(onDisk)))
      const tail = await instance.request(file, {
        headers: { range: `bytes=${FILE_VERSION_MAX_BYTES}-` },
      })
      expect(tail.status).toBe(206)
      expect(tail.headers.get("content-range")).toBe(
        `bytes ${FILE_VERSION_MAX_BYTES}-${size - 1}/${size}`
      )
      const tailBytes = new Uint8Array(await tail.arrayBuffer())
      expect(tailBytes.byteLength).toBe(size - FILE_VERSION_MAX_BYTES)
      expect(tailBytes.slice(-end.length)).toEqual(end)
      // A new version would lose it, as nothing could keep it: it is refused.
      const replaced = await instance.request(`${file}&replace=1`, { method: "PUT", body: "id\n" })
      expect(replaced.status).toBe(409)
      expect(await replaced.json()).toMatchObject({ code: "CONFLICT" })
      // So is one that names the revision it read, with the reason, leaving
      // the file and nothing staged.
      const named = await instance.request(file, {
        method: "PUT",
        headers: { "if-match": "rev_seen" },
        body: "id\n",
      })
      expect(named.status).toBe(409)
      expect(await named.json()).toMatchObject({
        code: "CONFLICT",
        error: expect.stringContaining("larger than 64 MiB"),
      })
      expect((await stat(onDisk)).size).toBe(size)
      expect(await readdir(stagingDirectory())).toEqual([])

      // Back within the limit, its history resumes.
      setSystemTime(new Date("2026-10-20T10:00:00.000Z"))
      await writeFile(onDisk, "id\n1\n")
      noteSpaceChanged(spaceId)
      expect(
        await recordExternalFileChanges({ spaceId, paths: ["data/feedback.csv"] })
      ).toEqual({ recorded: ["data/feedback.csv"], tooLarge: [] })
      expect((await versions("data/feedback.csv")).length).toBe(kept + 1)
      expect(await page()).not.toHaveProperty("noHistory")
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("names the Docs that use a file on the file's page", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      const instance = app()
      await instance.request(
        `/api/spaces/${spaceId}/documents/file?path=notes/readme/error.png`,
        { method: "PUT", body: "png" }
      )
      await writeDoc(spaceId, "notes/readme", "# Readme\n\n![Signup error](readme/error.png)", {
        updatedBy: "test",
        source: "rest-api",
      })
      await getSpaceLinkGraph(spaceId)
      const page = await instance.request(
        `/api/spaces/${spaceId}/documents/page?path=notes/readme/error.png`
      )
      const filePage = (await page.json()) as {
        page: { backlinks?: unknown; version?: string }
      }
      expect(filePage.page.backlinks).toEqual([
        { path: "notes/readme", context: "Signup error", count: 1 },
      ])
      // A deleted Doc goes from them at once, its sentence with it, though
      // the graph has yet to be rebuilt.
      await writeDoc(spaceId, "draft", "# Draft\n\n![Private draft caption](notes/readme/error.png)", {
        updatedBy: "test",
        source: "rest-api",
      })
      await getSpaceLinkGraph(spaceId)
      const pageBacklinks = async () =>
        ((await (
          await instance.request(
            `/api/spaces/${spaceId}/documents/page?path=notes/readme/error.png`
          )
        ).json()) as { page: { backlinks?: Array<{ path: string }> } }).page.backlinks
      expect((await pageBacklinks())?.map((link) => link.path).sort()).toEqual([
        "draft",
        "notes/readme",
      ])
      expect(
        (
          await instance.request(`/api/spaces/${spaceId}/documents/delete`, {
            method: "POST",
            body: JSON.stringify({ path: "draft" }),
          })
        ).status
      ).toBe(200)
      expect(JSON.stringify(await pageBacklinks())).not.toContain("Private draft")

      // The Doc's page gives the file's version, which loads it for good.
      const docPage = (await (
        await instance.request(`/api/spaces/${spaceId}/documents/page?path=notes/readme`)
      ).json()) as { page: { embeds?: Record<string, string> } }
      const version = docPage.page.embeds?.["notes/readme/error.png"]
      expect(version).toBeString()
      // The file's own page gives the same version.
      expect(filePage.page.version).toBe(version)
      const file = await instance.request(
        `/api/spaces/${spaceId}/documents/file?path=notes/readme/error.png&v=${encodeURIComponent(version!)}`
      )
      expect(file.headers.get("cache-control")).toContain("immutable")

      // Replaced with its modification time kept, the file still gets a new
      // version, so no browser keeps showing the old bytes.
      const onDisk = join(root, "spaces", spaceId, "docs", "notes", "readme", "error.png")
      const { mtime } = await stat(onDisk)
      await writeFile(onDisk, "new png")
      await utimes(onDisk, mtime, mtime)
      noteSpaceChanged(spaceId)
      const replaced = (await (
        await instance.request(`/api/spaces/${spaceId}/documents/page?path=notes/readme`)
      ).json()) as { page: { embeds?: Record<string, string> } }
      expect(replaced.page.embeds?.["notes/readme/error.png"]).toBeString()
      expect(replaced.page.embeds?.["notes/readme/error.png"]).not.toBe(version)
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("moves a Doc together with its folder of sub-Docs and files", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      const docs = join(root, "spaces", spaceId, "docs")
      await writeDoc(spaceId, "notes/readme/details", "# Details", {
        updatedBy: "test",
        source: "rest-api",
      })
      await writeFile(join(docs, "notes", "readme", "error.png"), "png")
      noteSpaceChanged(spaceId)

      // A child renamed before the move.
      await writeDoc(spaceId, "notes/readme/draft", "# Draft", {
        updatedBy: "test",
        source: "rest-api",
      })
      expect(
        (await renameDocAndSync(spaceId, "notes/readme/draft", "notes/readme/final"))
          .error
      ).toBeNull()

      // A Docs-only credential can't move the file in the Doc's folder.
      expect(
        await renameDocAndSync(spaceId, "notes/readme", "guides/start", {
          scopes: ["docs:write"],
        })
      ).toMatchObject({ forbidden: true, renamed: [] })
      expect(
        await readFile(join(docs, "notes", "readme", "error.png"), "utf8")
      ).toBe("png")

      expect(
        (await renameDocAndSync(spaceId, "notes/readme", "guides/start")).error
      ).toBeNull()
      expect(await readFile(join(docs, "guides", "start.md"), "utf8")).toBe(
        "# Readme"
      )
      expect(
        await readFile(join(docs, "guides", "start", "details.md"), "utf8")
      ).toBe("# Details")
      expect(
        await readFile(join(docs, "guides", "start", "error.png"), "utf8")
      ).toBe("png")
      expect(
        await readdir(join(docs, "notes", "readme"), { recursive: true }).catch(
          () => "gone"
        )
      ).toEqual("gone")

      // A folder with no Doc of its own is not a Doc's: nothing moves.
      const move = (path: string, to: string) =>
        app().request(`/api/spaces/${spaceId}/documents/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, to }),
        })
      expect((await move("guides", "elsewhere")).status).toBe(404)
      expect(
        await readFile(join(docs, "guides", "start", "error.png"), "utf8")
      ).toBe("png")

      // Moving back to where it was reclaims the old path, and keeps the
      // way to a child renamed in between.
      expect(
        (await renameDocAndSync(spaceId, "guides/start/details", "guides/start/more"))
          .error
      ).toBeNull()
      expect((await move("guides/start", "notes/readme")).status).toBe(200)
      expect((await resolveDocAlias(spaceId, "notes/readme/details")).path).toBe(
        "notes/readme/more"
      )
      expect((await resolveDocAlias(spaceId, "notes/readme/draft")).path).toBe(
        "notes/readme/final"
      )

      // An HTML-only credential can't move the Doc in an HTML Doc's folder.
      const board = await writeWidget(
        spaceId,
        { ...htmlDocument(), id: "boards/plan", name: "Plan" },
        "<h1>Plan</h1>"
      )
      board.release?.()
      await writeDoc(spaceId, "boards/plan/notes", "# Notes", {
        updatedBy: "test",
        source: "rest-api",
      })
      noteSpaceChanged(spaceId)
      expect(
        await moveHtmlDocument(spaceId, "boards/plan", "boards/later", {
          scopes: ["widgets:write"],
        })
      ).toMatchObject({ ok: false, kind: "forbidden" })
      expect(
        await readFile(join(docs, "boards", "plan", "notes.md"), "utf8")
      ).toBe("# Notes")
      expect(
        await readFile(join(docs, "notes", "readme", "error.png"), "utf8")
      ).toBe("png")
      expect(await readFile(join(docs, "notes", "readme.md"), "utf8")).toBe(
        "# Readme"
      )
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("archives and deletes a Doc with its folder, keeping files used elsewhere", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      const instance = app()
      setSystemTime(new Date("2026-10-20T09:00:00.000Z"))
      const docs = join(root, "spaces", spaceId, "docs")
      const options = { updatedBy: "test", source: "rest-api" as const }
      // details is kept because elsewhere links to it, and so is what it
      // embeds; elsewhere embeds shared.png through an old path's alias.
      await writeDoc(
        spaceId,
        "notes/readme/details",
        "# Details\n\n![Inner](/notes/readme/inner.png)",
        options
      )
      await mkdir(join(docs, "notes", "readme"), { recursive: true })
      await writeFile(join(docs, "notes", "readme", "shared.png"), "shared")
      await writeFile(join(docs, "notes", "readme", "own.png"), "own")
      await writeFile(join(docs, "notes", "readme", "inner.png"), "inner")
      noteSpaceChanged(spaceId)
      await recordDocAlias(spaceId, "old-shot.png", "notes/readme/shared.png", "exact")
      const inFolderBoard = await writeWidget(
        spaceId,
        { ...htmlDocument(), id: "notes/readme/board", name: "Board" },
        "<h1>Board</h1>"
      )
      inFolderBoard.release?.()
      await writeDoc(
        spaceId,
        "elsewhere",
        "# Elsewhere\n\n![Shot](/old-shot.png) and [details](/notes/readme/details) on the [board](/notes/readme/board)",
        options
      )
      noteSpaceChanged(spaceId)
      await getSpaceLinkGraph(spaceId)
      const post = (action: string, body: unknown) =>
        instance.request(`/api/spaces/${spaceId}/documents/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const listed = async () => {
        const paths = (
          await buildDocumentCatalog({ workspaceRoot: root, spaceId })
        ).entries.flatMap((entry) =>
          entry.kind === "document" && entry.descriptor.path.startsWith("notes/readme")
            ? [entry.descriptor.path]
            : []
        )
        return Promise.all(
          paths.map(async (path) => [
            path,
            Boolean(await getDocArchiveInfo(spaceId, path)),
          ] as const)
        )
      }

      const uses = await instance.request(
        `/api/spaces/${spaceId}/documents/uses?path=notes/readme`
      )
      expect(
        ((await uses.json()) as { items: Array<{ path: string; usedBy: string[] }> }).items
          .map((item) => [item.path, item.usedBy])
          .sort()
      ).toEqual([
        ["notes/readme", []],
        ["notes/readme/board", ["elsewhere"]],
        ["notes/readme/details", ["elsewhere"]],
        ["notes/readme/inner.png", ["notes/readme/details"]],
        ["notes/readme/own.png", []],
        ["notes/readme/shared.png", ["elsewhere"]],
      ])

      // Archiving and restoring the Doc takes its folder along, however the
      // path's case is written.
      expect((await post("archive", { path: "Notes/Readme" })).status).toBe(200)
      expect((await listed()).every(([, archived]) => archived)).toBe(true)
      expect((await post("restore", { path: "notes/readme" })).status).toBe(200)
      expect((await listed()).every(([, archived]) => !archived)).toBe(true)

      // A path to keep that isn't in the folder is refused, deleting nothing.
      expect(
        (await post("delete", { path: "notes/readme", keep: ["notes/readme/missing.png"] }))
          .status
      ).toBe(400)
      expect((await listed()).length).toBe(6)

      // Deleting it takes its folder too, except what another Doc uses,
      // which keeps its place in the Space's order.
      const space = await readSpace(spaceId)
      await writeSpace({
        ...space.data!,
        settings: {
          ...space.data!.settings,
          docOrder: ["notes/readme", "notes/readme/own.png", "notes/readme/shared.png"],
        },
      })
      expect((await post("delete", { path: "notes/readme" })).status).toBe(200)
      expect((await readSpace(spaceId)).data?.settings["docOrder"]).toEqual([
        "notes/readme",
        "notes/readme/shared.png",
      ])
      expect((await listed()).map(([path]) => path).sort()).toEqual([
        "notes/readme/board",
        "notes/readme/details",
        "notes/readme/inner.png",
        "notes/readme/shared.png",
      ])
      expect(
        await readFile(join(docs, "notes", "readme", "shared.png"), "utf8")
      ).toBe("shared")
      // HTML tools delete an HTML Doc alone: its folder is not theirs.
      const board = await writeWidget(
        spaceId,
        { ...htmlDocument(), id: "boards/plan", name: "Plan" },
        "<h1>Plan</h1>"
      )
      board.release?.()
      await writeDoc(spaceId, "boards/plan/notes", "# Notes", options)
      noteSpaceChanged(spaceId)
      expect((await deleteHtmlDocument(spaceId, "boards/plan")).ok).toBe(true)
      expect(await readFile(join(docs, "boards", "plan", "notes.md"), "utf8")).toBe(
        "# Notes"
      )

      // The alias that leads to a kept file still does.
      expect((await resolveDocAlias(spaceId, "old-shot.png")).path).toBe(
        "notes/readme/shared.png"
      )
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("serves a file as it was at an earlier moment, for an old Doc version", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      const instance = app()
      const url = (query: string) =>
        `/api/spaces/${spaceId}/documents/file?path=design/flow.png${query}`
      const before = "2026-10-19T09:00:00.000Z"
      setSystemTime(new Date("2026-10-20T09:00:00.000Z"))
      await instance.request(url(""), { method: "PUT", body: "Monday" })
      const monday = "2026-10-20T12:00:00.000Z"
      setSystemTime(new Date("2026-10-21T09:00:00.000Z"))
      expect(
        (await instance.request(url("&replace=1"), { method: "PUT", body: "Tuesday" }))
          .status
      ).toBe(200)

      expect(await (await instance.request(url(""))).text()).toBe("Tuesday")
      const then = await instance.request(url(`&at=${encodeURIComponent(monday)}`))
      expect(await then.text()).toBe("Monday")
      expect(then.headers.get("cache-control")).toContain("immutable")
      const thenPart = await instance.request(url(`&at=${encodeURIComponent(monday)}`), {
        headers: { range: "bytes=3-" },
      })
      expect(thenPart.status).toBe(206)
      expect(await thenPart.text()).toBe("day")
      // A kept copy changed on disk is never served as that version, whole or in part.
      const keptCopies = (await readdir(join(root, "versions"), { recursive: true }))
        .map((entry) => join(root, "versions", String(entry)))
      let kept: string | undefined
      for (const candidate of keptCopies) {
        if ((await stat(candidate)).isFile() && (await readFile(candidate, "utf8")) === "Monday") {
          kept = candidate
        }
      }
      expect(kept).toBeDefined()
      await writeFile(kept!, "Mxnday")
      expect(
        (
          await instance.request(url(`&at=${encodeURIComponent(monday)}`), {
            headers: { range: "bytes=3-" },
          })
        ).status
      ).toBe(409)
      await writeFile(kept!, "Monday")
      expect(
        (
          await instance.request(url(`&at=${encodeURIComponent(monday)}`), {
            headers: { "if-none-match": then.headers.get("etag")! },
          })
        ).status
      ).toBe(304)
      // Nothing was kept from before the file existed: never today's file.
      expect(
        (await instance.request(url(`&at=${encodeURIComponent(before)}`))).status
      ).toBe(404)
    } finally {
      setSystemTime()
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("restores a Doc with the images it showed, leaving the shared image as it is", async () => {
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      const instance = app()
      setSystemTime(new Date("2026-10-20T09:00:00.000Z"))
      const docs = join(root, "spaces", spaceId, "docs")
      const request = (method: string, action: string, body?: unknown) =>
        instance.request(`/api/spaces/${spaceId}/documents${action}`, {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        })
      // The link differs from the file's name in case, and encodes its space.
      await instance.request(
        `/api/spaces/${spaceId}/documents/file?path=${encodeURIComponent("spec/Shot one.png")}`,
        { method: "PUT", body: "Monday" }
      )
      const created = await request("POST", "", {
        path: "spec",
        format: { id: "worktable.markdown", sourceVersion: 1 },
        lifetime: "durable",
        // Two spellings of one image get one copy.
        source: "# Spec\n\n![Shot](spec/shot%20one.png)\n\n![Again](./spec/Shot%20one.png#top)\n",
      })
      expect(created.status).toBe(201)
      const monday = (
        (await (await request("GET", "/versions?path=spec&all=true")).json()) as {
          versions: Array<{ id: string }>
        }
      ).versions.at(-1)!.id

      // Tuesday: a new screenshot, and the spec changes.
      setSystemTime(new Date("2026-10-21T09:00:00.000Z"))
      await instance.request(
        `/api/spaces/${spaceId}/documents/file?path=${encodeURIComponent("spec/Shot one.png")}&replace=1`,
        { method: "PUT", body: "Tuesday" }
      )
      const tuesday = await request("PUT", "", {
        path: "spec",
        source: "# Spec\n\nRewritten.\n\n![Shot](spec/shot%20one.png)\n",
        expectedRevision: (await readRegisteredDocumentSource({ spaceId, path: "spec" }))
          .sourceRevision,
      })
      expect(tuesday.status).toBe(200)

      const restored = await request("POST", "/restore-version", {
        path: "spec",
        versionId: monday,
        expectedRevision: (await readRegisteredDocumentSource({ spaceId, path: "spec" }))
          .sourceRevision,
      })
      expect(restored.status).toBe(200)
      const body = (await restored.json()) as {
        keptImages: string[]
        sourceRevision: string
      }
      const day = new Date(Date.parse(monday.slice(0, 10))).toISOString().slice(0, 10)
      expect(body.keptImages).toEqual([`spec/Shot one-${day}.png`])
      // The restored spec shows Monday's screenshot, kept as a copy beside it.
      expect(await readFile(join(docs, "spec.md"), "utf8")).toBe(
        `# Spec\n\n![Shot](spec/Shot%20one-${day}.png)\n\n![Again](spec/Shot%20one-${day}.png)\n`
      )
      expect(await readFile(join(docs, "spec", `Shot one-${day}.png`), "utf8")).toBe(
        "Monday"
      )
      // The shared screenshot, which other Docs may use, stays as it is.
      expect(await readFile(join(docs, "spec", "Shot one.png"), "utf8")).toBe("Tuesday")
      // The revision returned is the Doc's current one.
      expect(body.sourceRevision).toBe(
        (await readRegisteredDocumentSource({ spaceId, path: "spec" })).sourceRevision
      )
    } finally {
      setSystemTime()
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })

  it("deletes mixed folders with common write authority, files in them included", async () => {
    const instance = app()
    const forbiddenDelete = await instance.request(
      `/api/spaces/${spaceId}/documents/delete-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:read",
        },
        body: JSON.stringify({ path: "notes" }),
      }
    )
    expect(forbiddenDelete.status).toBe(403)

    const resumeDocumentMutations = yjsManager.pauseWorkspaceMutations()
    try {
      const changingDelete = await instance.request(
        `/api/spaces/${spaceId}/documents/delete-folder`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-scopes": "documents:write",
          },
          body: JSON.stringify({ path: "notes" }),
        }
      )
      expect(changingDelete.status).toBe(409)
      expect((await readDoc(spaceId, "notes/readme")).data).toBe("# Readme")
      const materialized = await buildDocumentCatalog({
        workspaceRoot: root,
        spaceId,
      })
      expect(
        materialized.entries.flatMap((entry) =>
          entry.kind === "document" &&
          (entry.descriptor.path === "notes" ||
            entry.descriptor.path.startsWith("notes/"))
            ? [entry.handle.identity]
            : []
        )
      ).toEqual(["durable", "durable", "durable"])
    } finally {
      resumeDocumentMutations()
    }

    const unclaimed = join(root, "spaces", spaceId, "docs", "notes", "keep.txt")
    await mkdir(join(root, "spaces", spaceId, "docs", "notes"), {
      recursive: true,
    })
    await writeFile(unclaimed, "Keep this file")
    const deleted = await instance.request(
      `/api/spaces/${spaceId}/documents/delete-folder`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-scopes": "documents:write",
        },
        body: JSON.stringify({ path: "notes" }),
      }
    )
    const deletedBody = await deleted.json()
    expect(deleted.status).toBe(200)
    expect(deletedBody).toMatchObject({
      ok: true,
      path: "notes",
      count: 4,
      paths: expect.arrayContaining([
        "notes/keep.txt",
        "notes/old",
        "notes/readme",
        "notes/status",
      ]),
    })
    expect((await readDoc(spaceId, "notes/readme")).data).toBeNull()
    expect((await readWidget(spaceId, "notes/status")).data).toBeNull()
    // Every file in the folder is part of it, so it goes too.
    await expect(readFile(unclaimed, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  }, 10_000)
})

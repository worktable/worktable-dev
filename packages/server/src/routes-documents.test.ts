import { writeManagedFixtureHtml as writeWidget } from "./fixtures/managed-content.ts"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  access,
  mkdir,
  readdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
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
import { renameDocAndSync } from "./doc-rename.ts"
import { getSpaceLinkGraph } from "./link-graph.ts"
import {
  readRegisteredDocumentSource,
  recordExternalFileChanges,
} from "./document-write-service.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts"
import {
  getDocArchiveInfo,
  readDoc,
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
    const previous = process.env["WORKTABLE_FILES_PREVIEW"]
    process.env["WORKTABLE_FILES_PREVIEW"] = "1"
    try {
      const instance = app()
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
      if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"]
      else process.env["WORKTABLE_FILES_PREVIEW"] = previous
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

    const previous = process.env["WORKTABLE_FILES_PREVIEW"]
    try {
      process.env["WORKTABLE_FILES_PREVIEW"] = "0"
      expect((await upload("design/error.png", "png")).status).toBe(404)

      process.env["WORKTABLE_FILES_PREVIEW"] = "1"
      expect(
        (
          await upload("design/error.png", "png", {
            "x-test-scopes": "documents:read",
          })
        ).status
      ).toBe(403)
      // A Doc's name is for the Doc tools.
      expect((await upload("design/notes.md", "# Notes")).status).toBe(415)

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
      if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"]
      else process.env["WORKTABLE_FILES_PREVIEW"] = previous
    }
  })

  it("keeps a version when a file with history changes on disk", async () => {
    const previous = process.env["WORKTABLE_FILES_PREVIEW"]
    process.env["WORKTABLE_FILES_PREVIEW"] = "1"
    try {
      const instance = app()
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
      ).toEqual({ recorded: ["data/feedback.csv"] })
      const after = await versions("data/feedback.csv")
      expect(after.length).toBe(before + 1)
      expect(after[0]?.source).toBe("filesystem")
      // The same bytes again keep nothing new.
      expect(
        await recordExternalFileChanges({ spaceId, paths: ["data/feedback.csv"] })
      ).toEqual({ recorded: [] })
      // A quick further change, saved atomically and reported only by its
      // temporary name, continues that version rather than adding one.
      await writeFile(join(docs, "data", "feedback.csv"), "id\n1\n2\n3\n")
      noteSpaceChanged(spaceId)
      expect(
        await recordExternalFileChanges({
          spaceId,
          paths: ["data/feedback.csv.tmp"],
        })
      ).toEqual({ recorded: ["data/feedback.csv"] })
      expect((await versions("data/feedback.csv")).length).toBe(before + 1)

      // A file nobody has kept yet has no history to add to.
      await writeFile(join(docs, "data", "dropped.csv"), "id\n")
      noteSpaceChanged(spaceId)
      expect(
        await recordExternalFileChanges({ spaceId, paths: ["data/dropped.csv"] })
      ).toEqual({ recorded: [] })
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"]
      else process.env["WORKTABLE_FILES_PREVIEW"] = previous
    }
  })

  it("names the Docs that use a file on the file's page", async () => {
    const previous = process.env["WORKTABLE_FILES_PREVIEW"]
    process.env["WORKTABLE_FILES_PREVIEW"] = "1"
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
      expect(
        ((await page.json()) as { page: { backlinks?: unknown } }).page.backlinks
      ).toEqual([{ path: "notes/readme", context: "Signup error", count: 1 }])
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"]
      else process.env["WORKTABLE_FILES_PREVIEW"] = previous
    }
  })

  it("moves a Doc together with its folder of sub-Docs and files", async () => {
    const previous = process.env["WORKTABLE_FILES_PREVIEW"]
    process.env["WORKTABLE_FILES_PREVIEW"] = "1"
    try {
      const docs = join(root, "spaces", spaceId, "docs")
      await writeDoc(spaceId, "notes/readme/details", "# Details", {
        updatedBy: "test",
        source: "rest-api",
      })
      await writeFile(join(docs, "notes", "readme", "error.png"), "png")
      noteSpaceChanged(spaceId)

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

      // Moving back to where it was reclaims the old path.
      expect((await move("guides/start", "notes/readme")).status).toBe(200)
      expect(
        await readFile(join(docs, "notes", "readme", "error.png"), "utf8")
      ).toBe("png")
      expect(await readFile(join(docs, "notes", "readme.md"), "utf8")).toBe(
        "# Readme"
      )
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"]
      else process.env["WORKTABLE_FILES_PREVIEW"] = previous
    }
  })

  it("deletes mixed folders with common write authority while preserving unclaimed files", async () => {
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
      count: 3,
      paths: expect.arrayContaining([
        "notes/old",
        "notes/readme",
        "notes/status",
      ]),
    })
    expect((await readDoc(spaceId, "notes/readme")).data).toBeNull()
    expect((await readWidget(spaceId, "notes/status")).data).toBeNull()
    expect(await readFile(unclaimed, "utf8")).toBe("Keep this file")
  }, 10_000)
})

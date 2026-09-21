import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  access,
  mkdir,
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
import { ownerIdentity } from "./auth.ts"
import { createAnnotation } from "./annotation-store.ts"
import { HOSTED_BROWSER_RUNTIME_SCOPES } from "./hosted-auth.ts"
import { documentsRouter } from "./routes/documents.ts"
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
import { readWidget, setWidgetArchived, writeWidget } from "./widget-store.ts"
import { yjsManager } from "./yjs-manager.ts"
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
    const v1CommonWrite = await instance.request(
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
          body: "Must stay in the released V1 store",
        }),
      }
    )
    expect(v1CommonWrite.status).toBe(409)
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
    ).rejects.toMatchObject({ code: "ENOENT" })

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

    const conflicting = await writeWidget(
      spaceId,
      {
        ...htmlDocument(),
        id: "library/readme",
        name: "Conflicting readme",
      },
      "<h1>Conflict</h1>"
    )
    conflicting.release?.()
    const conflict = await resolve("notes/readme")
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: "CONFLICT" })
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
      (await readWidget(spaceId, "notes/status")).data?.archive
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

  it("moves and archives HTML-only folders despite unrelated malformed Doc metadata", async () => {
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
    expect(movedHtmlOnly.status).toBe(200)
    expect(await movedHtmlOnly.json()).toMatchObject({
      count: 1,
      renamed: [{ from: "dashboards/live", to: "reports/live" }],
    })

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

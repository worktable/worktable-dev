import { rotateWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Hono } from "hono"
import fc from "fast-check"
import {
  emptyQuickdrawDocument,
  parseQuickdrawDocument,
  sourceCategory,
  type SpaceFile,
} from "@worktable/types"
import { listAnnotations, replyAnnotation } from "./annotation-store.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import {
  DOCUMENT_RENDER_DISPOSITIONS,
  DocumentFormatRegistry,
} from "./document-format-registry.ts"
import {
  createDocumentAnnotationForPath,
  listDocumentAnnotationsForPath,
} from "./document-annotation-service.ts"
import { readDocument } from "./document-query.ts"
import {
  checkpointRegisteredDocument,
  createRegisteredDocument,
  deleteRegisteredDocument,
  moveRegisteredDocument,
  readRegisteredDocumentSource,
  replaceRegisteredDocument,
  restoreRegisteredDocumentVersion,
  setRegisteredDocumentArchived,
} from "./document-write-service.ts"
import {
  listDocumentGenerationsV2,
  readDocumentGenerationV2,
} from "./document-version-store-v2.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { assertPublicOperationOutput } from "./mcp/output-schemas.ts"
import { recordIndex } from "./record-index.ts"
import { documentsRouter } from "./routes/documents.ts"
import { invalidateSearchIndex, search } from "./search-index.ts"
import { syncExternalDocChange } from "./external-doc-sync.ts"
import { getDocArchiveInfo, writeDoc, writeSpace } from "./store.ts"
import {
  documentDataV2Directory,
  documentVersionsV2Directory,
} from "./workspace-storage-v2.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const spaceId = "format-conformance"
let workspaceRoot = ""
let appRoot = ""

function app(scopes: string[] = ["*"]): Hono {
  const instance = new Hono()
  instance.use("*", async (context, next) => {
    context.set("identity", { ...ownerIdentity(), scopes })
    return next()
  })
  instance.route("/api/spaces/:spaceId/documents", documentsRouter)
  return instance
}

async function post(
  instance: Hono,
  route: string,
  body: Record<string, unknown>
): Promise<Response> {
  return instance.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "worktable-format-ws-"))
  appRoot = await mkdtemp(join(tmpdir(), "worktable-format-app-"))
  setWorkspaceRootOverride(workspaceRoot)
  setAppDirOverride(appRoot)
  await ensureWorkspaceManifest()
  const now = new Date().toISOString()
  const space: SpaceFile = {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Format conformance",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
  await writeSpace(space)
})

afterEach(async () => {
  recordIndex.stop()
  invalidateSearchIndex()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all(
    [workspaceRoot, appRoot].map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("registered file format conformance", () => {
  it("gives a fourth format common discovery, search, and folder lifecycle", async () => {
    const source = join(
      workspaceRoot,
      "spaces",
      spaceId,
      "docs",
      "diagrams",
      "system-map.excalidraw"
    )
    await mkdir(dirname(source), { recursive: true })
    await writeFile(
      source,
      JSON.stringify({ type: "excalidraw", elements: [] })
    )
    invalidateSearchIndex()

    const instance = app()
    const listed = await instance.request(`/api/spaces/${spaceId}/documents`)
    expect(listed.status).toBe(200)
    expect((await listed.json()).documents).toEqual([
      expect.objectContaining({
        kind: "document",
        path: "diagrams/system-map",
        format: { id: "worktable.excalidraw", sourceVersion: 1 },
        health: "supported",
        folderOperations: { move: true, archive: true, delete: true },
      }),
    ])

    expect(
      await readDocument({ spaceId, path: "diagrams/system-map" })
    ).toMatchObject({
      kind: "document",
      document: {
        format: { id: "worktable.excalidraw", sourceVersion: 1 },
        health: "supported",
      },
      projection: {
        kind: "metadata-only",
        reason: "projection-unavailable",
      },
    })

    const page = await instance.request(
      `/api/spaces/${spaceId}/documents/page?path=${encodeURIComponent(
        "diagrams/system-map"
      )}`
    )
    expect(page.status).toBe(200)
    expect(await page.json()).toMatchObject({
      page: {
        kind: "document",
        document: {
          path: "diagrams/system-map",
          format: { id: "worktable.excalidraw", sourceVersion: 1 },
        },
        renderer: null,
        capabilities: {
          rawSource: true,
          versions: false,
          annotations: false,
          sharing: false,
        },
      },
    })

    const sourceDownload = await instance.request(
      `/api/spaces/${spaceId}/documents/source?path=${encodeURIComponent(
        "diagrams/system-map"
      )}`
    )
    expect(sourceDownload.status).toBe(200)
    expect(sourceDownload.headers.get("content-disposition")).toContain(
      "system-map.excalidraw"
    )
    expect(await sourceDownload.text()).toContain('"excalidraw"')

    const resolvedRoute = await instance.request(
      `/api/spaces/${spaceId}/documents/resolve?path=${encodeURIComponent(
        "diagrams/system-map"
      )}`
    )
    expect(resolvedRoute.status).toBe(200)
    expect(await resolvedRoute.json()).toEqual({
      target: { path: "diagrams/system-map" },
    })

    await expect(
      dispatchOperation("docs.write", {
        spaceId,
        docPath: "diagrams/system-map",
        content: "# Replacement",
      })
    ).rejects.toThrow("Another document already uses this path")
    await access(source)
    await expect(
      access(
        join(
          workspaceRoot,
          "spaces",
          spaceId,
          "docs",
          "diagrams",
          "system-map.md"
        )
      )
    ).rejects.toThrow()

    const provisionalSource = join(
      workspaceRoot,
      "spaces",
      spaceId,
      "docs",
      "scratch",
      "unmoved.excalidraw"
    )
    await mkdir(dirname(provisionalSource), { recursive: true })
    await writeFile(
      provisionalSource,
      JSON.stringify({ type: "excalidraw", elements: [] })
    )
    const deletedProvisional = await post(
      instance,
      `/api/spaces/${spaceId}/documents/delete-folder`,
      { path: "scratch" }
    )
    expect(deletedProvisional.status).toBe(200)
    await expect(access(provisionalSource)).rejects.toMatchObject({
      code: "ENOENT",
    })

    const results = await search("system map", {
      spaceId,
      documentAccess: "common",
    })
    expect(results).toContainEqual(
      expect.objectContaining({
        type: "doc",
        path: "diagrams/system-map",
        format: { id: "worktable.excalidraw", sourceVersion: 1 },
        health: "supported",
      })
    )

    const moved = await post(
      instance,
      `/api/spaces/${spaceId}/documents/move-folder`,
      { oldPath: "diagrams", newPath: "designs" }
    )
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({
      count: 1,
      renamed: [{ from: "diagrams/system-map", to: "designs/system-map" }],
    })
    const movedSource = join(
      workspaceRoot,
      "spaces",
      spaceId,
      "docs",
      "designs",
      "system-map.excalidraw"
    )
    expect(await readFile(movedSource, "utf8")).toContain('"excalidraw"')

    const archived = await post(
      instance,
      `/api/spaces/${spaceId}/documents/archive-folder`,
      { path: "designs", reason: "Superseded" }
    )
    expect(archived.status).toBe(200)
    expect(
      await getDocArchiveInfo(spaceId, "designs/system-map")
    ).toMatchObject({ reason: "Superseded" })

    const restored = await post(
      instance,
      `/api/spaces/${spaceId}/documents/restore-folder`,
      { path: "designs" }
    )
    expect(restored.status).toBe(200)
    expect(
      await getDocArchiveInfo(spaceId, "designs/system-map")
    ).toBeUndefined()

    const deleted = await post(
      instance,
      `/api/spaces/${spaceId}/documents/delete-folder`,
      { path: "designs" }
    )
    expect(deleted.status).toBe(200)
    await expect(access(movedSource)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves current bytes when a legacy document first enters V2 history", async () => {
    await writeDoc(spaceId, "notes/legacy-handoff", "# Tracked legacy\n", {
      updatedBy: "test",
      source: "test",
    })
    const legacySource = join(
      workspaceRoot,
      "spaces",
      spaceId,
      "docs",
      "notes",
      "legacy-handoff.md"
    )
    const untrackedLegacyBytes = new TextEncoder().encode(
      "# Uncaptured external edit\n"
    )
    await writeFile(legacySource, untrackedLegacyBytes)
    const manifestPath = join(workspaceRoot, "worktable.workspace.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: number
    }
    manifest.version = 2
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const legacyRead = await readRegisteredDocumentSource({
      spaceId,
      path: "notes/legacy-handoff",
    })
    const legacyReplacement = await replaceRegisteredDocument({
      spaceId,
      path: "notes/legacy-handoff",
      bytes: new TextEncoder().encode("# Replacement\n"),
      expectedRevision: legacyRead.sourceRevision,
      updatedBy: "test",
      source: "test",
    })
    const migratedGenerations = await listDocumentGenerationsV2({
      workspaceRoot,
      spaceId,
      documentId: legacyReplacement.documentId,
    })
    const migratedRecovery = migratedGenerations.find(
      (generation) => generation.reason === "Pre-edit recovery point"
    )
    expect(migratedRecovery).toBeDefined()
    expect(
      (
        await readDocumentGenerationV2({
          workspaceRoot,
          spaceId,
          documentId: legacyReplacement.documentId,
          generationId: migratedRecovery!.id,
        })
      )?.authoredSource.entries[0]?.bytes
    ).toEqual(untrackedLegacyBytes)

    expect(
      new TextDecoder().decode(
        (
          await readRegisteredDocumentSource({
            spaceId,
            path: "notes/legacy-handoff",
          })
        ).bytes
      )
    ).toBe("# Replacement\n")
  })

  it("validates Quickdraw writes before changing saved ink and projects typed notes", async () => {
    const copiedSource = join(
      workspaceRoot,
      "spaces",
      spaceId,
      "docs",
      "copied.quickdraw"
    )
    await writeFile(copiedSource, JSON.stringify(emptyQuickdrawDocument()))
    const copiedPage = await app().request(
      `/api/spaces/${spaceId}/documents/page?path=copied`
    )
    expect(await copiedPage.json()).toMatchObject({
      page: { renderer: null, capabilities: { rawSource: true } },
    })
    const manifestPath = join(workspaceRoot, "worktable.workspace.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 2 }))
    const editablePage = await app().request(
      `/api/spaces/${spaceId}/documents/page?path=copied`
    )
    expect(await editablePage.json()).toMatchObject({
      page: {
        renderer: { key: "quickdraw", disposition: "trusted-component" },
      },
    })
    const drawing = emptyQuickdrawDocument("Thinking through queues")
    drawing.snapshot.document.store.ink = {
      id: "ink",
      typeName: "shape",
      type: "draw",
      x: 10,
      y: 20,
      rot: 0,
      z: 1,
      props: {
        color: "black",
        size: "m",
        pts: [0, 0, 0.2, 20, 30, 0.8],
        done: true,
        isPen: true,
      },
    }
    drawing.snapshot.document.store.note = {
      id: "note",
      typeName: "shape",
      type: "note",
      x: 100,
      y: 20,
      rot: 0,
      z: 2,
      props: {
        text: "Queue ownership",
        color: "yellow",
        size: "m",
        font: "draw",
        scale: 1,
      },
    }
    fc.assert(
      fc.property(fc.webUrl(), (src) => {
        const withRemoteImage = structuredClone(drawing)
        withRemoteImage.snapshot.document.store.asset = {
          id: "asset",
          typeName: "asset",
          w: 10,
          h: 10,
          src,
        }
        expect(() =>
          parseQuickdrawDocument(
            new TextEncoder().encode(JSON.stringify(withRemoteImage))
          )
        ).toThrow()
      }),
      { numRuns: 25 }
    )
    // Embedded images must not hide typed notes behind the default 512 KiB read cap.
    drawing.snapshot.document.store.asset = {
      id: "asset",
      typeName: "asset",
      w: 100,
      h: 100,
      src: `data:image/png;base64,${"A".repeat(600 * 1024)}`,
    }
    const bytes = new TextEncoder().encode(JSON.stringify(drawing))
    const created = await createRegisteredDocument({
      spaceId,
      path: "scratchpad",
      format: { id: "worktable.quickdraw", sourceVersion: 1 },
      bytes,
      createdBy: "test",
      source: "test",
    })
    expect(
      (await readRegisteredDocumentSource({ spaceId, path: "scratchpad" }))
        .bytes
    ).toEqual(bytes)
    expect(await readDocument({ spaceId, path: "scratchpad" })).toMatchObject({
      projection: {
        kind: "text",
        text: expect.stringContaining("Queue ownership"),
        headings: ["Thinking through queues"],
      },
    })
    for (const invalid of [
      { ...drawing, version: 2 },
      {
        ...drawing,
        snapshot: {
          document: {
            store: {
              bad: {
                id: "bad",
                typeName: "asset",
                w: 10,
                h: 10,
                src: "https://example.com/tracker.png",
              },
            },
          },
        },
      },
      {
        ...drawing,
        snapshot: {
          document: {
            store: {
              ink: {
                ...drawing.snapshot.document.store.ink,
                props: { pts: [1, 2], color: "black", size: "m" },
              },
            },
          },
        },
      },
    ]) {
      await expect(
        replaceRegisteredDocument({
          spaceId,
          path: "scratchpad",
          expectedRevision: created.sourceRevision,
          bytes: new TextEncoder().encode(JSON.stringify(invalid)),
          updatedBy: "test",
          source: "test",
        })
      ).rejects.toThrow()
      expect(
        (await readRegisteredDocumentSource({ spaceId, path: "scratchpad" }))
          .bytes
      ).toEqual(bytes)
    }
    // The same bytes after replacement must not accept an old browser's revision.
    await rotateWorkspaceCollaborationEpoch()
    await expect(
      replaceRegisteredDocument({
        spaceId,
        path: "scratchpad",
        expectedRevision: created.sourceRevision,
        bytes,
        updatedBy: "test",
        source: "test",
      })
    ).rejects.toThrow("changed")
    expect(
      (await readRegisteredDocumentSource({ spaceId, path: "scratchpad" }))
        .bytes
    ).toEqual(bytes)
  })

  it("gives a registered writable format fenced CRUD and exact versions", async () => {
    const manifestPath = join(workspaceRoot, "worktable.workspace.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: number
    }
    manifest.version = 2
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const builtinMarkdown = await createRegisteredDocument({
      spaceId,
      path: "notes/generic-api",
      format: { id: "worktable.markdown", sourceVersion: 1 },
      bytes: new TextEncoder().encode("# Generic API\n"),
      createdBy: "test",
      source: "test",
    })
    expect(
      new TextDecoder().decode(
        (
          await readRegisteredDocumentSource({
            spaceId,
            path: "notes/generic-api",
          })
        ).bytes
      )
    ).toBe("# Generic API\n")
    expect(builtinMarkdown.documentId).toMatch(/^doc_/)
    const markdownGenerationCount = (
      await listDocumentGenerationsV2({
        workspaceRoot,
        spaceId,
        documentId: builtinMarkdown.documentId,
      })
    ).length
    expect(await syncExternalDocChange(spaceId, "notes/generic-api")).toBe(
      false
    )
    expect(
      await listDocumentGenerationsV2({
        workspaceRoot,
        spaceId,
        documentId: builtinMarkdown.documentId,
      })
    ).toHaveLength(markdownGenerationCount)
    const editablePath = encodeURIComponent("notes/generic-api")
    expect(
      (
        await app(["documents:read"]).request(
          `/api/spaces/${spaceId}/documents/editable-source?path=${editablePath}`
        )
      ).status
    ).toBe(200)
    expect(
      (
        await app(["documents:write"]).request(
          `/api/spaces/${spaceId}/documents/editable-source?path=${editablePath}`
        )
      ).status
    ).toBe(403)
    const movedMarkdown = await dispatchOperation("documents.move", {
      spaceId,
      path: "notes/generic-api",
      to: "notes/generic-api-moved",
    })
    expect(() =>
      assertPublicOperationOutput("documents.move", movedMarkdown)
    ).not.toThrow()
    expect(movedMarkdown).toMatchObject({
      documentId: builtinMarkdown.documentId,
      from: "notes/generic-api",
      to: "notes/generic-api-moved",
      path: "notes/generic-api-moved",
    })
    expect(
      (
        await readRegisteredDocumentSource({
          spaceId,
          path: "notes/generic-api",
        })
      ).path
    ).toBe("notes/generic-api-moved")
    await expect(
      setRegisteredDocumentArchived({
        spaceId,
        path: "notes/generic-api",
        archived: true,
        archivedBy: "test",
      })
    ).rejects.toMatchObject({ reason: "conflict" })
    expect(
      await getDocArchiveInfo(spaceId, "notes/generic-api-moved")
    ).toBeUndefined()
    const richWrite = await writeDoc(
      spaceId,
      "notes/generic-api-moved",
      [{ type: "paragraph", content: "Rich edit" }],
      {
        updatedBy: "test",
        source: "test",
        managedIdentity: true,
      }
    )
    expect(richWrite).toMatchObject({ ok: true, storedAs: "json" })
    const richSource = await readRegisteredDocumentSource({
      spaceId,
      path: "notes/generic-api-moved",
    })
    expect(richSource.format.id).toBe("worktable.rich-text")
    const crossFormatRestore = await restoreRegisteredDocumentVersion({
      spaceId,
      path: "notes/generic-api-moved",
      versionId: builtinMarkdown.versionId,
      expectedRevision: richSource.sourceRevision,
      restoredBy: "test",
      source: "test",
    })
    expect(crossFormatRestore.documentId).toBe(builtinMarkdown.documentId)
    expect(
      new TextDecoder().decode(
        (
          await readRegisteredDocumentSource({
            spaceId,
            path: "notes/generic-api-moved",
          })
        ).bytes
      )
    ).toContain("Generic API")

    const registry = new DocumentFormatRegistry([
      {
        id: "worktable.excalidraw",
        extensions: [".excalidraw"],
        sourceVersions: [1],
        fileSource: { extension: ".excalidraw", discoveryVersion: 1 },
        rendererKey: null,
        renderDisposition: DOCUMENT_RENDER_DISPOSITIONS.attachmentOnly,
        capabilities: {
          authoring: "replace",
          publicProjection: "none",
          execution: "none",
        },
        versionedCompanionKeys: [],
        portableState: "none",
        async prepareWrite({ bytes }) {
          const scene = JSON.parse(new TextDecoder().decode(bytes)) as {
            type?: unknown
            elements?: unknown
          }
          if (scene.type !== "excalidraw" || !Array.isArray(scene.elements)) {
            throw new Error("Drawing source is invalid")
          }
          return {
            bytes: new TextEncoder().encode(`${JSON.stringify(scene)}\n`),
          }
        },
      },
    ])
    const format = { id: "worktable.excalidraw", sourceVersion: 1 } as const
    const firstBytes = new TextEncoder().encode(
      JSON.stringify({ type: "excalidraw", elements: [] })
    )
    const created = await createRegisteredDocument({
      spaceId,
      path: "drawings/system-map",
      format,
      bytes: firstBytes,
      createdBy: "test",
      source: "test",
      registry,
    })
    const instance = app()
    const restCreatedResponse = await post(
      instance,
      `/api/spaces/${spaceId}/documents`,
      {
        path: "notes/rest-attribution",
        format: { id: "worktable.markdown", sourceVersion: 1 },
        source: "# Human REST write\n",
        encoding: "utf8",
      }
    )
    expect(restCreatedResponse.status).toBe(201)
    const restCreated = (await restCreatedResponse.json()) as {
      documentId: string
      versionId: string
    }
    const restGeneration = await readDocumentGenerationV2({
      workspaceRoot,
      spaceId,
      documentId: restCreated.documentId,
      generationId: restCreated.versionId,
    })
    expect(
      sourceCategory(
        restGeneration?.manifest.source,
        restGeneration?.manifest.createdBy
      )
    ).toBe("human")
    const page = await instance.request(
      `/api/spaces/${spaceId}/documents/page?path=${encodeURIComponent(
        "drawings/system-map"
      )}`
    )
    expect(await page.json()).toMatchObject({
      page: { capabilities: { versions: true, annotations: true } },
    })
    const annotated = await post(
      instance,
      `/api/spaces/${spaceId}/documents/annotations`,
      {
        path: "drawings/system-map",
        category: "comment",
        body: "Keep the system boundary visible",
      }
    )
    expect(annotated.status).toBe(200)
    expect(
      await listAnnotations(spaceId, {
        target: { docPath: "drawings/system-map" },
      })
    ).toMatchObject({
      total: 1,
      annotations: [
        { target: { type: "doc", docPath: "drawings/system-map" } },
      ],
    })
    const commonOnly = await createDocumentAnnotationForPath({
      spaceId,
      path: "drawings/system-map",
      input: {
        selector: {
          type: "future-canvas.element-anchor",
          version: 1,
          data: { elementId: "shape-1" },
        },
        category: "comment",
        body: "Common-only selector",
      },
    })
    await expect(
      replyAnnotation(spaceId, commonOnly.annotation.id, "Legacy retry")
    ).rejects.toThrow("requires the common API")
    expect(
      (
        await listDocumentAnnotationsForPath({
          spaceId,
          path: "drawings/system-map",
        })
      ).annotations.find(
        (annotation) => annotation.id === commonOnly.annotation.id
      )?.thread
    ).toEqual([])
    const opened = await readRegisteredDocumentSource({
      spaceId,
      path: "drawings/system-map",
      registry,
    })
    expect(opened.documentId).toBe(created.documentId)
    expect(new TextDecoder().decode(opened.bytes)).toBe(
      `${JSON.stringify({ type: "excalidraw", elements: [] })}\n`
    )

    const externalBytes = new TextEncoder().encode(
      `${JSON.stringify({
        type: "excalidraw",
        elements: [{ id: "external", type: "text", text: "External edit" }],
      })}\n`
    )
    await writeFile(
      join(
        workspaceRoot,
        "spaces",
        spaceId,
        "docs",
        "drawings",
        "system-map.excalidraw"
      ),
      externalBytes
    )
    const externallyEdited = await readRegisteredDocumentSource({
      spaceId,
      path: "drawings/system-map",
      registry,
    })

    const secondBytes = new TextEncoder().encode(
      JSON.stringify({
        type: "excalidraw",
        elements: [{ id: "title", type: "text", text: "System map" }],
      })
    )
    await expect(
      replaceRegisteredDocument({
        spaceId,
        path: "drawings/system-map",
        bytes: secondBytes,
        expectedRevision: opened.sourceRevision,
        updatedBy: "test",
        source: "test",
        registry,
      })
    ).rejects.toMatchObject({ reason: "conflict" })
    const replaced = await replaceRegisteredDocument({
      spaceId,
      path: "drawings/system-map",
      bytes: secondBytes,
      expectedRevision: externallyEdited.sourceRevision,
      updatedBy: "test",
      source: "test",
      registry,
    })
    const checkpoint = await checkpointRegisteredDocument({
      spaceId,
      path: "drawings/system-map",
      expectedRevision: replaced.sourceRevision,
      createdBy: "test",
      source: "test",
      label: "Ready for review",
      registry,
    })
    const generations = await listDocumentGenerationsV2({
      workspaceRoot,
      spaceId,
      documentId: created.documentId,
    })
    expect(generations).toHaveLength(4)
    const recoveryPoint = generations.find(
      (generation) => generation.reason === "Pre-edit recovery point"
    )
    expect(recoveryPoint).toBeDefined()
    const recovered = await readDocumentGenerationV2({
      workspaceRoot,
      spaceId,
      documentId: created.documentId,
      generationId: recoveryPoint!.id,
    })
    expect(recovered?.authoredSource.entries).toHaveLength(1)
    expect(
      new TextDecoder().decode(recovered?.authoredSource.entries[0]?.bytes)
    ).toBe(new TextDecoder().decode(externalBytes))
    const versions = await instance.request(
      `/api/spaces/${spaceId}/documents/versions?all=true&path=${encodeURIComponent(
        "drawings/system-map"
      )}`
    )
    expect(versions.status).toBe(200)
    expect((await versions.json()).versions).toHaveLength(4)
    const invalidRestore = await post(
      instance,
      `/api/spaces/${spaceId}/documents/restore-version`,
      {
        path: "drawings/system-map",
        versionId: "../outside",
        expectedRevision: checkpoint.sourceRevision,
      }
    )
    expect(invalidRestore.status).toBe(400)
    expect(await invalidRestore.json()).toMatchObject({ code: "INVALID" })

    const restored = await restoreRegisteredDocumentVersion({
      spaceId,
      path: "drawings/system-map",
      versionId: created.versionId,
      expectedRevision: checkpoint.sourceRevision,
      restoredBy: "test",
      source: "test",
      registry,
    })
    expect(
      new TextDecoder().decode(
        (
          await readRegisteredDocumentSource({
            spaceId,
            path: "drawings/system-map",
            registry,
          })
        ).bytes
      )
    ).toBe(`${JSON.stringify({ type: "excalidraw", elements: [] })}\n`)

    const moved = await moveRegisteredDocument({
      spaceId,
      path: "drawings/system-map",
      to: "designs/system-map",
      registry,
    })
    expect(moved.documentId).toBe(created.documentId)
    expect(moved.sourceRevision).not.toBe(restored.sourceRevision)
    const movedAnnotations = await instance.request(
      `/api/spaces/${spaceId}/documents/annotations?path=${encodeURIComponent(
        "designs/system-map"
      )}`
    )
    expect(await movedAnnotations.json()).toMatchObject({
      total: 2,
      annotations: [
        { target: { path: "designs/system-map" } },
        { target: { path: "designs/system-map" } },
      ],
    })
    await createRegisteredDocument({
      spaceId,
      path: "designs/system-map/notes",
      format,
      bytes: firstBytes,
      createdBy: "test",
      source: "test",
      registry,
    })
    await setRegisteredDocumentArchived({
      spaceId,
      path: "designs/system-map",
      archived: true,
      archivedBy: "test",
      reason: "Superseded",
      registry,
    })
    expect(
      await getDocArchiveInfo(spaceId, "designs/system-map")
    ).toMatchObject({ reason: "Superseded" })
    expect(
      await getDocArchiveInfo(spaceId, "designs/system-map/notes")
    ).toBeUndefined()
    await setRegisteredDocumentArchived({
      spaceId,
      path: "designs/system-map",
      archived: false,
      archivedBy: "test",
      registry,
    })
    const sourcePath = join(
      workspaceRoot,
      "spaces",
      spaceId,
      "docs",
      "designs",
      "system-map.excalidraw"
    )
    await deleteRegisteredDocument({
      spaceId,
      path: "designs/system-map",
      registry,
    })
    await expect(access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" })
    await access(
      join(
        workspaceRoot,
        "spaces",
        spaceId,
        "docs",
        "designs",
        "system-map",
        "notes.excalidraw"
      )
    )
    await expect(
      access(
        documentDataV2Directory(workspaceRoot, spaceId, created.documentId)
      )
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      access(
        documentVersionsV2Directory(workspaceRoot, spaceId, created.documentId)
      )
    ).rejects.toMatchObject({ code: "ENOENT" })
    const retired = join(
      workspaceRoot,
      "versions",
      spaceId,
      ".retired",
      "documents",
      created.documentId
    )
    const retirementIds = await readdir(retired)
    expect(retirementIds).toHaveLength(1)
    expect(await readdir(join(retired, retirementIds[0]!))).toContain(
      created.versionId
    )
    const provisionalPath = join(
      workspaceRoot,
      "spaces",
      spaceId,
      "docs",
      "drawings",
      "untracked.excalidraw"
    )
    await mkdir(dirname(provisionalPath), { recursive: true })
    await writeFile(provisionalPath, firstBytes)
    await deleteRegisteredDocument({
      spaceId,
      path: "drawings/untracked",
      registry,
    })
    await expect(access(provisionalPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  }, 15_000)
})

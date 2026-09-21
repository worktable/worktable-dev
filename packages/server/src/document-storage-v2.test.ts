import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  DocumentAnnotationV2Schema,
  type AnnotationTarget,
  type DocumentFormatClaim,
  type DocumentId,
} from "@worktable/types"
import {
  readCompatibleDocumentAnnotationsV2,
  readDocumentAnnotationsV2,
  readDocumentPortableStateV2,
  translateDocumentAnnotationTargetV2ToLegacy,
  translateLegacyDocumentAnnotationTarget,
  writeDocumentAnnotationsV2,
  writeDocumentPortableStateV2,
} from "./document-data-v2.ts"
import {
  BUILTIN_DOCUMENT_COMPANIONS,
  BUILTIN_DOCUMENT_FORMATS,
  DOCUMENT_RENDER_DISPOSITIONS,
  DocumentFormatRegistry,
} from "./document-format-registry.ts"
import {
  listCompatibleDocumentVersionsV2,
  listDocumentGenerationsV2,
  pruneDocumentGenerationsV2,
  readCompatibleDocumentVersionV2,
  readDocumentGenerationV2,
  writeDocumentGenerationV2,
  type DocumentGenerationPayloadCompanion,
  type DocumentGenerationPayloadSource,
} from "./document-version-store-v2.ts"
import { withAnnotationStoreLock } from "./annotation-store.ts"
import {
  documentGenerationV2Directory,
  documentPortableStateV2RevisionDirectory,
  readWorkspaceStorageLayoutAt,
  requireWorkspaceStorageVersionAt,
} from "./workspace-storage-v2.ts"
import { withLegacyAnnotationStoreLock } from "./legacy-annotation-lock.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

const encoder = new TextEncoder()
const spaceId = "alpha"
let workspaceRoot = ""

function documentId(index: number): DocumentId {
  return `doc_${String(index).padStart(22, "0")}` as DocumentId
}

function claim(id: string): DocumentFormatClaim {
  return { id: id as DocumentFormatClaim["id"], sourceVersion: 1 }
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value)
}

function testRegistry(input: {
  format: DocumentFormatClaim
  companions?: string[]
  portableState?: "none" | "durable" | "versioned"
}): DocumentFormatRegistry {
  return new DocumentFormatRegistry([
    {
      id: input.format.id,
      extensions: [],
      sourceVersions: [input.format.sourceVersion],
      rendererKey: null,
      renderDisposition: DOCUMENT_RENDER_DISPOSITIONS.attachmentOnly,
      capabilities: {
        authoring: "none",
        publicProjection: "none",
        execution: "none",
      },
      versionedCompanionKeys: input.companions ?? [],
      portableState: input.portableState ?? "none",
    },
  ])
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "worktable-storage-v2-"))
  setWorkspaceRootOverride(workspaceRoot)
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  await rm(workspaceRoot, { recursive: true, force: true })
})

describe("document storage V2", () => {
  it("round-trips exact authored generations without format-specific storage branches", async () => {
    const cases: Array<{
      name: string
      logicalPath: string
      format: DocumentFormatClaim
      source: DocumentGenerationPayloadSource
      companions?: DocumentGenerationPayloadCompanion[]
    }> = [
      {
        name: "Markdown",
        logicalPath: "notes/markdown",
        format: claim(BUILTIN_DOCUMENT_FORMATS.markdown),
        source: {
          kind: "file",
          entries: [{ path: "document.md", bytes: bytes("# Exact\n") }],
        },
      },
      {
        name: "rich text",
        logicalPath: "notes/rich-text",
        format: claim(BUILTIN_DOCUMENT_FORMATS.richText),
        source: {
          kind: "file",
          entries: [
            {
              path: "document.json",
              bytes: bytes('[{"type":"paragraph","content":[]}]'),
            },
          ],
        },
      },
      {
        name: "HTML with an authored permission companion",
        logicalPath: "dashboards/status",
        format: claim(BUILTIN_DOCUMENT_FORMATS.html),
        source: {
          kind: "file",
          entries: [
            { path: "index.html", bytes: bytes("<!doctype html><p>Ready</p>") },
          ],
        },
        companions: [
          {
            key: BUILTIN_DOCUMENT_COMPANIONS.htmlPermissions,
            entries: [
              { path: "permissions.json", bytes: bytes('{"network":false}') },
            ],
          },
        ],
      },
      {
        name: "unsupported file",
        logicalPath: "attachments/opaque",
        format: claim("future.opaque"),
        source: {
          kind: "file",
          entries: [
            { path: "payload.bin", bytes: new Uint8Array([0, 255, 1]) },
          ],
        },
      },
      {
        name: "core bundle",
        logicalPath: "projects/bundle",
        format: claim("future.bundle"),
        source: {
          kind: "bundle",
          entries: [
            { path: "assets/data.bin", bytes: new Uint8Array([4, 3, 2, 1]) },
            { path: "index.json", bytes: bytes('{"entry":"assets/data.bin"}') },
            { path: "z.txt", bytes: bytes("z") },
            { path: "ä.txt", bytes: bytes("umlaut") },
          ],
        },
      },
      {
        name: "Drawing",
        logicalPath: "diagrams/system-map",
        format: claim(BUILTIN_DOCUMENT_FORMATS.excalidraw),
        source: {
          kind: "file",
          entries: [
            {
              path: "drawing.excalidraw",
              bytes: bytes('{"type":"excalidraw","elements":[]}'),
            },
          ],
        },
      },
    ]

    for (const [index, fixture] of cases.entries()) {
      const id = documentId(index + 1)
      const generationId = `generation-${index + 1}`
      await writeDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: id,
        generationId,
        logicalPath: fixture.logicalPath,
        format: fixture.format,
        operation: "create",
        createdAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        createdBy: "test",
        source: "storage-conformance",
        authoredSource: fixture.source,
        companions: fixture.companions,
      })

      const stored = await readDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: id,
        generationId,
      })
      expect(stored?.manifest.format, fixture.name).toEqual(fixture.format)
      expect(stored?.manifest.logicalPath, fixture.name).toBe(
        fixture.logicalPath
      )
      expect(stored?.authoredSource.kind, fixture.name).toBe(
        fixture.source.kind
      )
      expect(
        stored?.authoredSource.entries.map((entry) => ({
          path: entry.path,
          bytes: [...entry.bytes],
        })),
        fixture.name
      ).toEqual(
        [...fixture.source.entries]
          .sort((left, right) =>
            left.path < right.path ? -1 : left.path > right.path ? 1 : 0
          )
          .map((entry) => ({ path: entry.path, bytes: [...entry.bytes] }))
      )
      expect(
        stored?.companions.map((companion) => ({
          key: companion.key,
          entries: companion.entries.map((entry) => ({
            path: entry.path,
            bytes: [...entry.bytes],
          })),
        })),
        fixture.name
      ).toEqual(
        (fixture.companions ?? []).map((companion) => ({
          key: companion.key,
          entries: companion.entries.map((entry) => ({
            path: entry.path,
            bytes: [...entry.bytes],
          })),
        }))
      )
      expect(
        (
          await listDocumentGenerationsV2({
            workspaceRoot,
            spaceId,
            documentId: id,
          })
        ).map((generation) => generation.id),
        fixture.name
      ).toEqual([generationId])
    }

    const portableBundle = await readDocumentGenerationV2({
      workspaceRoot,
      spaceId,
      documentId: documentId(5),
      generationId: "generation-5",
    })
    expect(portableBundle?.manifest.contentHash).toBe(
      "1e2968578d70ee67f3042b49bc76e608e836b09bd0dfe1f27a981b2347c3ba5f"
    )
    const portableBundleRoot = documentGenerationV2Directory(
      workspaceRoot,
      spaceId,
      documentId(5),
      "generation-5"
    )
    const undeclaredBundleEntry = join(
      portableBundleRoot,
      "source",
      "assets",
      "undeclared.bin"
    )
    await writeFile(undeclaredBundleEntry, "not in the manifest")
    await expect(
      readDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: documentId(5),
        generationId: "generation-5",
      })
    ).rejects.toThrow("undeclared entry")
    await rm(undeclaredBundleEntry)

    const htmlManifestPath = join(
      documentGenerationV2Directory(
        workspaceRoot,
        spaceId,
        documentId(3),
        "generation-3"
      ),
      "manifest.json"
    )
    const htmlManifest = JSON.parse(await readFile(htmlManifestPath, "utf8"))
    htmlManifest.format = claim(BUILTIN_DOCUMENT_FORMATS.markdown)
    await writeFile(htmlManifestPath, `${JSON.stringify(htmlManifest)}\n`)
    await expect(
      readDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: documentId(3),
        generationId: "generation-3",
      })
    ).rejects.toThrow("companion is not allowlisted")

    await expect(
      writeDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: documentId(10),
        generationId: "unauthorized-companion",
        logicalPath: "attachments/untrusted",
        format: claim("future.opaque"),
        operation: "create",
        createdAt: "2026-08-10T00:00:00.000Z",
        createdBy: "test",
        source: "storage-conformance",
        authoredSource: {
          kind: "file",
          entries: [{ path: "payload.bin", bytes: new Uint8Array([1]) }],
        },
        companions: [
          {
            key: BUILTIN_DOCUMENT_COMPANIONS.htmlPermissions,
            entries: [{ path: "permissions.json", bytes: bytes("{}") }],
          },
        ],
      })
    ).rejects.toThrow("companion is not allowlisted")

    const customFormat = claim("future.custom")
    const customCompanion = "future.custom-metadata"
    const customRegistry = testRegistry({
      format: customFormat,
      companions: [customCompanion],
    })
    await writeDocumentGenerationV2({
      workspaceRoot,
      spaceId,
      documentId: documentId(14),
      generationId: "custom-generation",
      logicalPath: "attachments/custom",
      format: customFormat,
      operation: "create",
      createdAt: "2026-08-14T00:00:00.000Z",
      createdBy: "test",
      source: "storage-conformance",
      authoredSource: {
        kind: "file",
        entries: [{ path: "document.custom", bytes: bytes("custom") }],
      },
      companions: [
        {
          key: customCompanion,
          entries: [{ path: "metadata.json", bytes: bytes('{"ok":true}') }],
        },
      ],
      registry: customRegistry,
    })
    const compatibleCustom = await readCompatibleDocumentVersionV2({
      workspaceRoot,
      spaceId,
      documentId: documentId(14),
      versionId: "custom-generation",
      store: "v2",
      registry: customRegistry,
    })
    expect(compatibleCustom?.store).toBe("v2")
    if (compatibleCustom?.store === "v2") {
      expect(compatibleCustom.generation.companions[0]?.key).toBe(
        customCompanion
      )
    }

    await expect(
      writeDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: documentId(11),
        generationId: "case-collision",
        logicalPath: "projects/collision",
        format: claim("future.bundle"),
        operation: "create",
        createdAt: "2026-08-11T00:00:00.000Z",
        createdBy: "test",
        source: "storage-conformance",
        authoredSource: {
          kind: "bundle",
          entries: [
            { path: "Assets/logo.png", bytes: bytes("first") },
            { path: "assets/logo.png", bytes: bytes("second") },
          ],
        },
      })
    ).rejects.toThrow("case-colliding")

    await expect(
      writeDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: documentId(12),
        generationId: "CON",
        logicalPath: "notes/non-portable-generation",
        format: claim(BUILTIN_DOCUMENT_FORMATS.markdown),
        operation: "create",
        createdAt: "2026-08-12T00:00:00.000Z",
        createdBy: "test",
        source: "storage-conformance",
        authoredSource: {
          kind: "file",
          entries: [{ path: "document.md", bytes: bytes("portable") }],
        },
      })
    ).rejects.toThrow("portable document generation ID")

    await expect(
      writeDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: documentId(13),
        generationId: "encoded-path-overflow",
        logicalPath: "notes/non-portable-entry",
        format: claim("future.bundle"),
        operation: "create",
        createdAt: "2026-08-13T00:00:00.000Z",
        createdBy: "test",
        source: "storage-conformance",
        authoredSource: {
          kind: "bundle",
          entries: [
            {
              path: Array.from({ length: 5 }, () => "界".repeat(85)).join("/"),
              bytes: bytes("too long when encoded"),
            },
          ],
        },
      })
    ).rejects.toThrow("generation entry path")
  })

  it("retains meaningful checkpoints outside ordinary count and byte budgets", async () => {
    const id = documentId(20)
    for (const generation of [
      {
        id: "2026-08-30T00-00-00-000Z-ordinary-old",
        createdAt: "2026-08-01T00:00:00.000Z",
        checkpoint: false,
      },
      {
        id: "2026-08-02T00-00-00-000Z-meaningful",
        createdAt: "2026-08-02T00:00:00.000Z",
        checkpoint: true,
      },
      {
        id: "2026-07-31T00-00-00-000Z-prunable",
        createdAt: "2026-07-31T00:00:00.000Z",
        checkpoint: false,
      },
      {
        id: "2026-08-01T00-00-00-000Z-ordinary-new",
        createdAt: "2026-08-03T00:00:00.000Z",
        checkpoint: false,
        previousGenerationCheckpoint: {
          generationId: "2026-08-30T00-00-00-000Z-ordinary-old",
          checkpoint: {
            meaningful: true,
            kind: "source-transition" as const,
          },
        },
      },
    ]) {
      await writeDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: id,
        generationId: generation.id,
        logicalPath: "notes/retention",
        format: claim(BUILTIN_DOCUMENT_FORMATS.markdown),
        operation: generation.checkpoint ? "checkpoint" : "update",
        createdAt: generation.createdAt,
        createdBy: "test",
        source: "retention",
        ...(generation.checkpoint
          ? { checkpoint: { meaningful: true, kind: "manual" as const } }
          : {}),
        ...(generation.previousGenerationCheckpoint
          ? {
              previousGenerationCheckpoint:
                generation.previousGenerationCheckpoint,
            }
          : {}),
        authoredSource: {
          kind: "file",
          entries: [{ path: "document.md", bytes: bytes(generation.id) }],
        },
      })
    }

    const newestSource = join(
      documentGenerationV2Directory(
        workspaceRoot,
        spaceId,
        id,
        "2026-08-01T00-00-00-000Z-ordinary-new"
      ),
      "source",
      "document.md"
    )
    await writeFile(newestSource, "corrupt")
    await expect(
      pruneDocumentGenerationsV2({
        workspaceRoot,
        spaceId,
        documentId: id,
        retention: { maxNonCheckpointGenerations: 1, maxNonCheckpointBytes: 1 },
      })
    ).rejects.toThrow("entry hash mismatch")
    expect(
      await listDocumentGenerationsV2({
        workspaceRoot,
        spaceId,
        documentId: id,
      })
    ).toHaveLength(4)
    await writeFile(
      newestSource,
      "2026-08-01T00-00-00-000Z-ordinary-new"
    )

    expect(
      await pruneDocumentGenerationsV2({
        workspaceRoot,
        spaceId,
        documentId: id,
        retention: { maxNonCheckpointGenerations: 1, maxNonCheckpointBytes: 1 },
      })
    ).toBe(1)
    expect(
      (
        await listDocumentGenerationsV2({
          workspaceRoot,
          spaceId,
          documentId: id,
        })
      ).map((generation) => generation.id)
    ).toEqual([
      "2026-08-01T00-00-00-000Z-ordinary-new",
      "2026-08-02T00-00-00-000Z-meaningful",
      "2026-08-30T00-00-00-000Z-ordinary-old",
    ])
  })

  it("refuses a generation whose captured entry was replaced by a symlink", async () => {
    const id = documentId(21)
    await writeDocumentGenerationV2({
      workspaceRoot,
      spaceId,
      documentId: id,
      generationId: "secure-generation",
      logicalPath: "notes/secure",
      format: claim(BUILTIN_DOCUMENT_FORMATS.markdown),
      operation: "create",
      createdAt: "2026-08-01T00:00:00.000Z",
      createdBy: "test",
      source: "security",
      authoredSource: {
        kind: "file",
        entries: [{ path: "document.md", bytes: bytes("inside") }],
      },
    })
    const outside = join(workspaceRoot, "outside.md")
    await writeFile(outside, "outside")
    const source = join(
      documentGenerationV2Directory(
        workspaceRoot,
        spaceId,
        id,
        "secure-generation"
      ),
      "source",
      "document.md"
    )
    await rm(source)
    await symlink(outside, source)

    await expect(
      readDocumentGenerationV2({
        workspaceRoot,
        spaceId,
        documentId: id,
        generationId: "secure-generation",
      })
    ).rejects.toMatchObject({ reason: "symlink" })
  })

  it("atomically advances format-owned state with identity-bound revisions", async () => {
    const id = documentId(30)
    const format = claim(BUILTIN_DOCUMENT_FORMATS.html)
    const first = await writeDocumentPortableStateV2({
      workspaceRoot,
      spaceId,
      documentId: id,
      logicalPath: "dashboards/first",
      format,
      stateVersion: 1,
      entries: [{ path: "state.json", bytes: bytes('{"tab":1}') }],
      expectedRevision: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    })
    const moved = await writeDocumentPortableStateV2({
      workspaceRoot,
      spaceId,
      documentId: id,
      logicalPath: "dashboards/moved",
      format,
      stateVersion: 1,
      entries: [{ path: "state.json", bytes: bytes('{"tab":1}') }],
      expectedRevision: first.revision,
      updatedAt: "2026-08-02T00:00:00.000Z",
    })

    expect(moved.revision).not.toBe(first.revision)
    await expect(
      writeDocumentPortableStateV2({
        workspaceRoot,
        spaceId,
        documentId: id,
        logicalPath: "dashboards/moved",
        format,
        stateVersion: 1,
        entries: [{ path: "state.json", bytes: bytes('{"tab":2}') }],
        expectedRevision: first.revision,
      })
    ).rejects.toThrow("changed before write")
    const current = await readDocumentPortableStateV2({
      workspaceRoot,
      spaceId,
      documentId: id,
    })
    expect(current?.manifest).toMatchObject({
      spaceId,
      documentId: id,
      logicalPath: "dashboards/moved",
      revision: moved.revision,
    })
    expect(new TextDecoder().decode(current?.entries[0]?.bytes)).toBe(
      '{"tab":1}'
    )
    const undeclaredStateEntry = join(
      documentPortableStateV2RevisionDirectory(
        workspaceRoot,
        spaceId,
        id,
        moved.revision
      ),
      "entries",
      "undeclared.json"
    )
    await writeFile(undeclaredStateEntry, "{}")
    await expect(
      readDocumentPortableStateV2({ workspaceRoot, spaceId, documentId: id })
    ).rejects.toThrow("undeclared entry")
    await rm(undeclaredStateEntry)
    const markdownStateRegistry = testRegistry({
      format: claim(BUILTIN_DOCUMENT_FORMATS.markdown),
      portableState: "durable",
    })
    const markdownStateDocumentId = documentId(32)
    await writeDocumentPortableStateV2({
      workspaceRoot,
      spaceId,
      documentId: markdownStateDocumentId,
      logicalPath: "notes/registered-state",
      format: claim(BUILTIN_DOCUMENT_FORMATS.markdown),
      stateVersion: 1,
      entries: [{ path: "state.json", bytes: bytes("{}") }],
      expectedRevision: null,
      registry: markdownStateRegistry,
    })
    await expect(
      readDocumentPortableStateV2({
        workspaceRoot,
        spaceId,
        documentId: markdownStateDocumentId,
      })
    ).rejects.toThrow("does not admit portable state")
    expect(
      await readDocumentPortableStateV2({
        workspaceRoot,
        spaceId,
        documentId: markdownStateDocumentId,
        registry: markdownStateRegistry,
      })
    ).not.toBeNull()
    await expect(
      writeDocumentPortableStateV2({
        workspaceRoot,
        spaceId,
        documentId: documentId(31),
        logicalPath: "notes/no-state",
        format: claim(BUILTIN_DOCUMENT_FORMATS.markdown),
        stateVersion: 1,
        entries: [{ path: "state.json", bytes: bytes("{}") }],
        expectedRevision: null,
      })
    ).rejects.toThrow("does not admit portable state")
  })

  it("translates legacy anchors and preserves unknown selectors unresolved", async () => {
    const id = documentId(40)
    const logicalPath = "notes/anchors"
    const legacyTargets: Array<{
      target: Extract<
        AnnotationTarget,
        { type: "doc" | "block" | "text" | "widget" }
      >
      kind: "docs" | "widgets"
    }> = [
      { target: { type: "doc", docPath: logicalPath }, kind: "docs" },
      {
        target: {
          type: "block",
          docPath: logicalPath,
          blockId: "block-1",
          quote: "Heading",
        },
        kind: "docs",
      },
      {
        target: {
          type: "text",
          docPath: logicalPath,
          blockId: "block-2",
          start: 2,
          end: 7,
          quote: "range",
        },
        kind: "docs",
      },
      { target: { type: "widget", widgetId: logicalPath }, kind: "widgets" },
    ]
    for (const fixture of legacyTargets) {
      const translated = translateLegacyDocumentAnnotationTarget(
        fixture.target,
        { documentId: id, logicalPath }
      )
      expect(translated).not.toBeNull()
      expect(
        translateDocumentAnnotationTargetV2ToLegacy(translated!, fixture.kind)
      ).toEqual({ kind: "resolved", target: fixture.target })
    }

    const unknown = DocumentAnnotationV2Schema.parse({
      id: "annotation-1",
      spaceId,
      target: {
        type: "document",
        documentId: id,
        path: logicalPath,
        selector: {
          type: "future-canvas.element-anchor",
          version: 3,
          data: { elementId: "shape-1", fallback: [10, 20] },
          resolverHint: "canvas-v3",
        },
      },
      category: "comment",
      body: "Check this shape",
      author: { type: "user", id: "owner" },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      metadata: { reviewedAt: new Date("2026-08-01T12:00:00.000Z") },
    })
    await writeDocumentAnnotationsV2({
      workspaceRoot,
      spaceId,
      documentId: id,
      logicalPath,
      annotations: [unknown],
      expectedRevision: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    })
    const stored = await readDocumentAnnotationsV2({
      workspaceRoot,
      spaceId,
      documentId: id,
    })
    const target = stored!.annotations[0]!.target
    expect(stored!.annotations[0]!.metadata["reviewedAt"]).toBe(
      "2026-08-01T12:00:00.000Z"
    )
    expect(target.selector).toEqual(unknown.target.selector)
    expect(translateDocumentAnnotationTargetV2ToLegacy(target, "docs")).toEqual(
      {
        kind: "unresolved",
        reason: "unsupported-selector",
        target,
      }
    )
  })

  it("reads V1 Doc and HTML histories through explicit compatibility locators without rewriting them", async () => {
    const legacySpaceId = "Team_Notes"
    const fixtures = [
      {
        kind: "docs" as const,
        key: "notes/legacy ",
        type: "worktable.doc-version",
        identityKey: "docPath",
      },
      {
        kind: "widgets" as const,
        key: "dashboards/CON",
        type: "worktable.widget-version",
        identityKey: "widgetId",
      },
    ]
    for (const [index, fixture] of fixtures.entries()) {
      const versionId = index === 0 ? "legacy-1" : "CON"
      const path = join(
        workspaceRoot,
        "versions",
        legacySpaceId,
        fixture.kind,
        fixture.key,
        `${versionId}.json`
      )
      await mkdir(dirname(path), { recursive: true })
      const original = `${JSON.stringify({
        type: fixture.type,
        version: 1,
        id: versionId,
        spaceId: legacySpaceId,
        [fixture.identityKey]: fixture.key,
        createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
        createdBy: "legacy-test",
        source: "legacy",
        operation: "update",
        checkpoint: {
          meaningful: true,
          kind: "manual",
          label: "L".repeat(201),
        },
        after: { content: `legacy-${fixture.kind}` },
      })}\n`
      await writeFile(path, original)
      await writeFile(join(dirname(path), "damaged.json"), "{not-json")
      const locator = { kind: fixture.kind, key: fixture.key }

      expect(
        await listCompatibleDocumentVersionsV2({
          workspaceRoot,
          spaceId: legacySpaceId,
          documentId: documentId(50 + index),
          legacy: locator,
        })
      ).toEqual([
        expect.objectContaining({
          store: "legacy-v1",
          legacyKind: fixture.kind,
          id: versionId,
          checkpoint: expect.objectContaining({
            meaningful: true,
            label: "L".repeat(200),
          }),
        }),
      ])
      expect(
        await readCompatibleDocumentVersionV2({
          workspaceRoot,
          spaceId: legacySpaceId,
          documentId: documentId(50 + index),
          versionId,
          store: "legacy-v1",
          legacy: locator,
        })
      ).toMatchObject({
        store: "legacy-v1",
        legacyKind: fixture.kind,
        snapshot: { after: { content: `legacy-${fixture.kind}` } },
      })
      expect(await readFile(path, "utf8")).toBe(original)
    }
  })

  it("dispatches workspace layouts only when their manifest version is admitted", async () => {
    const manifestPath = join(workspaceRoot, "worktable.workspace.json")
    const common = {
      type: "worktable.workspace",
      id: "workspace",
      name: "Workspace",
      createdAt: "2026-08-01T00:00:00.000Z",
      cloud: { status: "unlinked" },
    }
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...common,
        version: 1,
        name: "",
        createdAt: "released-v1-string",
      })
    )
    expect(await readWorkspaceStorageLayoutAt(workspaceRoot)).toMatchObject({
      kind: "v1",
      version: 1,
    })
    await writeFile(manifestPath, JSON.stringify({ ...common, version: 2 }))
    expect(await readWorkspaceStorageLayoutAt(workspaceRoot)).toMatchObject({
      kind: "v2",
      version: 2,
    })
    await expect(
      requireWorkspaceStorageVersionAt(workspaceRoot, [1])
    ).rejects.toThrow("not admitted")
    expect(
      await requireWorkspaceStorageVersionAt(workspaceRoot, [2])
    ).toMatchObject({ kind: "v2", version: 2 })

    await writeFile(manifestPath, JSON.stringify({ ...common, version: 99 }))
    expect(await readWorkspaceStorageLayoutAt(workspaceRoot)).toEqual({
      kind: "unsupported",
      version: 99,
    })
  })

  it("projects and CAS-migrates existing V1 annotations", async () => {
    await withLegacyAnnotationStoreLock(
      { workspaceRoot, spaceId: "Team_Notes" },
      async () => undefined
    )
    for (const unsafeSpaceId of [
      ".",
      "..",
      "../escape",
      "nested/space",
      "nested\\space",
    ]) {
      expect(() =>
        withLegacyAnnotationStoreLock(
          { workspaceRoot, spaceId: unsafeSpaceId },
          async () => undefined
        )
      ).toThrow("legacy Space ID is unsafe")
    }
    const id = documentId(60)
    const logicalPath = "notes/legacy-annotation "
    const emptyId = documentId(61)
    const emptySpaceId = "beta"
    const empty = await readCompatibleDocumentAnnotationsV2({
      workspaceRoot,
      spaceId: emptySpaceId,
      documentId: emptyId,
      logicalPath: "notes/empty",
      legacyKind: "docs",
    })
    await writeDocumentAnnotationsV2({
      workspaceRoot,
      spaceId: emptySpaceId,
      documentId: emptyId,
      logicalPath: "notes/empty",
      legacyKind: "docs",
      annotations: empty.file.annotations,
      expectedRevision: empty.file.revision,
    })
    expect(
      await readDocumentAnnotationsV2({
        workspaceRoot,
        spaceId: emptySpaceId,
        documentId: emptyId,
      })
    ).not.toBeNull()

    const path = join(
      workspaceRoot,
      "spaces",
      spaceId,
      "annotations",
      "docs",
      `${logicalPath}.annotations.json`
    )
    await mkdir(dirname(path), { recursive: true })
    const original = `${JSON.stringify({
      type: "worktable.annotations",
      version: 1,
      spaceId,
      revision: "legacy-revision",
      updatedAt: "released-v1-timestamp",
      annotations: [
        {
          id: "legacy-annotation",
          spaceId,
          target: {
            type: "block",
            docPath: logicalPath,
            blockId: "block-1",
            quote: "Legacy",
          },
          category: "comment",
          status: "open",
          body: "Keep this anchor",
          author: { type: "user", id: "owner" },
          labels: [],
          thread: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          metadata: {},
        },
      ],
    })}\n`
    await writeFile(path, original)

    const compatible = await readCompatibleDocumentAnnotationsV2({
      workspaceRoot,
      spaceId,
      documentId: id,
      logicalPath,
      legacyKind: "docs",
    })
    expect(compatible.store).toBe("legacy-v1")
    expect(compatible.file.updatedAt).toBe("1970-01-01T00:00:00.000Z")
    expect(compatible.file.annotations[0]?.target).toMatchObject({
      type: "document",
      documentId: id,
      path: logicalPath,
      selector: {
        type: "worktable.rich-text-block",
        version: 1,
        data: { blockId: "block-1", quote: "Legacy" },
      },
    })
    expect(await readFile(path, "utf8")).toBe(original)

    const changed = original.replace(
      "released-v1-timestamp",
      "2026-08-02T00:00:00.000Z"
    )
    await writeFile(path, changed)
    await expect(
      writeDocumentAnnotationsV2({
        workspaceRoot,
        spaceId,
        documentId: id,
        logicalPath,
        legacyKind: "docs",
        annotations: compatible.file.annotations,
        expectedRevision: compatible.file.revision,
      })
    ).rejects.toThrow("changed before write")
    await withAnnotationStoreLock(spaceId, async () => undefined)

    const current = await readCompatibleDocumentAnnotationsV2({
      workspaceRoot,
      spaceId,
      documentId: id,
      logicalPath,
      legacyKind: "docs",
    })
    await writeDocumentAnnotationsV2({
      workspaceRoot,
      spaceId,
      documentId: id,
      logicalPath,
      legacyKind: "docs",
      annotations: current.file.annotations,
      expectedRevision: current.file.revision,
    })
    expect(
      await readDocumentAnnotationsV2({
        workspaceRoot,
        spaceId,
        documentId: id,
      })
    ).not.toBeNull()
    await rm(
      join(
        workspaceRoot,
        "spaces",
        spaceId,
        "annotations",
        ".document-annotations-v2"
      )
    )
    await expect(
      withAnnotationStoreLock(spaceId, async () => undefined)
    ).rejects.toThrow("legacy annotation writes are retired")
  })
})

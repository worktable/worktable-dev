import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDocumentCatalog } from "./document-catalog.ts"
import { readLegacyHtmlClaim } from "./document-adapters.ts"
import { DocumentFormatRegistry } from "./document-format-registry.ts"
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import { stringifyCanonicalYaml } from "./yaml.ts"

let root = ""
const spaceId = "meta"

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-document-catalog-"))
  setWorkspaceRootOverride(root)
  await mkdir(join(root, "spaces", spaceId, "docs"), { recursive: true })
  await mkdir(join(root, "spaces", spaceId, "widgets"), { recursive: true })
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

async function writeWidget(id: string, name = "Status board"): Promise<void> {
  const directory = join(root, "spaces", spaceId, "widgets", ...id.split("/"))
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "widget.yaml"),
    stringifyCanonicalYaml({
      version: 1,
      kind: "worktable.widget",
      id,
      name,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      createdBy: "test",
      metadata: {},
      runtime: { type: "html", entry: "index.html" },
      permissions: {
        network: false,
        records: {},
        state: { read: true, write: true },
      },
    })
  )
  await writeFile(join(directory, "index.html"), "<h1>Content</h1>")
}

async function writeCoreBundle(
  relativePath: string,
  id: ReturnType<typeof mintDocumentId>,
  format = "future.canvas"
): Promise<void> {
  const bundle = join(root, "spaces", spaceId, ...relativePath.split("/"))
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, "content.bin"), "opaque")
  await writeFile(
    join(bundle, "manifest.json"),
    JSON.stringify({
      type: "worktable.document-bundle",
      version: 1,
      documentId: id,
      format: { id: format, sourceVersion: 1 },
      content: "content.bin",
    })
  )
}

describe("shadow document catalog", () => {
  it("rejects symlinked bundle paths during local HTML revalidation", async () => {
    const spaceRoot = join(root, "spaces", spaceId)
    const widgetsRoot = join(spaceRoot, "widgets")
    const cases = [
      {
        id: "linked-target",
        movedPath: join(widgetsRoot, "linked-target"),
        linkPath: join(widgetsRoot, "linked-target"),
      },
      {
        id: "linked-parent/child",
        movedPath: join(widgetsRoot, "linked-parent"),
        linkPath: join(widgetsRoot, "linked-parent"),
      },
    ]

    for (const [index, candidate] of cases.entries()) {
      await writeWidget(candidate.id, "Outside Space title")
      const outside = join(root, `outside-widget-${index}`)
      await rename(candidate.movedPath, outside)
      await symlink(outside, candidate.linkPath)

      expect(await readLegacyHtmlClaim(spaceRoot, candidate.id)).toBeNull()
    }
  })

  it("enumerates current formats without parsing authored bodies", async () => {
    const docs = join(root, "spaces", spaceId, "docs")
    await mkdir(join(docs, "notes"))
    await writeFile(join(docs, "notes", "brief.md"), "# Brief")
    await writeFile(join(docs, "broken.json"), "{not blocknote")
    await writeFile(
      join(root, "spaces", spaceId, "widgets", "widget.yaml"),
      "stray root metadata"
    )
    await writeWidget("dashboards/status")

    const catalog = await buildDocumentCatalog({ workspaceRoot: root, spaceId })
    expect(
      catalog.entries.map((entry) =>
        entry.kind === "document"
          ? [
              entry.descriptor.path,
              entry.descriptor.format.id,
              entry.descriptor.health,
              entry.handle.identity,
              entry.handle.storageProfile,
            ]
          : [entry.pathKey, "conflict"]
      )
    ).toEqual([
      [
        "broken",
        "worktable.rich-text",
        "supported",
        "provisional",
        "legacy-doc-file",
      ],
      [
        "dashboards/status",
        "worktable.html",
        "supported",
        "provisional",
        "legacy-html-bundle",
      ],
      [
        "notes/brief",
        "worktable.markdown",
        "supported",
        "provisional",
        "legacy-doc-file",
      ],
    ])
  })

  it("keeps missing, newer, and unknown inventoried formats visible and inert", async () => {
    const newerId = mintDocumentId()
    const unknownId = mintDocumentId()
    const missingId = mintDocumentId()
    const docs = join(root, "spaces", spaceId, "docs")
    await writeFile(join(docs, "newer.source"), "newer")
    await writeFile(join(docs, "unknown.source"), "unknown")
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: newerId,
          path: "future/newer",
          format: { id: "worktable.markdown", sourceVersion: 2 },
          source: { kind: "file", relativePath: "docs/newer.source" },
        },
        {
          documentId: unknownId,
          path: "future/unknown",
          format: { id: "future.binary", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/unknown.source" },
        },
        {
          documentId: missingId,
          path: "future/missing",
          format: { id: "future.canvas", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/missing.canvas" },
        },
      ],
    })

    const catalog = await buildDocumentCatalog({ workspaceRoot: root, spaceId })
    const health = Object.fromEntries(
      catalog.entries.map((entry) =>
        entry.kind === "document"
          ? [entry.descriptor.path, entry.descriptor.health]
          : [entry.pathKey, "ambiguous"]
      )
    )
    expect(health).toEqual({
      "future/missing": "invalid",
      "future/newer": "unsupported-version",
      "future/unknown": "unsupported-format",
    })

    const noHandlers = await buildDocumentCatalog({
      workspaceRoot: root,
      spaceId,
      registry: new DocumentFormatRegistry([]),
    })
    expect(
      noHandlers.entries.every(
        (entry) =>
          entry.kind !== "document" ||
          entry.descriptor.health === "invalid" ||
          entry.descriptor.health === "unsupported-format"
      )
    ).toBe(true)
  })

  it("uses one logical namespace and honors paths reserved by aliases", async () => {
    const docs = join(root, "spaces", spaceId, "docs")
    await writeFile(join(docs, "same.md"), "markdown")
    await writeFile(join(docs, "same.json"), "[]")
    await writeFile(join(docs, "old.md"), "stale sync copy")
    await writeWidget("same", "HTML same")
    await writeWidget("old", "HTML at aliased path")
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })
    await writeFile(
      join(root, "spaces", spaceId, "doc-aliases.json"),
      JSON.stringify({
        type: "worktable.doc-aliases",
        version: 1,
        exact: { old: "new" },
        prefixes: {},
      })
    )

    const catalog = await buildDocumentCatalog({ workspaceRoot: root, spaceId })
    expect(catalog.entries).toHaveLength(2)
    expect(catalog.entries[0]).toMatchObject({
      kind: "conflict",
      pathKey: "old",
      claims: [
        { kind: "document", format: { id: "worktable.html" } },
        { kind: "alias", path: "old", targetPath: "new" },
      ],
    })
    expect(catalog.entries[1]).toMatchObject({
      kind: "conflict",
      pathKey: "same",
    })
    if (catalog.entries[1]?.kind === "conflict") {
      expect(
        catalog.entries[1].claims.flatMap((claim) =>
          claim.kind === "document" ? [claim.format.id] : []
        )
      ).toEqual(["worktable.rich-text", "worktable.markdown", "worktable.html"])
    }
  })

  it("recognizes only manifest-proven core bundles", async () => {
    const docs = join(root, "spaces", spaceId, "docs")
    const ordinary = join(docs, "project.wtdoc")
    await mkdir(ordinary)
    await writeFile(join(ordinary, "notes.md"), "# Notes")

    const bundleId = mintDocumentId()
    await writeCoreBundle("docs/research.wtdoc", bundleId, "future.research")
    const invalidId = mintDocumentId()
    await mkdir(join(docs, "empty"))
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: bundleId,
          path: "research/room",
          format: { id: "future.research", sourceVersion: 1 },
          source: {
            kind: "bundle",
            relativePath: "docs/research.wtdoc",
            manifestPath: "docs/research.wtdoc/manifest.json",
          },
        },
        {
          documentId: invalidId,
          path: "empty",
          format: { id: "worktable.html", sourceVersion: 1 },
          source: { kind: "bundle", relativePath: "docs/empty" },
        },
      ],
    })

    const catalog = await buildDocumentCatalog({ workspaceRoot: root, spaceId })
    expect(
      catalog.entries.map((entry) =>
        entry.kind === "document"
          ? [
              entry.descriptor.path,
              entry.descriptor.health,
              entry.handle.storageProfile,
            ]
          : [entry.pathKey, "ambiguous"]
      )
    ).toEqual([
      ["empty", "invalid", null],
      ["project.wtdoc/notes", "supported", "legacy-doc-file"],
      ["research/room", "unsupported-format", "core-document-bundle"],
    ])
    expect(
      catalog.entries.find(
        (entry) =>
          entry.kind === "document" && entry.descriptor.path === "research/room"
      )
    ).toMatchObject({
      kind: "document",
      descriptor: { updatedAt: expect.any(String) },
    })
  })

  it("matches durable sources by their portable comparison key", async () => {
    const id = mintDocumentId()
    await writeFile(
      join(root, "spaces", spaceId, "docs", "Brief.md"),
      "# Brief"
    )
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: id,
          path: "Brief",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/brief.md" },
        },
      ],
    })

    const catalog = await buildDocumentCatalog({ workspaceRoot: root, spaceId })
    expect(catalog.entries).toEqual([
      expect.objectContaining({
        kind: "document",
        descriptor: expect.objectContaining({ documentId: id, path: "Brief" }),
        handle: expect.objectContaining({
          identity: "durable",
          source: { kind: "file", relativePath: "docs/Brief.md" },
        }),
      }),
    ])
  })

  it("keeps case-distinct sources visible while enforcing portable ownership", async () => {
    const bundleId = mintDocumentId()
    const docs = join(root, "spaces", spaceId, "docs")
    await writeCoreBundle("docs/Foo.wtdoc", bundleId)
    const legacyDirectory = join(docs, "foo.wtdoc")
    await mkdir(legacyDirectory)
    await writeFile(join(legacyDirectory, "notes.md"), "# Notes")
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: bundleId,
          path: "canvas",
          format: { id: "future.canvas", sourceVersion: 1 },
          source: {
            kind: "bundle",
            relativePath: "docs/Foo.wtdoc",
            manifestPath: "docs/Foo.wtdoc/manifest.json",
          },
        },
      ],
    })

    const catalog = await buildDocumentCatalog({ workspaceRoot: root, spaceId })
    const legacy = catalog.entries.find(
      (entry) =>
        entry.kind === "document" && entry.descriptor.path.endsWith("notes")
    )
    expect(legacy).toMatchObject({
      kind: "document",
      descriptor: { health: "invalid", path: "foo.wtdoc/notes" },
      handle: {
        diagnostics: [
          expect.objectContaining({ code: "source-ownership-overlap" }),
        ],
      },
    })
  })

  it("rejects sources owned by another document bundle", async () => {
    await writeWidget("status")
    const coreId = mintDocumentId()
    await writeCoreBundle("docs/board.wtdoc", coreId, "future.board")
    const widgetChild = mintDocumentId()
    const coreChild = mintDocumentId()
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: coreId,
          path: "boards/main",
          format: { id: "future.board", sourceVersion: 1 },
          source: {
            kind: "bundle",
            relativePath: "docs/board.wtdoc",
            manifestPath: "docs/board.wtdoc/manifest.json",
          },
        },
        {
          documentId: widgetChild,
          path: "status-source",
          format: { id: "worktable.html", sourceVersion: 1 },
          source: { kind: "file", relativePath: "widgets/status/index.html" },
        },
        {
          documentId: coreChild,
          path: "boards/content",
          format: { id: "future.binary", sourceVersion: 1 },
          source: {
            kind: "file",
            relativePath: "docs/board.wtdoc/content.bin",
          },
        },
      ],
    })

    const catalog = await buildDocumentCatalog({ workspaceRoot: root, spaceId })
    for (const id of [widgetChild, coreChild]) {
      const nested = catalog.entries.find(
        (entry) =>
          entry.kind === "document" && entry.descriptor.documentId === id
      )
      expect(nested).toMatchObject({
        kind: "document",
        descriptor: { health: "invalid" },
        handle: {
          diagnostics: [
            expect.objectContaining({ code: "source-ownership-overlap" }),
          ],
        },
      })
    }
  })

  it("fails closed when Space or alias authority is invalid", async () => {
    await expect(
      buildDocumentCatalog({ workspaceRoot: root, spaceId: "../outside" })
    ).rejects.toThrow()

    await writeFile(join(root, "spaces", spaceId, "docs", "brief.md"), "brief")
    await writeFile(
      join(root, "spaces", spaceId, "doc-aliases.json"),
      "{not json"
    )

    await expect(
      buildDocumentCatalog({ workspaceRoot: root, spaceId })
    ).rejects.toThrow("Corrupt document alias file")
  })
})

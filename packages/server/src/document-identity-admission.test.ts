import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { recordDocAlias } from "./doc-aliases.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import { setDocumentFolderArchived } from "./document-folder-archive.ts"
import { moveRegisteredDocument } from "./document-write-service.ts"
import { setDocumentLifecycleStepHookForTests } from "./document-lifecycle-journal.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import { admitManagedDocumentWrite } from "./document-identity-admission.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import {
  listDocumentGenerationsV2,
  readDocumentGenerationV2,
} from "./document-version-store-v2.ts"
import {
  DOCUMENT_INVENTORY_MAX_BYTES,
  mintDocumentId,
  readDocumentInventory,
  updateDocumentInventory,
} from "./document-inventory.ts"
import {
  convertDocToMarkdownStorage,
  getDocVersion,
  listDocVersions,
  readDoc,
  recordExternalDocChange,
  writeDoc,
  writeSpace,
} from "./store.ts"
import { buildWidgetFile } from "./widget-authoring.ts"
import {
  readWidget,
  listWidgets,
  withWidgetWriteLock,
  writeWidget,
} from "./widget-store.ts"
import {
  getWidgetVersion,
  listWidgetVersions,
  recordExternalWidgetChange,
} from "./widget-version-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { resetWorkspaceSafetyForTests } from "./workspace-safety.ts"

let root = ""
const spaceId = "identity-admission"

function space(): SpaceFile {
  const now = "2026-08-28T00:00:00.000Z"
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Identity admission",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

async function catalogDocument(path: string) {
  const catalog = await buildDocumentCatalog({ workspaceRoot: root, spaceId })
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.kind === "document" && candidate.descriptor.path === path
  )
  if (!entry || entry.kind !== "document") {
    throw new Error(`Expected catalog document: ${path}`)
  }
  return entry
}

function admitManagedHtmlTransaction<
  T extends {
    data: unknown | null
    error: string | null
    release?: () => void
  },
>(path: string, transaction: () => Promise<T>): Promise<T> {
  return admitManagedDocumentWrite({
    spaceId,
    path,
    family: "html",
    transaction,
    committedClaim: (result) =>
      result.data && !result.error
        ? {
            format: {
              id: BUILTIN_DOCUMENT_FORMATS.html,
              sourceVersion: 1,
            },
            source: {
              kind: "bundle",
              relativePath: `widgets/${path}`,
            },
          }
        : null,
    onAdmissionFailure: (result) => result.release?.(),
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-identity-admission-"))
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  await writeSpace(space())
})

afterEach(async () => {
  setDocumentLifecycleStepHookForTests(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  resetWorkspaceSafetyForTests()
  await rm(root, { recursive: true, force: true })
})

describe("managed document identity admission", () => {
  it("admits the first managed format transition and preserves identity thereafter", async () => {
    // Existing paths keep working even if they predate the portable grammar
    // that reserves known source suffixes for new logical paths.
    const legacyPath = "Legacy Plan.md"
    expect((await writeDoc(spaceId, legacyPath, "# First\n")).ok).toBe(true)
    expect((await catalogDocument(legacyPath)).handle.identity).toBe(
      "provisional"
    )

    expect(
      (
        await writeDoc(
          spaceId,
          legacyPath,
          [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Rich", styles: {} }],
            },
          ],
          { managedIdentity: true }
        )
      ).ok
    ).toBe(true)
    const richDoc = await catalogDocument(legacyPath)
    expect(richDoc.handle.identity).toBe("durable")
    const documentId = richDoc.handle.documentId
    expect(richDoc.handle.source.relativePath).toBe("docs/Legacy Plan.md.json")

    expect(
      (
        await convertDocToMarkdownStorage(spaceId, legacyPath, {
          managedIdentity: true,
        })
      ).ok
    ).toBe(true)
    const markdownDoc = await catalogDocument(legacyPath)
    expect(markdownDoc.handle.documentId).toBe(documentId)
    expect(markdownDoc.handle.source.relativePath).toBe("docs/Legacy Plan.md.md")
    expect((await readDoc(spaceId, legacyPath)).data).toContain("Rich")
  })

  it("makes new managed Markdown and HTML documents durable across updates", async () => {
    const manifestPath = join(root, "worktable.workspace.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`
    )

    expect(
      (
        await writeDoc(spaceId, "new-note", "# First\n", {
          managedIdentity: true,
        })
      ).ok
    ).toBe(true)
    const markdown = await catalogDocument("new-note")
    expect(markdown.handle.identity).toBe("durable")
    const markdownId = markdown.handle.documentId
    expect(
      (
        await writeDoc(spaceId, "new-note", "# Updated\n", {
          managedIdentity: true,
        })
      ).ok
    ).toBe(true)
    expect((await catalogDocument("new-note")).handle.documentId).toBe(
      markdownId
    )
    const markdownGenerations = await listDocumentGenerationsV2({
      workspaceRoot: root,
      spaceId,
      documentId: markdownId,
    })
    expect(markdownGenerations).toHaveLength(2)
    const markdownVersions = await listDocVersions("identity-admission", "new-note")
    expect(
      (await getDocVersion(spaceId, "new-note", markdownVersions.at(-1)!.id))
        ?.after.content
    ).toBe("# First\n")

    const richPath = "exact-rich"
    expect(
      (
        await writeDoc(
          spaceId,
          richPath,
          [{ type: "paragraph", content: [] }],
          {
            managedIdentity: true,
            updatedBy: "agent",
            source: "mcp",
          }
        )
      ).ok
    ).toBe(true)
    const rich = await catalogDocument(richPath)
    const externalRich =
      '[ { "type": "paragraph", "content": [{"type":"text","text":"External","styles":{}}] } ]\n'
    await writeFile(
      join(root, "spaces", spaceId, "docs", `${richPath}.json`),
      externalRich
    )
    const externalRichProvenance = await recordExternalDocChange(
      spaceId,
      richPath
    )
    const externalRichGeneration = await readDocumentGenerationV2({
      workspaceRoot: root,
      spaceId,
      documentId: rich.handle.documentId,
      generationId: externalRichProvenance!.versionId,
    })
    expect(
      new TextDecoder().decode(
        externalRichGeneration!.authoredSource.entries[0]!.bytes
      )
    ).toBe(externalRich)
    expect(
      (
        await writeDoc(
          spaceId,
          richPath,
          [{ type: "paragraph", content: [] }],
          {
            managedIdentity: true,
            updatedBy: "user",
            source: "browser-yjs",
          }
        )
      ).ok
    ).toBe(true)
    expect(
      (
        await readDocumentGenerationV2({
          workspaceRoot: root,
          spaceId,
          documentId: rich.handle.documentId,
          generationId: externalRichProvenance!.versionId,
        })
      )?.manifest.checkpoint
    ).toMatchObject({
      meaningful: true,
      kind: "source-transition",
      transition: { from: "external", to: "human" },
    })

    expect((await writeDoc(spaceId, "pre-tracking", "# Original\n")).ok).toBe(
      true
    )
    expect(
      (
        await writeDoc(spaceId, "pre-tracking", "# Replacement\n", {
          managedIdentity: true,
        })
      ).ok
    ).toBe(true)
    const preTrackingVersions = await listDocVersions(spaceId, "pre-tracking")
    expect(preTrackingVersions).toHaveLength(2)
    expect(
      (
        await getDocVersion(
          spaceId,
          "pre-tracking",
          preTrackingVersions.at(-1)!.id
        )
      )?.after.content
    ).toBe("# Original\n")

    expect(
      (await writeDoc(spaceId, "patched-provisional", "# Draft\n")).ok
    ).toBe(true)
    expect((await catalogDocument("patched-provisional")).handle.identity).toBe(
      "provisional"
    )
    await dispatchOperation("docs.patch", {
      spaceId,
      docPath: "patched-provisional",
      operations: [{ action: "append", content: "Agent update" }],
    })
    const patched = await catalogDocument("patched-provisional")
    expect(patched.handle.identity).toBe("durable")
    expect(
      await listDocumentGenerationsV2({
        workspaceRoot: root,
        spaceId,
        documentId: patched.handle.documentId,
      })
    ).toHaveLength(2)

    const htmlPath = "boards/status"
    const createdWidget = await createHtmlDocument({
      spaceId,
      explicitId: htmlPath,
      name: "Status",
      metadata: { purpose: "acceptance" },
      permissions: { network: true, records: {}, state: { read: true, write: true } },
      html: "<h1>First</h1>",
      createdBy: "test",
      versionSource: "rest-api",
      versionUpdatedBy: "user",
    })
    expect(createdWidget.error).toBeUndefined()
    const durableHtml = await catalogDocument(htmlPath)
    expect(durableHtml.handle.identity).toBe("durable")
    const htmlDocumentId = durableHtml.handle.documentId

    const htmlUpdate = await createHtmlDocument({
      spaceId,
      explicitId: htmlPath,
      name: "Current status",
      html: "<h1>Updated</h1>",
      createdBy: "test",
      versionSource: "rest-api",
      versionUpdatedBy: "user",
    })
    expect(htmlUpdate.error).toBeUndefined()
    expect((await catalogDocument(htmlPath)).handle.documentId).toBe(
      htmlDocumentId
    )
    expect(
      await listDocumentGenerationsV2({
        workspaceRoot: root,
        spaceId,
        documentId: htmlDocumentId,
      })
    ).toHaveLength(2)
    const htmlVersions = await listWidgetVersions(spaceId, htmlPath)
    expect(
      (await getWidgetVersion(spaceId, htmlPath, htmlVersions.at(-1)!.id))
        ?.after.content
    ).toMatchObject({
      html: "<h1>First</h1>",
      widget: {
        name: "Status",
        metadata: { purpose: "acceptance" },
        permissions: { network: true, records: {} },
      },
    })

    const sourcePath = join(root, "spaces", spaceId, "docs", `${htmlPath}.html`)
    const externalHtml = "<h1>Filesystem status</h1><!-- exact source marker -->\n"
    await writeFile(sourcePath, externalHtml)
    const externalHtmlProvenance = await recordExternalWidgetChange(
      spaceId,
      htmlPath
    )
    const externalHtmlGeneration = await readDocumentGenerationV2({
      workspaceRoot: root,
      spaceId,
      documentId: htmlDocumentId,
      generationId: externalHtmlProvenance!.versionId,
    })
    expect(
      new TextDecoder().decode(
        externalHtmlGeneration!.authoredSource.entries.find(
          (entry) => entry.path === "document.html"
        )!.bytes
      )
    ).toBe(externalHtml)
    const afterExternal = await createHtmlDocument({
      spaceId,
      explicitId: htmlPath,
      name: "Human status",
      html: "<h1>Human update</h1>",
      createdBy: "test",
      versionSource: "browser-yjs",
      versionUpdatedBy: "user",
    })
    expect(afterExternal.error).toBeUndefined()
    expect(
      (
        await readDocumentGenerationV2({
          workspaceRoot: root,
          spaceId,
          documentId: htmlDocumentId,
          generationId: externalHtmlProvenance!.versionId,
        })
      )?.manifest.checkpoint
    ).toMatchObject({
      meaningful: true,
      kind: "source-transition",
      transition: { from: "external", to: "human" },
    })
  }, 15_000)

  it("keeps imported HTML identity and history through archive, move, and external deletion", async () => {
    const manifest = join(root, "worktable.workspace.json")
    await writeFile(manifest, JSON.stringify({
      ...JSON.parse(await readFile(manifest, "utf8")), version: 2,
    }))
    const source = join(root, "spaces", spaceId, "docs", "imported", "board.html")
    await mkdir(join(source, ".."), { recursive: true })
    await writeFile(source, "<h1>Imported</h1>")
    expect((await setDocumentFolderArchived({
      spaceId, path: "imported", archived: true, archivedBy: "test",
    })).ok).toBe(true)
    const owner = await catalogDocument("imported/board")
    expect(owner.handle.identity).toBe("durable")
    expect((await readWidget(spaceId, "imported/board")).data?.archive).toBeDefined()
    expect(await listWidgets(spaceId)).toHaveLength(0)
    expect(await listWidgets(spaceId, { includeArchived: true })).toHaveLength(1)

    await recordExternalWidgetChange(spaceId, "imported/board")
    const movedSource = join(root, "spaces", spaceId, "docs", "moved.html")
    const edited = "<h1>External edit during move</h1>"
    setDocumentLifecycleStepHookForTests((step) => {
      if (step === "committed") return writeFile(movedSource, edited)
    })
    await moveRegisteredDocument({ spaceId, path: "imported/board", to: "moved" })
    setDocumentLifecycleStepHookForTests(null)
    expect((await catalogDocument("moved")).descriptor.documentId).toBe(owner.descriptor.documentId)
    const versions = await listWidgetVersions(spaceId, "moved", { checkpointsOnly: false })
    expect(versions.length).toBeGreaterThan(0)
    expect((await getWidgetVersion(spaceId, "moved", versions[0]!.id))?.after.content.html).toBe(edited)

    await rm(movedSource)
    await recordExternalWidgetChange(spaceId, "moved")
    expect((await readDocumentInventory(spaceId)).entries.has(owner.descriptor.documentId)).toBe(false)
    await writeFile(movedSource, "<h1>Replacement</h1>")
    await recordExternalWidgetChange(spaceId, "moved")
    expect((await catalogDocument("moved")).descriptor.documentId).not.toBe(owner.descriptor.documentId)
    expect((await readWidget(spaceId, "moved")).data?.archive).toBeFalsy()
  }, 15_000)

  it("leaves a capacity-rejected new HTML path reusable", async () => {
    const inventoryPath = join(root, "spaces", spaceId, "documents.meta.json")
    const inventory = {
      type: "worktable.document-inventory",
      version: 1,
      documents: {},
      futurePadding: "",
    }
    const unpadded = `${JSON.stringify(inventory, null, 2)}\n`
    inventory.futurePadding = "x".repeat(
      DOCUMENT_INVENTORY_MAX_BYTES - Buffer.byteLength(unpadded) - 1
    )
    const atCapacity = `${JSON.stringify(inventory, null, 2)}\n`
    expect(Buffer.byteLength(atCapacity)).toBe(DOCUMENT_INVENTORY_MAX_BYTES - 1)
    await writeFile(inventoryPath, atCapacity)

    const create = () =>
      createHtmlDocument({
        spaceId,
        name: "Capacity board",
        html: "<h1>Capacity</h1>",
        createdBy: "test",
        versionSource: "test",
        versionUpdatedBy: "test",
      })

    await expect(create()).rejects.toThrow(
      "document inventory exceeds its size limit"
    )
    expect((await readWidget(spaceId, "capacity-board")).data).toBeNull()

    inventory.futurePadding = inventory.futurePadding.slice(0, -1024)
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
    const created = await create()
    expect(created.data?.id).toBe("capacity-board")
    expect((await catalogDocument("capacity-board")).handle.identity).toBe(
      "durable"
    )
  })

  it("refuses managed writes when another format, an alias, or a conflict owns the path", async () => {
    expect((await writeDoc(spaceId, "shared", "# Markdown\n")).ok).toBe(true)
    await expect(
      admitManagedHtmlTransaction("shared", () =>
        withWidgetWriteLock(spaceId, "shared", () =>
          writeWidget(
            spaceId,
            buildWidgetFile({
              id: "shared",
              name: "HTML",
              createdBy: "test",
            }),
            "<h1>HTML</h1>"
          )
        )
      )
    ).rejects.toThrow("Another document")
    expect((await readWidget(spaceId, "shared")).data).toBeNull()
    expect((await readDoc(spaceId, "shared")).data).toBe("# Markdown\n")

    await recordDocAlias(spaceId, "reserved", "current", "exact")
    const aliasWrite = await writeDoc(spaceId, "reserved", "# Hidden\n", {
      managedIdentity: true,
    })
    expect(aliasWrite.ok).toBe(false)
    expect(aliasWrite.error).toContain("reserved")
    expect((await readDoc(spaceId, "reserved")).data).toBeNull()

    const sourceSuffixWrite = await writeDoc(
      spaceId,
      "new-document.md",
      "# Hidden\n",
      { managedIdentity: true }
    )
    expect(sourceSuffixWrite.ok).toBe(false)
    expect((await readDoc(spaceId, "new-document.md")).data).toBeNull()

    const docs = join(root, "spaces", spaceId, "docs")
    expect((await writeDoc(spaceId, "protected", "# Original\n")).ok).toBe(
      true
    )
    const sanitizedWrite = await writeDoc(
      spaceId,
      "pro..tected",
      "# Replacement\n",
      { managedIdentity: true }
    )
    expect(sanitizedWrite.ok).toBe(false)
    expect((await readDoc(spaceId, "protected")).data).toBe("# Original\n")

    expect(
      (
        await writeDoc(spaceId, "richdoc", [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Original", styles: {} }],
          },
        ])
      ).ok
    ).toBe(true)
    const sanitizedConversion = await convertDocToMarkdownStorage(
      spaceId,
      "rich..doc",
      { managedIdentity: true }
    )
    expect(sanitizedConversion.ok).toBe(false)
    expect((await readDoc(spaceId, "richdoc")).storedAs).toBe("json")

    await mkdir(docs, { recursive: true })
    await writeFile(join(docs, "conflicted.md"), "# Markdown\n")
    await writeFile(join(docs, "conflicted.json"), "[]")
    const conflictWrite = await writeDoc(
      spaceId,
      "conflicted",
      "# Replacement\n",
      { managedIdentity: true }
    )
    expect(conflictWrite.ok).toBe(false)
    expect(conflictWrite.error).toContain("conflicting documents")
    expect(await readFile(join(docs, "conflicted.md"), "utf8")).toBe(
      "# Markdown\n"
    )
    expect(await readFile(join(docs, "conflicted.json"), "utf8")).toBe("[]")
  })

  it("does not downgrade a document with a newer source version", async () => {
    expect((await writeDoc(spaceId, "future", "# Future\n")).ok).toBe(true)
    const futureId = mintDocumentId()
    await updateDocumentInventory(spaceId, {
      upsert: [
        {
          documentId: futureId,
          path: "future",
          format: {
            id: BUILTIN_DOCUMENT_FORMATS.markdown,
            sourceVersion: 2,
          },
          source: { kind: "file", relativePath: "docs/future.md" },
        },
      ],
    })

    const update = await writeDoc(spaceId, "future", "# Replaced\n", {
      managedIdentity: true,
    })
    expect(update.ok).toBe(false)
    expect(
      await readFile(join(root, "spaces", spaceId, "docs/future.md"), "utf8")
    ).toBe("# Future\n")
    const retained = (await readDocumentInventory(spaceId)).entries.get(
      futureId
    )
    expect(retained?.format.sourceVersion).toBe(2)
    expect(retained?.source.relativePath).toBe("docs/future.md")
  })
})

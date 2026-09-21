import { afterEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { createAnnotation, listAnnotations } from "./annotation-store.ts"
import { onDocContentChanged } from "./content-events.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  discoverDocumentDataV2LifecycleRecovery,
  reconcileDocumentDataV2LifecycleRecovery,
} from "./document-data-lifecycle-v2.ts"
import {
  reconcileRecoveredDocumentLifecycles,
  recoverInterruptedDocumentLifecycles,
  setDocumentLifecycleStepHookForTests,
  setDurableDocumentsArchivedByPrefixLocked,
  SimulatedDocumentLifecycleCrash,
  transitionDurableDocumentFormatLocked,
} from "./document-lifecycle-journal.ts"
import { deleteHtmlDocument } from "./html-document-delete.ts"
import { deleteDocumentFolder } from "./document-folder-delete.ts"
import { moveHtmlDocument } from "./html-document-move.ts"
import { moveDocumentFolder } from "./document-folder-move.ts"
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts"
import { renameDocAndSync, renameDocsByPrefixAndSync } from "./doc-rename.ts"
import { recordDocAlias, resolveDocAlias } from "./doc-aliases.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { DOCUMENT_STORAGE_PROFILE_IDS } from "./document-storage-profile.ts"
import { syncExternalDocChange } from "./external-doc-sync.ts"
import {
  createDocumentShare,
  createDocumentShareIfEligible,
  resolveDocumentShare,
} from "./share-store.ts"
import {
  convertDocToMarkdownStorage,
  deleteDoc,
  docExists,
  notePathEventIfSuppressed,
  getDocCollaborationCacheEpoch,
  getDocProvenance,
  getDocArchiveInfo,
  getDocVersion,
  listDocVersions,
  readDoc,
  readDocSourceSnapshot,
  readSpace,
  writeDoc,
  writeSpace,
} from "./store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  workspaceCacheKey,
} from "./workspace.ts"
import {
  resetWorkspaceSafetyForTests,
  workspaceRecoveryRequired,
} from "./workspace-safety.ts"
import { drainWorkspaceChanges, onWorkspaceChange } from "./workspace-events.ts"
import { yjsManager } from "./yjs-manager.ts"
import { buildWidgetFile } from "./widget-authoring.ts"
import {
  readWidget,
  readWidgetHtml,
  withWidgetWriteLocks,
  writeWidget,
} from "./widget-store.ts"
import { readWidgetState, writeWidgetState } from "./record-store.ts"
import {
  getWidgetProvenance,
  getWidgetVersion,
  listWidgetVersions,
  recordWidgetVersion,
} from "./widget-version-store.ts"
import { parseCanonicalYaml, stringifyCanonicalYaml } from "./yaml.ts"

const root = join(tmpdir(), `worktable-document-lifecycle-model-${Date.now()}`)
const originalHosted = process.env["WORKTABLE_HOSTED"]

function makeSpace(id: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: { docOrder: ["old", "other"] },
  }
}

afterEach(() => {
  setDocumentLifecycleStepHookForTests(null)
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  resetWorkspaceSafetyForTests()
  if (originalHosted === undefined) delete process.env["WORKTABLE_HOSTED"]
  else process.env["WORKTABLE_HOSTED"] = originalHosted
  rmSync(root, { recursive: true, force: true })
})

describe("recoverable document lifecycle", () => {
  it("recovers one coherent stable-ID lifecycle across every durable boundary", async () => {
    const boundaries = [
      "share-revoked",
      "history",
      "source-moved",
      "source",
      "doc-meta",
      "space-order",
      "inventory",
      "annotation-moved",
      "annotation",
      "aliases",
      "committed",
      "cleanup-renamed",
    ] as const

    for (const boundary of boundaries) {
      const workspace = join(root, boundary, "workspace")
      const app = join(root, boundary, "app")
      mkdirSync(workspace, { recursive: true })
      setWorkspaceRootOverride(workspace)
      setAppDirOverride(app)
      ensureWorkspaceManifest()
      await writeSpace(makeSpace("space"))
      await writeDoc("space", "old", "# Stable\n")
      const documentId = mintDocumentId()
      await updateDocumentInventory("space", {
        upsert: [
          {
            documentId,
            path: "old",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: { kind: "file", relativePath: "docs/old.md" },
          },
        ],
      })
      const createdAnnotation = await createAnnotation("space", {
        target: { type: "doc", docPath: "old" },
        category: "comment",
        body: "Keep this attached.",
      })
      const originalProvenance = await getDocProvenance("space", "old")
      const originalVersions = await listDocVersions("space", "old")
      expect(originalProvenance).toBeDefined()
      expect(originalVersions.length).toBeGreaterThan(0)

      const contentSignals: string[] = []
      const workspaceSignals: string[] = []
      const stopContent = onDocContentChanged((_spaceId, path) => {
        contentSignals.push(path)
      })
      const stopWorkspace = onWorkspaceChange((event) => {
        workspaceSignals.push(event.type)
      })
      setDocumentLifecycleStepHookForTests((step) => {
        if (step === boundary) {
          throw new SimulatedDocumentLifecycleCrash(boundary)
        }
      })

      try {
        await expect(
          renameDocAndSync("space", "old", "folder/new")
        ).rejects.toThrow(boundary)
      } finally {
        stopContent()
        stopWorkspace()
        setDocumentLifecycleStepHookForTests(null)
      }

      expect(contentSignals).toEqual([])
      expect(workspaceSignals).toEqual([])
      const recovered = recoverInterruptedDocumentLifecycles()
      expect(recovered).toHaveLength(1)
      expect(recoverInterruptedDocumentLifecycles()).toEqual(recovered)
      if (boundary === "committed") {
        const recreatedSource = join(
          workspace,
          "spaces",
          "space",
          "docs",
          "old.md"
        )
        const stopRecreation = onWorkspaceChange((event) => {
          if (
            event.type === "doc" &&
            event.spaceId === "space" &&
            event.docPath === "folder/new"
          ) {
            writeFileSync(recreatedSource, "# Recreated externally\n")
          }
        })
        try {
          await expect(
            reconcileRecoveredDocumentLifecycles(recovered)
          ).rejects.toThrow()
        } finally {
          stopRecreation()
        }
        expect(recoverInterruptedDocumentLifecycles()).toEqual(recovered)
        expect(await docExists("space", "old")).toBe(true)
        expect(await docExists("space", "folder/new")).toBe(true)
        rmSync(recreatedSource)
      }
      await reconcileRecoveredDocumentLifecycles(recovered)
      expect(recoverInterruptedDocumentLifecycles()).toEqual([])

      const committed =
        boundary === "committed" || boundary === "cleanup-renamed"
      const expectedPath = committed ? "folder/new" : "old"
      const otherPath = committed ? "old" : "folder/new"
      expect(await docExists("space", expectedPath)).toBe(true)
      expect(await docExists("space", otherPath)).toBe(false)
      expect((await readDoc("space", expectedPath)).data).toBe("# Stable\n")
      expect(await listDocVersions("space", expectedPath)).toEqual(
        originalVersions
      )
      expect(await listDocVersions("space", otherPath)).toEqual([])
      expect(await getDocProvenance("space", expectedPath)).toEqual(
        originalProvenance
      )
      expect(await getDocProvenance("space", otherPath)).toBeUndefined()

      const annotations = await listAnnotations("space", {
        target: { docPath: expectedPath },
      })
      expect(annotations.total).toBe(1)
      expect(annotations.annotations[0]).toMatchObject({
        id: createdAnnotation.annotation.id,
        body: "Keep this attached.",
      })
      expect(
        "docPath" in annotations.annotations[0]!.target &&
          annotations.annotations[0]!.target.docPath
      ).toBe(expectedPath)
      expect(
        (
          await listAnnotations("space", {
            target: { docPath: otherPath },
          })
        ).total
      ).toBe(0)
      expect((await readSpace("space")).data?.settings["docOrder"]).toEqual([
        expectedPath,
        "other",
      ])

      const catalog = await buildDocumentCatalog({
        workspaceRoot: workspace,
        spaceId: "space",
      })
      const identities = catalog.entries.flatMap((entry) =>
        entry.kind === "document" && entry.descriptor.documentId === documentId
          ? [entry]
          : []
      )
      expect(identities).toHaveLength(1)
      const identity = identities[0]
      if (!identity) throw new Error("Expected moved document identity")
      expect(identity.descriptor.path).toBe(expectedPath)
      expect(identity.handle.identity).toBe("durable")
      expect((await resolveDocAlias("space", "old")).path).toBe(
        committed ? "folder/new" : "old"
      )
    }

    const deleteBoundaries = [
      "journal-published",
      "share-revoked",
      "history",
      "source-moved",
      "source",
      "inventory",
      "committed",
      "cleanup-renamed",
    ] as const

    for (const boundary of deleteBoundaries) {
      const workspace = join(root, `delete-${boundary}`, "workspace")
      const app = join(root, `delete-${boundary}`, "app")
      mkdirSync(workspace, { recursive: true })
      setWorkspaceRootOverride(workspace)
      setAppDirOverride(app)
      process.env["WORKTABLE_HOSTED"] = "1"
      ensureWorkspaceManifest()
      await writeSpace(makeSpace("space"))
      await writeDoc("space", "old", "# Retiring generation\n")
      const documentId = boundary === "history" ? null : mintDocumentId()
      if (documentId) {
        await updateDocumentInventory("space", {
          upsert: [
            {
              documentId,
              path: "old",
              format: { id: "worktable.markdown", sourceVersion: 1 },
              source: { kind: "file", relativePath: "docs/old.md" },
            },
          ],
        })
      } else {
        const provisional = await buildDocumentCatalog({
          workspaceRoot: workspace,
          spaceId: "space",
        })
        expect(
          provisional.entries.some(
            (entry) =>
              entry.kind === "document" &&
              entry.descriptor.path === "old" &&
              entry.handle.identity === "provisional"
          )
        ).toBe(true)
      }
      await recordDocAlias("space", "legacy", "old", "exact")
      const annotation = await createAnnotation("space", {
        target: { type: "doc", docPath: "old" },
        category: "comment",
        body: "Retire with the generation.",
      })
      const share = await createDocumentShare({
        kind: "doc",
        spaceId: "space",
        artifactKey: "old",
      })
      expect(await resolveDocumentShare(share.token)).toBeDefined()
      const originalProvenance = await getDocProvenance("space", "old")
      const retiredVersions = await listDocVersions("space", "old")
      expect(originalProvenance).toBeDefined()
      expect(retiredVersions.length).toBeGreaterThan(0)
      const sourcePath = join(workspace, "spaces", "space", "docs", "old.md")
      if (boundary === "inventory" || boundary === "committed") {
        rmSync(sourcePath)
      }
      let sourceRemovedAfterAdmission = false
      let admittedDocumentId: string | undefined
      const stopAdmissionRemoval =
        boundary === "history"
          ? onWorkspaceChange((event) => {
              if (
                sourceRemovedAfterAdmission ||
                event.type !== "documentCorpus" ||
                event.spaceId !== "space" ||
                !existsSync(sourcePath)
              ) {
                return
              }
              const inventory = JSON.parse(
                readFileSync(
                  join(workspace, "spaces", "space", "documents.meta.json"),
                  "utf8"
                )
              ) as { documents: Record<string, { path?: string }> }
              admittedDocumentId = Object.entries(inventory.documents).find(
                ([, entry]) => entry.path === "old"
              )?.[0]
              rmSync(sourcePath)
              sourceRemovedAfterAdmission = true
            })
          : () => undefined

      setDocumentLifecycleStepHookForTests((step) => {
        if (step === boundary) {
          if (boundary === "share-revoked") rmSync(sourcePath)
          if (boundary === "source-moved" || boundary === "source") {
            writeFileSync(sourcePath, "# Recreated after source move\n")
          }
          throw new SimulatedDocumentLifecycleCrash(boundary)
        }
      })
      try {
        await expect(deleteDoc("space", "old")).rejects.toThrow(boundary)
      } finally {
        stopAdmissionRemoval()
        setDocumentLifecycleStepHookForTests(null)
      }
      if (boundary === "history") {
        expect(sourceRemovedAfterAdmission).toBe(true)
        expect(admittedDocumentId).toBeTruthy()
      }

      const recreatedAfterCommit = boundary === "committed"
      const recreatedDuringCompensation =
        boundary === "history" || boundary === "source-moved"
      const missingAfterCompensation =
        boundary === "share-revoked" || boundary === "inventory"
      if (recreatedAfterCommit || boundary === "history") {
        writeFileSync(
          sourcePath,
          recreatedAfterCommit
            ? "# New generation\n"
            : "# Recreated before recovery\n"
        )
      }
      const recovered = recoverInterruptedDocumentLifecycles()
      expect(recovered).toHaveLength(1)
      let removedDuringReconciliation = false
      const stopReconciliationRemoval =
        boundary === "source"
          ? onWorkspaceChange((event) => {
              if (
                removedDuringReconciliation ||
                event.type !== "doc" ||
                event.spaceId !== "space" ||
                event.docPath !== "old" ||
                !existsSync(sourcePath)
              ) {
                return
              }
              rmSync(sourcePath)
              removedDuringReconciliation = true
            })
          : () => undefined
      try {
        await reconcileRecoveredDocumentLifecycles(recovered)
      } finally {
        stopReconciliationRemoval()
      }
      if (boundary === "source") {
        expect(removedDuringReconciliation).toBe(true)
      }
      expect(recoverInterruptedDocumentLifecycles()).toEqual([])

      const committed =
        boundary === "committed" || boundary === "cleanup-renamed"
      expect(await resolveDocumentShare(share.token)).toEqual(
        boundary === "journal-published" ? share : null
      )
      if (!committed) {
        if (recreatedDuringCompensation) {
          expect((await readDoc("space", "old")).data).toBe(
            boundary === "history"
              ? "# Recreated before recovery\n"
              : "# Recreated after source move\n"
          )
          const activeVersions = await listDocVersions("space", "old")
          expect(
            retiredVersions.every((retired) =>
              activeVersions.some((active) => active.id === retired.id)
            )
          ).toBe(true)
          const recoveredProvenance = await getDocProvenance("space", "old")
          expect(recoveredProvenance).toBeDefined()
          expect(recoveredProvenance).not.toEqual(originalProvenance)
          expect(
            activeVersions.some(
              (version) => version.id === recoveredProvenance?.versionId
            )
          ).toBe(true)
          expect(
            retiredVersions.some(
              (version) => version.id === recoveredProvenance?.versionId
            )
          ).toBe(false)
        } else if (missingAfterCompensation) {
          expect(await docExists("space", "old")).toBe(false)
          expect(await listDocVersions("space", "old")).toEqual(retiredVersions)
          expect(await getDocProvenance("space", "old")).toEqual(
            originalProvenance
          )
        } else if (boundary === "source") {
          expect(await docExists("space", "old")).toBe(false)
          const activeVersions = await listDocVersions("space", "old")
          expect(
            retiredVersions.every((retired) =>
              activeVersions.some((active) => active.id === retired.id)
            )
          ).toBe(true)
          const recoveredProvenance = await getDocProvenance("space", "old")
          expect(recoveredProvenance).toBeDefined()
          expect(
            retiredVersions.some(
              (version) => version.id === recoveredProvenance?.versionId
            )
          ).toBe(false)
        } else {
          expect((await readDoc("space", "old")).data).toBe(
            "# Retiring generation\n"
          )
          expect(await listDocVersions("space", "old")).toEqual(retiredVersions)
          expect(await getDocProvenance("space", "old")).toEqual(
            originalProvenance
          )
        }
        expect((await resolveDocAlias("space", "legacy")).path).toBe("old")
        expect(
          (
            await listAnnotations("space", {
              target: { docPath: "old" },
            })
          ).annotations[0]?.id
        ).toBe(annotation.annotation.id)
        expect((await readSpace("space")).data?.settings["docOrder"]).toEqual([
          "old",
          "other",
        ])
        if (boundary === "inventory") {
          expect((await deleteDoc("space", "old")).error).toBeNull()
          expect(await listDocVersions("space", "old")).toEqual([])
          expect(await getDocProvenance("space", "old")).toBeUndefined()
        }
      } else {
        const activeVersions = await listDocVersions("space", "old")
        expect(
          activeVersions.some((version) =>
            retiredVersions.some((retired) => retired.id === version.id)
          )
        ).toBe(false)
        expect((await resolveDocAlias("space", "legacy")).path).toBe("legacy")
        expect(
          (
            await listAnnotations("space", {
              target: { docPath: "old" },
            })
          ).total
        ).toBe(0)
        expect((await readSpace("space")).data?.settings["docOrder"]).toEqual([
          "other",
        ])
        if (recreatedAfterCommit) {
          expect((await readDoc("space", "old")).data).toBe(
            "# New generation\n"
          )
          expect(activeVersions.length).toBeGreaterThan(0)
          const recreatedProvenance = await getDocProvenance("space", "old")
          expect(recreatedProvenance).toBeDefined()
          expect(recreatedProvenance).not.toEqual(originalProvenance)
          expect(
            activeVersions.some(
              (version) => version.id === recreatedProvenance?.versionId
            )
          ).toBe(true)
        } else {
          expect(await docExists("space", "old")).toBe(false)
          expect(activeVersions).toEqual([])
          expect(await getDocProvenance("space", "old")).toBeUndefined()
        }
      }

      const catalog = await buildDocumentCatalog({
        workspaceRoot: workspace,
        spaceId: "space",
      })
      const oldIdentitySurvives = catalog.entries.some((entry) => {
        if (!documentId) {
          return (
            entry.kind === "document" &&
            entry.descriptor.path === "old" &&
            entry.handle.identity === "durable"
          )
        }
        return entry.kind === "document"
          ? entry.descriptor.documentId === documentId
          : entry.claims.some(
              (claim) =>
                claim.kind === "document" && claim.documentId === documentId
            )
      })
      const oldGenerationSurvives = !committed && boundary !== "inventory"
      expect(oldIdentitySurvives).toBe(oldGenerationSurvives)
      if (boundary === "history" && oldIdentitySurvives) {
        const survivingId = catalog.entries.flatMap((entry) => {
          if (entry.kind === "document") {
            return entry.descriptor.path === "old"
              ? [entry.descriptor.documentId]
              : []
          }
          return entry.claims.flatMap((claim) =>
            claim.kind === "document" && claim.path === "old"
              ? [claim.documentId]
              : []
          )
        })[0]
        expect(survivingId).toBe(admittedDocumentId!)
      }
    }
  }, 30_000)

  it("finishes stable-ID document data after a committed move crash", async () => {
    const workspace = join(root, "v2-data-move", "workspace")
    const app = join(root, "v2-data-move", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    const manifestPath = join(workspace, "worktable.workspace.json")
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        { ...JSON.parse(readFileSync(manifestPath, "utf8")), version: 2 },
        null,
        2
      )}\n`
    )
    await writeSpace(makeSpace("space"))
    expect(
      (
        await writeDoc("space", "old", "# Stable\n", {
          managedIdentity: true,
        })
      ).ok
    ).toBe(true)
    const annotation = await createAnnotation("space", {
      target: { type: "doc", docPath: "old" },
      category: "comment",
      body: "Move this stable-ID data.",
    })

    setDocumentLifecycleStepHookForTests((step) => {
      if (step === "committed") {
        throw new SimulatedDocumentLifecycleCrash(step)
      }
    })
    try {
      await expect(
        renameDocAndSync("space", "old", "folder/new")
      ).rejects.toThrow("committed")
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }
    expect(workspaceRecoveryRequired()).toBe(true)
    resetWorkspaceSafetyForTests()

    const baseRecovery = recoverInterruptedDocumentLifecycles()
    expect(baseRecovery).toHaveLength(1)
    await reconcileRecoveredDocumentLifecycles(baseRecovery)
    const dataRecovery = discoverDocumentDataV2LifecycleRecovery()
    expect(dataRecovery).toHaveLength(1)
    await reconcileDocumentDataV2LifecycleRecovery(dataRecovery)
    expect(discoverDocumentDataV2LifecycleRecovery()).toEqual([])

    const moved = await listAnnotations("space", {
      target: { docPath: "folder/new" },
    })
    expect(moved.annotations.map((item) => item.id)).toEqual([
      annotation.annotation.id,
    ])
    expect(
      (
        await listAnnotations("space", {
          target: { docPath: "old" },
        })
      ).total
    ).toBe(0)
  })

  it("settles one mixed document folder atomically across compensation and committed recovery", async () => {
    for (const boundary of ["source-moved", "committed"] as const) {
      const workspace = join(root, `folder-delete-${boundary}`, "workspace")
      const app = join(root, `folder-delete-${boundary}`, "app")
      mkdirSync(workspace, { recursive: true })
      setWorkspaceRootOverride(workspace)
      setAppDirOverride(app)
      process.env["WORKTABLE_HOSTED"] = "1"
      ensureWorkspaceManifest()
      await writeSpace({
        ...makeSpace("space"),
        settings: {
          docOrder: ["folder/dashboard", "folder/note", "other"],
        },
      })
      await writeDoc("space", "folder/note", "# Mixed folder note\n")
      const written = await writeWidget(
        "space",
        buildWidgetFile({
          id: "folder/dashboard",
          name: "Mixed folder dashboard",
          createdBy: "test",
          updatedBy: "test",
        }),
        "<!doctype html><h1>Mixed folder dashboard</h1>"
      )
      expect(written.error).toBeNull()
      await recordWidgetVersion("space", "folder/dashboard", null, {
        source: "test",
        updatedBy: "test",
      })
      written.release?.()

      const docId = mintDocumentId()
      const htmlId = mintDocumentId()
      await updateDocumentInventory("space", {
        upsert: [
          {
            documentId: docId,
            path: "folder/note",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: { kind: "file", relativePath: "docs/folder/note.md" },
          },
          {
            documentId: htmlId,
            path: "folder/dashboard",
            format: { id: "worktable.html", sourceVersion: 1 },
            source: {
              kind: "bundle",
              relativePath: "widgets/folder/dashboard",
            },
          },
        ],
      })
      await recordDocAlias("space", "old-note", "folder/note", "exact")
      await recordDocAlias("space", "old-folder", "folder", "prefix")
      await createAnnotation("space", {
        target: { type: "doc", docPath: "folder/note" },
        category: "comment",
        body: "Doc annotation",
      })
      await createAnnotation("space", {
        target: { type: "widget", widgetId: "folder/dashboard" },
        category: "comment",
        body: "HTML annotation",
      })
      const docShare = await createDocumentShare({
        kind: "doc",
        spaceId: "space",
        artifactKey: "folder/note",
      })
      const htmlShare = await createDocumentShare({
        kind: "html",
        spaceId: "space",
        artifactKey: "folder/dashboard",
      })
      const docVersions = await listDocVersions("space", "folder/note")
      const htmlVersions = await listWidgetVersions("space", "folder/dashboard")
      const unclaimed = join(
        workspace,
        "spaces",
        "space",
        "docs",
        "folder",
        "keep.txt"
      )
      writeFileSync(unclaimed, "Unclaimed file\n")
      const widgetManifest = join(
        workspace,
        "spaces",
        "space",
        "widgets",
        "folder",
        "dashboard",
        "widget.yaml"
      )

      let sourceMoves = 0
      setDocumentLifecycleStepHookForTests((step) => {
        if (
          boundary === "source-moved" &&
          step === "source-moved" &&
          ++sourceMoves === 2
        ) {
          expect(notePathEventIfSuppressed(widgetManifest)).toBe(true)
          throw new SimulatedDocumentLifecycleCrash(boundary)
        }
        if (boundary === "committed" && step === "committed") {
          throw new SimulatedDocumentLifecycleCrash(boundary)
        }
      })
      await expect(deleteDocumentFolder("space", "folder")).rejects.toThrow(
        boundary
      )
      setDocumentLifecycleStepHookForTests(null)

      if (boundary === "source-moved") {
        writeFileSync(
          join(workspace, "spaces", "space", "docs", "folder", "note.md"),
          "# Edited during crash recovery\n"
        )
      }
      const recovered = recoverInterruptedDocumentLifecycles()
      expect(recovered).toHaveLength(1)
      if (boundary === "committed") {
        writeFileSync(
          join(workspace, "spaces", "space", "docs", "folder", "note.md"),
          "# Later generation\n"
        )
        mkdirSync(dirname(widgetManifest), { recursive: true })
        writeFileSync(
          widgetManifest,
          stringifyCanonicalYaml(
            buildWidgetFile({
              id: "folder/dashboard",
              name: "Later dashboard generation",
              createdBy: "external",
              updatedBy: "external",
            })
          )
        )
        writeFileSync(
          join(dirname(widgetManifest), "index.html"),
          "<!doctype html><h1>Later dashboard generation</h1>"
        )
        setDocumentLifecycleStepHookForTests((step) => {
          if (step === "delete-source-cleaned") {
            throw new SimulatedDocumentLifecycleCrash(step)
          }
        })
        await expect(
          reconcileRecoveredDocumentLifecycles(recovered)
        ).rejects.toThrow("delete-source-cleaned")
        setDocumentLifecycleStepHookForTests(null)
        const cleanupRecovered = recoverInterruptedDocumentLifecycles()
        expect(cleanupRecovered).toHaveLength(1)
        await reconcileRecoveredDocumentLifecycles(cleanupRecovered)
      } else {
        await reconcileRecoveredDocumentLifecycles(recovered)
        await withWidgetWriteLocks(
          "space",
          ["folder/dashboard"],
          async () => undefined
        )
        await drainWorkspaceChanges()
      }
      expect(recoverInterruptedDocumentLifecycles()).toEqual([])

      const committed = boundary === "committed"
      expect((await readDoc("space", "folder/note")).data).toBe(
        committed ? "# Later generation\n" : "# Edited during crash recovery\n"
      )
      expect((await readWidget("space", "folder/dashboard")).data?.name).toBe(
        committed ? "Later dashboard generation" : "Mixed folder dashboard"
      )
      const recoveredDocVersions = await listDocVersions("space", "folder/note")
      const recoveredHtmlVersions = await listWidgetVersions(
        "space",
        "folder/dashboard"
      )
      if (committed) {
        expect(recoveredDocVersions.length).toBeGreaterThan(0)
        expect(recoveredHtmlVersions.length).toBeGreaterThan(0)
      } else {
        expect(recoveredDocVersions.length).toBeGreaterThan(docVersions.length)
        expect(recoveredHtmlVersions).toEqual(htmlVersions)
      }
      expect(await getDocProvenance("space", "folder/note")).toMatchObject({
        source: "filesystem",
        updatedBy: "external",
      })
      if (committed) {
        expect(
          await getWidgetProvenance("space", "folder/dashboard")
        ).toMatchObject({
          source: "filesystem",
          updatedBy: "external",
        })
      }
      expect((await listAnnotations("space", {})).total).toBe(committed ? 0 : 2)
      expect(await resolveDocumentShare(docShare.token)).toBeNull()
      expect(await resolveDocumentShare(htmlShare.token)).toBeNull()
      expect((await readSpace("space")).data?.settings["docOrder"]).toEqual(
        committed ? ["other"] : ["folder/dashboard", "folder/note", "other"]
      )
      expect((await resolveDocAlias("space", "old-note")).path).toBe(
        committed ? "old-note" : "folder/note"
      )
      expect((await resolveDocAlias("space", "old-folder/child")).path).toBe(
        committed ? "old-folder/child" : "folder/child"
      )
      expect(readFileSync(unclaimed, "utf8")).toBe("Unclaimed file\n")

      const catalog = await buildDocumentCatalog({
        workspaceRoot: workspace,
        spaceId: "space",
      })
      const activeIds = new Set(
        catalog.entries.flatMap((entry) =>
          entry.kind === "document"
            ? [entry.descriptor.documentId]
            : entry.claims.flatMap((claim) =>
                claim.kind === "document" ? [claim.documentId] : []
              )
        )
      )
      expect(activeIds.has(docId)).toBe(!committed)
      expect(activeIds.has(htmlId)).toBe(!committed)
    }
  }, 10_000)

  it("keeps descendant Doc history independent from an exact parent move or deletion", async () => {
    const workspace = join(root, "exact-history-ownership", "workspace")
    const app = join(root, "exact-history-ownership", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))

    const durablePaths = [
      "rename-parent",
      "rename-parent/child",
      "rename-target/child",
      "delete-parent",
      "delete-parent/child",
    ]
    for (const path of [
      ...durablePaths,
      "provisional-parent",
      "provisional-parent/child",
      "provisional-target/child",
    ]) {
      await writeDoc("space", path, `# ${path}\n`)
      await writeDoc("space", path, `# ${path} updated\n`)
    }
    await updateDocumentInventory("space", {
      upsert: durablePaths.map((path) => ({
        documentId: mintDocumentId(),
        path,
        format: { id: "worktable.markdown", sourceVersion: 1 },
        source: { kind: "file" as const, relativePath: `docs/${path}.md` },
      })),
    })

    const renameParentVersions = await listDocVersions("space", "rename-parent")
    const renameChildVersions = await listDocVersions(
      "space",
      "rename-parent/child"
    )
    const renameTargetChildVersions = await listDocVersions(
      "space",
      "rename-target/child"
    )
    const deleteChildVersions = await listDocVersions(
      "space",
      "delete-parent/child"
    )
    const provisionalParentVersions = await listDocVersions(
      "space",
      "provisional-parent"
    )
    const provisionalChildVersions = await listDocVersions(
      "space",
      "provisional-parent/child"
    )
    const provisionalTargetChildVersions = await listDocVersions(
      "space",
      "provisional-target/child"
    )

    expect(
      (await renameDocAndSync("space", "rename-parent", "rename-target")).error
    ).toBeNull()
    expect(await listDocVersions("space", "rename-parent")).toEqual([])
    expect(await listDocVersions("space", "rename-target")).toEqual(
      renameParentVersions
    )
    expect(await listDocVersions("space", "rename-parent/child")).toEqual(
      renameChildVersions
    )
    expect(await listDocVersions("space", "rename-target/child")).toEqual(
      renameTargetChildVersions
    )

    expect((await deleteDoc("space", "delete-parent")).error).toBeNull()
    expect(await listDocVersions("space", "delete-parent")).toEqual([])
    expect(await listDocVersions("space", "delete-parent/child")).toEqual(
      deleteChildVersions
    )

    expect(
      (
        await renameDocAndSync(
          "space",
          "provisional-parent",
          "provisional-target"
        )
      ).error
    ).toBeNull()
    expect(await listDocVersions("space", "provisional-parent")).toEqual([])
    expect(await listDocVersions("space", "provisional-target")).toEqual(
      provisionalParentVersions
    )
    expect(await listDocVersions("space", "provisional-parent/child")).toEqual(
      provisionalChildVersions
    )
    expect(await listDocVersions("space", "provisional-target/child")).toEqual(
      provisionalTargetChildVersions
    )
    const catalog = await buildDocumentCatalog({
      workspaceRoot: workspace,
      spaceId: "space",
    })
    const renamedIdentities = catalog.entries.flatMap((entry) =>
      entry.kind === "document" &&
      ["provisional-parent", "provisional-target"].includes(
        entry.descriptor.path
      )
        ? [
            {
              path: entry.descriptor.path,
              identity: entry.handle.identity,
            },
          ]
        : []
    )
    expect(renamedIdentities).toEqual([
      { path: "provisional-target", identity: "durable" },
    ])
  })

  it("recovers a partially moved exact Doc history as one generation", async () => {
    const workspace = join(root, "partial-history-move", "workspace")
    const app = join(root, "partial-history-move", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "old", "# One\n")
    await writeDoc("space", "old", "# Two\n")
    await writeDoc("space", "old", "# Three\n")
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })
    const originalVersions = await listDocVersions("space", "old")
    expect(originalVersions.length).toBeGreaterThan(1)

    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "history-file-moved") return
      throw new SimulatedDocumentLifecycleCrash(step)
    })
    try {
      await expect(renameDocAndSync("space", "old", "new")).rejects.toThrow(
        "history-file-moved"
      )
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }
    const recovered = recoverInterruptedDocumentLifecycles()
    expect(recovered).toHaveLength(1)
    await reconcileRecoveredDocumentLifecycles(recovered)
    expect(await listDocVersions("space", "old")).toEqual(originalVersions)
    expect(await listDocVersions("space", "new")).toEqual([])
    expect(await docExists("space", "old")).toBe(true)
    expect(await docExists("space", "new")).toBe(false)
  })

  for (const boundary of ["source-moved", "committed"] as const) {
    it(`recovers one all-or-nothing mixed folder generation at ${boundary}`, async () => {
      const workspace = join(root, `prefix-${boundary}`, "workspace")
      const app = join(root, `prefix-${boundary}`, "app")
      mkdirSync(workspace, { recursive: true })
      setWorkspaceRootOverride(workspace)
      setAppDirOverride(app)
      process.env["WORKTABLE_HOSTED"] = "1"
      ensureWorkspaceManifest()
      const space = makeSpace("space")
      space.settings.docOrder = [
        "folder/dashboard",
        "folder/markdown",
        "folder/overview",
        "folder/nested/rich",
      ]
      await writeSpace(space)
      await writeDoc("space", "folder/markdown", "# First\n")
      await writeDoc("space", "folder/markdown", "# Final\n")
      await writeDoc("space", "folder/nested/rich", [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Rich", styles: {} }],
        },
      ])
      const widget = buildWidgetFile({
        id: "folder/dashboard",
        name: "Dashboard",
        createdBy: "test",
        updatedBy: "test",
      })
      const writtenWidget = await writeWidget(
        "space",
        widget,
        "<!doctype html><h1>Dashboard</h1>"
      )
      expect(writtenWidget.error).toBeNull()
      await recordWidgetVersion("space", "folder/dashboard", null, {
        source: "test",
        updatedBy: "test",
      })
      writtenWidget.release?.()
      const overview = await writeWidget(
        "space",
        buildWidgetFile({
          id: "folder/overview",
          name: "Overview",
          createdBy: "test",
          updatedBy: "test",
        }),
        "<!doctype html><h1>Overview</h1>"
      )
      expect(overview.error).toBeNull()
      overview.release?.()
      await writeWidgetState("space", "folder/dashboard", { count: 2 })
      const widgetBundle = join(
        workspace,
        "spaces",
        "space",
        "widgets",
        "folder",
        "dashboard"
      )
      mkdirSync(join(widgetBundle, "assets"), { recursive: true })
      writeFileSync(join(widgetBundle, "assets", "data.txt"), "dashboard data")
      const markdownId = mintDocumentId()
      const htmlId = mintDocumentId()
      await updateDocumentInventory("space", {
        upsert: [
          {
            documentId: markdownId,
            path: "folder/markdown",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: {
              kind: "file",
              relativePath: "docs/folder/markdown.md",
            },
          },
          {
            documentId: htmlId,
            path: "folder/dashboard",
            format: { id: "worktable.html", sourceVersion: 1 },
            source: {
              kind: "bundle",
              relativePath: "widgets/folder/dashboard",
            },
          },
        ],
      })
      const annotation = await createAnnotation("space", {
        target: { type: "doc", docPath: "folder/nested/rich" },
        category: "comment",
        body: "Move with the folder.",
      })
      const htmlAnnotation = await createAnnotation("space", {
        target: { type: "widget", widgetId: "folder/dashboard" },
        category: "comment",
        body: "Move the dashboard too.",
      })
      const markdownShare = await createDocumentShare({
        kind: "doc",
        spaceId: "space",
        artifactKey: "folder/markdown",
      })
      const richShare = await createDocumentShare({
        kind: "doc",
        spaceId: "space",
        artifactKey: "folder/nested/rich",
      })
      const htmlShare = await createDocumentShare({
        kind: "html",
        spaceId: "space",
        artifactKey: "folder/dashboard",
      })
      const markdownVersions = await listDocVersions("space", "folder/markdown")
      const richVersions = await listDocVersions("space", "folder/nested/rich")
      const htmlVersions = await listWidgetVersions("space", "folder/dashboard")

      setDocumentLifecycleStepHookForTests((step) => {
        if (step === boundary) {
          throw new SimulatedDocumentLifecycleCrash(boundary)
        }
      })
      try {
        await expect(
          moveDocumentFolder("space", "folder", "relocated")
        ).rejects.toThrow(boundary)
      } finally {
        setDocumentLifecycleStepHookForTests(null)
      }

      const recovered = recoverInterruptedDocumentLifecycles()
      expect(recovered).toHaveLength(1)
      await reconcileRecoveredDocumentLifecycles(recovered)
      expect(recoverInterruptedDocumentLifecycles()).toEqual([])

      const committed = boundary === "committed"
      const prefix = committed ? "relocated" : "folder"
      const otherPrefix = committed ? "folder" : "relocated"
      expect(await docExists("space", `${prefix}/markdown`)).toBe(true)
      expect(await docExists("space", `${prefix}/nested/rich`)).toBe(true)
      expect(await docExists("space", `${otherPrefix}/markdown`)).toBe(false)
      expect(await docExists("space", `${otherPrefix}/nested/rich`)).toBe(false)
      expect((await readWidget("space", `${prefix}/dashboard`)).data?.id).toBe(
        `${prefix}/dashboard`
      )
      expect(
        (await readWidget("space", `${otherPrefix}/dashboard`)).data
      ).toBeNull()
      expect((await readWidget("space", `${prefix}/overview`)).data?.id).toBe(
        `${prefix}/overview`
      )
      expect(
        (await readWidget("space", `${otherPrefix}/overview`)).data
      ).toBeNull()
      expect(
        await readWidgetHtml("space", `${prefix}/dashboard`)
      ).toMatchObject({
        data: "<!doctype html><h1>Dashboard</h1>",
      })
      expect(await readWidgetState("space", `${prefix}/dashboard`)).toEqual({
        count: 2,
      })
      expect(
        readFileSync(
          join(
            workspace,
            "spaces",
            "space",
            "widgets",
            prefix,
            "dashboard",
            "assets",
            "data.txt"
          ),
          "utf8"
        )
      ).toBe("dashboard data")
      expect((await readDoc("space", `${prefix}/markdown`)).data).toBe(
        "# Final\n"
      )
      expect(
        JSON.stringify((await readDoc("space", `${prefix}/nested/rich`)).data)
      ).toContain("Rich")
      expect(await listDocVersions("space", `${prefix}/markdown`)).toEqual(
        markdownVersions
      )
      expect(await listDocVersions("space", `${prefix}/nested/rich`)).toEqual(
        richVersions
      )
      expect(await listWidgetVersions("space", `${prefix}/dashboard`)).toEqual(
        htmlVersions
      )
      const annotations = await listAnnotations("space", {
        target: { docPath: `${prefix}/nested/rich` },
      })
      expect(annotations.annotations[0]?.id).toBe(annotation.annotation.id)
      const htmlAnnotations = await listAnnotations("space", {
        target: { widgetId: `${prefix}/dashboard` },
      })
      expect(htmlAnnotations.annotations[0]?.id).toBe(
        htmlAnnotation.annotation.id
      )
      expect((await readSpace("space")).data?.settings.docOrder).toEqual([
        `${prefix}/dashboard`,
        `${prefix}/markdown`,
        `${prefix}/overview`,
        `${prefix}/nested/rich`,
      ])
      const catalog = await buildDocumentCatalog({
        workspaceRoot: workspace,
        spaceId: "space",
      })
      const moved = new Map(
        catalog.entries.flatMap((entry) =>
          entry.kind === "document" &&
          entry.descriptor.path.startsWith(`${prefix}/`)
            ? [[entry.descriptor.path, entry] as const]
            : []
        )
      )
      expect(moved.size).toBe(4)
      expect(moved.get(`${prefix}/dashboard`)?.descriptor.documentId).toBe(
        htmlId
      )
      expect(moved.get(`${prefix}/dashboard`)?.handle.identity).toBe("durable")
      expect(moved.get(`${prefix}/overview`)?.handle.identity).toBe(
        committed ? "durable" : "provisional"
      )
      expect(moved.get(`${prefix}/markdown`)?.descriptor.documentId).toBe(
        markdownId
      )
      expect(moved.get(`${prefix}/markdown`)?.handle.identity).toBe("durable")
      expect(moved.get(`${prefix}/nested/rich`)?.handle.identity).toBe(
        committed ? "durable" : "provisional"
      )
      expect(await resolveDocumentShare(markdownShare.token)).toBeNull()
      expect(await resolveDocumentShare(richShare.token)).toBeNull()
      expect(await resolveDocumentShare(htmlShare.token)).toBeNull()
      const resolved = await resolveDocAlias("space", "folder/markdown")
      expect(resolved.path).toBe(
        committed ? "relocated/markdown" : "folder/markdown"
      )
    })
  }

  it("recovers mixed archive state without overwriting authored HTML metadata or minting archive versions", async () => {
    const expectedDocuments = [
      {
        path: "folder/note",
        storageProfileId: DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile,
      },
      {
        path: "folder/widget",
        storageProfileId: DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle,
      },
    ] as const

    const setup = async (name: string) => {
      const workspace = join(root, name, "workspace")
      const app = join(root, name, "app")
      mkdirSync(workspace, { recursive: true })
      setWorkspaceRootOverride(workspace)
      setAppDirOverride(app)
      process.env["WORKTABLE_HOSTED"] = "1"
      ensureWorkspaceManifest()
      await writeSpace(makeSpace("space"))
      await writeDoc("space", "folder/note", "# Archive me\n")
      const written = await writeWidget(
        "space",
        buildWidgetFile({
          id: "folder/widget",
          name: "Archive widget",
          createdBy: "test",
          updatedBy: "test",
        }),
        "<!doctype html><h1>Archive widget</h1>"
      )
      expect(written.error).toBeNull()
      await recordWidgetVersion("space", "folder/widget", null, {
        source: "test",
        updatedBy: "test",
      })
      written.release?.()
      await updateDocumentInventory("space", {
        upsert: [
          {
            documentId: mintDocumentId(),
            path: "folder/note",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: {
              kind: "file",
              relativePath: "docs/folder/note.md",
            },
          },
          {
            documentId: mintDocumentId(),
            path: "folder/widget",
            format: { id: "worktable.html", sourceVersion: 1 },
            source: {
              kind: "bundle",
              relativePath: "widgets/folder/widget",
            },
          },
        ],
      })
      const widgetPath = join(
        workspace,
        "spaces",
        "space",
        "widgets",
        "folder",
        "widget",
        "widget.yaml"
      )
      return {
        app,
        docMetadataPath: join(workspace, "spaces", "space", "docs.meta.json"),
        workspace,
        widgetPath,
        versions: await listWidgetVersions("space", "folder/widget"),
        provenance: await getWidgetProvenance("space", "folder/widget"),
      }
    }

    const setArchived = (archived: boolean) =>
      withDocPathLock("space", () =>
        withWidgetWriteLocks("space", ["folder/widget"], () =>
          setDurableDocumentsArchivedByPrefixLocked(
            "space",
            "folder",
            archived,
            expectedDocuments,
            archived ? { archivedBy: "test" } : undefined
          )
        )
      )
    const drainWidgetReplay = async () => {
      await Promise.resolve()
      await withWidgetWriteLocks("space", ["folder/widget"], async () => {})
      await drainWorkspaceChanges()
    }

    const live = await setup("prefix-archive-live")
    const docShare = await createDocumentShare({
      kind: "doc",
      spaceId: "space",
      artifactKey: "folder/note",
    })
    const htmlShare = await createDocumentShare({
      kind: "html",
      spaceId: "space",
      artifactKey: "folder/widget",
    })
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "before-journal-publication") return
      const manifest = parseCanonicalYaml(
        readFileSync(live.widgetPath, "utf8")
      ) as Record<string, unknown>
      manifest["metadata"] = { external: "preserved" }
      writeFileSync(live.widgetPath, stringifyCanonicalYaml(manifest))
      notePathEventIfSuppressed(live.widgetPath)
    })
    try {
      await setArchived(true)
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }
    await drainWidgetReplay()
    expect(await getDocArchiveInfo("space", "folder/note")).toBeDefined()
    expect((await readWidget("space", "folder/widget")).data).toMatchObject({
      archive: expect.any(Object),
      metadata: { external: "preserved" },
    })
    const externalVersions = await listWidgetVersions("space", "folder/widget")
    const externalProvenance = await getWidgetProvenance(
      "space",
      "folder/widget"
    )
    expect(externalVersions).toHaveLength(live.versions.length + 1)
    expect(externalProvenance).toMatchObject({
      updatedBy: "external",
      source: "filesystem",
    })
    expect(await resolveDocumentShare(docShare.token)).toBeNull()
    expect(await resolveDocumentShare(htmlShare.token)).toBeNull()

    setDocumentLifecycleStepHookForTests((step) => {
      if (step === "before-journal-publication") {
        notePathEventIfSuppressed(live.widgetPath)
      }
    })
    try {
      await setArchived(false)
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }
    await drainWidgetReplay()
    expect(await getDocArchiveInfo("space", "folder/note")).toBeUndefined()
    expect((await readWidget("space", "folder/widget")).data).toMatchObject({
      archive: null,
      metadata: { external: "preserved" },
    })
    expect(await listWidgetVersions("space", "folder/widget")).toEqual(
      externalVersions
    )
    expect(await getWidgetProvenance("space", "folder/widget")).toEqual(
      externalProvenance
    )
    expect(await resolveDocumentShare(docShare.token)).toBeNull()
    expect(await resolveDocumentShare(htmlShare.token)).toBeNull()

    const lateEdit = await setup("prefix-archive-late-metadata-edit")
    let injectedLateEdit = false
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "archive-before-metadata-publication" || injectedLateEdit) {
        return
      }
      injectedLateEdit = true
      const current = existsSync(lateEdit.docMetadataPath)
        ? (JSON.parse(readFileSync(lateEdit.docMetadataPath, "utf8")) as Record<
            string,
            unknown
          >)
        : { version: 1, docs: {} }
      const docs = current["docs"] as Record<string, unknown>
      docs["folder/note"] = {
        ...(docs["folder/note"] as Record<string, unknown> | undefined),
        collaborationCacheEpoch: "external-epoch",
      }
      writeFileSync(
        lateEdit.docMetadataPath,
        `${JSON.stringify(current, null, 2)}\n`
      )
    })
    try {
      await expect(setArchived(true)).rejects.toThrow(
        "document archive metadata changed before publication"
      )
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }
    expect(await getDocCollaborationCacheEpoch("space", "folder/note")).toBe(
      "external-epoch"
    )
    expect(await getDocArchiveInfo("space", "folder/note")).toBeUndefined()
    expect(
      (await readWidget("space", "folder/widget")).data?.archive
    ).toBeNull()

    for (const boundary of ["archive-mutation-written", "committed"] as const) {
      const original = await setup(`prefix-archive-${boundary}`)
      setDocumentLifecycleStepHookForTests((step) => {
        if (step === "archive-mutation-written") {
          if (boundary === step) {
            throw new SimulatedDocumentLifecycleCrash(step)
          }
        }
        if (step === boundary && boundary === "committed") {
          throw new SimulatedDocumentLifecycleCrash(step)
        }
      })
      try {
        await expect(setArchived(true)).rejects.toThrow(boundary)
      } finally {
        setDocumentLifecycleStepHookForTests(null)
      }
      await drainWidgetReplay()
      const recovered = recoverInterruptedDocumentLifecycles()
      expect(recovered).toHaveLength(1)
      await reconcileRecoveredDocumentLifecycles(recovered)
      const committed = boundary === "committed"
      expect(Boolean(await getDocArchiveInfo("space", "folder/note"))).toBe(
        committed
      )
      expect(
        Boolean((await readWidget("space", "folder/widget")).data?.archive)
      ).toBe(committed)
      expect(await listWidgetVersions("space", "folder/widget")).toEqual(
        original.versions
      )
      expect(await getWidgetProvenance("space", "folder/widget")).toEqual(
        original.provenance
      )
      expect((await readWidgetHtml("space", "folder/widget")).data).toBe(
        "<!doctype html><h1>Archive widget</h1>"
      )
    }

    const legacy = await setup("prefix-archive-v1-upgrade")
    setDocumentLifecycleStepHookForTests((step) => {
      if (step === "archive-mutation-written") {
        throw new SimulatedDocumentLifecycleCrash(step)
      }
    })
    try {
      await expect(setArchived(true)).rejects.toThrow(
        "archive-mutation-written"
      )
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }
    const journalPath = join(
      legacy.app,
      "document-lifecycle",
      workspaceCacheKey(),
      "active",
      "journal.json"
    )
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Record<
      string,
      unknown
    >
    journal["planVersion"] = 1
    writeFileSync(journalPath, `${JSON.stringify(journal)}\n`)
    const unplannedSource = join(
      legacy.workspace,
      "spaces",
      "space",
      "docs",
      "folder",
      "unplanned.excalidraw"
    )
    writeFileSync(
      unplannedSource,
      JSON.stringify({ type: "excalidraw", elements: [] })
    )

    const recoveredLegacy = recoverInterruptedDocumentLifecycles()
    expect(recoveredLegacy).toHaveLength(1)
    await reconcileRecoveredDocumentLifecycles(recoveredLegacy)
    expect(readFileSync(unplannedSource, "utf8")).toContain("excalidraw")
  }, 15_000)

  it("recovers an exact HTML bundle deletion on either side of commit", async () => {
    for (const boundary of ["source-moved", "committed"] as const) {
      const workspace = join(root, `html-delete-${boundary}`, "workspace")
      const app = join(root, `html-delete-${boundary}`, "app")
      mkdirSync(workspace, { recursive: true })
      setWorkspaceRootOverride(workspace)
      setAppDirOverride(app)
      process.env["WORKTABLE_HOSTED"] = "1"
      ensureWorkspaceManifest()
      await writeSpace(makeSpace("space"))

      const originalWidget = buildWidgetFile({
        id: "old",
        name: "Original generation",
        createdBy: "test",
        updatedBy: "test",
      })
      const originalHtml = "<!doctype html><p>original generation</p>"
      const written = await writeWidget("space", originalWidget, originalHtml)
      expect(written.error).toBeNull()
      await recordWidgetVersion("space", "old", null, {
        source: "test",
        updatedBy: "test",
      })
      written.release?.()
      await writeWidgetState("space", "old", { counter: 1 })
      const bundlePath = join(workspace, "spaces", "space", "widgets", "old")
      mkdirSync(join(bundlePath, "assets", "empty"), { recursive: true })
      writeFileSync(join(bundlePath, "assets", "data.txt"), "original asset")

      const documentId = mintDocumentId()
      await updateDocumentInventory("space", {
        upsert: [
          {
            documentId,
            path: "old",
            format: { id: "worktable.html", sourceVersion: 1 },
            source: { kind: "bundle", relativePath: "widgets/old" },
          },
        ],
      })
      await recordDocAlias("space", "previous", "old", "exact")
      await createAnnotation("space", {
        target: { type: "widget", widgetId: "old" },
        category: "comment",
        body: "Generation-bound note.",
      })
      const share = await createDocumentShare({
        kind: "html",
        spaceId: "space",
        artifactKey: "old",
      })
      const originalVersions = await listWidgetVersions("space", "old")
      const originalProvenance = await getWidgetProvenance("space", "old")
      expect(originalVersions.length).toBeGreaterThan(0)
      expect(originalProvenance).toBeDefined()

      setDocumentLifecycleStepHookForTests((step) => {
        if (step !== boundary) return
        if (boundary === "committed") {
          const replacement = buildWidgetFile({
            id: "old",
            name: "Replacement generation",
            createdBy: "external",
            updatedBy: "external",
          })
          mkdirSync(join(bundlePath, "assets"), { recursive: true })
          writeFileSync(
            join(bundlePath, "widget.yaml"),
            stringifyCanonicalYaml(replacement)
          )
          writeFileSync(
            join(bundlePath, "index.html"),
            "<!doctype html><p>replacement generation</p>"
          )
          writeFileSync(join(bundlePath, "state.yaml"), "counter: 2\n")
          writeFileSync(join(bundlePath, "assets", "new.txt"), "new asset")
        }
        throw new SimulatedDocumentLifecycleCrash(boundary)
      })
      await expect(deleteHtmlDocument("space", "old")).rejects.toThrow(boundary)
      setDocumentLifecycleStepHookForTests(null)

      const recovered = recoverInterruptedDocumentLifecycles()
      expect(recovered).toHaveLength(1)
      await reconcileRecoveredDocumentLifecycles(recovered)
      expect(recoverInterruptedDocumentLifecycles()).toEqual([])
      expect(await resolveDocumentShare(share.token)).toBeNull()
      expect((await resolveDocAlias("space", "previous")).path).toBe(
        boundary === "committed" ? "previous" : "old"
      )

      const widget = await readWidget("space", "old")
      const html = await readWidgetHtml("space", "old")
      const state = await readWidgetState("space", "old")
      const catalog = await buildDocumentCatalog({
        workspaceRoot: workspace,
        spaceId: "space",
      })
      const visible = catalog.entries.find(
        (entry) => entry.kind === "document" && entry.descriptor.path === "old"
      )
      expect(visible?.kind).toBe("document")

      if (boundary === "source-moved") {
        expect(widget.data?.name).toBe("Original generation")
        expect(html.data).toBe(originalHtml)
        expect(state).toEqual({ counter: 1 })
        expect(
          readFileSync(join(bundlePath, "assets", "data.txt"), "utf8")
        ).toBe("original asset")
        expect(existsSync(join(bundlePath, "assets", "empty"))).toBe(true)
        expect(await listWidgetVersions("space", "old")).toEqual(
          originalVersions
        )
        expect(await getWidgetProvenance("space", "old")).toEqual(
          originalProvenance
        )
        expect(
          visible?.kind === "document"
            ? visible.descriptor.documentId
            : undefined
        ).toBe(documentId)
        expect((await listAnnotations("space", {})).total).toBe(1)
        expect((await readSpace("space")).data?.settings["docOrder"]).toEqual([
          "old",
          "other",
        ])
      } else {
        expect(widget.data?.name).toBe("Replacement generation")
        expect(html.data).toContain("replacement generation")
        expect(state).toEqual({ counter: 2 })
        expect(
          readFileSync(join(bundlePath, "assets", "new.txt"), "utf8")
        ).toBe("new asset")
        const currentVersions = await listWidgetVersions("space", "old")
        expect(
          currentVersions.some((current) =>
            originalVersions.some((original) => original.id === current.id)
          )
        ).toBe(false)
        const currentProvenance = await getWidgetProvenance("space", "old")
        expect(
          currentVersions.some(
            (version) => version.id === currentProvenance?.versionId
          )
        ).toBe(true)
        expect(
          visible?.kind === "document"
            ? visible.descriptor.documentId
            : undefined
        ).not.toBe(documentId)
        expect((await listAnnotations("space", {})).total).toBe(0)
        expect((await readSpace("space")).data?.settings["docOrder"]).toEqual([
          "other",
        ])
      }
    }
  }, 5_000)

  it("recovers one exact HTML bundle move on either side of commit", async () => {
    for (const boundary of ["source-moved", "committed"] as const) {
      const workspace = join(root, `html-move-${boundary}`, "workspace")
      const app = join(root, `html-move-${boundary}`, "app")
      mkdirSync(workspace, { recursive: true })
      setWorkspaceRootOverride(workspace)
      setAppDirOverride(app)
      process.env["WORKTABLE_HOSTED"] = "1"
      ensureWorkspaceManifest()
      await writeSpace(makeSpace("space"))

      const originalWidget = buildWidgetFile({
        id: "old",
        name: "Original HTML document",
        createdBy: "test",
        updatedBy: "test",
      })
      const originalHtml = "<!doctype html><p>portable bundle</p>"
      const written = await writeWidget("space", originalWidget, originalHtml)
      expect(written.error).toBeNull()
      await recordWidgetVersion("space", "old", null, {
        source: "test",
        updatedBy: "test",
      })
      written.release?.()
      await writeWidgetState("space", "old", { tab: "overview" })
      const sourceBundle = join(workspace, "spaces", "space", "widgets", "old")
      mkdirSync(join(sourceBundle, "assets", "nested"), { recursive: true })
      writeFileSync(
        join(sourceBundle, "assets", "nested", "data.txt"),
        "authored companion"
      )
      writeFileSync(
        join(sourceBundle, "widget.yaml"),
        `${readFileSync(join(sourceBundle, "widget.yaml"), "utf8")}# extension-owned note\nextensionConfig:\n  mode: preserved\n`
      )

      const documentId = mintDocumentId()
      await updateDocumentInventory("space", {
        upsert: [
          {
            documentId,
            path: "old",
            format: { id: "worktable.html", sourceVersion: 1 },
            source: { kind: "bundle", relativePath: "widgets/old" },
          },
        ],
      })
      const annotation = await createAnnotation("space", {
        target: { type: "widget", widgetId: "old" },
        category: "comment",
        body: "Move with the HTML document.",
      })
      const sourceShare = await createDocumentShare({
        kind: "html",
        spaceId: "space",
        artifactKey: "old",
      })
      const targetShare = await createDocumentShare({
        kind: "html",
        spaceId: "space",
        artifactKey: "folder/new",
      })
      const originalVersion = (await listWidgetVersions("space", "old"))[0]!

      setDocumentLifecycleStepHookForTests((step) => {
        if (step === boundary) {
          throw new SimulatedDocumentLifecycleCrash(boundary)
        }
      })
      await expect(
        moveHtmlDocument("space", "old", "folder/new")
      ).rejects.toThrow(boundary)
      setDocumentLifecycleStepHookForTests(null)

      const externallyEditedHtml =
        "<!doctype html><p>edited while the move was interrupted</p>"
      if (boundary === "source-moved") {
        writeFileSync(
          join(
            workspace,
            "spaces",
            "space",
            "widgets",
            "folder",
            "new",
            "index.html"
          ),
          externallyEditedHtml
        )
      }

      const recovered = recoverInterruptedDocumentLifecycles()
      expect(recovered).toHaveLength(1)
      await reconcileRecoveredDocumentLifecycles(recovered)
      expect(recoverInterruptedDocumentLifecycles()).toEqual([])

      const committed = boundary === "committed"
      const expectedPath = committed ? "folder/new" : "old"
      const otherPath = committed ? "old" : "folder/new"
      const expectedBundle = join(
        workspace,
        "spaces",
        "space",
        "widgets",
        ...expectedPath.split("/")
      )
      expect((await readWidget("space", expectedPath)).data).toMatchObject({
        id: expectedPath,
        name: "Original HTML document",
      })
      expect((await readWidget("space", otherPath)).data).toBeNull()
      expect((await readWidgetHtml("space", expectedPath)).data).toBe(
        committed ? originalHtml : externallyEditedHtml
      )
      expect(await readWidgetState("space", expectedPath)).toEqual({
        tab: "overview",
      })
      expect(
        readFileSync(
          join(expectedBundle, "assets", "nested", "data.txt"),
          "utf8"
        )
      ).toBe("authored companion")
      const movedManifest = readFileSync(
        join(expectedBundle, "widget.yaml"),
        "utf8"
      )
      expect(movedManifest).toContain("# extension-owned note")
      expect(parseCanonicalYaml(movedManifest)).toMatchObject({
        id: expectedPath,
        extensionConfig: { mode: "preserved" },
      })

      expect(
        await getWidgetVersion("space", expectedPath, originalVersion.id)
      ).toMatchObject({
        after: { content: { html: originalHtml } },
      })
      expect(
        await getWidgetVersion("space", otherPath, originalVersion.id)
      ).toBeNull()
      const currentProvenance = await getWidgetProvenance("space", expectedPath)
      if (committed) {
        expect(currentProvenance).toMatchObject({
          versionId: originalVersion.id,
        })
      } else {
        expect(currentProvenance).toMatchObject({ source: "filesystem" })
        expect(
          currentProvenance
            ? await getWidgetVersion(
                "space",
                expectedPath,
                currentProvenance.versionId
              )
            : null
        ).toMatchObject({
          after: { content: { html: externallyEditedHtml } },
        })
      }
      expect(await getWidgetProvenance("space", otherPath)).toBeUndefined()

      const movedAnnotation = await listAnnotations("space", {
        target: { type: "widget", widgetId: expectedPath },
      })
      expect(movedAnnotation.annotations).toEqual([
        expect.objectContaining({
          id: annotation.annotation.id,
          target: { type: "widget", widgetId: expectedPath },
        }),
      ])
      expect(
        (
          await listAnnotations("space", {
            target: { type: "widget", widgetId: otherPath },
          })
        ).total
      ).toBe(0)
      expect((await readSpace("space")).data?.settings["docOrder"]).toEqual([
        expectedPath,
        "other",
      ])

      const catalog = await buildDocumentCatalog({
        workspaceRoot: workspace,
        spaceId: "space",
      })
      const identities = catalog.entries.flatMap((entry) =>
        entry.kind === "document" && entry.descriptor.documentId === documentId
          ? [entry]
          : []
      )
      expect(identities).toHaveLength(1)
      const identity = identities[0]
      if (!identity) throw new Error("Expected moved HTML document identity")
      expect(identity.descriptor.path).toBe(expectedPath)
      expect(identity.handle.identity).toBe("durable")
      expect((await resolveDocAlias("space", "old")).path).toBe(
        committed ? "folder/new" : "old"
      )
      expect(await resolveDocumentShare(sourceShare.token)).toBeNull()
      expect(await resolveDocumentShare(targetShare.token)).toBeNull()
    }
  }, 5_000)

  it("does not delete a substituted or unsafe HTML bundle", async () => {
    const workspace = join(root, "html-delete-substitution", "workspace")
    const app = join(root, "html-delete-substitution", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    const original = buildWidgetFile({ id: "old", name: "Original" })
    const written = await writeWidget(
      "space",
      original,
      "<!doctype html><p>original</p>"
    )
    written.release?.()
    await writeWidgetState("space", "old", { generation: "original" })
    const documentId = mintDocumentId()
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId,
          path: "old",
          format: { id: "worktable.html", sourceVersion: 1 },
          source: { kind: "bundle", relativePath: "widgets/old" },
        },
      ],
    })
    const bundlePath = join(workspace, "spaces", "space", "widgets", "old")
    const parkedPath = join(workspace, "parked-original")
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "journal-published") return
      renameSync(bundlePath, parkedPath)
      const replacement = buildWidgetFile({
        id: "old",
        name: "Replacement",
        createdBy: "external",
        updatedBy: "external",
      })
      mkdirSync(bundlePath, { recursive: true })
      writeFileSync(
        join(bundlePath, "widget.yaml"),
        stringifyCanonicalYaml(replacement)
      )
      writeFileSync(
        join(bundlePath, "index.html"),
        "<!doctype html><p>replacement</p>"
      )
      writeFileSync(join(bundlePath, "state.yaml"), "generation: replacement\n")
    })
    await expect(deleteHtmlDocument("space", "old")).rejects.toThrow()
    setDocumentLifecycleStepHookForTests(null)

    expect(recoverInterruptedDocumentLifecycles()).toEqual([])
    expect((await readWidget("space", "old")).data?.name).toBe("Replacement")
    expect((await readWidgetHtml("space", "old")).data).toContain("replacement")
    expect(await readWidgetState("space", "old")).toEqual({
      generation: "replacement",
    })
    const catalog = await buildDocumentCatalog({
      workspaceRoot: workspace,
      spaceId: "space",
    })
    const visible = catalog.entries.find(
      (entry) => entry.kind === "document" && entry.descriptor.path === "old"
    )
    expect(
      visible?.kind === "document" ? visible.descriptor.documentId : undefined
    ).toBe(documentId)

    symlinkSync(parkedPath, join(bundlePath, "unsafe-link"), "dir")
    const unsafe = await deleteHtmlDocument("space", "old")
    expect(unsafe).toMatchObject({ ok: false, kind: "conflict" })
    expect((await readWidget("space", "old")).data?.name).toBe("Replacement")
    expect(existsSync(parkedPath)).toBe(true)
  })

  it("keeps one stable identity across crashes in either format transition", async () => {
    const transitions = [
      {
        name: "markdown-to-rich",
        docPath: "doc",
        initial: "# Stable\n",
        initialFormat: { id: "worktable.markdown", sourceVersion: 1 },
        initialSource: "docs/doc.md",
        targetFormat: { id: "worktable.rich-text", sourceVersion: 1 },
        targetSource: "docs/doc.json",
        targetBytes: Buffer.from(
          JSON.stringify(
            [
              {
                id: "stable-block",
                type: "heading",
                props: { level: 1 },
                content: [{ type: "text", text: "Stable", styles: {} }],
                children: [],
              },
            ],
            null,
            2
          )
        ),
        expectedData: "Stable",
        externalBytes: Buffer.from(
          JSON.stringify([{ type: "paragraph", external: "Rich edit" }])
        ),
        externalData: "Rich edit",
        boundaries: [
          "journal-published",
          "target-published",
          "source-moved",
          "inventory",
          "committed",
          "cleanup-renamed",
        ],
      },
      {
        name: "rich-to-markdown",
        docPath: "doc.md",
        initial: [
          {
            id: "stable-block",
            type: "heading",
            props: { level: 1 },
            content: [{ type: "text", text: "Stable", styles: {} }],
            children: [],
          },
        ],
        initialFormat: { id: "worktable.rich-text", sourceVersion: 1 },
        initialSource: "docs/doc.md.json",
        targetFormat: { id: "worktable.markdown", sourceVersion: 1 },
        targetSource: "docs/doc.md.md",
        targetBytes: Buffer.from("# Stable\n"),
        expectedData: "# Stable",
        externalBytes: Buffer.from("# External Markdown edit\n"),
        externalData: "External Markdown edit",
        boundaries: [
          "target-published",
          "source-moved",
          "doc-meta",
          "inventory",
          "committed",
          "cleanup-renamed",
        ],
      },
    ] as const

    for (const transition of transitions) {
      for (const boundary of transition.boundaries) {
        const workspace = join(root, transition.name, boundary, "workspace")
        const app = join(root, transition.name, boundary, "app")
        mkdirSync(workspace, { recursive: true })
        setWorkspaceRootOverride(workspace)
        setAppDirOverride(app)
        ensureWorkspaceManifest()
        await writeSpace(makeSpace("space"))
        if (transition.name === "markdown-to-rich") {
          const source = join(
            workspace,
            "spaces",
            "space",
            transition.initialSource
          )
          mkdirSync(dirname(source), { recursive: true })
          writeFileSync(source, transition.initial)
        } else {
          await writeDoc("space", transition.docPath, [...transition.initial])
        }
        const documentId = mintDocumentId()
        await updateDocumentInventory("space", {
          upsert: [
            {
              documentId,
              path: transition.docPath,
              format: transition.initialFormat,
              source: {
                kind: "file",
                relativePath: transition.initialSource,
              },
            },
          ],
        })
        setDocumentLifecycleStepHookForTests((step) => {
          if (step === boundary) {
            if (boundary === "committed") {
              writeFileSync(
                join(workspace, "spaces", "space", transition.targetSource),
                transition.externalBytes
              )
            }
            throw new SimulatedDocumentLifecycleCrash(boundary)
          }
        })

        await expect(
          withDocPathLock("space", () =>
            transitionDurableDocumentFormatLocked({
              spaceId: "space",
              docPath: transition.docPath,
              format: transition.targetFormat,
              bytes: transition.targetBytes,
              rotateCollaborationCache:
                transition.targetFormat.id === "worktable.markdown",
              context: { updatedBy: "user", source: "rest-api" },
            })
          )
        ).rejects.toThrow(boundary)
        setDocumentLifecycleStepHookForTests(null)

        if (boundary === "journal-published") {
          const active = join(
            app,
            "document-lifecycle",
            workspaceCacheKey(),
            "active"
          )
          const journal = JSON.parse(
            readFileSync(join(active, "journal.json"), "utf8")
          ) as { operationId: string }
          writeFileSync(
            join(
              workspace,
              "spaces",
              "space",
              "docs",
              `.worktable-${journal.operationId}.target.worktable-lifecycle.tmp`
            ),
            "abandoned target staging bytes"
          )
        }

        const recovered = recoverInterruptedDocumentLifecycles()
        const editDuringReconciliation =
          transition.name === "markdown-to-rich" &&
          boundary === "cleanup-renamed"
        if (editDuringReconciliation) {
          setDocumentLifecycleStepHookForTests((step) => {
            if (step === "reconciliation-target-captured") {
              writeFileSync(
                join(workspace, "spaces", "space", transition.targetSource),
                transition.externalBytes
              )
            }
          })
        }
        try {
          await reconcileRecoveredDocumentLifecycles(recovered)
        } finally {
          setDocumentLifecycleStepHookForTests(null)
        }
        if (editDuringReconciliation) {
          const conversionProvenance = await getDocProvenance(
            "space",
            transition.docPath
          )
          expect(conversionProvenance).toMatchObject({
            updatedBy: "user",
            source: "rest-api",
          })
          const conversionVersion = await getDocVersion(
            "space",
            transition.docPath,
            conversionProvenance!.versionId
          )
          expect(JSON.stringify(conversionVersion?.after.content)).toContain(
            transition.expectedData
          )

          expect(await syncExternalDocChange("space", transition.docPath)).toBe(
            true
          )
          const externalProvenance = await getDocProvenance(
            "space",
            transition.docPath
          )
          expect(externalProvenance).toMatchObject({
            updatedBy: "external",
            source: "filesystem",
          })
          expect(externalProvenance?.versionId).not.toBe(
            conversionProvenance?.versionId
          )
        }
        const committed =
          boundary === "committed" || boundary === "cleanup-renamed"
        const expectedFormat = committed
          ? transition.targetFormat
          : transition.initialFormat
        const expectedSource = committed
          ? transition.targetSource
          : transition.initialSource
        const catalog = await buildDocumentCatalog({
          workspaceRoot: workspace,
          spaceId: "space",
        })
        const matches = catalog.entries.filter(
          (entry) =>
            entry.kind === "document" &&
            entry.descriptor.documentId === documentId
        )
        expect(matches).toHaveLength(1)
        expect(matches[0]?.kind).toBe("document")
        if (matches[0]?.kind === "document") {
          expect(matches[0].descriptor.path).toBe(transition.docPath)
          expect(matches[0].descriptor.format).toEqual(expectedFormat)
          expect(matches[0].handle.source).toEqual({
            kind: "file",
            relativePath: expectedSource,
          })
        }
        const stored = await readDoc("space", transition.docPath)
        expect(JSON.stringify(stored.data)).toContain(
          boundary === "committed" || editDuringReconciliation
            ? transition.externalData
            : committed
              ? transition.expectedData
              : transition.name === "markdown-to-rich"
                ? "# Stable"
                : "Stable"
        )
        if (boundary === "committed" || boundary === "cleanup-renamed") {
          const provenance = await getDocProvenance("space", transition.docPath)
          expect(provenance).toMatchObject({
            updatedBy:
              boundary === "committed" || editDuringReconciliation
                ? "external"
                : "user",
            source:
              boundary === "committed" || editDuringReconciliation
                ? "filesystem"
                : "rest-api",
          })
          const version = await getDocVersion(
            "space",
            transition.docPath,
            provenance!.versionId
          )
          if (!editDuringReconciliation) {
            expect(version?.before?.format).toBe(
              transition.name === "markdown-to-rich" ? "markdown" : "blocknote"
            )
            expect(JSON.stringify(version?.before?.content)).toContain("Stable")
          }
          expect(version?.after.content).toEqual(stored.data)
        }
        if (transition.name === "markdown-to-rich" && !committed) {
          expect(
            await getDocProvenance("space", transition.docPath)
          ).toBeUndefined()
        }
        const docsDir = join(workspace, "spaces", "space", "docs")
        expect(
          readdirSync(docsDir).filter((name) =>
            name.startsWith(".worktable-dlc_")
          )
        ).toEqual([])
        expect(recoverInterruptedDocumentLifecycles()).toEqual([])
      }
    }
  }, 15_000)

  it("rejects format targets derived from outdated source revisions", async () => {
    const workspace = join(root, "stale-conversion", "workspace")
    const app = join(root, "stale-conversion", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "doc", [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Original", styles: {} }],
      },
    ])
    let validationCount = 0
    const result = await convertDocToMarkdownStorage("space", "doc", {
      validateBeforeCommit: async () => {
        validationCount += 1
        if (validationCount === 1) {
          writeFileSync(
            join(workspace, "spaces", "space", "docs", "doc.json"),
            JSON.stringify([
              {
                type: "paragraph",
                content: [{ type: "text", text: "External", styles: {} }],
              },
            ])
          )
        }
        return true
      },
    })

    const stored = await readDoc("space", "doc")
    expect(JSON.stringify(stored.data)).toContain("External")
    expect(JSON.stringify(stored.data)).not.toContain("Original")
    expect(
      ["doc.json", "doc.md"].filter((name) =>
        existsSync(join(workspace, "spaces", "space", "docs", name))
      )
    ).toHaveLength(1)
    if (!result.ok) expect(stored.storedAs).toBe("json")

    await writeSpace(makeSpace("markdown"))
    await writeDoc("markdown", "doc", "# Original\n")
    await updateDocumentInventory("markdown", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "doc",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/doc.md" },
        },
      ],
    })
    const markdownSnapshot = await readDocSourceSnapshot("markdown", "doc")
    expect(markdownSnapshot.revision).toBeDefined()
    writeFileSync(
      join(workspace, "spaces", "markdown", "docs", "doc.md"),
      "# External\n"
    )
    const markdownResult = await writeDoc(
      "markdown",
      "doc",
      [
        {
          type: "heading",
          props: { level: 1 },
          content: [{ type: "text", text: "Original", styles: {} }],
        },
      ],
      { sourceRevision: markdownSnapshot.revision }
    )
    expect(markdownResult).toMatchObject({ ok: false, storedAs: "md" })
    expect(await readDoc("markdown", "doc")).toMatchObject({
      data: "# External\n",
      storedAs: "md",
    })
    expect(
      existsSync(join(workspace, "spaces", "markdown", "docs", "doc.json"))
    ).toBe(false)
    expect(workspaceRecoveryRequired()).toBe(false)
    expect(recoverInterruptedDocumentLifecycles()).toEqual([])
  })

  it("serializes durable format transitions across Spaces", async () => {
    const workspace = join(root, "concurrent-formats", "workspace")
    const app = join(root, "concurrent-formats", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()

    for (const spaceId of ["one", "two"]) {
      await writeSpace(makeSpace(spaceId))
      await writeDoc(spaceId, "doc", "# Markdown\n")
      await updateDocumentInventory(spaceId, {
        upsert: [
          {
            documentId: mintDocumentId(),
            path: "doc",
            format: { id: "worktable.markdown", sourceVersion: 1 },
            source: { kind: "file", relativePath: "docs/doc.md" },
          },
        ],
      })
    }

    const results = await Promise.all(
      ["one", "two"].map((spaceId) =>
        writeDoc(spaceId, "doc", [
          {
            type: "paragraph",
            content: [{ type: "text", text: spaceId, styles: {} }],
          },
        ])
      )
    )

    expect(results).toEqual([
      expect.objectContaining({ ok: true, storedAs: "json" }),
      expect.objectContaining({ ok: true, storedAs: "json" }),
    ])
    expect(workspaceRecoveryRequired()).toBe(false)
    expect(recoverInterruptedDocumentLifecycles()).toEqual([])
  })

  it("preserves an externally changed target instead of compensating over it", async () => {
    const workspace = join(root, "changed-format-target", "workspace")
    const app = join(root, "changed-format-target", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "doc", "# Original\n")
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "doc",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/doc.md" },
        },
      ],
    })
    const oldSource = join(workspace, "spaces", "space", "docs", "doc.md")
    const target = join(workspace, "spaces", "space", "docs", "doc.json")
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "inventory") return
      writeFileSync(target, JSON.stringify([{ external: true }]))
    })
    await expect(
      withDocPathLock("space", () =>
        transitionDurableDocumentFormatLocked({
          spaceId: "space",
          docPath: "doc",
          format: { id: "worktable.rich-text", sourceVersion: 1 },
          bytes: Buffer.from(JSON.stringify([{ converted: true }])),
        })
      )
    ).rejects.toThrow(/recovery|compensation/)
    setDocumentLifecycleStepHookForTests(null)

    expect(() => recoverInterruptedDocumentLifecycles()).toThrow(
      /target changed/
    )
    expect(readFileSync(target, "utf8")).toContain("external")
    expect(existsSync(oldSource)).toBe(false)
    const parked = readdirSync(dirname(oldSource)).find((name) =>
      name.endsWith(".source")
    )
    expect(parked).toBeDefined()
    expect(readFileSync(join(dirname(oldSource), parked!), "utf8")).toBe(
      "# Original\n"
    )
    expect(await readDoc("space", "doc")).toMatchObject({ storedAs: "json" })
  })

  it("preserves a recreated old source after a committed transition", async () => {
    const workspace = join(root, "recreated-format-source", "workspace")
    const app = join(root, "recreated-format-source", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "doc", "# Original\n")
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "doc",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/doc.md" },
        },
      ],
    })
    const oldSource = join(workspace, "spaces", "space", "docs", "doc.md")
    const target = join(workspace, "spaces", "space", "docs", "doc.json")
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "committed") return
      writeFileSync(oldSource, "# Recreated\n")
      throw new SimulatedDocumentLifecycleCrash(step)
    })
    await expect(
      withDocPathLock("space", () =>
        transitionDurableDocumentFormatLocked({
          spaceId: "space",
          docPath: "doc",
          format: { id: "worktable.rich-text", sourceVersion: 1 },
          bytes: Buffer.from(JSON.stringify([{ converted: true }])),
        })
      )
    ).rejects.toThrow("committed")
    setDocumentLifecycleStepHookForTests(null)

    expect(() => recoverInterruptedDocumentLifecycles()).toThrow(
      /source ownership|sources did not reach/
    )
    expect(readFileSync(oldSource, "utf8")).toBe("# Recreated\n")
    expect(existsSync(target)).toBe(true)
    const parked = readdirSync(dirname(oldSource)).find((name) =>
      name.endsWith(".source")
    )
    expect(parked).toBeDefined()
    expect(readFileSync(join(dirname(oldSource), parked!), "utf8")).toBe(
      "# Original\n"
    )
  })

  it("refuses reconciliation through a substituted nested source symlink", async () => {
    const workspace = join(root, "unsafe-recovery-path", "workspace")
    const app = join(root, "unsafe-recovery-path", "app")
    const external = join(root, "unsafe-recovery-path", "external")
    mkdirSync(workspace, { recursive: true })
    mkdirSync(external, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "old", "# Stable\n")
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })
    const targetBytes = Buffer.from(
      JSON.stringify([{ type: "paragraph", content: [] }])
    )
    setDocumentLifecycleStepHookForTests((step) => {
      if (step === "committed") throw new SimulatedDocumentLifecycleCrash(step)
    })
    await expect(
      withDocPathLock("space", () =>
        transitionDurableDocumentFormatLocked({
          spaceId: "space",
          docPath: "old",
          format: { id: "worktable.rich-text", sourceVersion: 1 },
          bytes: targetBytes,
        })
      )
    ).rejects.toThrow("committed")
    setDocumentLifecycleStepHookForTests(null)
    const recovered = recoverInterruptedDocumentLifecycles()
    const provenanceBefore = await getDocProvenance("space", "old")
    const docsRoot = join(workspace, "spaces", "space", "docs")
    renameSync(docsRoot, `${docsRoot}.parked`)
    const sentinel = join(external, "sentinel.txt")
    writeFileSync(sentinel, "outside\n")
    writeFileSync(join(external, "old.json"), targetBytes)
    writeFileSync(
      join(external, `.worktable-${recovered[0]!.operationId}.source`),
      "# Stable\n"
    )
    symlinkSync(external, docsRoot, "dir")

    await expect(
      reconcileRecoveredDocumentLifecycles(recovered)
    ).rejects.toThrow(/symbolic link/)
    expect(readFileSync(sentinel, "utf8")).toBe("outside\n")
    expect(readFileSync(join(external, "old.json"))).toEqual(targetBytes)
    expect(await getDocProvenance("space", "old")).toEqual(provenanceBefore)
  })

  it("refuses corrupted recovery artifacts without changing the workspace again", async () => {
    const workspace = join(root, "corrupt-recovery", "workspace")
    const app = join(root, "corrupt-recovery", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "old", "# Stable\n")
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })
    setDocumentLifecycleStepHookForTests((step) => {
      if (step === "source") {
        throw new SimulatedDocumentLifecycleCrash(step)
      }
    })
    await expect(renameDocAndSync("space", "old", "new")).rejects.toThrow(
      "source"
    )
    setDocumentLifecycleStepHookForTests(null)

    const oldBeforeRecovery = await docExists("space", "old")
    const newBeforeRecovery = await docExists("space", "new")
    writeFileSync(
      join(
        app,
        "document-lifecycle",
        workspaceCacheKey(),
        "active",
        "artifacts",
        "inventory.before.bin"
      ),
      "corrupted\n"
    )

    expect(() => recoverInterruptedDocumentLifecycles()).toThrow(
      /artifact (?:is invalid|does not match)|recovery artifact/i
    )
    expect(await docExists("space", "old")).toBe(oldBeforeRecovery)
    expect(await docExists("space", "new")).toBe(newBeforeRecovery)
  })

  it("does not publish a stale plan over metadata edited during preparation", async () => {
    const workspace = join(root, "stale-plan", "workspace")
    const app = join(root, "stale-plan", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "old", "# Stable\n")
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })
    const spacePath = join(workspace, "spaces", "space", "space.json")
    let externalBytes = ""
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "before-journal-publication") return
      const externalSpace = JSON.parse(readFileSync(spacePath, "utf8")) as {
        name: string
        updatedAt: string
      }
      externalSpace.name = "Edited outside Worktable"
      externalSpace.updatedAt = new Date().toISOString()
      externalBytes = `${JSON.stringify(externalSpace, null, 2)}\n`
      writeFileSync(spacePath, externalBytes)
    })

    try {
      await expect(renameDocAndSync("space", "old", "new")).rejects.toThrow()
      expect(readFileSync(spacePath, "utf8")).toBe(externalBytes)
      expect((await readSpace("space")).data?.name).toBe(
        "Edited outside Worktable"
      )
      expect(await docExists("space", "old")).toBe(true)
      expect(await docExists("space", "new")).toBe(false)
      expect(recoverInterruptedDocumentLifecycles()).toEqual([])
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }
  })

  it("compensates when journal publication finishes but its durability step fails", async () => {
    const workspace = join(root, "publication-failure", "workspace")
    const app = join(root, "publication-failure", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "old", "# Stable\n")
    const documentId = mintDocumentId()
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId,
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })
    setDocumentLifecycleStepHookForTests((step) => {
      if (step === "journal-published") {
        throw new Error("journal parent fsync failed")
      }
    })

    try {
      await expect(renameDocAndSync("space", "old", "new")).rejects.toThrow(
        "journal parent fsync failed"
      )
      expect(recoverInterruptedDocumentLifecycles()).toEqual([])
      expect(await docExists("space", "old")).toBe(true)
      expect(await docExists("space", "new")).toBe(false)
      const catalog = await buildDocumentCatalog({
        workspaceRoot: workspace,
        spaceId: "space",
      })
      const identity = catalog.entries.find(
        (entry) =>
          entry.kind === "document" &&
          entry.descriptor.documentId === documentId
      )
      expect(identity?.kind).toBe("document")
      if (identity?.kind === "document") {
        expect(identity.descriptor.path).toBe("old")
      }
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }
  })

  it("compensates ordinary exact and folder failures without reviving shares or discarding external edits", async () => {
    const workspace = join(root, "ordinary-failure", "workspace")
    const app = join(root, "ordinary-failure", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    process.env["WORKTABLE_HOSTED"] = "1"
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "old", "# Stable\n")
    const documentId = mintDocumentId()
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId,
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })
    const sourceShare = await createDocumentShare({
      kind: "doc",
      spaceId: "space",
      artifactKey: "old",
    })
    const targetShare = await createDocumentShare({
      kind: "doc",
      spaceId: "space",
      artifactKey: "folder/new",
    })

    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "source") return
      const target = join(
        workspace,
        "spaces",
        "space",
        "docs",
        "folder",
        "new.md"
      )
      writeFileSync(target, "# External edit\n")
      expect(notePathEventIfSuppressed(target)).toBe(true)
      throw new Error("simulated ancillary failure")
    })

    try {
      await expect(
        renameDocAndSync("space", "old", "folder/new")
      ).rejects.toThrow("simulated ancillary failure")
      setDocumentLifecycleStepHookForTests(null)
      await Promise.resolve()
      await drainWorkspaceChanges()

      expect(recoverInterruptedDocumentLifecycles()).toEqual([])
      expect((await readDoc("space", "old")).data).toBe("# External edit\n")
      expect(await getDocProvenance("space", "old")).toMatchObject({
        source: "filesystem",
        updatedBy: "external",
      })
      expect(await docExists("space", "folder/new")).toBe(false)
      const catalog = await buildDocumentCatalog({
        workspaceRoot: workspace,
        spaceId: "space",
      })
      const identity = catalog.entries.find(
        (entry) =>
          entry.kind === "document" &&
          entry.descriptor.documentId === documentId
      )
      expect(identity?.kind).toBe("document")
      if (identity?.kind === "document") {
        expect(identity.descriptor.path).toBe("old")
      }
      expect(await resolveDocumentShare(sourceShare.token)).toBeNull()
      expect(await resolveDocumentShare(targetShare.token)).toBeNull()
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }

    const folderWorkspace = join(root, "ordinary-folder-failure", "workspace")
    const folderApp = join(root, "ordinary-folder-failure", "app")
    mkdirSync(folderWorkspace, { recursive: true })
    setWorkspaceRootOverride(folderWorkspace)
    setAppDirOverride(folderApp)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    const folderDocuments = ["folder/first", "folder/nested/second"] as const
    await writeDoc("space", folderDocuments[0], "# First\n")
    await writeDoc("space", folderDocuments[1], "# Stable\n")
    await updateDocumentInventory("space", {
      upsert: folderDocuments.map((path) => ({
        documentId: mintDocumentId(),
        path,
        format: { id: "worktable.markdown" as const, sourceVersion: 1 },
        source: { kind: "file" as const, relativePath: `docs/${path}.md` },
      })),
    })
    const folderSourceShare = await createDocumentShare({
      kind: "doc",
      spaceId: "space",
      artifactKey: folderDocuments[1],
    })
    const folderTargetShare = await createDocumentShare({
      kind: "doc",
      spaceId: "space",
      artifactKey: "archive/nested/second",
    })
    let movedFolderDocuments = 0
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "source-moved" || ++movedFolderDocuments !== 2) return
      const target = join(
        folderWorkspace,
        "spaces",
        "space",
        "docs",
        "archive",
        "nested",
        "second.md"
      )
      writeFileSync(target, "# External folder edit\n")
      expect(notePathEventIfSuppressed(target)).toBe(true)
      throw new Error("simulated folder ancillary failure")
    })

    try {
      await expect(
        renameDocsByPrefixAndSync("space", "folder", "archive")
      ).rejects.toThrow("simulated folder ancillary failure")
      setDocumentLifecycleStepHookForTests(null)
      await Promise.resolve()
      await drainWorkspaceChanges()

      expect(recoverInterruptedDocumentLifecycles()).toEqual([])
      expect((await readDoc("space", folderDocuments[0])).data).toBe(
        "# First\n"
      )
      expect((await readDoc("space", folderDocuments[1])).data).toBe(
        "# External folder edit\n"
      )
      expect(await getDocProvenance("space", folderDocuments[1])).toMatchObject(
        {
          source: "filesystem",
          updatedBy: "external",
        }
      )
      expect(await docExists("space", "archive/first")).toBe(false)
      expect(await docExists("space", "archive/nested/second")).toBe(false)
      expect(await resolveDocumentShare(folderSourceShare.token)).toBeNull()
      expect(await resolveDocumentShare(folderTargetShare.token)).toBeNull()
    } finally {
      setDocumentLifecycleStepHookForTests(null)
    }
  })

  it("reconciles a late external Rich Doc edit after a successful exact rename", async () => {
    const workspace = join(root, "successful-exact-external-edit", "workspace")
    const app = join(root, "successful-exact-external-edit", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "old", [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Original", styles: {} }],
      },
    ])
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.rich-text", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.json" },
        },
      ],
    })
    await yjsManager.getOrCreateDoc("space", "old")
    const stopWorkspace = onWorkspaceChange(async (event) => {
      if (event.type === "doc") {
        await syncExternalDocChange(event.spaceId, event.docPath)
      }
    })
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "committed") return
      const target = join(workspace, "spaces", "space", "docs", "new.json")
      writeFileSync(
        target,
        JSON.stringify([
          {
            type: "paragraph",
            content: [{ type: "text", text: "External wins", styles: {} }],
          },
        ])
      )
      expect(notePathEventIfSuppressed(target)).toBe(true)
    })

    try {
      expect((await renameDocAndSync("space", "old", "new")).error).toBeNull()
      await withDocPathLock("space", async () => {})
      await drainWorkspaceChanges()
      await yjsManager.flushPersist("space", "new")

      expect(JSON.stringify((await readDoc("space", "new")).data)).toContain(
        "External wins"
      )
      expect(await getDocProvenance("space", "new")).toMatchObject({
        source: "filesystem",
        updatedBy: "external",
      })
    } finally {
      setDocumentLifecycleStepHookForTests(null)
      stopWorkspace()
      await yjsManager.shutdown()
    }
  })

  it("reconciles a late external Rich Doc edit on the second member of a successful folder move", async () => {
    const workspace = join(root, "successful-external-edit", "workspace")
    const app = join(root, "successful-external-edit", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    const documents = ["folder/parent", "folder/nested/child"] as const
    for (const path of documents) {
      await writeDoc("space", path, [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Original", styles: {} }],
        },
      ])
    }
    await updateDocumentInventory("space", {
      upsert: documents.map((path) => ({
        documentId: mintDocumentId(),
        path,
        format: { id: "worktable.rich-text" as const, sourceVersion: 1 },
        source: { kind: "file" as const, relativePath: `docs/${path}.json` },
      })),
    })
    for (const path of documents) {
      await yjsManager.getOrCreateDoc("space", path)
    }
    const stopWorkspace = onWorkspaceChange(async (event) => {
      if (event.type === "doc") {
        await syncExternalDocChange(event.spaceId, event.docPath)
      }
    })
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "committed") return
      const target = join(
        workspace,
        "spaces",
        "space",
        "docs",
        "archive",
        "nested",
        "child.json"
      )
      writeFileSync(
        target,
        JSON.stringify([
          {
            type: "paragraph",
            content: [{ type: "text", text: "External wins", styles: {} }],
          },
        ])
      )
      expect(notePathEventIfSuppressed(target)).toBe(true)
    })

    try {
      expect(
        (await renameDocsByPrefixAndSync("space", "folder", "archive")).error
      ).toBeNull()
      await withDocPathLock("space", async () => {})
      await drainWorkspaceChanges()
      await yjsManager.flushPersist("space", "archive/nested/child")

      expect(await docExists("space", "folder/parent")).toBe(false)
      expect(await docExists("space", "archive/parent")).toBe(true)
      expect(
        JSON.stringify((await readDoc("space", "archive/nested/child")).data)
      ).toContain("External wins")
      expect(
        await getDocProvenance("space", "archive/nested/child")
      ).toMatchObject({
        source: "filesystem",
        updatedBy: "external",
      })
    } finally {
      setDocumentLifecycleStepHookForTests(null)
      stopWorkspace()
      await yjsManager.shutdown()
    }
  })

  it("prevents a stale source capability from being minted during commit", async () => {
    const workspace = join(root, "share-mint-race", "workspace")
    const app = join(root, "share-mint-race", "app")
    mkdirSync(workspace, { recursive: true })
    setWorkspaceRootOverride(workspace)
    setAppDirOverride(app)
    process.env["WORKTABLE_HOSTED"] = "1"
    ensureWorkspaceManifest()
    await writeSpace(makeSpace("space"))
    await writeDoc("space", "old", "# Stable\n")
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })

    let shareRevoked!: () => void
    let finishRename!: () => void
    const revoked = new Promise<void>((resolve) => {
      shareRevoked = resolve
    })
    const renameGate = new Promise<void>((resolve) => {
      finishRename = resolve
    })
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "share-revoked") return
      shareRevoked()
      return renameGate
    })

    const renaming = renameDocAndSync("space", "old", "new")
    let minting: ReturnType<typeof createDocumentShareIfEligible> | null = null
    try {
      await revoked
      minting = createDocumentShareIfEligible(
        { kind: "doc", spaceId: "space", artifactKey: "old" },
        () => docExists("space", "old")
      )

      finishRename()
      expect((await renaming).error).toBeNull()
      expect(await minting).toBeNull()
      expect(await docExists("space", "old")).toBe(false)
      expect(await docExists("space", "new")).toBe(true)
    } finally {
      finishRename()
      setDocumentLifecycleStepHookForTests(null)
      await Promise.allSettled([renaming, ...(minting ? [minting] : [])])
    }
  })
})

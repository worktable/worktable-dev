import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fc from "fast-check"
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  listDocs,
  readDoc,
  writeDoc,
  deleteDoc,
  docExists,
  docStat,
  getDocProvenance,
  getDocVersion,
  renameDoc,
  listDocsDetailed,
  getDocArchiveInfo,
  setDocArchived,
  writeSpace,
  getDocPath,
  isPathSuppressed,
  notePathEventIfSuppressed,
  suppressPath,
  unsuppressPath,
  convertDocToMarkdownStorage,
  whenNextDocDeleteObservationForTests,
} from "./store.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import {
  whenVersionKeyLockDepthForTests,
  withVersionKeyLock,
} from "./version-store.ts"
import type { SpaceFile } from "@worktable/types"
import { yjsManager } from "./yjs-manager.ts"

const testDir = join(tmpdir(), `worktable-docs-test-${Date.now()}`)
const appDir = join(tmpdir(), `worktable-docs-app-${Date.now()}`)
const spacesDir = join(testDir, "spaces")

// A valid BlockNote paragraph. writeDoc canonicalizes blocks on write (stable
// ids, default props), so tests assert on semantic text rather than exact bytes.
const para = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
})
function textOf(data: unknown): string {
  if (!Array.isArray(data)) return ""
  return data
    .map((block: any) =>
      Array.isArray(block?.content)
        ? block.content.map((inline: any) => inline?.text ?? "").join("")
        : ""
    )
    .join("\n")
}

function makeSpace(id: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: `Test Space ${id}`,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

describe("doc store", () => {
  beforeEach(async () => {
    setWorkspaceRootOverride(testDir)
    setAppDirOverride(appDir)
    ensureWorkspaceManifest()
    mkdirSync(spacesDir, { recursive: true })
    await writeSpace(makeSpace("test-space"))
  })

  afterEach(() => {
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  // ── CRUD ───────────────────────────────────────────────

  describe("CRUD", () => {
    it("writes and reads a doc", async () => {
      const content = [{ type: "paragraph", content: [{ text: "hello" }] }]
      await writeDoc("test-space", "my-doc", content)

      const { data, error } = await readDoc("test-space", "my-doc")
      expect(error).toBeNull()
      expect(data).toEqual(content)
    })

    it("returns error for missing doc", async () => {
      const { data, error } = await readDoc("test-space", "nonexistent")
      expect(data).toBeNull()
      expect(error).toContain("not found")
    })

    it("overwrites existing doc", async () => {
      await writeDoc("test-space", "my-doc", [para("v1")])
      await writeDoc("test-space", "my-doc", [para("v2")])

      const { data } = await readDoc("test-space", "my-doc")
      expect(textOf(data)).toBe("v2")
    })

    it("preserves both sources when a Doc path is ambiguous", async () => {
      await writeDoc("test-space", "ambiguous", [para("Rich source")])
      const docs = join(spacesDir, "test-space", "docs")
      const richPath = join(docs, "ambiguous.json")
      const markdownPath = join(docs, "ambiguous.md")
      const richBefore = readFileSync(richPath, "utf8")
      writeFileSync(markdownPath, "# External source\n")

      const result = await writeDoc("test-space", "ambiguous", [
        para("Replacement"),
      ])

      expect(result.ok).toBe(false)
      expect(readFileSync(richPath, "utf8")).toBe(richBefore)
      expect(readFileSync(markdownPath, "utf8")).toBe(
        "# External source\n"
      )
    })

    it("re-writing identical id-less content is a version no-op with stable block ids", async () => {
      // Agents commonly write blocks without ids. Canonicalization inherits
      // ids positionally from the existing doc, so an idempotent re-write
      // keeps the same ids (annotation anchors survive) and the same content
      // hash (no phantom version).
      await writeDoc("test-space", "idem-doc", [para("same"), para("content")])
      const first = await getDocProvenance("test-space", "idem-doc")
      const { data: firstData } = await readDoc("test-space", "idem-doc")

      await writeDoc("test-space", "idem-doc", [para("same"), para("content")])
      const second = await getDocProvenance("test-space", "idem-doc")
      const { data: secondData } = await readDoc("test-space", "idem-doc")

      expect(second?.versionId).toBe(first!.versionId)
      expect((secondData as any[]).map((b) => b.id)).toEqual(
        (firstData as any[]).map((b) => b.id)
      )
    })

    it("a partial id-less rewrite keeps the ids of blocks that stayed in place", async () => {
      await writeDoc("test-space", "partial-doc", [para("keep"), para("old")])
      const { data: before } = await readDoc("test-space", "partial-doc")

      await writeDoc("test-space", "partial-doc", [para("keep"), para("new")])
      const { data: after } = await readDoc("test-space", "partial-doc")

      expect((after as any[])[0].id).toBe((before as any[])[0].id)
      expect(textOf(after)).toBe("keep\nnew")
    })

    it("an idempotent rewrite of a legacy id-less doc records nothing and leaves the file untouched", async () => {
      // Files from before canonical-on-write hold blocks without ids. A
      // rewrite of the same logical content must be a full no-op — comparing
      // raw-before to canonical-after would always differ (fresh ids) and
      // record a phantom version that flips provenance.
      const legacy = [
        {
          type: "paragraph",
          content: [{ type: "text", text: "legacy", styles: {} }],
        },
      ]
      const path = join(spacesDir, "test-space", "docs", "legacy.json")
      mkdirSync(join(spacesDir, "test-space", "docs"), { recursive: true })
      writeFileSync(path, JSON.stringify(legacy))
      const bytesBefore = readFileSync(path, "utf8")

      const result = await writeDoc("test-space", "legacy", legacy, {
        updatedBy: "worktable-agent",
        source: "mcp",
      })
      expect(result.ok).toBe(true)
      expect(await getDocProvenance("test-space", "legacy")).toBeUndefined()
      expect(readFileSync(path, "utf8")).toBe(bytesBefore)
    })

    it("an id-less insert keeps unchanged blocks' ids and never re-donates them", async () => {
      await writeDoc("test-space", "insert-doc", [para("alpha"), para("beta")])
      const { data: before } = await readDoc("test-space", "insert-doc")
      const [alphaId, betaId] = (before as any[]).map((b) => b.id)

      await writeDoc("test-space", "insert-doc", [
        para("new first"),
        para("alpha"),
        para("beta"),
      ])
      const { data: after } = await readDoc("test-space", "insert-doc")

      // The moved-but-unchanged blocks keep their ids (annotations stay put);
      // the inserted block gets a FRESH id, never a shifted existing one.
      expect((after as any[])[1].id).toBe(alphaId)
      expect((after as any[])[2].id).toBe(betaId)
      expect((after as any[])[0].id).not.toBe(alphaId)
      expect((after as any[])[0].id).not.toBe(betaId)
    })

    it("isolates generations when concurrent deletes race an external unlink", async () => {
      const docPath = "folder/legacy.md"
      await writeDoc("test-space", docPath, [para("old generation")])
      const oldVersionId = (await getDocProvenance(
        "test-space",
        docPath
      ))?.versionId
      expect(oldVersionId).toBeTruthy()
      await yjsManager.getOrCreateDoc("test-space", docPath)
      expect(
        (await deleteDoc("test-space", "folder//legacy.md")).error
      ).toContain("not canonical")
      expect(await docExists("test-space", docPath)).toBe(true)

      const sourcePath = getDocPath("test-space", docPath)
      let removedExternally = false
      let retiredDocumentId: string | undefined
      let reportVersionLock!: () => void
      let releaseVersionLock!: () => void
      const versionLockAcquired = new Promise<void>((resolve) => {
        reportVersionLock = resolve
      })
      const holdVersionLock = new Promise<void>((resolve) => {
        releaseVersionLock = resolve
      })
      const versionLock = withVersionKeyLock(
        "test-space",
        "docs",
        docPath,
        async () => {
          reportVersionLock()
          await holdVersionLock
        }
      )
      await versionLockAcquired
      const off = onWorkspaceChange((event) => {
        if (
          removedExternally ||
          event.type !== "documentCorpus" ||
          event.spaceId !== "test-space" ||
          !existsSync(sourcePath)
        ) {
          return
        }
        const inventory = JSON.parse(
          readFileSync(
            join(testDir, "spaces", "test-space", "documents.meta.json"),
            "utf8"
          )
        ) as {
          documents: Record<string, { path?: string }>
        }
        retiredDocumentId = Object.entries(inventory.documents).find(
          ([, entry]) => entry.path === docPath
        )?.[0]
        unlinkSync(sourcePath)
        removedExternally = true
      })
      let results: Array<{ error: string | null }>
      try {
        const firstDelete = deleteDoc("test-space", docPath)
        await whenVersionKeyLockDepthForTests(
          "test-space",
          "docs",
          docPath,
          2
        )
        expect(removedExternally).toBe(true)
        const lateObservation = whenNextDocDeleteObservationForTests(
          "test-space",
          docPath
        )
        const lateDelete = deleteDoc("test-space", docPath)
        await lateObservation
        releaseVersionLock()
        results = await Promise.all([firstDelete, lateDelete])
        await versionLock
      } finally {
        releaseVersionLock()
        await versionLock
        off()
      }

      expect(retiredDocumentId).toBeTruthy()
      expect(results.every((result) => result.error === null)).toBe(true)
      const exists = await docExists("test-space", docPath)
      expect(exists).toBe(false)
      await expect(
        yjsManager.getOrCreateDoc("test-space", docPath)
      ).rejects.toThrow("does not exist")

      await writeDoc("test-space", docPath, [
        para("new generation"),
      ])
      await yjsManager.getOrCreateDoc("test-space", docPath)
      await yjsManager.flushPersist("test-space", docPath)
      expect(
        textOf((await readDoc("test-space", docPath)).data)
      ).toBe("new generation")
      expect(
        await getDocVersion("test-space", docPath, oldVersionId!)
      ).toBeNull()
      let recreatedDocumentId: string | undefined
      const offRecreatedAdmission = onWorkspaceChange((event) => {
        if (
          recreatedDocumentId ||
          event.type !== "documentCorpus" ||
          event.spaceId !== "test-space"
        ) {
          return
        }
        const inventory = JSON.parse(
          readFileSync(
            join(testDir, "spaces", "test-space", "documents.meta.json"),
            "utf8"
          )
        ) as { documents: Record<string, { path?: string }> }
        recreatedDocumentId = Object.entries(inventory.documents).find(
          ([, entry]) => entry.path === docPath
        )?.[0]
      })
      try {
        expect((await deleteDoc("test-space", docPath)).error).toBeNull()
      } finally {
        offRecreatedAdmission()
      }
      expect(recreatedDocumentId).toBeTruthy()
      expect(recreatedDocumentId).not.toBe(retiredDocumentId)
    })

    it("docExists returns true for existing doc", async () => {
      await writeDoc("test-space", "exists-test", [])
      expect(await docExists("test-space", "exists-test")).toBe(true)
    })

    it("docExists returns false for missing doc", async () => {
      expect(await docExists("test-space", "nope")).toBe(false)
    })

    it("docStat returns updatedAt for existing doc", async () => {
      await writeDoc("test-space", "stat-test", [])
      const stat = await docStat("test-space", "stat-test")
      expect(stat).not.toBeNull()
      expect(typeof stat!.updatedAt).toBe("number")
      expect(stat!.updatedAt).toBeGreaterThan(0)
    })

    it("docStat returns null for missing doc", async () => {
      const stat = await docStat("test-space", "missing")
      expect(stat).toBeNull()
    })
  })

  // ── Listing ────────────────────────────────────────────

  describe("listDocs", () => {
    it("returns empty array for space with no docs", async () => {
      const docs = await listDocs("test-space")
      expect(docs).toEqual([])
    })

    it("lists all docs in a space", async () => {
      await writeDoc("test-space", "alpha", [])
      await writeDoc("test-space", "beta", [])
      await writeDoc("test-space", "gamma", [])

      const docs = await listDocs("test-space")
      expect(docs.sort()).toEqual(["alpha", "beta", "gamma"])
    })

    it("lists nested docs with folder paths", async () => {
      await writeDoc("test-space", "top-level", [])
      await writeDoc("test-space", "folder/nested", [])
      await writeDoc("test-space", "folder/deep/nested", [])

      const docs = await listDocs("test-space")
      expect(docs.sort()).toEqual([
        "folder/deep/nested",
        "folder/nested",
        "top-level",
      ])
    })
  })

  // ── Names with spaces and special characters ──────────

  describe("names with spaces", () => {
    it("writes and reads a doc with spaces in the name", async () => {
      await writeDoc("test-space", "My Document Name", [para("spaces work")])

      const { data, error } = await readDoc("test-space", "My Document Name")
      expect(error).toBeNull()
      expect(textOf(data)).toBe("spaces work")
    })

    it("lists docs with spaces correctly", async () => {
      await writeDoc("test-space", "Planning Onsite", [])
      await writeDoc("test-space", "Spring Cleaning", [])

      const docs = await listDocs("test-space")
      expect(docs.sort()).toEqual(["Planning Onsite", "Spring Cleaning"])
    })

    it("renames a doc with spaces", async () => {
      await writeDoc("test-space", "Old Name", [para("content")])
      const { error } = await renameDoc("test-space", "Old Name", "New Name")
      expect(error).toBeNull()

      const { data } = await readDoc("test-space", "New Name")
      expect(textOf(data)).toBe("content")

      const oldExists = await docExists("test-space", "Old Name")
      expect(oldExists).toBe(false)
    })

    it("handles unicode names", async () => {
      await writeDoc("test-space", "日本語ドキュメント", [])
      const { data, error } = await readDoc("test-space", "日本語ドキュメント")
      expect(error).toBeNull()
      expect(data).toEqual([])
    })
  })

  // ── Rename ─────────────────────────────────────────────

  describe("rename", () => {
    it("renames a doc preserving content", async () => {
      await writeDoc("test-space", "original", [para("preserved")])

      const { error } = await renameDoc("test-space", "original", "renamed")
      expect(error).toBeNull()

      const { data } = await readDoc("test-space", "renamed")
      expect(textOf(data)).toBe("preserved")
    })

    it("returns error when source does not exist", async () => {
      const { error } = await renameDoc("test-space", "ghost", "target")
      expect(error).toContain("not found")
    })

    it("returns error when target already exists", async () => {
      await writeDoc("test-space", "source", [])
      await writeDoc("test-space", "target", [])

      const { error } = await renameDoc("test-space", "source", "target")
      expect(error).toContain("already exists")
    })

    it("renames into a subfolder", async () => {
      await writeDoc("test-space", "flat-doc", [para("moved")])
      const { error } = await renameDoc(
        "test-space",
        "flat-doc",
        "folder/moved-doc"
      )
      expect(error).toBeNull()

      const { data } = await readDoc("test-space", "folder/moved-doc")
      expect(textOf(data)).toBe("moved")
    })

    it("preserves archive metadata across rename", async () => {
      await writeDoc("test-space", "original", [{ archived: true }])
      await setDocArchived("test-space", "original", true, "test")

      const { error } = await renameDoc("test-space", "original", "renamed")
      expect(error).toBeNull()

      expect(await getDocArchiveInfo("test-space", "original")).toBeUndefined()
      expect(await getDocArchiveInfo("test-space", "renamed")).toBeTruthy()
    })

  })

  describe("archive", () => {
    it("stores archive metadata and filters active lists", async () => {
      await writeDoc("test-space", "active", [])
      await writeDoc("test-space", "archived", [])
      await setDocArchived("test-space", "archived", true, "test", "stale")

      const archiveInfo = await getDocArchiveInfo("test-space", "archived")
      expect(archiveInfo?.archivedBy).toBe("test")
      expect(archiveInfo?.reason).toBe("stale")

      const activeDocs = await listDocsDetailed("test-space", {
        includeArchived: false,
      })
      expect(activeDocs.map((doc) => doc.path)).toEqual(["active"])

      const allDocs = await listDocsDetailed("test-space", {
        includeArchived: true,
      })
      const archivedDoc = allDocs.find((doc) => doc.path === "archived")
      expect(archivedDoc?.archived?.archivedBy).toBe("test")
    })

    it("includes doc discovery metadata for rich docs", async () => {
      await writeDoc("test-space", "diagram-doc", [
        {
          id: "h1",
          type: "heading",
          props: { level: 1 },
          content: [{ type: "text", text: "Architecture", styles: {} }],
          children: [],
        },
        {
          id: "m1",
          type: "mermaid",
          props: { data: "flowchart TD\nA-->B" },
          content: [],
          children: [],
        },
      ])

      const docs = await listDocsDetailed("test-space", {
        includeArchived: true,
      })
      const diagramDoc = docs.find((doc) => doc.path === "diagram-doc")

      expect(diagramDoc?.storedAs).toBe("json")
      expect(diagramDoc?.format).toBe("blocknote")
      expect(diagramDoc?.readFormatHint).toBe("markdown")
      expect(diagramDoc?.containsMermaid).toBe(true)
      expect(diagramDoc?.richBlockTypes).toEqual(["mermaid"])
      expect(diagramDoc?.headings).toEqual(["Architecture"])
      expect(diagramDoc?.blockCount).toBe(2)
    })
  })

  // ── Concurrent writes ──────────────────────────────────

  describe("concurrent doc writes", () => {
    it("handles concurrent writes without corruption", async () => {
      const writes = Array.from({ length: 10 }, (_, i) =>
        writeDoc("test-space", "concurrent-doc", [{ version: i }])
      )
      await Promise.all(writes)

      const { data, error } = await readDoc("test-space", "concurrent-doc")
      expect(error).toBeNull()
      expect(data).toBeTruthy()
      expect(Array.isArray(data)).toBe(true)
    })

    it("holds queued writes until a format transition finishes", async () => {
      await writeDoc("test-space", "format-lock", [para("before")])
      let reportTransition!: () => void
      let releaseTransition!: () => void
      const transitionEntered = new Promise<void>((resolve) => {
        reportTransition = resolve
      })
      const transitionHeld = new Promise<void>((resolve) => {
        releaseTransition = resolve
      })

      const conversion = convertDocToMarkdownStorage(
        "test-space",
        "format-lock",
        {
          onConverted: async () => {
            reportTransition()
            await transitionHeld
          },
        }
      )
      await transitionEntered

      const queuedWrite = writeDoc("test-space", "format-lock", [
        para("after"),
      ])
      await Promise.resolve()
      expect((await readDoc("test-space", "format-lock")).storedAs).toBe("md")

      releaseTransition()
      await Promise.all([conversion, queuedWrite])
      const finalDoc = await readDoc("test-space", "format-lock")
      expect(finalDoc.storedAs).toBe("json")
      expect(textOf(finalDoc.data)).toContain("after")
    })

    it("returns a conflict when a Markdown format change is already active", async () => {
      await writeDoc("test-space", "markdown-conflict", "# Stable\n")
      const { yjsManager } = await import("./yjs-manager.ts")
      let reportTransition!: () => void
      let releaseTransition!: () => void
      const transitionEntered = new Promise<void>((resolve) => {
        reportTransition = resolve
      })
      const transitionHeld = new Promise<void>((resolve) => {
        releaseTransition = resolve
      })
      const activeTransition = yjsManager.withDocFormatTransition(
        "test-space",
        "markdown-conflict",
        async () => {
          reportTransition()
          await transitionHeld
        }
      )
      await transitionEntered

      const result = await (async () => {
        try {
          return await writeDoc("test-space", "markdown-conflict", [
            para("replacement"),
          ])
        } finally {
          releaseTransition()
          await activeTransition
        }
      })()

      expect(result).toMatchObject({ ok: false, storedAs: "md" })
      expect(await readDoc("test-space", "markdown-conflict")).toMatchObject({
        data: "# Stable\n",
        storedAs: "md",
      })
    })

    it("reports a committed conversion when derived cleanup fails", async () => {
      await writeDoc("test-space", "cleanup-failure", [para("preserved")])
      const result = await convertDocToMarkdownStorage(
        "test-space",
        "cleanup-failure",
        {
          onConverted: async () => {
            throw new Error("cleanup failed")
          },
        }
      )

      expect(result.ok).toBe(true)
      const stored = await readDoc("test-space", "cleanup-failure")
      expect(stored.storedAs).toBe("md")
      expect(stored.data).toContain("preserved")
    })

    it("does not suppress external events while a write waits for the namespace lock", async () => {
      let releaseLock!: () => void
      let reportAcquired!: () => void
      const acquired = new Promise<void>((resolve) => {
        reportAcquired = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      const lockHolder = withDocPathLock("test-space", async () => {
        reportAcquired()
        await blocked
      })
      await acquired

      const queuedWrite = writeDoc("test-space", "queued-doc", "# Queued\n")
      const docBase = resolve(spacesDir, "test-space", "docs", "queued-doc")
      expect(isPathSuppressed(`${docBase}.md`)).toBe(false)
      expect(isPathSuppressed(`${docBase}.json`)).toBe(false)

      releaseLock()
      await Promise.all([lockHolder, queuedWrite])
      expect(isPathSuppressed(`${docBase}.md`)).toBe(false)
      expect(isPathSuppressed(`${docBase}.json`)).toBe(false)
    })

    it("replays a suppressed external edit but drops the internal watcher echo", async () => {
      const docBase = resolve(spacesDir, "test-space", "docs", "replay-doc")
      const mdPath = `${docBase}.md`
      const jsonPath = `${docBase}.json`
      const events: unknown[] = []
      const off = onWorkspaceChange((event) => events.push(event))
      try {
        suppressPath(mdPath)
        await writeDoc("test-space", "replay-doc", "# Internal\n", {
          updatedBy: "agent",
          source: "test",
        })
        expect(notePathEventIfSuppressed(mdPath)).toBe(true)
        unsuppressPath(mdPath)
        await withDocPathLock("test-space", async () => {})
        expect(events).toEqual([])

        let releaseVersionLock!: () => void
        let reportVersionLock!: () => void
        const versionLockAcquired = new Promise<void>((resolve) => {
          reportVersionLock = resolve
        })
        const holdVersionLock = new Promise<void>((resolve) => {
          releaseVersionLock = resolve
        })
        const versionLock = withVersionKeyLock(
          "test-space",
          "docs",
          "replay-doc",
          async () => {
            reportVersionLock()
            await holdVersionLock
          }
        )
        await versionLockAcquired
        const internalWrite = writeDoc(
          "test-space",
          "replay-doc",
          "# Internal two\n",
          {
            updatedBy: "agent",
            source: "test",
          }
        )
        await whenVersionKeyLockDepthForTests(
          "test-space",
          "docs",
          "replay-doc",
          2
        )
        expect(readFileSync(mdPath, "utf8")).toBe("# Internal two\n")
        writeFileSync(mdPath, "# External wins\n")
        expect(notePathEventIfSuppressed(mdPath)).toBe(true)
        expect(notePathEventIfSuppressed(jsonPath)).toBe(true)
        releaseVersionLock()
        await Promise.all([versionLock, internalWrite])
        await withDocPathLock("test-space", async () => {})
        expect(events).toEqual([
          { type: "doc", spaceId: "test-space", docPath: "replay-doc" },
        ])
      } finally {
        if (isPathSuppressed(mdPath)) unsuppressPath(mdPath)
        if (isPathSuppressed(jsonPath)) unsuppressPath(jsonPath)
        off()
      }
    })

    it("waits for a queued internal write before replaying a suppressed echo", async () => {
      const docPath = "queued-replay-doc"
      const docBase = resolve(spacesDir, "test-space", "docs", docPath)
      const mdPath = `${docBase}.md`
      const events: unknown[] = []
      const off = onWorkspaceChange((event) => events.push(event))
      let releaseVersionLock!: () => void
      let reportVersionLock!: () => void
      const versionLockAcquired = new Promise<void>((resolve) => {
        reportVersionLock = resolve
      })
      const holdVersionLock = new Promise<void>((resolve) => {
        releaseVersionLock = resolve
      })
      try {
        const versionLock = withVersionKeyLock(
          "test-space",
          "docs",
          docPath,
          async () => {
            reportVersionLock()
            await holdVersionLock
          }
        )
        await versionLockAcquired
        const firstWrite = writeDoc("test-space", docPath, "# First\n", {
          updatedBy: "agent",
          source: "test",
        })
        await whenVersionKeyLockDepthForTests("test-space", "docs", docPath, 2)
        expect(readFileSync(mdPath, "utf8")).toBe("# First\n")
        expect(notePathEventIfSuppressed(mdPath)).toBe(true)
        const secondWrite = writeDoc("test-space", docPath, "# Second\n", {
          updatedBy: "agent",
          source: "test",
        })
        releaseVersionLock()
        await Promise.all([versionLock, firstWrite, secondWrite])
        expect(events).toEqual([])
        expect((await readDoc("test-space", docPath)).data).toBe("# Second\n")
        expect((await getDocProvenance("test-space", docPath))?.updatedBy).toBe(
          "agent"
        )
      } finally {
        releaseVersionLock?.()
        if (isPathSuppressed(mdPath)) unsuppressPath(mdPath)
        off()
      }
    })

    it("does not suppress an external revert to an older internal hash", async () => {
      const docPath = "reverted-replay-doc"
      const docBase = resolve(spacesDir, "test-space", "docs", docPath)
      const mdPath = `${docBase}.md`
      const events: unknown[] = []
      const off = onWorkspaceChange((event) => events.push(event))
      let releaseFirstVersionLock!: () => void
      let reportFirstVersionLock!: () => void
      const firstVersionLockAcquired = new Promise<void>((resolve) => {
        reportFirstVersionLock = resolve
      })
      const holdFirstVersionLock = new Promise<void>((resolve) => {
        releaseFirstVersionLock = resolve
      })
      let releaseSecondVersionLock!: () => void
      let reportSecondVersionLock!: () => void
      const secondVersionLockAcquired = new Promise<void>((resolve) => {
        reportSecondVersionLock = resolve
      })
      const holdSecondVersionLock = new Promise<void>((resolve) => {
        releaseSecondVersionLock = resolve
      })
      let firstVersionLock: Promise<void> | undefined
      let firstWrite: Promise<unknown> | undefined
      let secondVersionLock: Promise<void> | undefined
      let secondWrite: Promise<unknown> | undefined
      try {
        firstVersionLock = withVersionKeyLock(
          "test-space",
          "docs",
          docPath,
          async () => {
            reportFirstVersionLock()
            await holdFirstVersionLock
          }
        )
        await firstVersionLockAcquired

        firstWrite = writeDoc("test-space", docPath, "# First\n", {
          updatedBy: "agent",
          source: "test",
        })
        await whenVersionKeyLockDepthForTests("test-space", "docs", docPath, 2)
        expect(readFileSync(mdPath, "utf8")).toBe("# First\n")
        expect(notePathEventIfSuppressed(mdPath)).toBe(true)

        secondWrite = writeDoc("test-space", docPath, "# Second\n", {
          updatedBy: "agent",
          source: "test",
        })
        secondVersionLock = withVersionKeyLock(
          "test-space",
          "docs",
          docPath,
          async () => {
            reportSecondVersionLock()
            await holdSecondVersionLock
          }
        )
        releaseFirstVersionLock()
        await secondVersionLockAcquired

        await whenVersionKeyLockDepthForTests("test-space", "docs", docPath, 2)
        expect(readFileSync(mdPath, "utf8")).toBe("# Second\n")
        writeFileSync(mdPath, "# First\n")
        expect(notePathEventIfSuppressed(mdPath)).toBe(true)

        releaseSecondVersionLock()
        await Promise.all([
          firstVersionLock,
          firstWrite,
          secondVersionLock,
          secondWrite,
        ])
        await withDocPathLock("test-space", async () => {})
        expect(events).toEqual([
          { type: "doc", spaceId: "test-space", docPath },
        ])
        expect(readFileSync(mdPath, "utf8")).toBe("# First\n")
      } finally {
        releaseFirstVersionLock?.()
        releaseSecondVersionLock?.()
        await Promise.allSettled(
          [firstVersionLock, firstWrite, secondVersionLock, secondWrite].filter(
            (pending): pending is Promise<unknown> => pending !== undefined
          )
        )
        if (isPathSuppressed(mdPath)) unsuppressPath(mdPath)
        off()
      }
    })
  })
})

// ── Path Security ────────────────────────────────────────

describe("path security", () => {
  beforeEach(async () => {
    setWorkspaceRootOverride(testDir)
    setAppDirOverride(appDir)
    ensureWorkspaceManifest()
    mkdirSync(spacesDir, { recursive: true })
    await writeSpace(makeSpace("test-space"))
  })

  afterEach(() => {
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true, force: true })
    }
  })

  it("path traversal via .. is neutralized", async () => {
    const resolved = getDocPath("test-space", "../../etc/passwd")
    const docsBase = resolve(spacesDir, "test-space", "docs")
    expect(resolved.startsWith(docsBase)).toBe(true)
  })

  it("path traversal via encoded .. is neutralized", async () => {
    // After URL decoding, ../.. should still be safe
    const resolved = getDocPath("test-space", "../../../etc/passwd")
    const docsBase = resolve(spacesDir, "test-space", "docs")
    expect(resolved.startsWith(docsBase)).toBe(true)
  })

  it("leading slashes are stripped", async () => {
    const resolved = getDocPath("test-space", "/etc/passwd")
    const docsBase = resolve(spacesDir, "test-space", "docs")
    expect(resolved.startsWith(docsBase)).toBe(true)
  })

  it("double-dot sequences in filenames are handled", async () => {
    // ....// after stripping .. should not escape
    const resolved = getDocPath("test-space", "....//etc/passwd")
    const docsBase = resolve(spacesDir, "test-space", "docs")
    expect(resolved.startsWith(docsBase)).toBe(true)
  })

  // ── Property-based: doc path always resolves within docs dir ──

  it("PBT: any doc path resolves within the docs directory", () => {
    const docsBase = resolve(spacesDir, "test-space", "docs")

    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (input) => {
        // Skip null bytes — Bun throws on these in file paths (separate concern)
        if (input.includes("\0")) return true

        const resolved = resolve(getDocPath("test-space", input))
        return resolved.startsWith(docsBase)
      }),
      { numRuns: 500 }
    )
  })

  it("PBT: path traversal sequences never escape the docs directory", () => {
    const docsBase = resolve(spacesDir, "test-space", "docs")

    // Generate strings that are likely to contain traversal attempts
    const traversalArb = fc.oneof(
      fc.constant(".."),
      fc.constant("../.."),
      fc.constant("../../etc/passwd"),
      fc.constant("....//"),
      fc.constant(".../...//"),
      fc.constant("/etc/passwd"),
      fc.constant("//etc/passwd"),
      fc.stringMatching(/^[.\/\\a-zA-Z0-9_ %]{1,100}$/)
    )

    fc.assert(
      fc.property(traversalArb, (input) => {
        if (input.includes("\0")) return true
        const resolved = resolve(getDocPath("test-space", input))
        return resolved.startsWith(docsBase)
      }),
      { numRuns: 1000 }
    )
  })
})

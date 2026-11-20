import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { SpaceFile } from "@worktable/types"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { readDocumentCatalogSnapshot } from "./document-query.ts"
import {
  closeDerivedStore,
  derivedStore,
  onDerivedChange,
  type DerivedChange,
  type DerivedKey,
} from "./derived-store.ts"
import { sweepDerivedOutput } from "./derived-sweep.ts"
import { writeSpace } from "./store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  writeWorkspaceManifest,
} from "./workspace.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"

const spaceId = "derived"
let root: string
let appDir: string

const key = (overrides: Partial<DerivedKey> = {}): DerivedKey => ({
  spaceId,
  documentId: "doc_report",
  version: "sha256:aaa",
  kind: "contents",
  variant: "",
  maker: "pdf",
  makerVersion: 1,
  ...overrides,
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-derived-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-derived-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(appDir)
  closeDerivedStore()
})

afterEach(async () => {
  closeDerivedStore()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
  await rm(appDir, { recursive: true, force: true })
})

describe("the derived store", () => {
  it("keeps a reader's output for one version and reads it back a page of lines at a time", () => {
    const store = derivedStore()
    store.putContents(key(), {
      state: "ready",
      output: {
        parts: [
          { label: "Page 1", text: "Quarterly report\nRevenue grew\n" },
          { label: "Page 2", text: "" },
          { label: "Page 3", text: "Appendix" },
        ],
        facts: { pages: 3 },
        gaps: [{ where: "Page 2", why: "no text layer" }],
      },
    })
    expect(store.getContents(key())).toEqual({
      state: "ready",
      facts: { pages: 3 },
      missing: [{ where: "Page 2", why: "no text layer" }],
      totalLines: 6,
      outline: [
        { label: "Page 1", line: 1 },
        { label: "Page 2", line: 4 },
        { label: "Page 3", line: 5 },
      ],
    })
    expect(store.readContentsLines(key(), 1, 3)).toEqual({
      text: "## Page 1\nQuarterly report\nRevenue grew\n",
      startLine: 1,
      endLine: 3,
      totalLines: 6,
      nextOffset: 4,
    })
    expect(store.readContentsLines(key(), 4)).toMatchObject({
      text: "## Page 2\n## Page 3\nAppendix\n",
      endLine: 6,
    })
    // A page stops at its bytes; a line too long for one is cut there.
    expect(store.readContentsLines(key(), 1, 10, 30)).toMatchObject({ endLine: 2, nextOffset: 3 })
    expect(store.readContentsLines(key(), 2, 10, 5)).toMatchObject({ text: "Quart\n", cutLine: 2 })

    // Another version, or an older reader, never answers.
    expect(store.getContents(key({ version: "sha256:bbb" }))).toBeNull()
    expect(store.getContents(key({ makerVersion: 2 }))).toBeNull()

    // Why a file has no contents is kept too, so it isn't read again.
    store.putContents(key({ documentId: "doc_locked" }), {
      state: "refused",
      reason: "encrypted",
      message: "This file is password protected.",
    })
    expect(store.getContents(key({ documentId: "doc_locked" }))).toMatchObject({
      state: "refused",
      reason: "encrypted",
      totalLines: 0,
    })
  })

  it("keeps pictures by variant, finds which items have one in one call, and drops other versions", () => {
    const store = derivedStore()
    const changes: DerivedChange[] = []
    const stop = onDerivedChange((change) => changes.push(change))
    const picture = key({ kind: "picture", variant: "w480p1", maker: "pdf-page" })
    const bytes = new Uint8Array([137, 80, 78, 71])
    store.putPicture(picture, { state: "ready", mimeType: "image/png", bytes })
    expect(store.getPicture(picture)).toEqual({
      state: "ready",
      mimeType: "image/png",
      bytes,
      sha256: "0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543",
    })
    expect(store.getPicture({ ...picture, variant: "w240p1" })).toBeNull()
    store.putPicture(key({ kind: "picture", documentId: "doc_bad", maker: "pdf-page" }), {
      state: "failed",
      message: "The reader stopped before it finished this file.",
    })
    expect(store.versionsWith(spaceId, "picture", ["doc_report", "doc_bad", "doc_none"])).toEqual(
      new Map([["doc_report", ["sha256:aaa"]]])
    )

    store.putContents(key({ version: "sha256:new" }), { state: "ready", output: { parts: [], facts: {}, gaps: [] } })
    store.keepOnlyVersion(spaceId, "doc_report", "sha256:new")
    expect(store.getPicture(picture)).toBeNull()
    expect(store.listing(spaceId).map((row) => [row.documentId, row.version, row.kind])).toEqual([
      ["doc_bad", "sha256:aaa", "picture"],
      ["doc_report", "sha256:new", "contents"],
    ])
    stop()
    expect(changes.map((change) => change.change)).toEqual(["stored", "stored", "stored", "removed"])
  })

  it("removes what was derived from a file once the file is gone, deleted on disk included", async () => {
    writeWorkspaceManifest({ ...ensureWorkspaceManifest(), version: 2 })
    const previous = process.env["WORKTABLE_FILES"]
    process.env["WORKTABLE_FILES"] = "1"
    try {
      await writeSpace({
        type: "worktable.space",
        version: 1,
        id: spaceId,
        name: "Derived",
        createdAt: "2026-11-20T00:00:00.000Z",
        updatedAt: "2026-11-20T00:00:00.000Z",
        createdBy: "test",
        settings: {},
      } satisfies SpaceFile)
      const docs = join(root, "spaces", spaceId, "docs")
      await mkdir(docs, { recursive: true })
      await writeFile(join(docs, "report.pdf"), "%PDF-1.7 not really")
      noteSpaceChanged(spaceId)
      const entry = (await readDocumentCatalogSnapshot(spaceId)).entries.find(
        (candidate) => candidate.kind === "document" && candidate.descriptor.path === "report.pdf"
      )
      if (entry?.kind !== "document") throw new Error("report.pdf isn't listed")
      const documentId = entry.handle.documentId
      const store = derivedStore()
      store.putContents(key({ documentId }), { state: "ready", output: { parts: [], facts: {}, gaps: [] } })
      store.putContents(key({ documentId: "doc_deleted_earlier" }), {
        state: "ready",
        output: { parts: [], facts: {}, gaps: [] },
      })

      expect(await sweepDerivedOutput(spaceId)).toBe(1)
      expect(store.listing(spaceId).map((row) => row.documentId)).toEqual([documentId])

      await rm(join(docs, "report.pdf"))
      noteSpaceChanged(spaceId)
      expect(await sweepDerivedOutput(spaceId)).toBe(1)
      expect(store.listing(spaceId)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_FILES"]
      else process.env["WORKTABLE_FILES"] = previous
    }
  })
})

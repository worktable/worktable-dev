import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { closeDerivedStore, derivedStore } from "./derived-store.ts"
import { readParsedContents } from "./parsed-contents.ts"
import { setStorageLimitForTests, startStorageLimits } from "./storage-limit.ts"
import { activeStorageAccount, startStorageAccounting, storageUsage } from "./storage-usage.ts"
import { writeSpace } from "./store.ts"
import { smallPdf } from "./test-support/small-pdf.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride, writeWorkspaceManifest } from "./workspace.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"

const spaceId = "parsed"
let workspace: string
let app: string
let stops: Array<() => Promise<void> | void> = []
let previousFiles: string | undefined

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "wt-parsed-ws-"))
  app = mkdtempSync(join(tmpdir(), "wt-parsed-app-"))
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(app)
  closeDerivedStore()
  writeWorkspaceManifest({ ...ensureWorkspaceManifest(), version: 2 })
  previousFiles = process.env["WORKTABLE_FILES"]
  process.env["WORKTABLE_FILES"] = "1"
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Parsed",
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    createdBy: "test",
    settings: {},
  })
  await mkdir(join(workspace, "spaces", spaceId, "docs"), { recursive: true })
  setStorageLimitForTests(null)
  stops = [startStorageLimits(), startStorageAccounting()]
})

afterEach(async () => {
  for (const stop of stops) await stop()
  setStorageLimitForTests(null)
  closeDerivedStore()
  if (previousFiles === undefined) delete process.env["WORKTABLE_FILES"]
  else process.env["WORKTABLE_FILES"] = previousFiles
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  rmSync(workspace, { recursive: true, force: true })
  rmSync(app, { recursive: true, force: true })
})

describe("parsed contents", () => {
  it("keeps a parse's output only with room for it, and reads it once there is room", async () => {
    await writeFile(
      join(workspace, "spaces", spaceId, "docs", "report.pdf"),
      smallPdf([{ text: "A report with some words in it" }])
    )
    noteSpaceChanged(spaceId)
    await activeStorageAccount()!.settled()
    // The total limit leaves room for less than the PDF's contents.
    const total = storageUsage()!.total.bytes
    setStorageLimitForTests(1024 ** 3, { totalBytes: total + 100 })
    const full = await readParsedContents({ spaceId, path: "report.pdf", reader: "pdf" })
    expect(full!.contents).toMatchObject({ state: "failed", missing: [{ why: expect.stringContaining("too full") }] })
    expect(derivedStore().listing(spaceId)).toEqual([])

    setStorageLimitForTests(1024 ** 3, { totalBytes: total + 1024 ** 2 })
    const roomy = await readParsedContents({ spaceId, path: "report.pdf", reader: "pdf" })
    expect(roomy!.contents.state).toBe("ready")
    expect(roomy!.contents.text).toContain("A report with some words")
  }, 60_000)
})

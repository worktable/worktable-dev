import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import type { DocumentId, SpaceFile } from "@worktable/types"
import { ENV } from "@worktable/hosted-contract"
import { setAppDirOverride } from "./app-storage.ts"
import { runDeletedItemsPass } from "./deleted-items.ts"
import { listDocumentGenerationsV2 } from "./document-version-store-v2.ts"
import {
  createRegisteredDocument,
  deleteRegisteredDocument,
  readRegisteredDocumentSource,
  replaceRegisteredDocument,
} from "./document-write-service.ts"
import { withStagedUpload, writeUploadedFile } from "./file-uploads.ts"
import {
  invalidateServerSettingsCache,
  updateServerSettings,
} from "./settings-store.ts"
import { stagingDirectory } from "./staged-file.ts"
import {
  DEFAULT_STORAGE_LIMIT_BYTES,
  setStorageLimitForTests,
  startStorageLimits,
  STORAGE_LIMIT_CEILING_BYTES,
  StorageLimitError,
  storageLimitBytes,
  storagePruningSettled,
  storageSummary,
} from "./storage-limit.ts"
import { prunedHistoryFor, resetPrunedRecordForTests } from "./storage-pruned.ts"
import {
  activeStorageAccount,
  startStorageAccounting,
  storageUsage,
} from "./storage-usage.ts"
import { writeSpace } from "./store.ts"
import { WorkspaceWatcher } from "./watcher.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const KB = 1024
let workspace: string
let app: string
let stops: (() => Promise<void>)[] = []
let watcher: WorkspaceWatcher | null = null
let listeners = new Map<string, (eventType: string, filename: string) => void>()

function space(id: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

/** About `size` bytes of Markdown, different for each `fill`. */
const bytes = (size: number, fill: string) =>
  new TextEncoder().encode(
    `# ${fill}\n\n${fill.repeat(Math.ceil(size / fill.length)).slice(0, size)}\n`
  )

async function createDoc(path: string, size: number) {
  return createRegisteredDocument({
    spaceId: "notes",
    path,
    format: { id: "worktable.markdown", sourceVersion: 1 },
    bytes: bytes(size, path),
    createdBy: "test",
    source: "test",
  })
}

/** A Doc with `versions` versions of `size` bytes each, oldest first. */
async function docWithVersions(path: string, versions: number, size: number) {
  let written = await createDoc(path, size)
  for (let index = 1; index < versions; index += 1) {
    written = await replaceRegisteredDocument({
      spaceId: "notes",
      path,
      bytes: bytes(size, `${path}${index}`),
      expectedRevision: written.sourceRevision,
      updatedBy: "test",
      source: "test",
      separateVersion: true,
    })
  }
  return written.documentId as DocumentId
}

const generations = async (documentId: DocumentId) =>
  (
    await listDocumentGenerationsV2({
      workspaceRoot: workspace,
      spaceId: "notes",
      documentId,
    })
  ).map((manifest) => manifest.id)

async function settled(): Promise<number> {
  await storagePruningSettled()
  await activeStorageAccount()!.settled()
  return storageUsage()!.total.bytes
}

/** Every file under the workspace folder, relative to it. */
function workspaceFiles(): string[] {
  const found: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else found.push(relative(workspace, path))
    }
  }
  visit(workspace)
  return found.sort()
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "wt-limit-ws-"))
  app = mkdtempSync(join(tmpdir(), "wt-limit-app-"))
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(app)
  invalidateServerSettingsCache()
  await updateServerSettings({
    history: { retention: { mode: "age", maxAgeDays: 30 } },
  })
  ensureWorkspaceManifest()
  await writeSpace(space("notes"))
  resetPrunedRecordForTests()
  setStorageLimitForTests(null, { promptPruneMs: 10_000 })
  stops = [startStorageLimits(), startStorageAccounting()]
})

afterEach(async () => {
  watcher?.stop()
  watcher = null
  for (const stop of stops) await stop()
  setStorageLimitForTests(null)
  resetPrunedRecordForTests()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  invalidateServerSettingsCache()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(app, { recursive: true, force: true })
})

describe("storage limit", () => {
  it("prunes deleted items first, then the oldest versions, so the write succeeds", async () => {
    const older = await docWithVersions("older", 3, 16 * KB)
    const newer = await docWithVersions("newer", 2, 16 * KB)
    await createDoc("gone", 16 * KB)
    await deleteRegisteredDocument({ spaceId: "notes", path: "gone" })
    await runDeletedItemsPass()
    const olderBefore = await generations(older)
    const newerBefore = await generations(newer)
    expect(olderBefore).toHaveLength(3)

    // Room for a little less than the next Doc and its version.
    const roomForLess = async () =>
      setStorageLimitForTests((await settled()) + 6 * KB, { promptPruneMs: 10_000 })
    await roomForLess()

    // The deleted item's trash goes first; every version stays.
    await createDoc("first", 4 * KB)
    let usage = await settled()
    expect(storageUsage()!.parts.trash.bytes).toBe(0)
    expect(await generations(older)).toEqual(olderBefore)
    expect(await generations(newer)).toEqual(newerBefore)
    expect(usage).toBeLessThanOrEqual(storageLimitBytes())

    // Then the oldest version in the whole Worktable, never a current one.
    await roomForLess()
    await createDoc("second", 4 * KB)
    usage = await settled()
    expect(usage).toBeLessThanOrEqual(storageLimitBytes())
    const olderAfter = await generations(older)
    expect(olderAfter).toEqual(olderBefore.slice(0, -1))
    expect(await generations(newer)).toEqual(newerBefore)
    expect(
      (await readRegisteredDocumentSource({ spaceId: "notes", path: "older" }))
        .bytes
    ).toEqual(bytes(16 * KB, "older2"))

    // What went is recorded for the item and for Settings.
    expect(prunedHistoryFor("notes", { documentId: older })?.versions).toBe(1)
    expect(storageSummary()!.pruned).toMatchObject({ versions: 1, deletedItems: 1 })
  })

  it("refuses a write when nothing prunable is left, and leaves nothing behind", async () => {
    await createDoc("kept", 8 * KB)
    setStorageLimitForTests((await settled()) + 4 * KB)
    const before = workspaceFiles()

    const refused = await createDoc("refused", 8 * KB).catch((error) => error)
    expect(refused).toBeInstanceOf(StorageLimitError)
    expect(refused.code).toBe("STORAGE_LIMIT")
    expect(refused.message).toBe(
      `This Worktable is at its ${Math.round(storageLimitBytes() / KB)} KB limit. Delete something to make room.`
    )
    // An upload is staged first; a refused one leaves no file behind either.
    const upload = await withStagedUpload(new Response(new Uint8Array(8 * KB)), (file) =>
      writeUploadedFile({
        spaceId: "notes",
        path: "photo.bin",
        file,
        mode: { kind: "create", keepBoth: false },
        actor: "test",
        source: "test",
      })
    ).catch((error) => error)
    expect(upload).toBeInstanceOf(StorageLimitError)
    expect(workspaceFiles()).toEqual(before)
    expect(existsSync(stagingDirectory()) ? readdirSync(stagingDirectory()) : []).toEqual([])

    // Reads, smaller replacements and deletes still work at the limit.
    const kept = await readRegisteredDocumentSource({ spaceId: "notes", path: "kept" })
    await replaceRegisteredDocument({
      spaceId: "notes",
      path: "kept",
      bytes: bytes(2 * KB, "kept"),
      expectedRevision: kept.sourceRevision,
      updatedBy: "test",
      source: "test",
    })
    await deleteRegisteredDocument({ spaceId: "notes", path: "kept" })
  })

  it("counts a write on disk past the limit and refuses the next Worktable write", async () => {
    listeners = new Map()
    watcher = new WorkspaceWatcher({
      watch: (directory, listener) => {
        listeners.set(directory, listener)
        return { close: () => listeners.delete(directory), on: () => undefined }
      },
      schedule: () => setTimeout(() => undefined, 0),
      cancel: () => undefined,
    })
    watcher.start()
    await createDoc("plan", 2 * KB)
    setStorageLimitForTests((await settled()) + 16 * KB)

    // An agent with a shell writes straight into the Space's folder.
    const folder = join(workspace, "spaces", "notes", "exports")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "dump.bin"), new Uint8Array(32 * KB))
    listeners.get(join(workspace, "spaces"))!("rename", "notes/exports/dump.bin")
    expect(await settled()).toBeGreaterThan(storageLimitBytes())
    expect(existsSync(join(folder, "dump.bin"))).toBe(true)

    expect(await createDoc("next", 1 * KB).catch((error) => error)).toBeInstanceOf(
      StorageLimitError
    )
  })

  it("takes its limit from the environment, within the ceiling outside Cloud", () => {
    const saved = { limit: process.env[ENV.STORAGE_LIMIT_BYTES], hosted: process.env[ENV.HOSTED] }
    const limitWith = (value: string | undefined, hosted: boolean) => {
      if (value === undefined) delete process.env[ENV.STORAGE_LIMIT_BYTES]
      else process.env[ENV.STORAGE_LIMIT_BYTES] = value
      if (hosted) process.env[ENV.HOSTED] = "1"
      else delete process.env[ENV.HOSTED]
      setStorageLimitForTests(null)
      return storageLimitBytes()
    }
    try {
      expect(limitWith(undefined, false)).toBe(DEFAULT_STORAGE_LIMIT_BYTES)
      expect(limitWith(String(512 * 1024 * 1024), false)).toBe(512 * 1024 * 1024)
      expect(limitWith(String(STORAGE_LIMIT_CEILING_BYTES * 4), false)).toBe(
        STORAGE_LIMIT_CEILING_BYTES
      )
      expect(limitWith("lots", false)).toBe(DEFAULT_STORAGE_LIMIT_BYTES)
      // On Cloud the plan's storage applies as given.
      expect(limitWith(String(STORAGE_LIMIT_CEILING_BYTES * 4), true)).toBe(
        STORAGE_LIMIT_CEILING_BYTES * 4
      )
      expect(limitWith(undefined, true)).toBe(DEFAULT_STORAGE_LIMIT_BYTES)
    } finally {
      for (const [name, value] of [
        [ENV.STORAGE_LIMIT_BYTES, saved.limit],
        [ENV.HOSTED, saved.hosted],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      setStorageLimitForTests(null)
    }
  })
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { lstat, readdir, statfs } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { Hono } from "hono"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { runDeletedItemsPass } from "./deleted-items.ts"
import {
  createRegisteredDocument,
  deleteRegisteredDocument,
} from "./document-write-service.ts"
import { systemRouter } from "./routes/system.ts"
import {
  invalidateServerSettingsCache,
  updateServerSettings,
} from "./settings-store.ts"
import { StagingFile } from "./staged-file.ts"
import {
  activeStorageAccount,
  startStorageAccounting,
  storageUsage,
  type StorageFileSystem,
  type StoragePartName,
} from "./storage-usage.ts"
import { writeSpace } from "./store.ts"
import { WorkspaceWatcher } from "./watcher.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  workspaceCacheKey,
} from "./workspace.ts"

const DAY = 24 * 60 * 60 * 1000
let workspace: string
let app: string
let watcher: WorkspaceWatcher | null = null
/** The watcher's listeners, by the directory each watches. */
let listeners = new Map<string, (eventType: string, filename: string) => void>()
let stopAccounting: (() => Promise<void>) | null = null

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

/** Every regular file under `root`, by its path. */
function filesUnder(root: string): Map<string, number> {
  const files = new Map<string, number>()
  const visit = (directory: string) => {
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isDirectory()) visit(path)
      else if (info.isFile()) files.set(path, info.size)
    }
  }
  visit(root)
  return files
}

/** What is on disk now, walked from scratch, in the count's parts. */
function onDisk() {
  const parts: Record<StoragePartName, { bytes: number; files: number }> = {
    live: { bytes: 0, files: 0 },
    history: { bytes: 0, files: 0 },
    trash: { bytes: 0, files: 0 },
    transfers: { bytes: 0, files: 0 },
    derived: { bytes: 0, files: 0 },
  }
  const add = (part: StoragePartName, size: number) => {
    parts[part].bytes += size
    parts[part].files += 1
  }
  for (const [path, size] of filesUnder(workspace)) {
    const [top, second, third] = relative(workspace, path).split(sep)
    const deleted =
      (top === "spaces" && second === ".trash") ||
      (top === "versions" && (second === ".trash" || third === ".retired"))
    add(deleted ? "trash" : top === "versions" ? "history" : "live", size)
  }
  const key = workspaceCacheKey()
  for (const size of filesUnder(join(app, "trash", key)).values()) add("trash", size)
  for (const size of filesUnder(join(app, "staged-files")).values()) {
    add("transfers", size)
  }
  return parts
}

async function counted() {
  await activeStorageAccount()!.settled()
  return storageUsage()!.parts
}

/** Once the notes are applied, the count is what is on disk. */
async function matchesDisk(): Promise<void> {
  expect(await counted()).toEqual(onDisk())
}

/** Watch through the real watcher, with the test standing in for the OS. */
function startWatcher(): void {
  listeners = new Map()
  watcher = new WorkspaceWatcher({
    watch: (directory, listener) => {
      listeners.set(directory, listener)
      return { close: () => listeners.delete(directory), on: () => undefined }
    },
    // Debounced follow-up work is not what is counted here.
    schedule: () => setTimeout(() => undefined, 0),
    cancel: () => undefined,
  })
  watcher.start()
}

/** What the OS reports after `path`, under `spaces/`, changed on disk. */
function changedOnDisk(path: string): void {
  const spaces = join(workspace, "spaces")
  listeners.get(spaces)!("rename", relative(spaces, path))
}

async function createDoc(path: string, body: string, spaceId = "notes") {
  return createRegisteredDocument({
    spaceId,
    path,
    format: { id: "worktable.markdown", sourceVersion: 1 },
    bytes: new TextEncoder().encode(body),
    createdBy: "test",
    source: "test",
  })
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "wt-storage-ws-"))
  app = mkdtempSync(join(tmpdir(), "wt-storage-app-"))
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(app)
  invalidateServerSettingsCache()
  await updateServerSettings({
    history: { retention: { mode: "age", maxAgeDays: 30 } },
  })
  ensureWorkspaceManifest()
  await writeSpace(space("notes"))
})

afterEach(async () => {
  watcher?.stop()
  watcher = null
  await stopAccounting?.()
  stopAccounting = null
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  invalidateServerSettingsCache()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(app, { recursive: true, force: true })
})

describe("storage usage", () => {
  it("matches the disk through writes, a change on disk, a delete and an emptied trash", async () => {
    stopAccounting = startStorageAccounting()
    startWatcher()
    await matchesDisk()

    // Writes through Worktable: Docs and their first versions.
    await createDoc("plan", `# Plan\n\n${"Steps. ".repeat(400)}\n`)
    await createDoc("notes", "# Notes\n")
    await matchesDisk()
    const written = await counted()
    expect(written.live.bytes).toBeGreaterThan(2_800)
    expect(written.history.files).toBeGreaterThan(0)

    // An upload being received counts while it arrives.
    const upload = await StagingFile.create()
    await upload.append(new Uint8Array(4_096))
    await matchesDisk()
    expect((await counted()).transfers).toEqual({ bytes: 4_096, files: 1 })
    await upload.discard()
    await matchesDisk()

    // A file written on disk, outside Worktable.
    const outside = join(workspace, "spaces", "notes", "files")
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, "photo.bin"), new Uint8Array(10_000))
    changedOnDisk(join(outside, "photo.bin"))
    await matchesDisk()
    expect((await counted()).live.bytes - written.live.bytes).toBeGreaterThanOrEqual(10_000)

    // A delete: its history moves to the trash in app data.
    const start = Date.now()
    await deleteRegisteredDocument({ spaceId: "notes", path: "plan" })
    await runDeletedItemsPass({ now: () => start })
    await matchesDisk()
    const deleted = await counted()
    expect(deleted.trash.files).toBeGreaterThan(0)
    expect(deleted.history.bytes).toBeLessThan(written.history.bytes)

    // Past the window, the trash empties.
    await runDeletedItemsPass({ now: () => start + 31 * DAY })
    await matchesDisk()
    expect((await counted()).trash).toEqual({ bytes: 0, files: 0 })
  })

  it("answers requests from memory, and rescans only what a change touched", async () => {
    await writeSpace(space("other"))
    await createDoc("plan", "# Plan\n")
    await createDoc("elsewhere", "# Elsewhere\n", "other")
    let calls = 0
    const read: string[] = []
    const counting: StorageFileSystem = {
      readdir: (path) => (calls++, read.push(path), readdir(path)),
      lstat: (path) => (calls++, read.push(path), lstat(path)),
      statfs: (path) => (calls++, statfs(path)),
    }
    stopAccounting = startStorageAccounting({ fs: counting })
    await activeStorageAccount()!.settled()
    expect(calls).toBeGreaterThan(10)

    const before = calls
    const api = new Hono().route("/api/system", systemRouter)
    for (let request = 0; request < 20; request += 1) {
      const response = await api.fetch(
        new Request("http://localhost/api/system/settings")
      )
      const body = (await response.json()) as { storage: unknown }
      expect(body.storage).toEqual(storageUsage())
    }
    expect(calls).toBe(before)

    // A write rescans the directories it touched, not the tree: nothing
    // in the other Space is read again.
    read.length = 0
    await createDoc("more", "# More\n")
    await activeStorageAccount()!.settled()
    expect(read.some((path) => path.includes(`${sep}notes${sep}`))).toBe(true)
    expect(read.filter((path) => path.includes(`${sep}other`))).toEqual([])
    const usage = storageUsage()!
    expect(usage.total.bytes).toBeGreaterThan(0)
    expect(usage.workspaceEntries).toBeGreaterThan(usage.parts.live.files)
    expect(usage.disk?.freeBytes).toBeGreaterThan(0)
  })
})

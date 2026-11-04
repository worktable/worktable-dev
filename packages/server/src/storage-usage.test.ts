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
import { atomicWriteText } from "./atomic-file.ts"
import { runDeletedItemsPass } from "./deleted-items.ts"
import { deleteDocumentFolder } from "./document-folder-delete.ts"
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
import { storageSummary } from "./storage-limit.ts"
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
  for (const area of ["yjs", "records-index"]) {
    for (const size of filesUnder(join(app, area, key)).values()) add("derived", size)
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

async function createDoc(path: string, body: string) {
  return createRegisteredDocument({
    spaceId: "notes",
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

    // A folder delete: what else the folder held, hidden items included,
    // goes to the trash with it and counts there.
    await createDoc("project/brief", "# Brief\n")
    const project = join(workspace, "spaces", "notes", "docs", "project")
    mkdirSync(join(project, ".git"), { recursive: true })
    writeFileSync(join(project, ".env"), new Uint8Array(5_000))
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n")
    changedOnDisk(join(project, ".env"))
    changedOnDisk(join(project, ".git", "HEAD"))
    await matchesDisk()
    expect(await deleteDocumentFolder("notes", "project")).toMatchObject({
      ok: true,
    })
    await runDeletedItemsPass({ now: () => start })
    await matchesDisk()
    const folderTrash = (await counted()).trash.bytes - deleted.trash.bytes
    expect(folderTrash).toBeGreaterThanOrEqual(5_000)

    // Past the window, the trash empties.
    await runDeletedItemsPass({ now: () => start + 31 * DAY })
    await matchesDisk()
    expect((await counted()).trash).toEqual({ bytes: 0, files: 0 })
  })

  it("answers requests from memory, with this workspace's transfers only", async () => {
    await createDoc("plan", "# Plan\n")
    // Transfer jobs of two workspaces that share this app data.
    const jobs = join(app, "workspace-transfers", "jobs")
    const job = (id: string, workspaceKey: string, bytes: number) => {
      mkdirSync(join(jobs, id), { recursive: true })
      writeFileSync(join(jobs, id, "job.json"), JSON.stringify({ id, workspaceKey }))
      writeFileSync(join(jobs, id, "package.wtb"), new Uint8Array(bytes))
    }
    job("wtx_ours", workspaceCacheKey(), 1_000)
    job("wtx_theirs", "0123456789abcdef", 50_000)
    let calls = 0
    const counting: StorageFileSystem = {
      readdir: (path) => (calls++, readdir(path)),
      lstat: (path) => (calls++, lstat(path)),
      statfs: (path) => (calls++, statfs(path)),
    }
    let firstCounts = 0
    stopAccounting = startStorageAccounting({
      fs: counting,
      onFirstCount: () => firstCounts++,
    })
    await activeStorageAccount()!.settled()
    expect(calls).toBeGreaterThan(10)
    expect(storageUsage()!.parts.transfers).toEqual({
      bytes: 1_000 + JSON.stringify({ id: "wtx_ours", workspaceKey: workspaceCacheKey() }).length,
      files: 2,
    })
    // Open pages hear of the first count once, not of each recount.
    activeStorageAccount()!.recount()
    await activeStorageAccount()!.settled()
    expect(firstCounts).toBe(1)

    const before = calls
    const api = new Hono().route("/api/system", systemRouter)
    for (let request = 0; request < 20; request += 1) {
      const response = await api.fetch(
        new Request("http://localhost/api/system/settings")
      )
      const body = (await response.json()) as { storage: unknown }
      expect(body.storage).toEqual(storageSummary())
    }
    expect(calls).toBe(before)
    const usage = storageUsage()!
    expect(usage.total.bytes).toBeGreaterThan(0)
    expect(usage.workspaceEntries).toBeGreaterThan(usage.parts.live.files)
    expect(usage.disk?.freeBytes).toBeGreaterThan(0)
  })

  it("rescans only the directories a batch touched, each once", async () => {
    await writeSpace(space("other"))
    const elsewhere = join(workspace, "spaces", "other", "docs")
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, "elsewhere.md"), "# Elsewhere\n")
    const records = join(workspace, "spaces", "notes", "records", "tasks")
    mkdirSync(records, { recursive: true })
    const listed: string[] = []
    const statted: string[] = []
    const counting: StorageFileSystem = {
      readdir: (path) => (listed.push(path), readdir(path)),
      lstat: (path) => (statted.push(path), lstat(path)),
      statfs: (path) => statfs(path),
    }
    stopAccounting = startStorageAccounting({ fs: counting })
    await activeStorageAccount()!.settled()

    // A bulk write of records into one collection, through Worktable's
    // atomic publish, which notes each file.
    listed.length = 0
    statted.length = 0
    const batch = 200
    for (let index = 0; index < batch; index += 1) {
      await atomicWriteText(join(records, `task-${index}.yaml`), `id: task-${index}\n`)
    }
    await activeStorageAccount()!.settled()
    // Once, not once per file: 200 notes, one listing, one stat each.
    expect(listed.filter((path) => path === records)).toEqual([records])
    expect(
      statted.filter((path) => path.startsWith(records)).length
    ).toBeLessThanOrEqual(batch + 1)
    await matchesDisk()

    // A Doc written in one Space reads nothing in another.
    listed.length = 0
    statted.length = 0
    await createDoc("more", "# More\n")
    await activeStorageAccount()!.settled()
    expect(listed.some((path) => path.includes(`${sep}notes`))).toBe(true)
    expect(
      [...listed, ...statted].filter((path) => path.includes(`${sep}other`))
    ).toEqual([])
  })
})

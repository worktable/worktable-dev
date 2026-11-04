// ============================================================
// Storage usage: what a Worktable takes on disk
// ============================================================
//
// One figure per Worktable, in five parts, with the number of files:
//
//   live       the workspace folder outside `versions/`: Spaces with their
//              Docs, files, Records and threads, the workspace manifest
//   history    `versions/`: version history
//   trash      deleted items: `spaces/.trash`, `versions/.trash` and
//              `versions/<space>/.retired` on their way out of the workspace
//              folder, then the trash in app data (deleted-items.ts)
//   transfers  uploads being received (staged-file.ts, counted in memory) and
//              workspace captures, imports and restores in app data
//   derived    the record index and the Yjs edit caches in app data
//
// Live, history and the in-workspace trash together are what an export or a
// backup captures; `workspaceEntries` counts the files and folders there, as
// their manifests do. Sizes are file sizes (what a manifest records), not
// allocated blocks; links and special files are not counted, as exports
// refuse them. Free space on the volume the workspace folder is on is
// reported beside it, as headroom, and nothing acts on it yet.
//
// Keeping it current. The count is a tree of directory totals: each known
// directory holds the size and number of its own files and the names of its
// subdirectories. A change to a path rescans its directory alone (one readdir
// and an lstat per entry), walks only directories it has not seen, and drops
// the subtree of one that went away. The paths noted in one batch are first
// grouped by the directory each needs, so a batch that changed many files in
// one directory scans it once. Notes come from:
//   - Worktable's own writes note their paths as they finish: every atomic
//     publish (atomic-file.ts) and every write bracketed for the watcher
//     (store.ts unsuppressPath), and the writers of history, the trash,
//     transfers and the caches, which nothing watches;
//   - the watcher notes every change under `spaces/` and the workspace root,
//     which brings in changes made on disk;
//   - staged uploads are counted from memory as their bytes arrive.
// Notes cost a Set insert on the writer's path. They are applied a moment
// later, in the background, one directory at a time and yielding between
// small batches. A full recount runs shortly after start and then every few
// hours as a correction for anything a note missed, such as a change on disk
// under `versions/`; it builds a fresh tree beside the current one and swaps
// it in, then applies the notes that arrived while it ran.
//
// Requests only read the totals kept in memory: `storageUsage()` does no I/O.

import { lstat, readdir, statfs } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import { getAppDir } from "./app-storage.ts"
import { readBoundedRegularFile } from "./bounded-file.ts"
import { logError } from "./debug-log.ts"
import { stagedFilesInProgress } from "./staged-file.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"

export const STORAGE_PARTS = [
  "live",
  "history",
  "trash",
  "transfers",
  "derived",
] as const
export type StoragePartName = (typeof STORAGE_PARTS)[number]

export interface StoragePart {
  bytes: number
  files: number
}

export interface StorageUsage {
  /** When the last full count finished. Notes have been applied since. */
  countedAt: string
  total: StoragePart
  parts: Record<StoragePartName, StoragePart>
  /** Files and folders in the workspace folder, as export manifests list them. */
  workspaceEntries: number
  /** The volume the workspace folder is on. */
  disk: { freeBytes: number; totalBytes: number } | null
}

/** The file system calls the count makes; tests count them. */
export interface StorageFileSystem {
  readdir(path: string): Promise<string[]>
  lstat(path: string): Promise<{
    size: number
    isFile(): boolean
    isDirectory(): boolean
  }>
  statfs(path: string): Promise<{ bavail: number; blocks: number; bsize: number }>
}

const nodeFileSystem: StorageFileSystem = {
  readdir: (path) => readdir(path),
  lstat: (path) => lstat(path),
  statfs: (path) => statfs(path),
}

/** A folder whose contents are counted to one part, or the workspace folder. */
export interface StorageArea {
  root: string
  part: StoragePartName | "workspace"
  /** Whether a subdirectory belongs to the served workspace; all do by default. */
  owns?: (directory: string, name: string) => Promise<boolean>
}

/**
 * Transfer jobs of every workspace that uses this app data share one
 * folder. A job is this workspace's unless it names another, as
 * workspace-transfer-jobs.ts reads them; one whose state can't be read is
 * counted, since it takes space here until it expires.
 */
function ownsTransferJob(jobs: string, key: string) {
  return async (directory: string, name: string): Promise<boolean> => {
    if (directory !== jobs) return true
    try {
      const job = JSON.parse(
        await readBoundedRegularFile(join(directory, name, "job.json"), 1024 * 1024)
      ) as { workspaceKey?: unknown }
      return !job.workspaceKey || job.workspaceKey === key
    } catch {
      return true
    }
  }
}

/** The folders counted for the served workspace. */
export function storageAreas(
  workspaceRoot = getWorkspaceRoot(),
  appDir = getAppDir(),
  key = workspaceCacheKey()
): StorageArea[] {
  return [
    { root: workspaceRoot, part: "workspace" },
    { root: join(appDir, "trash", key), part: "trash" },
    {
      root: join(appDir, "workspace-transfers"),
      part: "transfers",
      owns: ownsTransferJob(join(appDir, "workspace-transfers", "jobs"), key),
    },
    { root: join(appDir, "yjs", key), part: "derived" },
    { root: join(appDir, "records-index", key), part: "derived" },
  ]
}

/** File system calls between yields to the event loop. */
const BATCH = 128
/** Distinct paths noted before the count gives up on them and recounts. */
const MAX_NOTES = 20_000
const NOTE_DELAY_MS = 1_000
const FIRST_COUNT_DELAY_MS = 5_000
const RECOUNT_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Free space is sampled at most this often, after applied notes. */
const DISK_SAMPLE_MS = 60_000

interface ScanTarget {
  directory: string
  area: StorageArea
  /** Every directory under it too, not only new ones. */
  deep: boolean
}

interface Directory {
  part: StoragePartName
  inWorkspace: boolean
  bytes: number
  files: number
  children: Set<string>
}

function emptyParts(): Record<StoragePartName, StoragePart> {
  return {
    live: { bytes: 0, files: 0 },
    history: { bytes: 0, files: 0 },
    trash: { bytes: 0, files: 0 },
    transfers: { bytes: 0, files: 0 },
    derived: { bytes: 0, files: 0 },
  }
}

function workspacePart(root: string, directory: string): StoragePartName {
  const [top, second, third] = relative(root, directory).split(sep)
  if (top === "versions") {
    return second === ".trash" || third === ".retired" ? "trash" : "history"
  }
  if (top === "spaces" && second === ".trash") return "trash"
  return "live"
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Directory totals for a set of areas; see the header. */
export class StorageTree {
  readonly directories = new Map<string, Directory>()
  readonly parts = emptyParts()
  workspaceEntries = 0
  readonly #areas: readonly StorageArea[]
  readonly #skip: ReadonlySet<string>
  readonly #fs: StorageFileSystem
  readonly #stopped: () => boolean
  #calls = 0

  constructor(
    areas: readonly StorageArea[],
    options: {
      fs?: StorageFileSystem
      /** Never counted as part of another area, such as app data. */
      skip?: readonly string[]
      stopped?: () => boolean
    } = {}
  ) {
    this.#areas = [...areas].sort((a, b) => b.root.length - a.root.length)
    this.#skip = new Set([...areas.map((area) => area.root), ...(options.skip ?? [])])
    this.#fs = options.fs ?? nodeFileSystem
    this.#stopped = options.stopped ?? (() => false)
  }

  /** Count every area from scratch. */
  async countAll(): Promise<void> {
    await this.apply(this.#areas.map((area) => area.root))
  }

  /**
   * Bring the totals in line with the disk at each path and what it holds.
   * Paths are first turned into the directories to rescan, so a batch that
   * changed many files in one directory scans it once.
   */
  async apply(paths: Iterable<string>): Promise<void> {
    const targets = new Map<string, ScanTarget>()
    for (const path of paths) {
      if (this.#stopped()) return
      const target = await this.#target(path)
      if (!target) continue
      const existing = targets.get(target.directory)
      if (!existing || (target.deep && !existing.deep)) {
        targets.set(target.directory, target)
      }
    }
    // An ancestor sorts before what is under it, so a deep rescan is done
    // before the rescans it already covers are skipped.
    const ordered = [...targets.values()].sort((a, b) =>
      a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0
    )
    const deep: string[] = []
    for (const target of ordered) {
      if (this.#stopped()) return
      if (deep.some((root) => inside(root, target.directory))) continue
      await this.#scan(target.directory, target.area, target.deep)
      if (target.deep) deep.push(target.directory)
    }
  }

  /**
   * What to rescan for a change at `path`: a counted directory that is still
   * one, whole; otherwise the nearest counted directory above it, alone, which
   * finds what was added under it and drops what went away.
   */
  async #target(path: string): Promise<ScanTarget | null> {
    const area = this.#areas.find((candidate) => inside(candidate.root, path))
    if (!area) return null
    if (this.directories.has(path)) {
      if (path === area.root || (await this.#lstat(path))?.isDirectory()) {
        return { directory: path, area, deep: true }
      }
    }
    let current = path
    while (current !== area.root) {
      current = dirname(current)
      if (this.directories.has(current)) {
        return { directory: current, area, deep: false }
      }
    }
    // Nothing above it is counted yet, not even the area itself.
    return { directory: area.root, area, deep: true }
  }

  /**
   * Rescan `start`. Deep rescans every directory under it; otherwise only
   * `start` itself, and directories under it not counted before.
   */
  async #scan(start: string, area: StorageArea, deep: boolean): Promise<void> {
    const stack: [string, boolean][] = [[start, deep]]
    while (stack.length > 0) {
      if (this.#stopped()) return
      const [directory, all] = stack.pop()!
      for (const child of await this.#scanDirectory(directory, area, all)) {
        stack.push([child, true])
      }
    }
  }

  async #scanDirectory(
    directory: string,
    area: StorageArea,
    all: boolean
  ): Promise<string[]> {
    let names: string[]
    try {
      names = await this.#fs.readdir(directory)
    } catch {
      // Gone, or unreadable: it holds nothing countable now.
      this.#remove(directory)
      this.#detach(directory)
      return []
    }
    await this.#pace()
    const next: Directory = {
      part: area.part === "workspace" ? workspacePart(area.root, directory) : area.part,
      inWorkspace: area.part === "workspace",
      bytes: 0,
      files: 0,
      children: new Set(),
    }
    for (const name of names) {
      const path = join(directory, name)
      const info = await this.#lstat(path)
      if (!info) continue
      if (info.isDirectory()) {
        if (
          !this.#skip.has(path) &&
          (!area.owns || (await area.owns(directory, name)))
        ) {
          next.children.add(name)
        }
      } else if (info.isFile()) {
        next.bytes += info.size
        next.files += 1
      }
    }
    const previous = this.directories.get(directory)
    this.#replace(directory, previous, next)
    for (const name of previous?.children ?? []) {
      if (!next.children.has(name)) this.#remove(join(directory, name))
    }
    const children: string[] = []
    for (const name of next.children) {
      const child = join(directory, name)
      if (all || !this.directories.has(child)) children.push(child)
    }
    return children
  }

  #replace(path: string, previous: Directory | undefined, next: Directory | null) {
    if (previous) this.#add(previous, -1)
    if (next) {
      this.#add(next, 1)
      this.directories.set(path, next)
    } else this.directories.delete(path)
  }

  #add(directory: Directory, sign: 1 | -1) {
    const part = this.parts[directory.part]
    part.bytes += sign * directory.bytes
    part.files += sign * directory.files
    if (directory.inWorkspace) {
      this.workspaceEntries +=
        sign * (directory.files + directory.children.size)
    }
  }

  /** Forget a directory and everything counted under it. */
  #remove(path: string) {
    const stack = [path]
    while (stack.length > 0) {
      const current = stack.pop()!
      const directory = this.directories.get(current)
      if (!directory) continue
      this.#replace(current, directory, null)
      for (const name of directory.children) stack.push(join(current, name))
    }
  }

  /** A directory that vanished leaves its parent's listing too. */
  #detach(path: string) {
    const parent = this.directories.get(dirname(path))
    if (!parent?.children.has(basename(path))) return
    this.#add(parent, -1)
    parent.children.delete(basename(path))
    this.#add(parent, 1)
  }

  async #lstat(path: string) {
    try {
      return await this.#fs.lstat(path)
    } catch {
      return null
    } finally {
      await this.#pace()
    }
  }

  async #pace() {
    this.#calls += 1
    if (this.#calls % BATCH === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

export interface StorageAccountOptions {
  areas?: readonly StorageArea[]
  /** The folder whose volume's free space is reported. */
  workspaceRoot?: string
  skip?: readonly string[]
  fs?: StorageFileSystem
  noteDelayMs?: number
  firstCountDelayMs?: number
  recountIntervalMs?: number
  now?: () => number
  /** Called once, when the first count is ready, to tell open pages. */
  onFirstCount?: () => void
}

/** The running count for one served workspace. */
export class StorageAccount {
  #tree: StorageTree | null = null
  #countedAt = 0
  #notes = new Set<string>()
  #noteTimer: ReturnType<typeof setTimeout> | null = null
  #firstTimer: ReturnType<typeof setTimeout> | null = null
  #recountTimer: ReturnType<typeof setInterval> | null = null
  #work: Promise<void> = Promise.resolve()
  #recountQueued = false
  #disk: StorageUsage["disk"] = null
  #diskAt = 0
  #stopped = false
  readonly #areas: readonly StorageArea[]
  readonly #workspaceRoot: string
  readonly #skip: readonly string[]
  readonly #fs: StorageFileSystem
  readonly #noteDelayMs: number
  readonly #firstCountDelayMs: number
  readonly #recountIntervalMs: number
  readonly #now: () => number
  #onFirstCount: (() => void) | undefined

  constructor(options: StorageAccountOptions = {}) {
    this.#areas = options.areas ?? storageAreas()
    this.#workspaceRoot = options.workspaceRoot ?? this.#areas[0]!.root
    this.#skip = options.skip ?? []
    this.#fs = options.fs ?? nodeFileSystem
    this.#noteDelayMs = options.noteDelayMs ?? NOTE_DELAY_MS
    this.#firstCountDelayMs = options.firstCountDelayMs ?? FIRST_COUNT_DELAY_MS
    this.#recountIntervalMs = options.recountIntervalMs ?? RECOUNT_INTERVAL_MS
    this.#now = options.now ?? Date.now
    this.#onFirstCount = options.onFirstCount
  }

  start(): void {
    this.#firstTimer = setTimeout(() => {
      this.#firstTimer = null
      this.recount()
    }, this.#firstCountDelayMs)
    this.#firstTimer.unref?.()
    this.#recountTimer = setInterval(() => this.recount(), this.#recountIntervalMs)
    this.#recountTimer.unref?.()
  }

  /** Something at `path` changed: fold it in shortly. No I/O here. */
  note(path: string): void {
    if (this.#stopped) return
    if (this.#notes.size >= MAX_NOTES) {
      this.#notes.clear()
      this.recount()
      return
    }
    this.#notes.add(path)
    if (this.#noteTimer) return
    this.#noteTimer = setTimeout(() => {
      this.#noteTimer = null
      this.#enqueue(() => this.#applyNotes())
    }, this.#noteDelayMs)
    this.#noteTimer.unref?.()
  }

  /** Count everything again in the background; at most one waits. */
  recount(): void {
    if (this.#stopped || this.#recountQueued) return
    this.#recountQueued = true
    this.#enqueue(async () => {
      this.#recountQueued = false
      await this.#recount()
    })
  }

  /** The totals kept in memory, or null before the first count finishes. */
  summary(): StorageUsage | null {
    const tree = this.#tree
    if (!tree) return null
    const staged = stagedFilesInProgress()
    const parts = emptyParts()
    const total: StoragePart = { bytes: 0, files: 0 }
    for (const name of STORAGE_PARTS) {
      parts[name].bytes = tree.parts[name].bytes
      parts[name].files = tree.parts[name].files
    }
    parts.transfers.bytes += staged.bytes
    parts.transfers.files += staged.files
    for (const name of STORAGE_PARTS) {
      total.bytes += parts[name].bytes
      total.files += parts[name].files
    }
    return {
      countedAt: new Date(this.#countedAt).toISOString(),
      total,
      parts,
      workspaceEntries: tree.workspaceEntries,
      disk: this.#disk ? { ...this.#disk } : null,
    }
  }

  /** Resolves once queued notes and counts are applied. For tests. */
  async settled(): Promise<void> {
    if (this.#firstTimer) {
      clearTimeout(this.#firstTimer)
      this.#firstTimer = null
      this.recount()
    }
    for (;;) {
      if (this.#noteTimer) {
        clearTimeout(this.#noteTimer)
        this.#noteTimer = null
        this.#enqueue(() => this.#applyNotes())
      }
      const work = this.#work
      await work
      if (work === this.#work && !this.#noteTimer) return
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#noteTimer) clearTimeout(this.#noteTimer)
    if (this.#firstTimer) clearTimeout(this.#firstTimer)
    if (this.#recountTimer) clearInterval(this.#recountTimer)
    this.#noteTimer = this.#firstTimer = this.#recountTimer = null
    await this.#work
  }

  #enqueue(task: () => Promise<void>): void {
    this.#work = this.#work.then(task).catch((error: unknown) => {
      console.error("[storage-usage] count failed:", logError(error))
    })
  }

  async #recount(): Promise<void> {
    // The fresh count reads everything noted so far; later notes wait for it.
    this.#notes.clear()
    const tree = new StorageTree(this.#areas, {
      fs: this.#fs,
      skip: this.#skip,
      stopped: () => this.#stopped,
    })
    await tree.countAll()
    if (this.#stopped) return
    this.#tree = tree
    this.#countedAt = this.#now()
    await this.#sampleDisk(true)
    const first = this.#onFirstCount
    this.#onFirstCount = undefined
    first?.()
  }

  async #applyNotes(): Promise<void> {
    const tree = this.#tree
    // Before the first count, it will read these paths itself.
    if (!tree || this.#notes.size === 0) return
    const paths = [...this.#notes]
    this.#notes.clear()
    await tree.apply(paths)
    await this.#sampleDisk(false)
  }

  async #sampleDisk(force: boolean): Promise<void> {
    const now = this.#now()
    if (!force && now - this.#diskAt < DISK_SAMPLE_MS) return
    this.#diskAt = now
    try {
      const volume = await this.#fs.statfs(this.#workspaceRoot)
      this.#disk = {
        freeBytes: volume.bavail * volume.bsize,
        totalBytes: volume.blocks * volume.bsize,
      }
    } catch {
      this.#disk = null
    }
  }
}

let active: StorageAccount | null = null

/** A path under the workspace or app data changed; the count catches up. */
export function noteStorageChange(path: string): void {
  active?.note(path)
}

/** What this Worktable takes on disk, from memory; null until counted. */
export function storageUsage(): StorageUsage | null {
  return active?.summary() ?? null
}

/** Start counting the served workspace. Returns its stop. */
export function startStorageAccounting(
  options: StorageAccountOptions = {}
): () => Promise<void> {
  const previous = active
  void previous?.stop()
  const account = new StorageAccount({ skip: [getAppDir()], ...options })
  active = account
  account.start()
  return async () => {
    if (active === account) active = null
    await account.stop()
  }
}

/** The running count, for tests that wait on it. */
export function activeStorageAccount(): StorageAccount | null {
  return active
}

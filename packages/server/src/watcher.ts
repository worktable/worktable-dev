import { watch } from "node:fs"
import type { Dirent } from "node:fs"
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { CanonicalIdSchema, WidgetIdSchema } from "@worktable/types"
import { isAtomicWriteTemporaryFileName } from "./atomic-file.ts"
import {
  getSpacesBaseDir,
  notePathEventIfSuppressed,
  PREPARED_SPACE_MARKER,
} from "./store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import {
  notifyWorkspaceChange,
  onWorkspaceChange,
  type ChangeEvent,
  type ChangeHandler,
  threadEventLocation,
} from "./workspace-events.ts"

export {
  notifyWorkspaceChange,
  onWorkspaceChange,
  type ChangeEvent,
} from "./workspace-events.ts"

interface WorkspaceWatchHandle {
  close(): void
  on(event: "error", listener: (error: Error) => void): unknown
}

export interface WorkspaceWatcherOptions {
  debounceMs?: number
  /** Route watcher-originated document activity through its coordinator. */
  onDocumentChange?: (event: DocumentFilesystemChangeEvent) => void
  /** Observe a queued debounce boundary; used to coordinate real-I/O tests. */
  onPendingChange?: (event: ChangeEvent | null) => void
  watch?: (
    directory: string,
    listener: (eventType: string, filename: string | null) => void,
    recursive?: boolean
  ) => WorkspaceWatchHandle
  schedule?: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}

export type DocumentFilesystemChangeEvent = Extract<
  ChangeEvent,
  { type: "doc" | "widget" | "documentCorpus" }
>

// ============================================================
// Types
// ============================================================

// ============================================================
// Spaces base dir
// ============================================================

function spacesDir(): string {
  return getSpacesBaseDir()
}

function worktableThreadsDir(): string {
  return join(getWorkspaceRoot(), "threads")
}

function directoryIdentity(path: string): string | null {
  try {
    const info = statSync(path)
    return info.isDirectory() ? `${info.dev}:${info.ino}` : null
  } catch {
    return null
  }
}

function directoryFingerprint(path: string): string | null {
  try {
    const info = statSync(path)
    return info.isDirectory()
      ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
      : null
  } catch {
    return null
  }
}

function rootThreadSnapshot(dir: string): Map<string, string> | null {
  const snapshot = new Map<string, string>()
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  try {
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !/^thr_[A-Za-z0-9_-]{12,}\.json$/.test(entry.name)
      ) {
        continue
      }
      const info = statSync(join(dir, entry.name))
      snapshot.set(
        entry.name.slice(0, -".json".length),
        `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
      )
    }
  } catch {
    return null
  }
  return snapshot
}

const ROOT_THREAD_REPLACEMENT_POLL_MS = 100

// ============================================================
// Parse a changed file path into a ChangeEvent
// ============================================================

// Exported for tests: pure path→event parsing, no fs access.
export function parseChangedPath(
  spacesBase: string,
  filename: string | null,
  watchedDir: string
): ChangeEvent | null {
  if (!filename) return null

  // watchedDir is the directory being watched
  // We need to determine what changed
  const fullPath = join(watchedDir, filename)

  // Relative to spacesBase
  const relative = fullPath.slice(spacesBase.length + 1) // e.g. "cms-research/space.json" or "cms-research/views/foo.json"
  const parts = relative.split("/")

  const spaceId = parts[0]

  if (!spaceId || !CanonicalIdSchema.safeParse(spaceId).success) return null

  // The private marker proves this is an unpublished directory owned by the
  // first-run transaction. A user-created space may legitimately slug to the
  // same UUID-shaped name and must remain fully observable without the marker.
  if (existsSync(join(spacesBase, spaceId, PREPARED_SPACE_MARKER))) {
    return null
  }

  // Linux can report only a removed or moved directory's name. Reconcile the
  // identity from the stable parent even though its space.json is no longer
  // available to produce the more specific event below.
  if (parts.length === 1) return { type: "space", spaceId }

  // space.json
  if (parts.length === 2 && parts[1] === "space.json") {
    return { type: "space", spaceId }
  }

  if (parts.length === 2 && parts[1] === "doc-aliases.json") {
    return { type: "docAliases", spaceId }
  }

  if (
    parts.length === 3 &&
    parts[1] === "threads" &&
    parts[2]?.endsWith(".json")
  ) {
    const threadId = parts[2].slice(0, -".json".length)
    if (/^thr_[A-Za-z0-9_-]{12,}$/.test(threadId)) {
      return {
        type: "thread",
        location: { kind: "space", spaceId },
        spaceId,
        threadId,
      }
    }
  }
  // Atomic writers may report only their temporary path on Linux. Any
  // non-canonical activity inside this bounded directory reconciles its
  // current canonical files instead of guessing an editor-specific suffix.
  if (parts[1] === "threads") {
    return {
      type: "threadCollectionReconcile",
      location: { kind: "space", spaceId },
      spaceId,
    }
  }

  // widgets/<widget/path/id>/widget.yaml or .../index.html — widget ids are
  // slash-joined segments, so the id is everything between widgets/ and the file.
  if (parts.length >= 4 && parts[1] === "widgets") {
    const file = parts[parts.length - 1]
    if (file === "widget.yaml" || file === "index.html") {
      const widgetId = parts.slice(2, -1).join("/")
      if (widgetId) return { type: "widget", spaceId, widgetId }
    }
  }
  if (parts.length >= 3 && parts[1] === "widgets") {
    const widgetId = parts.slice(2).join("/")
    if (WidgetIdSchema.safeParse(widgetId).success) {
      return { type: "widget", spaceId, widgetId }
    }
  }
  if (parts[1] === "widgets") {
    const file = parts[parts.length - 1] ?? ""
    const insideCoreBundle = parts
      .slice(2, -1)
      .some((segment) => segment.endsWith(".wtdoc"))
    if (
      !insideCoreBundle &&
      (file === "state.yaml" ||
        file.startsWith("state.yaml.") ||
        file.startsWith(".state.yaml.") ||
        isAtomicWriteTemporaryFileName(file))
    ) {
      return null
    }
    return { type: "documentCorpus", spaceId }
  }

  // records/<collectionId>/schema.yaml or records/<collectionId>/<recordId>.yaml
  //
  // Any other activity below the collection is deliberately normalized to a
  // bounded collection reconcile. On Linux, an atomic
  // `<record>.yaml.tmp -> <record>.yaml` write can emit ONLY the temporary
  // path, so ignoring unknown/temp paths makes canonical files invisible to
  // the projection. External editors use many temporary naming schemes; do
  // not guess one suffix list here.
  if (parts.length >= 3 && parts[1] === "records") {
    const collectionId = parts[2]
    if (!collectionId) return null
    if (parts.length === 4) {
      const file = parts[3]
      if (file === "schema.yaml")
        return { type: "recordCollection", spaceId, collectionId }
      if (file?.endsWith(".yaml")) {
        return {
          type: "record",
          spaceId,
          collectionId,
          recordId: file.replace(/\.yaml$/, ""),
        }
      }
    }
    return { type: "recordCollectionReconcile", spaceId, collectionId }
  }

  // docs/{any/nested/path}.json, .md, or .html
  if (parts.length >= 3 && parts[1] === "docs") {
    const docParts = parts.slice(2)
    const lastPart = docParts[docParts.length - 1]
    if (lastPart?.endsWith(".json")) {
      const docPath = docParts.join("/").replace(/\.json$/, "")
      return { type: "doc", spaceId, docPath }
    }
    if (lastPart?.endsWith(".md")) {
      const docPath = docParts.join("/").replace(/\.md$/, "")
      return { type: "doc", spaceId, docPath }
    }
    if (lastPart?.endsWith(".html")) {
      const widgetId = docParts.join("/").replace(/\.html$/, "")
      return { type: "widget", spaceId, widgetId }
    }
    return { type: "documentCorpus", spaceId }
  }

  if (
    parts.length === 2 &&
    (parts[1] === "docs.meta.json" ||
      parts[1]?.startsWith("docs.meta.json.") ||
      parts[1] === "documents.meta.json" ||
      parts[1]?.startsWith("documents.meta.json.") ||
      isAtomicWriteTemporaryFileName(parts[1] ?? ""))
  ) {
    return { type: "documentCorpus", spaceId }
  }

  return null
}

export function parseWorktableThreadChangedPath(
  threadsBase: string,
  filename: string | null,
  watchedDir: string
): ChangeEvent | null {
  if (!filename) return null
  const fullPath = join(watchedDir, filename)
  const relative = fullPath.slice(threadsBase.length + 1)
  const parts = relative.split("/")
  if (parts.length === 1 && parts[0]?.endsWith(".json")) {
    const threadId = parts[0].slice(0, -".json".length)
    if (/^thr_[A-Za-z0-9_-]{12,}$/.test(threadId)) {
      return {
        type: "thread",
        location: { kind: "worktable" },
        threadId,
      }
    }
  }
  return {
    type: "threadCollectionReconcile",
    location: { kind: "worktable" },
  }
}

// ============================================================
// WorkspaceWatcher class
// ============================================================

export class WorkspaceWatcher {
  private handlerOffs: Set<() => void> = new Set()
  private watchers: Map<string, WorkspaceWatchHandle> = new Map()
  private debounceTimers: Map<
    string,
    { timer: ReturnType<typeof setTimeout>; flush: () => void }
  > = new Map()
  private rootThreadsIdentity: string | null = null
  private rootThreadPoller: ReturnType<typeof setInterval> | null = null
  private rootThreadPollDirectoryFingerprint: string | null = null
  private rootThreadPollSnapshot = new Map<string, string>()
  private stopping = false
  private readonly debounceMs: number
  private readonly watchFileSystem: NonNullable<
    WorkspaceWatcherOptions["watch"]
  >
  private readonly schedule: NonNullable<WorkspaceWatcherOptions["schedule"]>
  private readonly cancel: NonNullable<WorkspaceWatcherOptions["cancel"]>
  private readonly onDocumentChange?: NonNullable<
    WorkspaceWatcherOptions["onDocumentChange"]
  >
  private readonly onPendingChange?: NonNullable<
    WorkspaceWatcherOptions["onPendingChange"]
  >

  constructor(options: number | WorkspaceWatcherOptions = 50) {
    const resolved =
      typeof options === "number" ? { debounceMs: options } : options
    this.debounceMs = resolved.debounceMs ?? 50
    this.watchFileSystem =
      resolved.watch ??
      ((directory, listener, recursive = true) =>
        watch(directory, { recursive }, (eventType, filename) =>
          listener(eventType, filename)
        ))
    this.schedule = resolved.schedule ?? setTimeout
    this.cancel = resolved.cancel ?? clearTimeout
    this.onDocumentChange = resolved.onDocumentChange
    this.onPendingChange = resolved.onPendingChange
  }

  on(handler: ChangeHandler): () => void {
    const offGlobal = onWorkspaceChange(handler)
    const off = () => {
      offGlobal()
      this.handlerOffs.delete(off)
    }
    this.handlerOffs.add(off)
    return off
  }

  start(): void {
    this.stopping = false
    try {
      const dir = spacesDir()
      const workspaceRoot = getWorkspaceRoot()

      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const rootThreads = worktableThreadsDir()
      if (!existsSync(rootThreads)) {
        mkdirSync(rootThreads, { recursive: true })
      }
      this.rootThreadsIdentity = directoryIdentity(rootThreads)
      this.rootThreadPollDirectoryFingerprint = directoryFingerprint(rootThreads)
      this.rootThreadPollSnapshot = rootThreadSnapshot(rootThreads) ?? new Map()
      this.watchDir(workspaceRoot, true)
      this.watchDir(rootThreads)
      this.watchDir(dir)
    } catch (error) {
      // Starting is one lifecycle boundary: if a later directory cannot be
      // watched, release every handle acquired earlier in this attempt.
      this.stop()
      throw error
    }
  }

  private watchDir(dir: string, rootThreadParent = false): void {
    if (this.watchers.has(dir)) return

    const spacesBase = spacesDir()
    const rootThreads = worktableThreadsDir()
    const worktableThreadWatch = rootThreadParent || dir.startsWith(rootThreads)
    const parse = (filename: string | null) =>
      worktableThreadWatch
        ? parseWorktableThreadChangedPath(rootThreads, filename, dir)
        : parseChangedPath(spacesBase, filename, dir)
    const watcher = this.watchFileSystem(dir, (eventType, filename) => {
      if (!filename) return
      const changedPath = filename.replaceAll("\\", "/")
      // Atomic directory replacement may be reported only under the source
      // name, so every root-level rename rechecks the stable threads path.
      if (rootThreadParent && eventType !== "rename") return

      // Ambiguous record activity is debounced PER COLLECTION, not per temp
      // file. A 60-record agent batch should cause one bounded scan, not 60.
      const parsed = parse(changedPath)
      const fullPath = join(dir, changedPath)
      const rawSuppressed = notePathEventIfSuppressed(fullPath)
      const key = rootThreadParent
        ? "thread-root-parent"
        : parsed?.type === "recordCollectionReconcile"
          ? `record-reconcile:${parsed.spaceId}/${parsed.collectionId}`
          : parsed?.type === "threadCollectionReconcile"
            ? `thread-reconcile:${JSON.stringify(threadEventLocation(parsed))}`
            : join(dir, changedPath)
      const existing = this.debounceTimers.get(key)
      if (existing) this.cancel(existing.timer)

      const flush = () => {
        this.debounceTimers.delete(key)

        if (rootThreadParent) {
          const nextIdentity = directoryIdentity(rootThreads)
          if (nextIdentity !== this.rootThreadsIdentity) {
            this.rootThreadsIdentity = nextIdentity
            this.startRootThreadPolling(rootThreads)
          }
          const existingRootWatcher = this.watchers.get(rootThreads)
          existingRootWatcher?.close()
          this.watchers.delete(rootThreads)
          if (!this.stopping && existsSync(rootThreads)) {
            this.watchDir(rootThreads)
          }
          const location = { kind: "worktable" } as const
          this.emit({ type: "threadCollectionReconcile", location })
          this.emitCanonicalThreadFiles(location)
          if (this.rootThreadPoller) {
            this.rootThreadPollDirectoryFingerprint =
              directoryFingerprint(rootThreads)
            const snapshot = rootThreadSnapshot(rootThreads)
            if (snapshot) this.rootThreadPollSnapshot = snapshot
          }
          return
        }

        // Check if this path is suppressed (internal REST write)
        const directory = isDirectory(fullPath)
        if (directory) {
          if (!this.stopping) {
            try {
              this.watchDir(fullPath)
            } catch (error) {
              // Atomic publication can rename a nested directory away after
              // discovery but before fs.watch() registers it. The stable
              // parent watcher observes the destination; other errors remain
              // fatal so a broken root watch cannot fail silently.
              if ((error as { code?: unknown })?.code !== "ENOENT") throw error
            }
          }
          this.emitExistingFiles(fullPath)
        }

        if (this.rootThreadPoller && dir === rootThreads) {
          this.rootThreadPollDirectoryFingerprint = directoryFingerprint(dir)
          const snapshot = rootThreadSnapshot(dir)
          if (snapshot) this.rootThreadPollSnapshot = snapshot
        }

        const suppressed =
          rawSuppressed || notePathEventIfSuppressed(fullPath)
        const event = parse(changedPath)
        console.log(
          `[Worktable] watcher debounce: file=${changedPath}, parsed=${event ? JSON.stringify(event) : "null"}, suppressed=${suppressed}`
        )

        if (suppressed) {
          return
        }

        if (event) {
          this.emit(event)
          if (event.type === "threadCollectionReconcile" && !directory) {
            this.emitCanonicalThreadFiles(threadEventLocation(event))
          }
        }
      }
      const timer = this.schedule(flush, this.debounceMs)

      this.debounceTimers.set(key, { timer, flush })
      this.onPendingChange?.(parsed)
    }, !rootThreadParent)

    watcher.on("error", (err) => {
      console.error("[WorkspaceWatcher] fs.watch error:", err)
    })

    this.watchers.set(dir, watcher)
  }

  flushPending(): void {
    const pending = [...this.debounceTimers.values()]
    for (const { timer } of pending) {
      this.cancel(timer)
    }
    for (const { flush } of pending) flush()
  }

  stop({ flushPending = false }: { flushPending?: boolean } = {}): void {
    this.stopping = true
    if (this.rootThreadPoller) clearInterval(this.rootThreadPoller)
    this.rootThreadPoller = null
    this.rootThreadPollDirectoryFingerprint = null
    this.rootThreadPollSnapshot.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    if (flushPending) this.flushPending()
    else {
      for (const { timer } of this.debounceTimers.values()) this.cancel(timer)
      this.debounceTimers.clear()
    }
    for (const off of [...this.handlerOffs]) off()
  }

  private emit(event: ChangeEvent): void {
    if (
      this.onDocumentChange &&
      (event.type === "doc" ||
        event.type === "widget" ||
        event.type === "documentCorpus")
    ) {
      this.onDocumentChange(event)
      return
    }
    notifyWorkspaceChange(event)
  }

  private startRootThreadPolling(dir: string): void {
    if (this.rootThreadPoller) return
    this.rootThreadPollDirectoryFingerprint = directoryFingerprint(dir)
    this.rootThreadPollSnapshot = rootThreadSnapshot(dir) ?? new Map()
    this.rootThreadPoller = setInterval(() => {
      if (this.stopping) return
      const directoryState = directoryFingerprint(dir)
      if (
        !directoryState ||
        directoryState === this.rootThreadPollDirectoryFingerprint
      ) {
        return
      }
      this.rootThreadPollDirectoryFingerprint = directoryState
      const previous = this.rootThreadPollSnapshot
      const next = rootThreadSnapshot(dir)
      if (!next) return
      this.rootThreadPollSnapshot = next
      const changed = new Set<string>()
      for (const [threadId, fingerprint] of next) {
        if (previous.get(threadId) !== fingerprint) changed.add(threadId)
      }
      for (const threadId of previous.keys()) {
        if (!next.has(threadId)) changed.add(threadId)
      }
      if (changed.size === 0) return

      const location = { kind: "worktable" } as const
      this.emit({ type: "threadCollectionReconcile", location })
      for (const threadId of changed) {
        const path = join(dir, `${threadId}.json`)
        if (!notePathEventIfSuppressed(path)) {
          this.emit({ type: "thread", location, threadId })
        }
      }
    }, ROOT_THREAD_REPLACEMENT_POLL_MS)
    this.rootThreadPoller.unref?.()
  }

  private emitExistingFiles(dir: string): void {
    const spacesBase = spacesDir()
    const rootThreads = worktableThreadsDir()
    for (const file of listFiles(dir)) {
      const relative = file.slice(dir.length + 1)
      const event = dir.startsWith(rootThreads)
        ? parseWorktableThreadChangedPath(rootThreads, relative, dir)
        : parseChangedPath(spacesBase, relative, dir)
      if (event && !notePathEventIfSuppressed(file)) {
        this.emit(event)
      }
    }
  }

  private emitCanonicalThreadFiles(
    location:
      | { kind: "worktable" }
      | { kind: "space"; spaceId: string }
  ): void {
    const spacesBase = spacesDir()
    const dir =
      location.kind === "worktable"
        ? worktableThreadsDir()
        : join(spacesBase, location.spaceId, "threads")
    for (const file of listFiles(dir)) {
      const relative = file.slice(dir.length + 1)
      const event =
        location.kind === "worktable"
          ? parseWorktableThreadChangedPath(dir, relative, dir)
          : parseChangedPath(spacesBase, relative, dir)
      if (event?.type === "thread" && !notePathEventIfSuppressed(file)) {
        this.emit(event)
      }
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listFiles(dir: string): string[] {
  const files: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...listFiles(fullPath))
      } else {
        files.push(fullPath)
      }
    }
  } catch {
    // Directory may have been removed between the fs event and the scan.
  }
  return files
}

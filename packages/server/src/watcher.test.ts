import { afterEach, beforeEach, describe, it, expect } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  WorkspaceWatcher,
  parseChangedPath,
  parseWorktableThreadChangedPath,
  type DocumentFilesystemChangeEvent,
} from "./watcher.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import { suppressPath, unsuppressPath } from "./store.ts"

function controlledWatcher(
  debounceMs: number,
  onDocumentChange?: (event: DocumentFilesystemChangeEvent) => void
): {
  watcher: WorkspaceWatcher
  notify(filename: string): void
} {
  let listener:
    | ((eventType: string, filename: string | null) => void)
    | undefined
  let nextTimer = 0
  const timers = new Map<number, () => void>()
  const watcher = new WorkspaceWatcher({
    debounceMs,
    ...(onDocumentChange ? { onDocumentChange } : {}),
    watch: (_directory, nextListener) => {
      listener = nextListener
      const handle = {
        close() {},
        on() {
          return handle
        },
      }
      return handle
    },
    schedule: (callback) => {
      nextTimer += 1
      timers.set(nextTimer, callback)
      return nextTimer as unknown as ReturnType<typeof setTimeout>
    },
    cancel: (timer) => {
      timers.delete(timer as unknown as number)
    },
  })
  return {
    watcher,
    notify(filename) {
      listener?.("rename", filename)
    },
  }
}

describe("WorkspaceWatcher", () => {
  let workspaceDir = ""

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worktable-watcher-"))
    setWorkspaceRootOverride(workspaceDir)
  })

  afterEach(() => {
    setWorkspaceRootOverride(null)
    if (existsSync(workspaceDir))
      rmSync(workspaceDir, { recursive: true, force: true })
  })

  it("routes portable alias-file edits through the watcher event seam", () => {
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/doc-aliases.json",
        "/workspace/spaces"
      )
    ).toEqual({ type: "docAliases", spaceId: "space" })
  })
  it("routes format-neutral inventory and future source edits through one corpus seam", () => {
    for (const path of [
      "space/docs.meta.json",
      "space/docs.meta.json.tmp",
      "space/documents.meta.json",
      "space/docs/canvas.bin",
      "space/widgets/canvas/source.md",
      "space/widgets/canvas.wtdoc/state.yaml",
    ]) {
      expect(
        parseChangedPath("/workspace/spaces", path, "/workspace/spaces")
      ).toEqual({ type: "documentCorpus", spaceId: "space" })
    }
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/annotations/note.json",
        "/workspace/spaces"
      )
    ).toBeNull()
  })
  it("reconciles Space and HTML Doc identities from directory-level events", () => {
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space",
        "/workspace/spaces"
      )
    ).toEqual({ type: "space", spaceId: "space" })
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/widgets/plans/q3",
        "/workspace/spaces"
      )
    ).toEqual({ type: "widget", spaceId: "space", widgetId: "plans/q3" })
  })
  it("ignores private first-run staging paths without hiding user spaces", () => {
    const stagingId = "welcome-seed-123e4567-e89b-42d3-a456-426614174000"
    const stagingDir = join(workspaceDir, "spaces", stagingId)
    mkdirSync(stagingDir, { recursive: true })
    writeFileSync(join(stagingDir, ".worktable-internal-seed"), stagingId)
    expect(
      parseChangedPath(
        join(workspaceDir, "spaces"),
        `${stagingId}/docs/ways-to-work.json`,
        join(workspaceDir, "spaces")
      )
    ).toBeNull()
    expect(
      parseChangedPath(
        "/workspace/spaces",
        `${stagingId}/docs/notes.md`,
        "/workspace/spaces"
      )
    ).toEqual({
      type: "doc",
      spaceId: stagingId,
      docPath: "notes",
    })
  })
  it("routes portable thread files through the watcher event seam", () => {
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/threads/thr_abcdefghijkl.json",
        "/workspace/spaces"
      )
    ).toEqual({
      type: "thread",
      location: { kind: "space", spaceId: "space" },
      spaceId: "space",
      threadId: "thr_abcdefghijkl",
    })
  })
  it("reconciles ambiguous temporary activity in the bounded threads directory", () => {
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/threads/.thr_abcdefghijkl.json.swp",
        "/workspace/spaces"
      )
    ).toEqual({
      type: "threadCollectionReconcile",
      location: { kind: "space", spaceId: "space" },
      spaceId: "space",
    })
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/threads/thr_abcdefghijkl.json.tmp-42",
        "/workspace/spaces"
      )
    ).toEqual({
      type: "threadCollectionReconcile",
      location: { kind: "space", spaceId: "space" },
      spaceId: "space",
    })
  })
  it("routes Worktable thread files through the root thread watcher", () => {
    expect(
      parseWorktableThreadChangedPath(
        "/workspace/threads",
        "thr_abcdefghijkl.json",
        "/workspace/threads"
      )
    ).toEqual({
      type: "thread",
      location: { kind: "worktable" },
      threadId: "thr_abcdefghijkl",
    })
  })
  it("observes root thread files through the stable workspace parent", () => {
    const listeners = new Map<
      string,
      (eventType: string, filename: string | null) => void
    >()
    const watchCalls: string[] = []
    const watcher = new WorkspaceWatcher({
      debounceMs: 0,
      watch: (directory, listener) => {
        watchCalls.push(directory)
        listeners.set(directory, listener)
        const handle = {
          close() {},
          on() {
            return handle
          },
        }
        return handle
      },
      schedule: (callback) => {
        callback()
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      cancel() {},
    })
    const events: unknown[] = []
    watcher.on((event) => events.push(event))
    watcher.start()

    const threadDir = join(workspaceDir, "threads")
    writeFileSync(join(threadDir, "thr_abcdefghijkl.json"), "{}")
    listeners.get(workspaceDir)?.("rename", "threads")
    watcher.stop()

    expect(watchCalls.filter((directory) => directory === threadDir)).toHaveLength(
      2
    )
    expect(events).toContainEqual({
      type: "threadCollectionReconcile",
      location: { kind: "worktable" },
    })
    expect(events).toContainEqual({
      type: "thread",
      location: { kind: "worktable" },
      threadId: "thr_abcdefghijkl",
    })
  })
  it("continues watching after the root threads directory is replaced", async () => {
    const watcher = new WorkspaceWatcher(5)
    watcher.start()
    const nextThread = (threadId: string) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          off()
          reject(new Error(`Timed out waiting for ${threadId}`))
        }, 2_000)
        const off = watcher.on((event) => {
          if (event.type !== "thread" || event.threadId !== threadId) return
          clearTimeout(timeout)
          off()
          resolve()
        })
      })

    const threadDir = join(workspaceDir, "threads")
    const replacement = join(workspaceDir, "replacement-threads")
    const replacedThread = "thr_replaced1234"
    mkdirSync(replacement)
    writeFileSync(join(replacement, `${replacedThread}.json`), "{}")
    const replacementObserved = nextThread(replacedThread)
    rmSync(threadDir, { recursive: true })
    renameSync(replacement, threadDir)

    try {
      await replacementObserved
      const laterThread = "thr_afterreplace"
      const laterObserved = nextThread(laterThread)
      writeFileSync(join(threadDir, `${laterThread}.json`), "{}")
      await laterObserved
      const steadyThread = "thr_steadyafterreplace"
      const steadyObserved = nextThread(steadyThread)
      writeFileSync(join(threadDir, `${steadyThread}.json`), "{}")
      await steadyObserved
    } finally {
      watcher.stop()
    }
  })
  it("ignores a nested directory renamed away before its watch is registered", () => {
    const listeners = new Map<
      string,
      (eventType: string, filename: string | null) => void
    >()
    const spaces = join(workspaceDir, "spaces")
    const stagedId = "welcome-seed-123e4567-e89b-42d3-a456-426614174000"
    const stagedRoot = join(spaces, stagedId)
    const vanishedDir = join(stagedRoot, "widgets", "welcome")
    const stableDir = join(spaces, "stable", "widgets", "dashboard")
    const watcher = new WorkspaceWatcher({
      debounceMs: 0,
      watch: (directory, listener) => {
        if (directory === vanishedDir) {
          rmSync(stagedRoot, { recursive: true, force: true })
          throw Object.assign(new Error("watch target vanished"), {
            code: "ENOENT",
          })
        }
        listeners.set(directory, listener)
        const handle = {
          close() {},
          on() {
            return handle
          },
        }
        return handle
      },
      schedule: (callback) => {
        callback()
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      cancel() {},
    })
    watcher.start()
    mkdirSync(vanishedDir, { recursive: true })
    writeFileSync(join(stagedRoot, ".worktable-internal-seed"), stagedId)

    expect(() =>
      listeners.get(spaces)?.("rename", `${stagedId}/widgets/welcome`)
    ).not.toThrow()
    expect(existsSync(stagedRoot)).toBe(false)

    mkdirSync(stableDir, { recursive: true })
    listeners.get(spaces)?.("rename", "stable/widgets/dashboard")
    expect(listeners.has(stableDir)).toBe(true)
    watcher.stop()
  })
  it("turns a temp-only filesystem signal into collection and canonical thread events", () => {
    const threadDir = join(workspaceDir, "spaces", "space", "threads")
    mkdirSync(threadDir, { recursive: true })
    writeFileSync(join(threadDir, "thr_abcdefghijkl.json"), "{}")
    const controlled = controlledWatcher(25)
    const watcher = controlled.watcher
    const events: unknown[] = []
    watcher.on((event) => events.push(event))
    watcher.start()

    writeFileSync(join(threadDir, ".editor-write.tmp"), "{}")
    controlled.notify("space/threads/.editor-write.tmp")
    watcher.stop({ flushPending: true })

    expect(events).toContainEqual({
      type: "threadCollectionReconcile",
      location: { kind: "space", spaceId: "space" },
      spaceId: "space",
    })
    expect(events).toContainEqual({
      type: "thread",
      location: { kind: "space", spaceId: "space" },
      spaceId: "space",
      threadId: "thr_abcdefghijkl",
    })
  })
  it("normalizes ambiguous record temp and directory activity to a collection reconcile", () => {
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/records/ideas/idea.yaml.tmp",
        "/workspace/spaces"
      )
    ).toEqual({
      type: "recordCollectionReconcile",
      spaceId: "space",
      collectionId: "ideas",
    })
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/records/ideas",
        "/workspace/spaces"
      )
    ).toEqual({
      type: "recordCollectionReconcile",
      spaceId: "space",
      collectionId: "ideas",
    })
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/records/ideas/.idea.yaml.swp",
        "/workspace/spaces"
      )
    ).toEqual({
      type: "recordCollectionReconcile",
      spaceId: "space",
      collectionId: "ideas",
    })
  })
  it("keeps canonical record and schema activity precise", () => {
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/records/ideas/idea.yaml",
        "/workspace/spaces"
      )
    ).toEqual({
      type: "record",
      spaceId: "space",
      collectionId: "ideas",
      recordId: "idea",
    })
    expect(
      parseChangedPath(
        "/workspace/spaces",
        "space/records/ideas/schema.yaml",
        "/workspace/spaces"
      )
    ).toEqual({
      type: "recordCollection",
      spaceId: "space",
      collectionId: "ideas",
    })
  })
  it("can be created and started/stopped without error", () => {
    const watcher = new WorkspaceWatcher()
    expect(() => watcher.start()).not.toThrow()
    expect(() => watcher.stop()).not.toThrow()
  })

  it("releases directory watches acquired before startup fails", () => {
    let attempts = 0
    let closes = 0
    const watcher = new WorkspaceWatcher({
      watch: () => {
        attempts += 1
        if (attempts === 2) throw new Error("watch unavailable")
        const handle = {
          close() {
            closes += 1
          },
          on() {
            return handle
          },
        }
        return handle
      },
    })

    expect(() => watcher.start()).toThrow("watch unavailable")
    expect(closes).toBe(1)
    expect(() => watcher.stop()).not.toThrow()
    expect(closes).toBe(1)
  })

  it("routes only filesystem document activity through the coordinator", () => {
    const documentEvents: DocumentFilesystemChangeEvent[] = []
    const globalEvents: unknown[] = []
    const controlled = controlledWatcher(1_000, (event) =>
      documentEvents.push(event)
    )
    controlled.watcher.on((event) => globalEvents.push(event))
    controlled.watcher.start()

    controlled.notify("space/docs/notes.md")
    controlled.notify("space/space.json")
    controlled.watcher.stop({ flushPending: true })

    expect(documentEvents).toEqual([
      { type: "doc", spaceId: "space", docPath: "notes" },
    ])
    expect(globalEvents).toEqual([{ type: "space", spaceId: "space" }])
  })

  it("keeps an internally observed document event suppressed through debounce", () => {
    const documentEvents: DocumentFilesystemChangeEvent[] = []
    const controlled = controlledWatcher(1_000, (event) =>
      documentEvents.push(event)
    )
    controlled.watcher.start()
    const path = join(workspaceDir, "spaces", "space", "docs", "new.md")

    suppressPath(path)
    controlled.notify("space/docs/new.md")
    unsuppressPath(path)
    controlled.watcher.stop({ flushPending: true })

    expect(documentEvents).toEqual([])
  })

  it("does not let an earlier suppression hide a later external edit", () => {
    const documentEvents: DocumentFilesystemChangeEvent[] = []
    const controlled = controlledWatcher(1_000, (event) =>
      documentEvents.push(event)
    )
    controlled.watcher.start()
    const path = join(workspaceDir, "spaces", "space", "docs", "new.md")

    suppressPath(path)
    controlled.notify("space/docs/new.md")
    unsuppressPath(path)
    controlled.notify("space/docs/new.md")
    controlled.watcher.stop({ flushPending: true })

    expect(documentEvents).toEqual([
      { type: "doc", spaceId: "space", docPath: "new" },
    ])
  })

  it("flushes a filesystem event that is still inside the debounce window", () => {
    const controlled = controlledWatcher(1_000)
    const watcher = controlled.watcher
    const events: string[] = []
    watcher.on((event) => {
      if (event.type === "space") events.push(event.spaceId)
    })
    watcher.start()

    const spaceDir = join(workspaceDir, "spaces", "flushed")
    mkdirSync(spaceDir, { recursive: true })
    writeFileSync(
      join(spaceDir, "space.json"),
      JSON.stringify({ id: "flushed", name: "Flushed" })
    )
    controlled.notify("flushed/space.json")
    expect(events).toEqual([])

    watcher.stop({ flushPending: true })
    expect(events).toContain("flushed")
  })
})

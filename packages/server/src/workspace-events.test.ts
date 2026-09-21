import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { getAppDir } from "./app-storage.ts"
import "./thread-delivery-store.ts"
import {
  changeEventAffectsContentDerivedState,
  drainWorkspaceChanges,
  notifyWorkspaceChange,
  notifyWorkspaceChangeAndWait,
  notifyWorkspaceChangeAndWaitOrThrow,
  onWorkspaceChange,
} from "./workspace-events.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"

describe("workspace event lifecycle", () => {
  it("keeps machine-local collaboration activity out of content caches", () => {
    expect(
      changeEventAffectsContentDerivedState({
        type: "threadActivity",
        spaceId: "space",
        threadId: "thr_example123",
        messageId: "msg_example123",
        participantId: "ptc_example123",
      })
    ).toBe(false)
    expect(
      changeEventAffectsContentDerivedState({
        type: "participants",
        spaceId: "space",
      })
    ).toBe(false)
    expect(
      changeEventAffectsContentDerivedState({
        type: "thread",
        spaceId: "space",
        threadId: "thr_example123",
      })
    ).toBe(true)
    expect(
      changeEventAffectsContentDerivedState({
        type: "doc",
        spaceId: "space",
        docPath: "plan",
      })
    ).toBe(true)
  })

  it("drains asynchronous handlers, including work emitted while draining", async () => {
    const completed: string[] = []
    const off = onWorkspaceChange(async (event) => {
      if (event.type !== "space") return
      await Promise.resolve()
      completed.push(event.spaceId)
      if (event.spaceId === "first") {
        notifyWorkspaceChange({ type: "space", spaceId: "second" })
      }
    })

    try {
      notifyWorkspaceChange({ type: "space", spaceId: "first" })
      await drainWorkspaceChanges()
      expect(completed).toEqual(["first", "second"])
    } finally {
      off()
      await drainWorkspaceChanges()
    }
  })

  it("waits for handlers started by one dispatched event", async () => {
    let release!: () => void
    let reportStarted!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    let completed = false
    const off = onWorkspaceChange(async (event) => {
      if (event.type !== "space" || event.spaceId !== "held") return
      reportStarted()
      await held
      completed = true
    })

    try {
      const notification = notifyWorkspaceChangeAndWait({
        type: "space",
        spaceId: "held",
      })
      await started
      expect(completed).toBe(false)
      release()
      await notification
      expect(completed).toBe(true)
    } finally {
      release()
      off()
      await drainWorkspaceChanges()
    }
  })

  it("surfaces synchronous and asynchronous failures to strict lifecycle callers", async () => {
    const synchronousError = new Error("synchronous reset failure")
    const asynchronousError = new Error("asynchronous reset failure")
    const offSync = onWorkspaceChange((event) => {
      if (event.type === "workspaceReset") throw synchronousError
    })
    const offAsync = onWorkspaceChange(async (event) => {
      if (event.type === "workspaceReset") throw asynchronousError
    })

    try {
      const rejection = await notifyWorkspaceChangeAndWaitOrThrow({
        type: "workspaceReset",
      }).catch((error) => error)
      expect(rejection).toBeInstanceOf(AggregateError)
      expect((rejection as AggregateError).errors).toEqual([
        synchronousError,
        asynchronousError,
      ])
    } finally {
      offSync()
      offAsync()
      await drainWorkspaceChanges()
    }
  })

  it("keeps reset side effects inside the process test sandbox", async () => {
    expect(getWorkspaceRoot()).toBe(process.env["WORKTABLE_WORKSPACE"]!)
    expect(getAppDir()).toBe(process.env["WORKTABLE_APP_DIR"]!)

    await notifyWorkspaceChangeAndWaitOrThrow({ type: "workspaceReset" })

    const deliveryFile = join(
      getAppDir(),
      "thread-deliveries",
      `${workspaceCacheKey()}.json`
    )
    const stored = JSON.parse(await readFile(deliveryFile, "utf8")) as {
      type: string
      deliveries: unknown[]
    }
    expect(stored).toMatchObject({
      type: "worktable.thread-deliveries",
      deliveries: [],
    })
  })
})

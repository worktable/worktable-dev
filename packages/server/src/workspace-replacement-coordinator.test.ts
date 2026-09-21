import { afterEach, describe, expect, it } from "bun:test"
import {
  scheduleWorkspaceReplacement,
  setWorkspaceReplacementExecutor,
  withWorkspaceExportLease,
  type ScheduledWorkspaceReplacement,
} from "./workspace-replacement-coordinator.ts"

afterEach(() => {
  setWorkspaceReplacementExecutor(null)
})

function replacement(): ScheduledWorkspaceReplacement {
  return {
    stagingPath: "/tmp/staging",
    backupPath: "/tmp/backup",
    contentCheckpoint: "a".repeat(64),
    async onSucceeded() {},
    async onFailed() {},
  }
}

describe("workspace replacement coordination", () => {
  it("admits only one replacement until its callback settles", async () => {
    let first!: ScheduledWorkspaceReplacement
    let called!: () => void
    const executorCalled = new Promise<void>((resolve) => {
      called = resolve
    })
    setWorkspaceReplacementExecutor((scheduled) => {
      first = scheduled
      called()
    })

    scheduleWorkspaceReplacement(replacement())
    expect(() => scheduleWorkspaceReplacement(replacement())).toThrow(
      /already in progress/
    )
    await executorCalled
    await first.onSucceeded()

    let second!: ScheduledWorkspaceReplacement
    setWorkspaceReplacementExecutor((replacement) => {
      second = replacement
    })
    scheduleWorkspaceReplacement(replacement())
    await Promise.resolve()
    expect(second).toBeDefined()
    await second.onSucceeded()
  })

  it("drains an active export and rejects new exports after replacement admission", async () => {
    let exportStarted!: () => void
    let releaseExport!: () => void
    const started = new Promise<void>((resolve) => {
      exportStarted = resolve
    })
    const exportGate = new Promise<void>((resolve) => {
      releaseExport = resolve
    })
    const runningExport = withWorkspaceExportLease(async () => {
      exportStarted()
      await exportGate
    })
    await started

    let scheduled!: ScheduledWorkspaceReplacement
    let executorCalled!: () => void
    const called = new Promise<void>((resolve) => {
      executorCalled = resolve
    })
    setWorkspaceReplacementExecutor((replacement) => {
      scheduled = replacement
      executorCalled()
    })
    scheduleWorkspaceReplacement(replacement())

    await expect(
      withWorkspaceExportLease(async () => undefined)
    ).rejects.toThrow(/during replacement/)
    releaseExport()
    await runningExport
    await called
    await scheduled.onFailed(new Error("test rollback"))
  })
})

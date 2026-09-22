import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import {
  inspectWorkspaceSnapshot,
  writeWorkspaceSnapshot,
} from "./workspace-snapshot.ts"
import {
  beginPreparedWorkspaceReplacement,
  createWorkspaceReplacementPaths,
} from "./workspace-replacement.ts"
import {
  calculateWorkspaceContentCheckpoint,
  setWorkspaceExportCaptureHookForTests,
  setWorkspaceExportCaptureRemovalHookForTests,
} from "./workspace-transfer-v2.ts"

import { WorkspaceBackupNotifier } from "./workspace-backup-notifier.ts"

let root: string
let workspace: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-snapshot-"))
  workspace = join(root, "workspace")
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(workspace)
  ensureWorkspaceManifest()
})
afterEach(async () => {
  setWorkspaceExportCaptureHookForTests(null)
  setWorkspaceExportCaptureRemovalHookForTests(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("portable workspace snapshots", () => {
  it("drains cancelled copies before releasing writers and then cleans scratch outside the barrier", async () => {
    await writeFile(join(workspace, "held.md"), "held copy")
    await writeFile(join(workspace, "failed.md"), "failed copy")
    const cancellation = new AbortController()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const enteredCopy = new Promise<void>((resolve) => {
      entered = resolve
    })
    let failed!: () => void
    const copyFailed = new Promise<void>((resolve) => {
      failed = resolve
    })
    setWorkspaceExportCaptureHookForTests(async (entry) => {
      if (entry.path === "held.md") {
        entered()
        await held
      }
      if (entry.path === "failed.md") {
        await enteredCopy
        failed()
        cancellation.abort(new Error("capture cancelled"))
      }
    })
    let barrier = false
    let cleanedOutsideBarrier = false
    setWorkspaceExportCaptureRemovalHookForTests(async () => {
      cleanedOutsideBarrier = !barrier
    })
    const snapshot = writeWorkspaceSnapshot(join(root, "failed-snapshot"), {
      signal: cancellation.signal,
      withCaptureBarrier: async (capture) => {
        barrier = true
        try {
          return await capture()
        } finally {
          barrier = false
        }
      },
    })
    // Observe the failure without allowing an unhandled rejection to race the assertion.
    const outcome = snapshot.then(
      () => null,
      (error) => error
    )
    try {
      await copyFailed
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(barrier).toBe(true)
    } finally {
      release()
    }
    expect((await outcome)?.message).toBe("capture cancelled")
    expect(cleanedOutsideBarrier).toBe(true)
    expect(barrier).toBe(false)
    expect(
      await readdir(join(root, "app", "workspace-transfers", "captures"))
    ).toEqual([])
  })
  it.each([1, 2] as const)(
    "captures layout %i with full history and restores it while preserving current identity",
    async (version) => {
      const manifestPath = join(workspace, "worktable.workspace.json")
      const identity = {
        ...JSON.parse(await readFile(manifestPath, "utf8")),
        version,
      }
      await writeFile(manifestPath, JSON.stringify(identity))
      await mkdir(join(workspace, "spaces", "empty"), { recursive: true })
      await mkdir(join(workspace, "versions", "notes"), { recursive: true })
      await writeFile(
        join(workspace, "versions", "notes", "old.json"),
        '{"content":"older"}'
      )
      await writeFile(join(workspace, "note.md"), "saved")
      let barrier = false
      const saved = await writeWorkspaceSnapshot(join(root, "snapshot"), {
        withCaptureBarrier: async (capture) => {
          barrier = true
          try {
            return await capture()
          } finally {
            barrier = false
            // Upload is allowed to overlap later editing; its bytes stay frozen.
            await writeFile(join(workspace, "note.md"), "newer")
          }
        },
      })
      expect(barrier).toBe(false)
      expect(saved.workspaceStorageVersion).toBe(version)
      expect(
        saved.files.some((file) => file.path === "versions/notes/old.json")
      ).toBe(true)
      expect(saved.directories.some((dir) => dir.path === "spaces/empty")).toBe(
        true
      )
      await expect(
        inspectWorkspaceSnapshot(join(root, "snapshot"), {
          workspaceId: identity.id,
        })
      ).resolves.toEqual(saved)
      // Cross-layout restore must not label a historical tree with today's layout.
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...identity,
          version: version === 1 ? 2 : 1,
          name: "Renamed today",
        })
      )
      const paths = createWorkspaceReplacementPaths()
      await cp(join(root, "snapshot", "workspace"), paths.stagingPath, {
        recursive: true,
      })
      const transaction = await beginPreparedWorkspaceReplacement(
        paths.stagingPath,
        paths.backupPath,
        saved.contentCheckpoint,
        await calculateWorkspaceContentCheckpoint(workspace),
        {
          manifest: "checkpoint",
          expectedSourceCheckpoint: saved.sourceCheckpoint,
        }
      )
      await transaction.commit()
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
        id: identity.id,
        name: "Renamed today",
        version,
      })
      expect(await readFile(join(workspace, "note.md"), "utf8")).toBe("saved")
    }
  )

  it("rejects changed bytes, another workspace, and unsupported layouts", async () => {
    const destination = join(root, "snapshot")
    const saved = await writeWorkspaceSnapshot(destination)
    await expect(
      inspectWorkspaceSnapshot(destination, { workspaceId: "ws_another" })
    ).rejects.toThrow("identity")
    await writeFile(
      join(destination, "workspace", "injected.md"),
      "not captured"
    )
    await expect(inspectWorkspaceSnapshot(destination)).rejects.toThrow(
      "integrity"
    )
    await rm(join(destination, "workspace", "injected.md"))
    const metadata = { ...saved, workspaceStorageVersion: 999 }
    await writeFile(
      join(destination, "snapshot.json"),
      JSON.stringify(metadata)
    )
    await expect(inspectWorkspaceSnapshot(destination)).rejects.toThrow()
  })

  it("refuses in-workspace destinations, overwrites, and linked content", async () => {
    await expect(
      writeWorkspaceSnapshot(join(workspace, "backup"))
    ).rejects.toThrow("outside")
    const destination = join(root, "snapshot")
    await writeWorkspaceSnapshot(destination)
    await expect(writeWorkspaceSnapshot(destination)).rejects.toThrow(
      "already exists"
    )
    await symlink(join(root, "app"), join(workspace, "linked"))
    await expect(writeWorkspaceSnapshot(join(root, "other"))).rejects.toThrow()
  })
})

describe("durable backup change reports", () => {
  async function until(predicate: () => Promise<boolean>) {
    const deadline = Date.now() + 3000
    while (!(await predicate())) {
      if (Date.now() >= deadline)
        throw new Error("backup report did not settle")
      // test-policy: external-readiness-backoff (persisted outbox and HTTP delivery)
      await Bun.sleep(10)
    }
  }
  it("retries a persisted unacknowledged report after restart and audits external edits", async () => {
    const ledger = join(root, "outbox.json")
    let attempted = false
    const first = new WorkspaceBackupNotifier(
      ledger,
      workspace,
      async (_, signal) => {
        attempted = true
        await new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        )
      }
    )
    await first.initialize()
    await until(async () => attempted)
    await first.stop()
    const pending = JSON.parse(await readFile(ledger, "utf8"))
    expect(pending.generation).toBeGreaterThan(pending.reported)
    const reports: { epoch: string; generation: number }[] = []
    const second = new WorkspaceBackupNotifier(
      ledger,
      workspace,
      async (value) => {
        reports.push(value)
      }
    )
    try {
      await second.initialize()
      await until(async () => {
        const state = JSON.parse(await readFile(ledger, "utf8"))
        return state.reported === pending.generation
      })
      expect(reports[0]).toEqual({
        epoch: pending.epoch,
        generation: pending.generation,
      })
      await second.audit()
      await writeFile(join(workspace, "outside-editor.md"), "External content")
      await second.audit()
      await until(async () =>
        reports.some((report) => report.generation > pending.generation)
      )
    } finally {
      await second.stop()
    }
  })
  it("persists edits arriving during a report without acknowledging them with the older request", async () => {
    const ledger = join(root, "outbox.json")
    let release!: () => void
    let firstGeneration = 0
    let calls = 0
    const notifier = new WorkspaceBackupNotifier(
      ledger,
      workspace,
      async (value) => {
        calls += 1
        if (calls === 1) {
          firstGeneration = value.generation
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
      }
    )
    try {
      await notifier.initialize()
      await until(async () => calls === 1)
      notifier.changed()
      release()
      await until(async () => {
        const state = JSON.parse(await readFile(ledger, "utf8"))
        return state.reported > firstGeneration
      })
      expect(calls).toBeGreaterThan(1)
    } finally {
      release?.()
      await notifier.stop()
    }
  })
})

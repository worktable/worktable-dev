import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { beginPreparedWorkspaceReplacement } from "./workspace-replacement.ts"
import { setWorkspaceReplacementExecutor } from "./workspace-replacement-coordinator.ts"
import { setWorkspaceExportFlush } from "./workspace-export-coordinator.ts"
import {
  appendWorkspaceImportChunk,
  cleanupExpiredWorkspaceTransfers,
  createWorkspaceExportJob,
  createWorkspaceImportJob,
  getCurrentWorkspaceExportJob,
  getCurrentWorkspaceImportJob,
  getWorkspaceImportJob,
  openWorkspaceExportDownload,
  prepareWorkspaceImportJob,
  recoverWorkspaceExportJob,
  getWorkspaceExportJob,
  recoverInterruptedWorkspaceTransferJobs,
  replaceWorkspaceImportJob,
  runWorkspaceTransferMaintenance,
  setWorkspaceExportRunHookForTests,
  setWorkspaceImportChunkBeforePublishHookForTests,
  setWorkspaceImportRollbackCleanupHookForTests,
  setWorkspaceImportRunHookForTests,
  setWorkspaceTransferCleanupAfterReadHookForTests,
  setWorkspaceTransferJobWriteHookForTests,
  startWorkspaceTransferMaintenance,
  waitForScheduledWorkspaceTransferCleanupsForTests,
  waitForWorkspaceExportJob,
  waitForWorkspaceImportJob,
} from "./workspace-transfer-jobs.ts"
import {
  calculateWorkspaceContentCheckpoint,
  writeWorkspaceExportV2,
} from "./workspace-transfer-v2.ts"
import { createWorkspaceReplacementPaths } from "./workspace-replacement.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

let root: string
let active: string
let source: string

async function seed(workspace: string, body: string): Promise<void> {
  await mkdir(join(workspace, "spaces", "notes", "docs"), { recursive: true })
  await writeFile(join(workspace, "spaces", "notes", "docs", "note.md"), body)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-transfer-jobs-"))
  active = join(root, "active")
  source = join(root, "source")
  setAppDirOverride(join(root, "app"))

  setWorkspaceRootOverride(active)
  ensureWorkspaceManifest()
  await seed(active, "# Before\n")
  setWorkspaceRootOverride(source)
  ensureWorkspaceManifest()
  await seed(source, "# After\n")
  setWorkspaceRootOverride(active)
})

afterEach(async () => {
  setWorkspaceReplacementExecutor(null)
  setWorkspaceExportFlush(null)
  setWorkspaceExportRunHookForTests(null)
  setWorkspaceImportChunkBeforePublishHookForTests(null)
  setWorkspaceImportRollbackCleanupHookForTests(null)
  setWorkspaceImportRunHookForTests(null)
  setWorkspaceTransferCleanupAfterReadHookForTests(null)
  setWorkspaceTransferJobWriteHookForTests(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("durable workspace transfer jobs", () => {
  it("persists reviewed recovery and returns one child job for concurrent retries", async () => {
    const bad = join(active, "versions/test-space/docs/legacy-note ")
    await mkdir(bad, { recursive: true })
    await writeFile(join(bad, "snapshot.json"), "history")
    const failed = await waitForWorkspaceExportJob(
      (await createWorkspaceExportJob({ mode: "all" })).id
    )
    expect(failed.failure?.code).toBe("NON_PORTABLE_HISTORY")
    const [first, second] = await Promise.all([
      recoverWorkspaceExportJob(failed.id),
      recoverWorkspaceExportJob(failed.id),
    ])
    expect(first.id).toBe(second.id)
    const recovered = await waitForWorkspaceExportJob(first.id)
    expect(recovered).toMatchObject({
      state: "complete",
      manifest: { history: { recovery: { omittedFiles: 1 } } },
    })
    expect(await readFile(join(bad, "snapshot.json"), "utf8")).toBe("history")
    await utimes(
      join(root, "app/workspace-transfers/jobs", first.id),
      new Date(0),
      new Date(0)
    )
    setWorkspaceRootOverride(source)
    await expect(getWorkspaceExportJob(first.id)).rejects.toThrow("not found")
    await cleanupExpiredWorkspaceTransfers()
    setWorkspaceRootOverride(active)
    expect((await getWorkspaceExportJob(first.id)).state).toBe("complete")
  })

  it("reports best-effort cleanup failures without rejecting job creation", async () => {
    await createWorkspaceImportJob({
      fileName: "existing.wtb",
      bytes: 2,
    })
    const cleanupFailure = new Error("injected cleanup failure")
    setWorkspaceTransferCleanupAfterReadHookForTests(async () => {
      throw cleanupFailure
    })
    let logged!: () => void
    const cleanupWasLogged = new Promise<void>((resolve) => {
      logged = resolve
    })
    const error = spyOn(console, "error").mockImplementation(
      (message, cause) => {
        if (
          message === "[workspace-transfer] background cleanup failed:" &&
          cause === cleanupFailure
        ) {
          logged()
        }
      }
    )

    try {
      await expect(
        createWorkspaceImportJob({
          fileName: "new.wtb",
          bytes: 2,
        })
      ).resolves.toMatchObject({ state: "uploading" })
      await cleanupWasLogged
      expect(error).toHaveBeenCalledWith(
        "[workspace-transfer] background cleanup failed:",
        cleanupFailure
      )
    } finally {
      error.mockRestore()
    }
  })

  it("finishes exports in app-private storage and exposes the artifact", async () => {
    let flushes = 0
    setWorkspaceExportFlush(async () => {
      flushes += 1
    })
    const created = await createWorkspaceExportJob({ mode: "none" })
    const finished = await waitForWorkspaceExportJob(created.id)
    const download = await openWorkspaceExportDownload(created.id)
    const bytes = Buffer.from(await new Response(download.body).arrayBuffer())

    expect(finished).toMatchObject({
      kind: "export",
      state: "complete",
      history: { mode: "none" },
    })
    expect(finished.downloadName).toEndWith(".wtb")
    expect(flushes).toBe(1)
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from("PK"))
  })

  it("rediscovers the latest durable jobs after a client reload", async () => {
    const exported = await createWorkspaceExportJob({ mode: "none" })
    await waitForWorkspaceExportJob(exported.id)
    const imported = await createWorkspaceImportJob({
      fileName: "resume.wtb",
      bytes: 2,
    })

    await expect(getCurrentWorkspaceExportJob()).resolves.toMatchObject({
      id: exported.id,
      state: "complete",
    })
    await expect(getCurrentWorkspaceImportJob()).resolves.toMatchObject({
      id: imported.id,
      state: "uploading",
      receivedBytes: 0,
    })
  })

  it("validates and persists a resumable upload fingerprint", async () => {
    const created = await createWorkspaceImportJob({
      fileName: "resume.wtb",
      bytes: 2,
      resumeFingerprint: "AB".repeat(32),
    })

    expect(created.resumeFingerprint).toBe("ab".repeat(32))
    await expect(
      createWorkspaceImportJob({
        fileName: "invalid.wtb",
        bytes: 2,
        resumeFingerprint: "not-a-fingerprint",
      })
    ).rejects.toThrow(/resume fingerprint/)
  })

  it("keeps an expired export while its download stream is active", async () => {
    const created = await createWorkspaceExportJob({ mode: "none" })
    const finished = await waitForWorkspaceExportJob(created.id)
    const download = await openWorkspaceExportDownload(created.id)
    const directory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      created.id
    )
    await writeFile(
      join(directory, "job.json"),
      `${JSON.stringify({
        ...finished,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      })}\n`
    )

    await cleanupExpiredWorkspaceTransfers()
    await expect(stat(directory)).resolves.toBeDefined()

    await download.body.cancel()
    await cleanupExpiredWorkspaceTransfers()
    await expect(stat(directory)).rejects.toThrow()
  })

  it("creates Unicode-safe download names", async () => {
    const manifestPath = join(active, "worktable.workspace.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name: string
    }
    manifest.name = `${"a".repeat(79)}😀tail`
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const created = await createWorkspaceExportJob({ mode: "none" })
    const finished = await waitForWorkspaceExportJob(created.id)

    expect(finished.downloadName).toContain("😀")
    expect(finished.downloadName).not.toContain("\uFFFD")
    expect(() => encodeURIComponent(finished.downloadName!)).not.toThrow()
  })

  it("removes a partial artifact when export generation fails", async () => {
    setWorkspaceExportRunHookForTests(async () => {
      const jobsRoot = join(root, "app", "workspace-transfers", "jobs")
      const [id] = await readdir(jobsRoot)
      await writeFile(join(jobsRoot, id!, "workspace.wtb"), "partial")
      throw new Error("injected export failure")
    })

    const created = await createWorkspaceExportJob({ mode: "none" })
    await expect(waitForWorkspaceExportJob(created.id)).resolves.toMatchObject({
      state: "failed",
      error: expect.stringContaining("injected export failure"),
    })
    await expect(
      stat(
        join(
          root,
          "app",
          "workspace-transfers",
          "jobs",
          created.id,
          "workspace.wtb"
        )
      )
    ).rejects.toThrow()
  })

  it("keeps export runner persistence failures handled and retryable", async () => {
    const exportFailure = new Error("injected export failure")
    const persistenceFailure = new Error("injected persistence failure")
    setWorkspaceExportRunHookForTests(async () => {
      throw exportFailure
    })
    setWorkspaceTransferJobWriteHookForTests(async (job) => {
      if (job.kind === "export" && job.state === "failed") {
        throw persistenceFailure
      }
    })
    let logged!: () => void
    const runnerFailureWasLogged = new Promise<void>((resolve) => {
      logged = resolve
    })
    const error = spyOn(console, "error").mockImplementation(
      (message, cause) => {
        if (
          typeof message === "string" &&
          message.startsWith("[workspace-transfer] export runner failed for") &&
          cause === persistenceFailure
        ) {
          logged()
        }
      }
    )

    try {
      const created = await createWorkspaceExportJob({ mode: "none" })
      await runnerFailureWasLogged
      expect(
        JSON.parse(
          await readFile(
            join(
              root,
              "app",
              "workspace-transfers",
              "jobs",
              created.id,
              "job.json"
            ),
            "utf8"
          )
        )
      ).toMatchObject({ state: "running" })

      setWorkspaceExportRunHookForTests(null)
      setWorkspaceTransferJobWriteHookForTests(null)
      await expect(
        waitForWorkspaceExportJob(created.id)
      ).resolves.toMatchObject({ state: "complete" })
    } finally {
      error.mockRestore()
    }
  })

  it("does not publish an import job without its upload artifact", async () => {
    const persistenceFailure = new Error("injected job publication failure")
    setWorkspaceTransferJobWriteHookForTests(async (job) => {
      if (job.kind === "import" && job.state === "uploading") {
        throw persistenceFailure
      }
    })

    await expect(
      createWorkspaceImportJob({
        fileName: "unpublished.wtb",
        bytes: 2,
      })
    ).rejects.toBe(persistenceFailure)
    expect(
      await readdir(join(root, "app", "workspace-transfers", "jobs"))
    ).toEqual([])
  })

  it("never prepares an import that failed its expected archive hash", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "wrong-pin"), {
      workspaceRoot: source,
    })
    const bytes = await readFile(archive.destination)
    const created = await createWorkspaceImportJob({
      fileName: "wrong-pin.wtb",
      bytes: bytes.byteLength,
      sha256: "0".repeat(64),
    })

    const verifying = await appendWorkspaceImportChunk({
      id: created.id,
      start: 0,
      total: bytes.byteLength,
      bytes,
    })
    expect(verifying.state).toBe("verifying")
    const failed = await waitForWorkspaceImportJob(created.id)
    expect(failed).toMatchObject({
      state: "failed",
      error: expect.stringContaining("hash does not match"),
    })
    await expect(prepareWorkspaceImportJob(created.id)).rejects.toThrow(
      /not ready to prepare/
    )
  })

  it("resumes chunk uploads, prepares a replacement, and records completion", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
      workspaceRoot: source,
    })
    const bytes = await readFile(archive.destination)
    const created = await createWorkspaceImportJob({
      fileName: "incoming.wtb",
      bytes: bytes.byteLength,
      sha256: archive.sha256,
    })
    const split = Math.floor(bytes.byteLength / 2)
    const partial = await appendWorkspaceImportChunk({
      id: created.id,
      start: 0,
      total: bytes.byteLength,
      bytes: bytes.subarray(0, split),
    })
    expect(partial).toMatchObject({
      state: "uploading",
      receivedBytes: split,
    })
    expect(
      await appendWorkspaceImportChunk({
        id: created.id,
        start: 0,
        total: bytes.byteLength,
        bytes: bytes.subarray(0, split),
      })
    ).toMatchObject({
      state: "uploading",
      receivedBytes: split,
    })
    const verifying = await appendWorkspaceImportChunk({
      id: created.id,
      start: split,
      total: bytes.byteLength,
      bytes: bytes.subarray(split),
    })
    expect(verifying.state).toBe("verifying")
    const uploaded = await waitForWorkspaceImportJob(created.id)
    expect(uploaded.state).toBe("uploaded")
    expect(
      await appendWorkspaceImportChunk({
        id: created.id,
        start: split,
        total: bytes.byteLength,
        bytes: bytes.subarray(split),
      })
    ).toMatchObject({
      state: "uploaded",
      receivedBytes: bytes.byteLength,
    })

    const preparing = await prepareWorkspaceImportJob(created.id)
    expect(preparing.state).toBe("preparing")
    const ready = await waitForWorkspaceImportJob(created.id)
    expect(ready).toMatchObject({
      state: "ready",
      prepared: {
        source: { workspaceId: archive.manifest.source.workspaceId },
      },
    })

    let finish!: () => void
    const completed = new Promise<void>((resolve) => {
      finish = resolve
    })
    setWorkspaceReplacementExecutor((replacement) => {
      void (async () => {
        try {
          const transaction = await beginPreparedWorkspaceReplacement(
            replacement.stagingPath,
            replacement.backupPath,
            replacement.contentCheckpoint,
            await calculateWorkspaceContentCheckpoint(active)
          )
          await transaction.commit()
          await replacement.onSucceeded()
        } catch (error) {
          await replacement.onFailed(error)
        } finally {
          finish()
        }
      })()
    })

    const expiredAt = new Date(Date.now() - 1).toISOString()
    const jobDirectory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      created.id
    )
    await writeFile(
      join(jobDirectory, "job.json"),
      `${JSON.stringify({ ...ready, expiresAt: expiredAt })}\n`
    )
    expect((await replaceWorkspaceImportJob(created.id)).state).toBe(
      "replacing"
    )
    await completed
    const finished = await getWorkspaceImportJob(created.id)
    expect(finished.state).toBe("complete")
    expect(finished.prepared).toBeUndefined()
    expect(Date.parse(finished.expiresAt)).toBeGreaterThan(
      Date.parse(expiredAt)
    )
    await expect(
      stat(`${ready.prepared!.backupPath}.committed`)
    ).rejects.toThrow()
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toBe("# After\n")
  })

  it("resumes verification and rolls back interrupted preparation after restart", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
      workspaceRoot: source,
    })
    const bytes = await readFile(archive.destination)
    const verifying = await createWorkspaceImportJob({
      fileName: "verifying.wtb",
      bytes: bytes.byteLength,
      sha256: archive.sha256,
    })
    const verifyingDirectory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      verifying.id
    )
    await writeFile(join(verifyingDirectory, "workspace.wtb"), bytes)
    await writeFile(
      join(verifyingDirectory, "job.json"),
      `${JSON.stringify({
        ...verifying,
        state: "verifying",
        receivedBytes: bytes.byteLength,
      })}\n`
    )

    expect(await recoverInterruptedWorkspaceTransferJobs()).toContain(
      verifying.id
    )
    expect((await waitForWorkspaceImportJob(verifying.id)).state).toBe(
      "uploaded"
    )

    const preparation = createWorkspaceReplacementPaths()
    await mkdir(preparation.stagingPath, { recursive: true })
    await writeFile(join(preparation.stagingPath, "partial"), "partial")
    const uploaded = await getWorkspaceImportJob(verifying.id)
    await writeFile(
      join(verifyingDirectory, "job.json"),
      `${JSON.stringify({
        ...uploaded,
        state: "preparing",
        preparation,
      })}\n`
    )

    expect(await recoverInterruptedWorkspaceTransferJobs()).toContain(
      verifying.id
    )
    const recovered = await waitForWorkspaceImportJob(verifying.id)
    expect(recovered).toMatchObject({
      state: "ready",
      prepared: {
        source: { workspaceId: archive.manifest.source.workspaceId },
      },
    })
    expect("preparation" in recovered).toBe(false)
    await expect(stat(preparation.stagingPath)).rejects.toThrow()
  })

  it("promotes a fully received uploading job after an interrupted final state write", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "received"), {
      workspaceRoot: source,
    })
    const bytes = await readFile(archive.destination)
    const uploading = await createWorkspaceImportJob({
      fileName: "received.wtb",
      bytes: bytes.byteLength,
      sha256: archive.sha256,
    })
    const directory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      uploading.id
    )
    await writeFile(join(directory, "workspace.wtb"), bytes)
    await writeFile(
      join(directory, "job.json"),
      `${JSON.stringify({
        ...uploading,
        state: "uploading",
        receivedBytes: bytes.byteLength,
      })}\n`
    )

    expect(await recoverInterruptedWorkspaceTransferJobs()).toContain(
      uploading.id
    )
    expect(await waitForWorkspaceImportJob(uploading.id)).toMatchObject({
      state: "uploaded",
      receivedBytes: bytes.byteLength,
      sha256: archive.sha256,
    })
  })

  it("cleans expired transfer artifacts without requiring another job", async () => {
    const expired = await createWorkspaceImportJob({
      fileName: "expired.wtb",
      bytes: 1,
    })
    const directory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      expired.id
    )
    await writeFile(
      join(directory, "job.json"),
      `${JSON.stringify({
        ...expired,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      })}\n`
    )

    await runWorkspaceTransferMaintenance()

    await expect(stat(directory)).rejects.toThrow()
  })

  it("cleans an expired running export abandoned by a prior process", async () => {
    const created = await createWorkspaceExportJob({ mode: "none" })
    const completed = await waitForWorkspaceExportJob(created.id)
    const directory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      created.id
    )
    await writeFile(
      join(directory, "job.json"),
      `${JSON.stringify({
        ...completed,
        state: "running",
        expiresAt: new Date(Date.now() - 1).toISOString(),
      })}\n`
    )

    await cleanupExpiredWorkspaceTransfers()

    await expect(stat(directory)).rejects.toThrow()
  })

  it("cleans staging left by an expired abandoned preparation", async () => {
    const created = await createWorkspaceImportJob({
      fileName: "abandoned-preparation.wtb",
      bytes: 1,
    })
    const directory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      created.id
    )
    const preparation = createWorkspaceReplacementPaths()
    await mkdir(preparation.stagingPath)
    await writeFile(
      join(directory, "job.json"),
      `${JSON.stringify({
        ...created,
        state: "preparing",
        preparation,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      })}\n`
    )

    await cleanupExpiredWorkspaceTransfers()

    await expect(stat(preparation.stagingPath)).rejects.toThrow()
    await expect(stat(directory)).rejects.toThrow()
  })

  it("refreshes active uploads and rechecks expiry under the upload lock", async () => {
    const created = await createWorkspaceImportJob({
      fileName: "active-upload.wtb",
      bytes: 2,
    })
    await waitForScheduledWorkspaceTransferCleanupsForTests()
    const directory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      created.id
    )
    const expiredAt = new Date(Date.now() - 1).toISOString()
    await writeFile(
      join(directory, "job.json"),
      `${JSON.stringify({ ...created, expiresAt: expiredAt })}\n`
    )

    let cleanupRead!: () => void
    let releaseCleanup!: () => void
    const cleanupHasRead = new Promise<void>((resolve) => {
      cleanupRead = resolve
    })
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    setWorkspaceTransferCleanupAfterReadHookForTests(async (job) => {
      if (job.id !== created.id) return
      cleanupRead()
      await cleanupGate
    })

    let chunkWritten!: () => void
    let releaseChunk!: () => void
    const chunkHasWritten = new Promise<void>((resolve) => {
      chunkWritten = resolve
    })
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve
    })
    setWorkspaceImportChunkBeforePublishHookForTests(async () => {
      chunkWritten()
      await chunkGate
    })

    const cleaning = cleanupExpiredWorkspaceTransfers()
    await cleanupHasRead
    const uploading = appendWorkspaceImportChunk({
      id: created.id,
      start: 0,
      total: 2,
      bytes: new Uint8Array([1]),
    })
    await chunkHasWritten
    releaseCleanup()
    releaseChunk()
    await expect(uploading).resolves.toMatchObject({
      state: "uploading",
      receivedBytes: 1,
    })
    await cleaning

    const retained = await getWorkspaceImportJob(created.id)
    expect(retained.state).toBe("uploading")
    expect(retained.receivedBytes).toBe(1)
    expect(Date.parse(retained.expiresAt)).toBeGreaterThan(
      Date.parse(expiredAt)
    )
    expect((await stat(join(directory, "workspace.wtb"))).size).toBe(1)
  })

  it("refreshes upload expiry for an idempotent chunk retry", async () => {
    const created = await createWorkspaceImportJob({
      fileName: "retry.wtb",
      bytes: 2,
    })
    await appendWorkspaceImportChunk({
      id: created.id,
      start: 0,
      total: 2,
      bytes: new Uint8Array([1]),
    })
    const directory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      created.id
    )
    const current = await getWorkspaceImportJob(created.id)
    const expiredAt = new Date(Date.now() - 1).toISOString()
    await writeFile(
      join(directory, "job.json"),
      `${JSON.stringify({ ...current, expiresAt: expiredAt })}\n`
    )

    const retried = await appendWorkspaceImportChunk({
      id: created.id,
      start: 0,
      total: 2,
      bytes: new Uint8Array([1]),
    })

    expect(retried.state).toBe("uploading")
    expect(retried.receivedBytes).toBe(1)
    expect(Date.parse(retried.expiresAt)).toBeGreaterThan(Date.parse(expiredAt))
  })

  it("drains an active maintenance sweep when its scheduler stops", async () => {
    let entered!: () => void
    let release!: () => void
    const maintenanceEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const maintenanceGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stop = startWorkspaceTransferMaintenance({
      run: async () => {
        entered()
        await maintenanceGate
      },
    })
    await maintenanceEntered

    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
  })

  it("retains incomplete rollback state and refreshes expiry on terminal failure", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
      workspaceRoot: source,
    })
    const bytes = await readFile(archive.destination)
    const created = await createWorkspaceImportJob({
      fileName: "incoming.wtb",
      bytes: bytes.byteLength,
      sha256: archive.sha256,
    })
    await appendWorkspaceImportChunk({
      id: created.id,
      start: 0,
      total: bytes.byteLength,
      bytes,
    })
    await waitForWorkspaceImportJob(created.id)
    await prepareWorkspaceImportJob(created.id)
    await waitForWorkspaceImportJob(created.id)

    let rollbackIncomplete!: () => void
    let continueRollback!: () => void
    let terminalFailure!: () => void
    let retryCleanup!: () => Promise<void>
    const incompleteCallback = new Promise<void>((resolve) => {
      rollbackIncomplete = resolve
    })
    const rollbackGate = new Promise<void>((resolve) => {
      continueRollback = resolve
    })
    const terminalCallback = new Promise<void>((resolve) => {
      terminalFailure = resolve
    })
    setWorkspaceReplacementExecutor((replacement) => {
      retryCleanup = () =>
        replacement.onFailed(new Error("rollback completed with error"))
      void (async () => {
        await replacement.onFailed(new Error("rollback restart failed"), {
          recoveryIncomplete: true,
        })
        rollbackIncomplete()
        await rollbackGate
        await replacement.onFailed(new Error("rollback completed with error"))
        terminalFailure()
      })()
    })
    const ready = await getWorkspaceImportJob(created.id)
    const directory = join(
      root,
      "app",
      "workspace-transfers",
      "jobs",
      created.id
    )
    const expiredAt = new Date(Date.now() - 1).toISOString()
    await writeFile(
      join(directory, "job.json"),
      `${JSON.stringify({ ...ready, expiresAt: expiredAt })}\n`
    )
    await replaceWorkspaceImportJob(created.id)
    await incompleteCallback

    expect(await getWorkspaceImportJob(created.id)).toMatchObject({
      state: "replacing",
      error: expect.stringContaining("rollback restart failed"),
      prepared: {
        stagingPath: expect.any(String),
        backupPath: expect.any(String),
      },
    })

    setWorkspaceImportRollbackCleanupHookForTests(async () => {
      throw new Error("injected cleanup failure")
    })
    continueRollback()
    await terminalCallback
    const failed = await getWorkspaceImportJob(created.id)
    expect(failed).toMatchObject({
      state: "failed",
      error: expect.stringContaining("rollback completed with error"),
      prepared: {
        stagingPath: expect.any(String),
        backupPath: expect.any(String),
      },
    })
    expect(Date.parse(failed.expiresAt)).toBeGreaterThan(Date.parse(expiredAt))

    setWorkspaceImportRollbackCleanupHookForTests(null)
    await retryCleanup()
    expect((await getWorkspaceImportJob(created.id)).prepared).toBeUndefined()
  })
})

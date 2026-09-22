import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
  mkdir,
  readdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  setStarterSeedScheduleHookForTests,
  setWorkspaceReplacementAfterCheckpointHookForTests,
  setWorkspaceReplacementFatalExitHookForTests,
  setWorkspaceReplacementRestartHookForTests,
  startServer,
  stopActiveServer,
} from "./index.ts"
import { getSpaceLinkGraph } from "./link-graph.ts"
import { search } from "./search-index.ts"
import {
  getWorkspaceImportJob,
  openWorkspaceExportDownload,
  waitForWorkspaceExportJob,
  waitForWorkspaceImportJob,
} from "./workspace-transfer-jobs.ts"
import {
  setWorkspaceReplacementCommitHookForTests,
  setWorkspaceReplacementRenameHookForTests,
} from "./workspace-replacement.ts"
import {
  isWorkspaceRequest,
  resetWorkspaceRequestLifecycleForTests,
  setWorkspaceRequestAdmissionHookForTests,
} from "./workspace-request-lifecycle.ts"
import {
  setWorkspaceExportBeforePublishHookForTests,
  setWorkspaceExportCaptureHookForTests,
  writeWorkspaceExportV2,
} from "./workspace-transfer-v2.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import {
  createWorkspaceClearJob,
  getWorkspaceClearJob,
  confirmWorkspaceClearJob,
  type WorkspaceClearJob,
} from "./workspace-clear-jobs.ts"
import {
  writeWorkspaceTransferJob,
  createWorkspaceExportJob,
} from "./workspace-transfer-jobs.ts"
import { seedStarterWorkspace } from "./seed.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"

const originalEnv = { ...process.env }
let root: string
let active: string
let source: string

async function seed(workspace: string, body: string): Promise<void> {
  await mkdir(join(workspace, "spaces", "notes", "docs"), { recursive: true })
  const timestamp = new Date().toISOString()
  await writeFile(
    join(workspace, "spaces", "notes", "space.json"),
    `${JSON.stringify({
      type: "worktable.space",
      version: 1,
      id: "notes",
      name: "Notes",
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: "test",
      settings: {},
    })}\n`
  )
  await writeFile(join(workspace, "spaces", "notes", "docs", "note.md"), body)
}

async function uploadAndPrepareImport(
  origin: string,
  id: string,
  packageBytes: Buffer
): Promise<void> {
  const upload = await fetch(
    `${origin}/api/workspace/transfers/imports/${id}/content`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes 0-${packageBytes.byteLength - 1}/${packageBytes.byteLength}`,
      },
      body: new Blob([new Uint8Array(packageBytes)]),
    }
  )
  expect(upload.status).toBe(200)
  expect((await upload.json()) as { state: string }).toMatchObject({
    state: "verifying",
  })
  expect((await waitForWorkspaceImportJob(id)).state).toBe("uploaded")

  const prepare = await fetch(
    `${origin}/api/workspace/transfers/imports/${id}/prepare`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }
  )
  expect(prepare.status).toBe(200)
  expect((await prepare.json()) as { state: string }).toMatchObject({
    state: "preparing",
  })
  expect((await waitForWorkspaceImportJob(id)).state).toBe("ready")
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-replacement-lifecycle-"))
  active = join(root, "active")
  source = join(root, "source")
  setAppDirOverride(join(root, "app"))
  process.env["WORKTABLE_SKIP_STARTER_SEED"] = "1"
  process.env["WORKTABLE_SKIP_LINT_SWEEP"] = "1"
  process.env["WORKTABLE_NO_UPDATE_CHECK"] = "1"

  setWorkspaceRootOverride(active)
  ensureWorkspaceManifest()
  await seed(active, "# Before\n\nBeforeOnly [old](old.md)\n")
  await writeFile(join(active, "spaces", "notes", "docs", "old.md"), "# Old\n")
  setWorkspaceRootOverride(source)
  ensureWorkspaceManifest()
  await seed(source, "# After\n\nAfterOnly [new](new.md)\n")
  await writeFile(join(source, "spaces", "notes", "docs", "new.md"), "# New\n")
  setWorkspaceRootOverride(active)
})

afterEach(async () => {
  await stopActiveServer()
  setWorkspaceReplacementCommitHookForTests(null)
  setWorkspaceReplacementRenameHookForTests(null)
  setStarterSeedScheduleHookForTests(null)
  setWorkspaceReplacementRestartHookForTests(null)
  setWorkspaceReplacementAfterCheckpointHookForTests(null)
  setWorkspaceReplacementFatalExitHookForTests(null)
  setWorkspaceExportBeforePublishHookForTests(null)
  setWorkspaceExportCaptureHookForTests(null)
  setWorkspaceRequestAdmissionHookForTests(null)
  resetWorkspaceRequestLifecycleForTests()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  process.env = { ...originalEnv }
  await rm(root, { recursive: true, force: true })
})

describe("live workspace replacement", () => {
  it("holds HTTP writes only while capturing an immutable export", async () => {
    const server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`
    let captureEntered!: () => void
    let releaseCapture!: () => void
    const capturing = new Promise<void>((resolve) => {
      captureEntered = resolve
    })
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve
    })
    let blocked = false
    setWorkspaceExportCaptureHookForTests(async (entry) => {
      if (!blocked && entry.path.endsWith("note.md")) {
        blocked = true
        captureEntered()
        await captureGate
      }
    })
    let packagingEntered!: () => void
    let releasePackaging!: () => void
    const packaging = new Promise<void>((resolve) => {
      packagingEntered = resolve
    })
    const packagingGate = new Promise<void>((resolve) => {
      releasePackaging = resolve
    })
    setWorkspaceExportBeforePublishHookForTests(async () => {
      packagingEntered()
      await packagingGate
    })

    const createdResponse = await fetch(
      `${origin}/api/workspace/transfers/exports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: { mode: "none" } }),
      }
    )
    expect(createdResponse.status).toBe(202)
    const created = (await createdResponse.json()) as { id: string }
    await capturing

    const blockedWrite = await fetch(
      `${origin}/api/spaces/notes/docs/during-export`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: [] }),
      }
    )
    expect(blockedWrite.status).toBe(503)
    releaseCapture()
    await packaging

    const resumedWrite = await fetch(
      `${origin}/api/spaces/notes/docs/after-capture`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: [] }),
      }
    )
    expect(resumedWrite.status).toBe(200)
    releasePackaging()

    const finished = await waitForWorkspaceExportJob(created.id)
    expect(finished.state).toBe("complete")
    expect(
      finished.manifest?.integrity.files.some(
        (file) => file.path === "spaces/notes/docs/after-capture.json"
      )
    ).toBe(false)
    const download = await openWorkspaceExportDownload(created.id)
    const downloaded = Buffer.from(
      await new Response(download.body).arrayBuffer()
    )
    expect(downloaded.subarray(0, 2)).toEqual(Buffer.from("PK"))
    await expect(
      readFile(join(active, "spaces", "notes", "docs", "during-export.json"))
    ).rejects.toThrow()
  })

  it("drains, swaps, restarts on the same port, and remains queryable", async () => {
    const originalManifest = await readFile(
      join(active, "worktable.workspace.json")
    )
    const originalCollaborationEpoch = await getWorkspaceCollaborationEpoch()
    const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
      workspaceRoot: source,
    })
    expect(await search("BeforeOnly")).toHaveLength(1)
    expect(
      (await getSpaceLinkGraph("notes")).outbound.get("note")?.[0]?.resolvedPath
    ).toBe("old")
    const packageBytes = await readFile(archive.destination)
    const server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`

    const createdResponse = await fetch(
      `${origin}/api/workspace/transfers/imports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "incoming.wtb",
          bytes: packageBytes.byteLength,
          sha256: archive.sha256,
        }),
      }
    )
    const created = (await createdResponse.json()) as { id: string }
    expect(createdResponse.status).toBe(201)

    await uploadAndPrepareImport(origin, created.id, packageBytes)
    const replacing = await fetch(
      `${origin}/api/workspace/transfers/imports/${created.id}/replace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "replace" }),
      }
    )
    expect(replacing.status).toBe(202)

    const deadline = Date.now() + 10_000
    let state = "replacing"
    while (Date.now() < deadline) {
      const job = await getWorkspaceImportJob(created.id)
      state = job.state
      if ((state === "complete" || state === "failed") && !job.prepared) break
      // test-policy: external-readiness-backoff
      await Bun.sleep(20)
    }
    expect(state).toBe("complete")
    const replacementCollaborationEpoch = await getWorkspaceCollaborationEpoch()
    expect(replacementCollaborationEpoch).not.toBe(originalCollaborationEpoch)

    const health = await fetch(`${origin}/health`)
    expect(health.status).toBe(200)
    const currentDoc = (await (
      await fetch(`${origin}/api/spaces/notes/docs/note`)
    ).json()) as { collaborationEpoch: string }
    expect(currentDoc.collaborationEpoch).toBe(replacementCollaborationEpoch)
    expect(await readFile(join(active, "worktable.workspace.json"))).toEqual(
      originalManifest
    )
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toBe("# After\n\nAfterOnly [new](new.md)\n")
    expect(await search("AfterOnly")).toHaveLength(1)
    expect(await search("BeforeOnly")).toHaveLength(0)
    expect(
      (await getSpaceLinkGraph("notes")).outbound.get("note")?.[0]?.resolvedPath
    ).toBe("new")
  }, 15_000)

  it("does not seed an intentionally empty imported workspace during restart", async () => {
    const emptySource = join(root, "empty-source")
    setWorkspaceRootOverride(emptySource)
    ensureWorkspaceManifest()
    const archive = await writeWorkspaceExportV2(join(root, "empty-import"), {
      workspaceRoot: emptySource,
    })
    const packageBytes = await readFile(archive.destination)
    setWorkspaceRootOverride(active)
    delete process.env["WORKTABLE_SKIP_STARTER_SEED"]
    let seedSchedules = 0
    let seedScheduled!: () => void
    let releaseSeed!: () => void
    const seedStarted = new Promise<void>((resolve) => {
      seedScheduled = resolve
    })
    const seedGate = new Promise<void>((resolve) => {
      releaseSeed = resolve
    })
    setStarterSeedScheduleHookForTests(async () => {
      seedSchedules += 1
      seedScheduled()
      await seedGate
    })

    const server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`
    await seedStarted
    expect(seedSchedules).toBe(1)
    const createdResponse = await fetch(
      `${origin}/api/workspace/transfers/imports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "empty.wtb",
          bytes: packageBytes.byteLength,
          sha256: archive.sha256,
        }),
      }
    )
    const created = (await createdResponse.json()) as { id: string }
    await uploadAndPrepareImport(origin, created.id, packageBytes)
    const replacing = await fetch(
      `${origin}/api/workspace/transfers/imports/${created.id}/replace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "replace" }),
      }
    )
    expect(replacing.status).toBe(202)

    const stopDeadline = Date.now() + 10_000
    let listenerStopped = false
    while (Date.now() < stopDeadline) {
      try {
        await fetch(`${origin}/health`)
      } catch {
        listenerStopped = true
        break
      }
      // test-policy: external-readiness-backoff
      await Bun.sleep(20)
    }
    expect(listenerStopped).toBe(true)
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toContain("BeforeOnly")
    expect((await getWorkspaceImportJob(created.id)).state).toBe("replacing")

    releaseSeed()
    const deadline = Date.now() + 10_000
    let state = "replacing"
    while (Date.now() < deadline) {
      const job = await getWorkspaceImportJob(created.id)
      state = job.state
      if ((state === "complete" || state === "failed") && !job.prepared) break
      // test-policy: external-readiness-backoff
      await Bun.sleep(20)
    }
    expect(state).toBe("complete")
    expect(seedSchedules).toBe(1)
    const body = (await (
      await fetch(`${origin}/api/spaces?includeArchived=true`)
    ).json()) as { spaces: unknown[] }
    expect(body.spaces).toEqual([])
  }, 15_000)

  it("keeps writes closed through rollback and reopens after status failure", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
      workspaceRoot: source,
    })
    const packageBytes = await readFile(archive.destination)
    const server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`
    const createdResponse = await fetch(
      `${origin}/api/workspace/transfers/imports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "incoming.wtb",
          bytes: packageBytes.byteLength,
          sha256: archive.sha256,
        }),
      }
    )
    const created = (await createdResponse.json()) as { id: string }
    await uploadAndPrepareImport(origin, created.id, packageBytes)

    let entered!: () => void
    let release!: () => void
    const committing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setWorkspaceReplacementCommitHookForTests(async () => {
      entered()
      await gate
      setWorkspaceReplacementCommitHookForTests(null)
      throw new Error("injected commit failure")
    })
    let failureLogged!: () => void
    const logged = new Promise<void>((resolve) => {
      failureLogged = resolve
    })
    const error = spyOn(console, "error").mockImplementation((message) => {
      if (
        message ===
        "[Worktable] workspace replacement rolled back, but failure status finalization failed:"
      ) {
        failureLogged()
      }
    })

    try {
      const replacing = await fetch(
        `${origin}/api/workspace/transfers/imports/${created.id}/replace`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "replace" }),
        }
      )
      expect(replacing.status).toBe(202)
      await committing
      expect((await fetch(`${origin}/health`)).status).toBe(200)
      const denied = await fetch(
        `${origin}/api/spaces/notes/docs/uncommitted`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: [] }),
        }
      )
      expect(denied.status).toBe(503)
      await rm(join(root, "app", "workspace-transfers", "jobs", created.id), {
        recursive: true,
        force: true,
      })
      release()
      await withDeadline(
        logged,
        10_000,
        "replacement status failure was not reported"
      )

      expect((await fetch(`${origin}/health`)).status).toBe(200)
      const write = await fetch(
        `${origin}/api/spaces/notes/docs/after-rollback`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: [] }),
        }
      )
      expect(write.status).toBe(200)
      expect(
        await readFile(
          join(active, "spaces", "notes", "docs", "note.md"),
          "utf8"
        )
      ).toContain("BeforeOnly")
      await expect(
        readFile(join(active, "spaces", "notes", "docs", "uncommitted.json"))
      ).rejects.toThrow()
    } finally {
      error.mockRestore()
    }
  }, 15_000)

  it("recovers the backup before restarting after both immediate swap renames fail", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
      workspaceRoot: source,
    })
    const packageBytes = await readFile(archive.destination)
    const server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`
    const createdResponse = await fetch(
      `${origin}/api/workspace/transfers/imports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "incoming.wtb",
          bytes: packageBytes.byteLength,
          sha256: archive.sha256,
        }),
      }
    )
    const created = (await createdResponse.json()) as { id: string }
    await uploadAndPrepareImport(origin, created.id, packageBytes)

    let renameCall = 0
    setWorkspaceReplacementRenameHookForTests(
      async (sourcePath, destinationPath) => {
        renameCall += 1
        if (renameCall === 2 || renameCall === 3) {
          throw new Error(`injected swap rename failure ${renameCall}`)
        }
        await rename(sourcePath, destinationPath)
      }
    )

    const replacing = await fetch(
      `${origin}/api/workspace/transfers/imports/${created.id}/replace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "replace" }),
      }
    )
    expect(replacing.status).toBe(202)

    const deadline = Date.now() + 10_000
    let state = "replacing"
    while (Date.now() < deadline) {
      const job = await getWorkspaceImportJob(created.id)
      state = job.state
      if (state === "failed" && !job.prepared) break
      // test-policy: external-readiness-backoff
      await Bun.sleep(20)
    }
    expect(state).toBe("failed")
    expect(renameCall).toBe(3)
    expect((await fetch(`${origin}/health`)).status).toBe(200)
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toContain("BeforeOnly")
  }, 15_000)

  it("terminates for supervisor recovery when both replacement restarts fail", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
      workspaceRoot: source,
    })
    const packageBytes = await readFile(archive.destination)
    const server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`
    const createdResponse = await fetch(
      `${origin}/api/workspace/transfers/imports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "incoming.wtb",
          bytes: packageBytes.byteLength,
          sha256: archive.sha256,
        }),
      }
    )
    const created = (await createdResponse.json()) as { id: string }
    await uploadAndPrepareImport(origin, created.id, packageBytes)

    const restartPhases: Array<"replacement" | "rollback"> = []
    setWorkspaceReplacementRestartHookForTests((phase) => {
      restartPhases.push(phase)
      throw new Error(`injected ${phase} restart failure`)
    })
    let reportFatal!: (error: unknown) => void
    const fatal = new Promise<unknown>((resolve) => {
      reportFatal = resolve
    })
    setWorkspaceReplacementFatalExitHookForTests(reportFatal)

    const replacing = await fetch(
      `${origin}/api/workspace/transfers/imports/${created.id}/replace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "replace" }),
      }
    )
    expect(replacing.status).toBe(202)

    const fatalError = await withDeadline(
      fatal,
      10_000,
      "replacement fatal-exit hook was not called"
    )
    expect(restartPhases).toEqual(["replacement", "rollback"])
    expect(fatalError).toBeInstanceOf(AggregateError)
    expect((fatalError as Error).message).toContain(
      "workspace replacement and rollback restart failed"
    )
    expect(await getWorkspaceImportJob(created.id)).toMatchObject({
      state: "replacing",
      error: expect.stringContaining(
        "workspace replacement and rollback restart failed"
      ),
      prepared: expect.any(Object),
    })
  }, 15_000)

  it("preserves direct filesystem edits made after replacement shutdown", async () => {
    const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
      workspaceRoot: source,
    })
    const packageBytes = await readFile(archive.destination)
    const server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`
    const createdResponse = await fetch(
      `${origin}/api/workspace/transfers/imports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "incoming.wtb",
          bytes: packageBytes.byteLength,
          sha256: archive.sha256,
        }),
      }
    )
    const created = (await createdResponse.json()) as { id: string }
    await uploadAndPrepareImport(origin, created.id, packageBytes)
    const directEdit = join(
      active,
      "spaces",
      "notes",
      "docs",
      "external-after-shutdown.md"
    )
    setWorkspaceReplacementAfterCheckpointHookForTests(async () => {
      await writeFile(directEdit, "must survive\n")
    })

    const replacing = await fetch(
      `${origin}/api/workspace/transfers/imports/${created.id}/replace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "replace" }),
      }
    )
    expect(replacing.status).toBe(202)

    const deadline = Date.now() + 10_000
    let state = "replacing"
    while (Date.now() < deadline) {
      const job = await getWorkspaceImportJob(created.id)
      state = job.state
      if (state === "failed" && !job.prepared) break
      // test-policy: external-readiness-backoff
      await Bun.sleep(20)
    }
    expect(state).toBe("failed")
    expect((await fetch(`${origin}/health`)).status).toBe(200)
    expect(await readFile(directEdit, "utf8")).toBe("must survive\n")
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toContain("BeforeOnly")
  }, 15_000)

  it("waits for an overlapping real HTTP write before swapping roots", async () => {
    expect(isWorkspaceRequest("POST", "/api/shares")).toBe(true)
    expect(isWorkspaceRequest("POST", "/api/linked")).toBe(true)

    const archive = await writeWorkspaceExportV2(join(root, "incoming"), {
      workspaceRoot: source,
    })
    const packageBytes = await readFile(archive.destination)
    const server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`

    const createdResponse = await fetch(
      `${origin}/api/workspace/transfers/imports`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "incoming.wtb",
          bytes: packageBytes.byteLength,
          sha256: archive.sha256,
        }),
      }
    )
    const created = (await createdResponse.json()) as { id: string }
    await uploadAndPrepareImport(origin, created.id, packageBytes)

    let entered!: () => void
    let release!: () => void
    const admitted = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setWorkspaceRequestAdmissionHookForTests(async ({ pathname }) => {
      if (pathname.endsWith("/docs/late")) {
        entered()
        await gate
      }
    })
    const overlappingWrite = fetch(`${origin}/api/spaces/notes/docs/late`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: [] }),
    })
    await admitted

    const replacing = await fetch(
      `${origin}/api/workspace/transfers/imports/${created.id}/replace`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "replace" }),
      }
    )
    expect(replacing.status).toBe(202)
    release()
    const [writeOutcome] = await Promise.allSettled([overlappingWrite])
    if (writeOutcome?.status === "fulfilled") {
      expect(writeOutcome.value.status).toBe(200)
    }

    const deadline = Date.now() + 10_000
    let state = "replacing"
    while (Date.now() < deadline) {
      const job = await getWorkspaceImportJob(created.id)
      state = job.state
      if ((state === "complete" || state === "failed") && !job.prepared) break
      // test-policy: external-readiness-backoff
      await Bun.sleep(20)
    }
    expect(state).toBe("complete")
    await expect(
      readFile(join(active, "spaces", "notes", "docs", "late.json"))
    ).rejects.toThrow()
    expect(
      await readFile(join(active, "spaces", "notes", "docs", "note.md"), "utf8")
    ).toBe("# After\n\nAfterOnly [new](new.md)\n")
  }, 15_000)
})

async function waitForClear(
  id: string,
  terminal = false
): Promise<WorkspaceClearJob> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const job = await getWorkspaceClearJob(id)
    if (
      terminal
        ? (job.state === "complete" || job.state === "failed") && !job.prepared
        : job.state !== "preparing"
    )
      return job
    // test-policy: external-readiness-backoff
    await Bun.sleep(20)
  }
  throw new Error("Clear job did not settle")
}

describe("live workspace clear", () => {
  it("expires a clear review without changing the workspace", async () => {
    startServer(0, "127.0.0.1")
    const reviewed = await waitForClear((await createWorkspaceClearJob()).id)
    await writeWorkspaceTransferJob({
      ...reviewed,
      expiresAt: new Date(0).toISOString(),
    })
    await expect(
      confirmWorkspaceClearJob(
        reviewed.id,
        reviewed.confirmationText,
        reviewed.reviewRevision
      )
    ).rejects.toThrow("review expired")
    expect(
      await readFile(join(active, "spaces/notes/docs/old.md"), "utf8")
    ).toBe("# Old\n")
  })

  it("reviews, confirms, clears legacy names, revokes exports, fences stale writes, and stays empty on restart", async () => {
    const server = startServer(0, "127.0.0.1")
    const origin = `http://127.0.0.1:${server.port}`
    const original = ensureWorkspaceManifest()
    const oldEpoch = await getWorkspaceCollaborationEpoch()
    const exported = await waitForWorkspaceExportJob(
      (await createWorkspaceExportJob({ mode: "none" })).id
    )
    expect(exported.state).toBe("complete")
    const bad = join(active, "versions/test-space/docs/legacy-note ")
    await mkdir(bad, { recursive: true })
    await writeFile(join(bad, "snapshot.json"), "old history")
    const response = await fetch(`${origin}/api/workspace/clear`, {
      method: "POST",
    })
    expect(response.status).toBe(202)
    const publicJob = (await response.json()) as WorkspaceClearJob
    expect(publicJob.preparation).toBeUndefined()
    const reviewed = await waitForClear(publicJob.id)
    expect(reviewed.state).toBe("ready")
    await expect(
      confirmWorkspaceClearJob(reviewed.id, "wrong", reviewed.reviewRevision)
    ).rejects.toThrow("exact confirmation")
    await expect(
      confirmWorkspaceClearJob(
        reviewed.id,
        reviewed.confirmationText,
        "old revision"
      )
    ).rejects.toThrow("exact confirmation")
    expect(await readFile(join(bad, "snapshot.json"), "utf8")).toBe(
      "old history"
    )
    let downloadDuringReplacement: number | undefined
    setWorkspaceReplacementCommitHookForTests(async () => {
      const download = await fetch(
        `${origin}/api/workspace/transfers/exports/${exported.id}/download`
      )
      downloadDuringReplacement = download.status
      await download.body?.cancel()
    })
    expect(
      (
        await confirmWorkspaceClearJob(
          reviewed.id,
          reviewed.confirmationText,
          reviewed.reviewRevision
        )
      ).state
    ).toBe("replacing")
    expect((await waitForClear(reviewed.id, true)).state).toBe("complete")
    expect(downloadDuringReplacement).toBe(503)
    expect(ensureWorkspaceManifest()).toMatchObject({
      id: original.id,
      name: original.name,
      starterSeed: { version: 1, status: "suppressed" },
    })
    for (const name of ["spaces", "threads", "versions"])
      expect(await readdir(join(active, name))).toEqual([])
    expect(await getWorkspaceCollaborationEpoch()).not.toBe(oldEpoch)
    await expect(openWorkspaceExportDownload(exported.id)).rejects.toThrow()
    const stale = await fetch(`${origin}/api/spaces`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Worktable-Content-Epoch": oldEpoch,
      },
      body: JSON.stringify({ name: "Stale content" }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: "WORKSPACE_CHANGED" })
    await writeFile(join(active, "after-clear.txt"), "new data")
    expect(
      (
        await confirmWorkspaceClearJob(
          reviewed.id,
          reviewed.confirmationText,
          reviewed.reviewRevision
        )
      ).state
    ).toBe("complete")
    expect(await readFile(join(active, "after-clear.txt"), "utf8")).toBe(
      "new data"
    )
    await stopActiveServer()
    delete process.env["WORKTABLE_SKIP_STARTER_SEED"]
    expect(await seedStarterWorkspace()).toBe(false)
    const restarted = startServer(0, "127.0.0.1")
    expect(
      (await fetch(`http://127.0.0.1:${restarted.port}/api/spaces`)).status
    ).toBe(200)
    expect(await readdir(join(active, "spaces"))).toEqual([])
  })

  it("rejects a review when content changed, preserving the newer content", async () => {
    startServer(0, "127.0.0.1")
    const reviewed = await waitForClear((await createWorkspaceClearJob()).id)
    await writeFile(
      join(active, "spaces/notes/docs/new-after-review.md"),
      "preserve this"
    )
    await confirmWorkspaceClearJob(
      reviewed.id,
      reviewed.confirmationText,
      reviewed.reviewRevision
    )
    const result = await waitForClear(reviewed.id, true)
    expect(result.state).toBe("failed")
    expect(result.error).toContain("changed")
    expect(
      await readFile(
        join(active, "spaces/notes/docs/new-after-review.md"),
        "utf8"
      )
    ).toBe("preserve this")
  })

  it("rolls back a failed clear restart without losing content or suppressing starter state", async () => {
    startServer(0, "127.0.0.1")
    const original = ensureWorkspaceManifest()
    const reviewed = await waitForClear((await createWorkspaceClearJob()).id)
    setWorkspaceReplacementRestartHookForTests((stage) => {
      if (stage === "replacement")
        throw new Error("injected clear restart failure")
    })
    await confirmWorkspaceClearJob(
      reviewed.id,
      reviewed.confirmationText,
      reviewed.reviewRevision
    )
    expect((await waitForClear(reviewed.id, true)).state).toBe("failed")
    expect(ensureWorkspaceManifest()).toEqual(original)
    expect(
      await readFile(join(active, "spaces/notes/docs/old.md"), "utf8")
    ).toBe("# Old\n")
  })
})

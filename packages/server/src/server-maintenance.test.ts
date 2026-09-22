import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runServerMaintenance } from "./server-maintenance.ts"
import { setAppDirOverride } from "./app-storage.ts"
import {
  importWorkspaceExportV2,
  inspectWorkspaceExportV2,
} from "./workspace-transfer-v2.ts"
import { setWorkspaceExportFlush } from "./workspace-export-coordinator.ts"
import { startServer, stopActiveServer } from "./index.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { writeDoc } from "./store.ts"
import { inspectWorkspaceSnapshot } from "./workspace-snapshot.ts"
import { restoreLiveWorkspaceSnapshot } from "./workspace-snapshot-restore.ts"
import { operatorSnapshotDirectory } from "./operator-snapshot.ts"

let root: string
let workspace: string
const originalEnv = { ...process.env }

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "worktable-maintenance-")))
  workspace = join(root, "workspace")
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(join(root, "app"))
  process.env["WORKTABLE_SKIP_STARTER_SEED"] = "1"
  process.env["WORKTABLE_SKIP_LINT_SWEEP"] = "1"
  process.env["WORKTABLE_SKIP_RETENTION_SWEEP"] = "1"
  process.env["WORKTABLE_SKIP_RECORD_RECONCILE_SWEEP"] = "1"
  ensureWorkspaceManifest()
  await mkdir(join(workspace, "spaces", "notes", "docs"), {
    recursive: true,
  })
  await writeFile(
    join(workspace, "spaces", "notes", "docs", "hello.md"),
    "# Hello\n"
  )
})

afterEach(async () => {
  await stopActiveServer()
  setWorkspaceExportFlush(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
  process.env = { ...originalEnv }
})

describe("server maintenance entrypoint", () => {
  it("captures through the live capability and rejects restoring over edits made after the safety capture", async () => {
    const server = startServer(0, "127.0.0.1")
    process.env["PORT"] = String(server.port)
    const output: string[] = []
    await runServerMaintenance(
      ["workspace-snapshot", "live-capture-test"],
      (value) => output.push(value)
    )
    const saved = JSON.parse(output[0]!)
    const capture = join(
      await operatorSnapshotDirectory("live-capture-test"),
      "capture"
    )
    await expect(inspectWorkspaceSnapshot(capture)).resolves.toMatchObject({
      sourceCheckpoint: saved.sourceCheckpoint,
    })
    const prepare = async (id: string) => {
      const dir = await operatorSnapshotDirectory(id)
      await cp(capture, join(dir, "download"), { recursive: true })
      return join(
        root,
        "app",
        "workspace-transfers",
        "jobs",
        `wss_${id}`,
        "job.json"
      )
    }
    const changed = await writeDoc("notes", "hello", "# New edit\n", {
      updatedBy: "test",
      source: "test",
    })
    expect(changed.ok).toBe(true)
    const failedJob = await prepare("restore-stale-test")
    await restoreLiveWorkspaceSnapshot({
      operationId: "restore-stale-test",
      workspaceId: saved.workspaceId,
      sourceCheckpoint: saved.sourceCheckpoint,
      safetyCheckpoint: saved.sourceCheckpoint,
    })
    const waitJob = async (path: string) => {
      for (let i = 0; i < 200; i++) {
        const job = JSON.parse(await readFile(path, "utf8"))
        if (job.state !== "replacing") return job
        // test-policy: external-readiness-backoff (durable restore/admission state)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("restore did not finish")
    }
    expect((await waitJob(failedJob)).state).toBe("failed")
    expect(
      await readFile(
        join(workspace, "spaces", "notes", "docs", "hello.md"),
        "utf8"
      )
    ).toContain("New edit")
    const latest: string[] = []
    for (let i = 0; i < 200 && latest.length === 0; i++) {
      try {
        await runServerMaintenance(
          ["workspace-snapshot", "live-safety-test"],
          (value) => latest.push(value)
        )
      } catch {
        // The durable outcome can precede recovery cleanup and admission.
        // test-policy: external-readiness-backoff (durable restore/admission state)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    expect(latest).toHaveLength(1)
    const completedJob = await prepare("restore-current-test")
    await restoreLiveWorkspaceSnapshot({
      operationId: "restore-current-test",
      workspaceId: saved.workspaceId,
      sourceCheckpoint: saved.sourceCheckpoint,
      safetyCheckpoint: JSON.parse(latest[0]!).sourceCheckpoint,
    })
    expect((await waitJob(completedJob)).state).toBe("complete")
    const status: string[] = []
    const statusArgs = [
      "workspace-snapshot-restore-status",
      "restore-current-test",
      saved.workspaceId,
      saved.sourceCheckpoint,
      JSON.parse(latest[0]!).sourceCheckpoint,
    ]
    await runServerMaintenance(statusArgs, (value) => status.push(value))
    expect(JSON.parse(status[0]!)).toMatchObject({
      operationId: "restore-current-test",
      state: "complete",
    })
    await expect(
      runServerMaintenance([...statusArgs.slice(0, -1), "a".repeat(64)])
    ).rejects.toThrow("identity mismatch")

    expect(
      await readFile(
        join(workspace, "spaces", "notes", "docs", "hello.md"),
        "utf8"
      )
    ).toContain("Hello")
  })
  it("routes the canonical export through the live server flush barrier", async () => {
    const destination = join(
      root,
      "app",
      "operator-exports",
      "operator-export.wtb"
    )
    const output: string[] = []
    process.env["WORKTABLE_HOSTED"] = "1"
    delete process.env["WORKTABLE_GATEWAY_SECRET"]
    const server = startServer(0, "127.0.0.1")
    process.env["PORT"] = String(server.port)
    setWorkspaceExportFlush(async () => {
      const written = await writeDoc(
        "notes",
        "hello",
        "# Flushed live edit\n",
        { updatedBy: "test", source: "test" }
      )
      if (!written.ok) throw new Error(written.error)
    })

    const unauthorized = await fetch(
      `http://127.0.0.1:${server.port}/internal/operator/workspace-export`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination }),
      }
    )
    expect(unauthorized.status).toBe(403)

    await expect(
      runServerMaintenance(
        ["/app/bin/worktable-server", "workspace-export", destination],
        (value) => output.push(value)
      )
    ).resolves.toBe(true)

    const result = JSON.parse(output[0]!)
    const bundle = await inspectWorkspaceExportV2(destination)
    const restored = join(root, "restored")
    await importWorkspaceExportV2(destination, restored)
    expect(result).toMatchObject({
      command: "workspace-export",
      destination,
      exportId: bundle.manifest.exportId,
      sourceWorkspaceId: bundle.manifest.source.workspaceId,
      sourceCheckpoint: bundle.manifest.integrity.sourceCheckpoint,
    })
    expect(bundle.manifest.integrity.files.map((file) => file.path)).toContain(
      "spaces/notes/docs/hello.md"
    )
    expect(
      await Bun.file(
        join(restored, "spaces", "notes", "docs", "hello.md")
      ).text()
    ).toBe("# Flushed live edit\n")
  })

  it("leaves normal server startup alone and rejects malformed commands", async () => {
    await expect(
      runServerMaintenance(["/app/bin/worktable-server"])
    ).resolves.toBe(false)
    await expect(runServerMaintenance(["workspace-export"])).rejects.toThrow(
      "workspace-export <destination>"
    )
  })

  it("keeps the real maintenance stdout machine-readable with static assets", async () => {
    const destination = join(
      root,
      "app",
      "operator-exports",
      "process-export.wtb"
    )
    const staticDir = join(root, "web")
    const appDir = join(root, "app")
    await mkdir(staticDir)
    await writeFile(join(staticDir, "_shell.html"), "<!doctype html>")
    const server = startServer(0, "127.0.0.1")

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "index.ts"),
        "workspace-export",
        destination,
      ],
      {
        env: {
          ...process.env,
          WORKTABLE_WORKSPACE: workspace,
          WORKTABLE_APP_DIR: appDir,
          WORKTABLE_STATIC_DIR: staticDir,
          PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ])

    expect(exitCode).toBe(0)
    expect(stdout.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(stdout)).toMatchObject({
      command: "workspace-export",
      destination,
    })
  })
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
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

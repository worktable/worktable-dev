import type {
  BackupWorkerInput,
  BackupWorkerResult,
} from "@worktable/hosted-contract"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { readBoundedRegularFile } from "./bounded-file.ts"
import { removeWorkspaceTree } from "./workspace-tree-cleanup.ts"
interface WorkspaceSnapshotManifest {
  snapshotId: string
  workspaceId: string
  sourceCheckpoint: string
  contentCheckpoint: string
  workspaceStorageVersion: 1 | 2
  capturedAt: string
  files: Array<{ size: number }>
}

export interface WorkerTools {
  restic: string
  server: string[]
  appDirectory: string
}
const DIGEST = /^[a-f0-9]{64}$/
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

/** Subprocess output is bounded and never included in control-plane errors. */
export async function runBackupCommand(
  command: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal,
  limit = 40 * 1024 * 1024
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    let count = 0
    let exceeded = false
    const kill = () => child.kill("SIGKILL")
    signal.addEventListener("abort", kill, { once: true })
    if (signal.aborted) kill()
    child.stdout.on("data", (chunk: Buffer) => {
      count += chunk.length
      if (count > limit) {
        exceeded = true
        kill()
      } else output.push(chunk)
    })
    // Never propagate restic stderr (paths and backend credentials can appear).
    child.stderr.resume()
    child.on("error", (error) => {
      signal.removeEventListener("abort", kill)
      reject(error)
    })
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill)
      if (signal.aborted || exceeded)
        reject(
          new Error(
            signal.aborted
              ? "backup deadline exceeded"
              : "backup command output limit exceeded"
          )
        )
      else
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(output).toString("utf8"),
        })
    })
  })
}

export async function publishWorkerJson(
  directory: string,
  name: string,
  value: unknown
): Promise<void> {
  const temporary = join(directory, `${name}.${process.pid}.partial`)
  const handle = await open(temporary, "w", 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, join(directory, name))
  const parent = await open(directory, "r")
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}

function validateInput(input: BackupWorkerInput) {
  if (
    input.captureBudgetMs !== undefined &&
    (!Number.isSafeInteger(input.captureBudgetMs) ||
      input.captureBudgetMs < 1 ||
      input.captureBudgetMs > 30000)
  )
    throw new Error("invalid snapshot capture budget")
  if (
    input.version !== 1 ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(input.jobId) ||
    !/^ws_[A-Za-z0-9_-]+$/.test(input.workspaceId) ||
    !["backup", "download"].includes(input.kind) ||
    !input.repositoryPassword ||
    !input.repository ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= Date.now()
  )
    throw new Error("invalid or expired backup job")
  if (input.repositoryId && !DIGEST.test(input.repositoryId))
    throw new Error("invalid repository id")
  if (
    input.kind === "download" &&
    (!DIGEST.test(input.snapshotId ?? "") ||
      !DIGEST.test(input.sourceCheckpoint ?? "") ||
      !input.repositoryId)
  )
    throw new Error("download requires a catalogued snapshot")
}

/** Same implementation is compiled for the Sprite and exercised with real restic. */
export async function runBackupWorker(
  input: BackupWorkerInput,
  tools: WorkerTools
): Promise<BackupWorkerResult> {
  validateInput(input)
  const root = join(resolve(tools.appDirectory), "operator-snapshots")
  const directory = join(root, input.jobId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const path of [root, directory]) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("invalid backup job directory")
  }
  const signal = AbortSignal.timeout(
    Math.min(input.expiresAt - Date.now(), 30 * 60_000)
  )
  // No ambient cloud credentials, password-command, or restic repository env.
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: process.env["HOME"],
    WORKTABLE_APP_DIR: tools.appDirectory,
    WORKTABLE_WORKSPACE: process.env["WORKTABLE_WORKSPACE"],
    PORT: process.env["PORT"],
  }
  const resticEnv = {
    ...baseEnv,
    RESTIC_REPOSITORY: input.repository,
    RESTIC_PASSWORD: input.repositoryPassword,
    AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true",
    ...(input.credentials
      ? {
          AWS_ACCESS_KEY_ID: input.credentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: input.credentials.secretAccessKey,
          AWS_SESSION_TOKEN: input.credentials.sessionToken,
        }
      : {}),
  }
  const restic = async (args: string[], cwd = directory) =>
    runBackupCommand(
      [
        tools.restic,
        "--no-cache",
        "--json",
        "--stuck-request-timeout",
        "30s",
        ...args,
      ],
      resticEnv,
      cwd,
      signal
    )
  const core = async (args: string[]) => {
    const result = await runBackupCommand(
      [...tools.server, ...args],
      baseEnv,
      directory,
      signal
    )
    if (result.code !== 0)
      throw new Error("workspace snapshot operation failed")
    return result.stdout
  }
  return withCrossProcessLock(
    join(root, ".worker.lock"),
    { label: "Cloud backup worker", staleMs: 0, timeoutMs: 1000 },
    async () => {
      let repository = await restic(["cat", "config"])
      if (
        repository.code === 10 &&
        input.kind === "backup" &&
        !input.repositoryId
      ) {
        if ((await restic(["init", "--repository-version", "2"])).code !== 0)
          throw new Error("backup repository initialization failed")
        repository = await restic(["cat", "config"])
      }
      if (repository.code !== 0)
        throw new Error("backup repository is unavailable")
      const repositoryId: unknown = JSON.parse(repository.stdout).id
      if (
        typeof repositoryId !== "string" ||
        !DIGEST.test(repositoryId) ||
        (input.repositoryId && repositoryId !== input.repositoryId)
      )
        throw new Error("backup repository identity changed")
      let manifest: WorkspaceSnapshotManifest
      let snapshotId: string
      if (input.kind === "backup") {
        await publishWorkerJson(directory, "progress.json", {
          phase: "capturing",
          at: Date.now(),
        })
        await core([
          "workspace-snapshot",
          input.jobId,
          ...(input.captureBudgetMs === undefined
            ? []
            : [String(input.captureBudgetMs)]),
        ])
        const capture = join(directory, "capture")
        try {
          const bytes = await readBoundedRegularFile(
            join(capture, "snapshot.json"),
            32 * 1024 * 1024
          )
          manifest = JSON.parse(
            await core([
              "workspace-snapshot-inspect",
              capture,
              input.workspaceId,
            ])
          )
          await publishWorkerJson(directory, "progress.json", {
            phase: "uploading",
            at: Date.now(),
          })
          const backup = await restic(
            [
              "backup",
              "--host",
              input.workspaceId,
              "--group-by",
              "host",
              "--tag",
              `worktable-job:${input.jobId}`,
              "--quiet",
              "--",
              "workspace",
              "snapshot.json",
            ],
            capture
          )
          // Code 3 can leave a snapshot behind. It must never be advertised.
          if (backup.code !== 0)
            throw new Error(`backup upload failed (exit ${backup.code})`)
          const summary = backup.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .find((row) => row.message_type === "summary")
          if (!summary || !/^[a-f0-9]{8,64}$/.test(summary.snapshot_id ?? ""))
            throw new Error("backup returned no snapshot")
          const metadata = await restic([
            "cat",
            "snapshot",
            summary.snapshot_id,
          ])
          if (metadata.code !== 0)
            throw new Error("backup snapshot verification failed")
          const saved = JSON.parse(metadata.stdout)
          if (
            saved.hostname !== input.workspaceId ||
            !saved.tags?.includes(`worktable-job:${input.jobId}`)
          )
            throw new Error("backup snapshot identity verification failed")
          // Expand any abbreviated CLI id through the exact snapshot listing.
          const listing = await restic(["snapshots", summary.snapshot_id])
          if (listing.code !== 0)
            throw new Error("backup snapshot lookup failed")
          const matches = JSON.parse(listing.stdout)
          if (
            !Array.isArray(matches) ||
            matches.length !== 1 ||
            !DIGEST.test(matches[0]?.id)
          )
            throw new Error("backup snapshot lookup is ambiguous")
          snapshotId = matches[0].id
          const remote = await restic(["dump", snapshotId, "/snapshot.json"])
          if (remote.code !== 0 || sha(remote.stdout) !== sha(bytes))
            throw new Error("backup manifest read-back failed")
        } finally {
          await removeWorkspaceTree(capture)
        }
      } else {
        snapshotId = input.snapshotId!
        const temporary = join(directory, "download.partial")
        const download = join(directory, "download")
        await removeWorkspaceTree(temporary)
        await publishWorkerJson(directory, "progress.json", {
          phase: "downloading",
          at: Date.now(),
        })
        try {
          const restored = await restic([
            "restore",
            snapshotId,
            "--target",
            temporary,
          ])
          if (restored.code !== 0) throw new Error("backup download failed")
          manifest = JSON.parse(
            await core([
              "workspace-snapshot-inspect",
              temporary,
              input.workspaceId,
            ])
          )
          if (manifest.sourceCheckpoint !== input.sourceCheckpoint)
            throw new Error("downloaded checkpoint does not match the catalog")
          await removeWorkspaceTree(download)
          await rename(temporary, download)
        } finally {
          await removeWorkspaceTree(temporary)
        }
      }
      const result: BackupWorkerResult = {
        version: 1,
        jobId: input.jobId,
        kind: input.kind,
        state: "complete",
        workspaceId: manifest.workspaceId,
        repositoryId,
        snapshotId,
        captureId: manifest.snapshotId,
        sourceCheckpoint: manifest.sourceCheckpoint,
        contentCheckpoint: manifest.contentCheckpoint,
        workspaceStorageVersion: manifest.workspaceStorageVersion,
        capturedAt: manifest.capturedAt,
        bytes: manifest.files.reduce((total, file) => total + file.size, 0),
        completedAt: new Date().toISOString(),
      }
      await publishWorkerJson(directory, "result.json", result)
      return result
    }
  )
}

if (import.meta.main && process.argv[2] === "--version") {
  console.log("worktable-backup protocol 1")
} else if (import.meta.main) {
  const jobId = process.argv[2] ?? ""
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(jobId))
    throw new Error("expected backup job id")
  const appDirectory = process.env["WORKTABLE_APP_DIR"] ?? "/data/app"
  const directory = join(appDirectory, "operator-snapshots", jobId)
  const inputPath = join(directory, "input.json")
  try {
    const input = JSON.parse(
      await readBoundedRegularFile(inputPath, 32 * 1024)
    ) as BackupWorkerInput
    if (input.jobId !== jobId) throw new Error("backup job identity mismatch")
    await runBackupWorker(input, {
      appDirectory,
      restic: "/app/cloud-backup/restic",
      server: ["/app/bin/worktable-server"],
    })
  } catch {
    await publishWorkerJson(directory, "failure.json", {
      jobId,
      state: "failed",
      error:
        "The backup job failed. Retry after checking the runtime and backup storage.",
      at: Date.now(),
    })
    process.exitCode = 1
  } finally {
    await rm(inputPath, { force: true })
  }
}

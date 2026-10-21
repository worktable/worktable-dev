import type {
  BackupWorkerInput,
  BackupWorkerResult,
  VisitorCommentsCheckpoint,
} from "@worktable/hosted-contract"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
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
  teamState?: {
    authentication: { size: number }
    participants?: { size: number }
  }
  visitorComments?: { size: number; checkpoint: VisitorCommentsCheckpoint }
  files: Array<{ size: number }>
}

export interface WorkerTools {
  restic: string
  server: string[]
  appDirectory: string
}
const DIGEST = /^[a-f0-9]{64}$/
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

/**
 * The snapshot manifest a server command printed. The command prints it as
 * one JSON line; anything a dependency printed around it, JSON or not, is
 * not the manifest.
 */
export function snapshotManifestResult(stdout: string): unknown {
  const lines = stdout.split("\n").filter((line) => line.trim().startsWith("{"))
  for (const line of lines.reverse()) {
    try {
      const value: unknown = JSON.parse(line)
      if (
        value !== null &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === "worktable.workspace-snapshot"
      )
        return value
    } catch {
      // Not the manifest line.
    }
  }
  // Says how much arrived and whether it stopped mid-line, never what it was.
  throw new Error(
    `server command printed no snapshot manifest (${Buffer.byteLength(stdout)} bytes${stdout.endsWith("\n") ? "" : ", cut off mid-line"})`
  )
}

/**
 * Subprocess output is bounded. Stderr is discarded unless `stderrLimit` asks
 * for its first bytes. Restic stderr is never kept: paths and backend
 * credentials can appear in it.
 */
export async function runBackupCommand(
  command: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  signal: AbortSignal,
  limit = 40 * 1024 * 1024,
  stderrLimit = 0
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let count = 0
    let errorCount = 0
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
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorCount >= stderrLimit) return
      const kept = chunk.subarray(0, stderrLimit - errorCount)
      errorCount += kept.length
      errors.push(kept)
    })
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
          stderr: Buffer.concat(errors).toString("utf8"),
        })
    })
  })
}

/** Where a backup job stopped. Recorded in progress.json and failure.json. */
export type BackupWorkerStep =
  | "input"
  | "prepare"
  | "lock"
  | "repository-check"
  | "capture"
  | "read-manifest"
  | "inspect"
  | "parse-manifest"
  | "upload"
  | "verify"
  | "download"
  | "publish"

/** Secret-free failure description written to failure.json. */
export interface BackupFailureDetail {
  step: BackupWorkerStep
  exitCode?: number
  errorName: string
  message: string
}

interface FailureContext {
  /** Absolute paths under these roots are reported relative to them. */
  roots: string[]
  /** Exact values that must never appear in a message. */
  secrets: string[]
}

/** A subprocess exited unsuccessfully. Its message never holds restic output. */
class BackupCommandError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode: number) {
    super(message)
    this.name = "BackupCommandError"
    this.exitCode = exitCode
  }
}

export class BackupWorkerFailure extends Error {
  readonly detail: BackupFailureDetail
  constructor(detail: BackupFailureDetail, cause: unknown) {
    super(`backup job failed during ${detail.step}`, { cause })
    this.name = "BackupWorkerFailure"
    this.detail = detail
  }
}

const SERVER_ERROR_PREFIX = "[Worktable server] "
const SERVER_STDERR_LIMIT = 64 * 1024
const MESSAGE_LIMIT = 200

/** The server CLI's fatal error line (its last prefixed one), or else its first line. */
function serverErrorLine(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const reported = [...lines]
    .reverse()
    .find((line) => line.startsWith(SERVER_ERROR_PREFIX))
  return reported ? reported.slice(SERVER_ERROR_PREFIX.length) : lines[0]
}

/**
 * One line of at most 200 characters. Known secrets and URLs are removed, and
 * absolute paths become relative to a known root or else their basename.
 */
export function sanitizeFailureMessage(
  text: string,
  context: FailureContext
): string {
  let line = text.split(/\r?\n/, 1)[0] ?? ""
  for (const secret of context.secrets)
    if (secret) line = line.split(secret).join("[redacted]")
  line = line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
  const roots = context.roots.filter(Boolean).map((root) => resolve(root))
  line = line.replace(/(?<![\w.~-])\/[^\s'"`,;()<>]+/g, (path) => {
    const absolute = resolve(path)
    for (const root of roots) {
      const inside = relative(root, absolute)
      if (inside && !inside.startsWith("..") && !inside.startsWith("/"))
        return inside
    }
    return basename(absolute) || "/"
  })
  line = Array.from(line, (char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? " " : char
  }).join("")
  return line.replace(/\s+/g, " ").trim().slice(0, MESSAGE_LIMIT)
}

export function describeBackupFailure(
  step: BackupWorkerStep,
  error: unknown,
  context: FailureContext
): BackupFailureDetail {
  if (error instanceof BackupWorkerFailure) return error.detail
  const errorName =
    error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name)
      ? error.name
      : "Error"
  // A JSON parse error can quote the subprocess output it rejected.
  const raw =
    error instanceof SyntaxError
      ? "invalid JSON"
      : error instanceof Error
        ? error.message
        : "non-error failure"
  return {
    step,
    ...(error instanceof BackupCommandError
      ? { exitCode: error.exitCode }
      : {}),
    errorName,
    message: sanitizeFailureMessage(raw, context) || "no message",
  }
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

function backupSecrets(input: BackupWorkerInput): string[] {
  return [
    input.repository,
    input.repositoryPassword,
    input.credentials?.accessKeyId,
    input.credentials?.secretAccessKey,
    input.credentials?.sessionToken,
  ].filter((value): value is string => typeof value === "string")
}

/**
 * Same implementation is compiled for the Sprite and exercised with real restic.
 * A failure is rethrown as BackupWorkerFailure naming the step that failed.
 */
export async function runBackupWorker(
  input: BackupWorkerInput,
  tools: WorkerTools
): Promise<BackupWorkerResult> {
  const tracker = { step: "input" as BackupWorkerStep }
  try {
    return await runBackupSteps(input, tools, tracker)
  } catch (error) {
    const directory = join(
      resolve(tools.appDirectory),
      "operator-snapshots",
      String(input.jobId)
    )
    throw new BackupWorkerFailure(
      describeBackupFailure(tracker.step, error, {
        roots: [process.env["WORKTABLE_WORKSPACE"] ?? "", directory],
        secrets: backupSecrets(input),
      }),
      error
    )
  }
}

async function runBackupSteps(
  input: BackupWorkerInput,
  tools: WorkerTools,
  tracker: { step: BackupWorkerStep }
): Promise<BackupWorkerResult> {
  validateInput(input)
  tracker.step = "prepare"
  const root = join(resolve(tools.appDirectory), "operator-snapshots")
  const directory = join(root, input.jobId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const path of [root, directory]) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("invalid backup job directory")
  }
  // The control plane reads `phase`; `step` shows where a lost worker stopped.
  let phase: "capturing" | "uploading" | "downloading" | undefined
  const advance = async (step: BackupWorkerStep, nextPhase = phase) => {
    tracker.step = step
    phase = nextPhase
    await publishWorkerJson(directory, "progress.json", {
      ...(phase ? { phase } : {}),
      step,
      at: Date.now(),
    })
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
  // Server CLI errors are Worktable's own messages, so their line is kept.
  const core = async (args: string[]) => {
    const result = await runBackupCommand(
      [...tools.server, ...args],
      baseEnv,
      directory,
      signal,
      undefined,
      SERVER_STDERR_LIMIT
    )
    if (result.code !== 0)
      throw new BackupCommandError(
        serverErrorLine(result.stderr) ?? "workspace snapshot operation failed",
        result.code
      )
    return result.stdout
  }
  await advance("lock")
  return withCrossProcessLock(
    join(root, ".worker.lock"),
    { label: "Cloud backup worker", staleMs: 0, timeoutMs: 1000 },
    async () => {
      await advance("repository-check")
      let repository = await restic(["cat", "config"])
      if (
        repository.code === 10 &&
        input.kind === "backup" &&
        !input.repositoryId
      ) {
        const init = await restic(["init", "--repository-version", "2"])
        if (init.code !== 0)
          throw new BackupCommandError(
            "backup repository initialization failed",
            init.code
          )
        repository = await restic(["cat", "config"])
      }
      if (repository.code !== 0)
        throw new BackupCommandError(
          "backup repository is unavailable",
          repository.code
        )
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
        await advance("capture", "capturing")
        await core([
          "workspace-snapshot",
          input.jobId,
          ...(input.captureBudgetMs === undefined
            ? []
            : [String(input.captureBudgetMs)]),
        ])
        const capture = join(directory, "capture")
        try {
          await advance("read-manifest")
          const bytes = await readBoundedRegularFile(
            join(capture, "snapshot.json"),
            32 * 1024 * 1024
          )
          await advance("inspect")
          const inspected = await core([
            "workspace-snapshot-inspect",
            capture,
            input.workspaceId,
          ])
          await advance("parse-manifest")
          manifest = snapshotManifestResult(
            inspected
          ) as WorkspaceSnapshotManifest
          await advance("upload", "uploading")
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
              ...(manifest.teamState ? ["team"] : []),
              ...(manifest.visitorComments
                ? ["app/visitor-comments.sqlite"]
                : []),
            ],
            capture
          )
          // Code 3 can leave a snapshot behind. It must never be advertised.
          if (backup.code !== 0)
            throw new BackupCommandError(
              `backup upload failed (exit ${backup.code})`,
              backup.code
            )
          const summary = backup.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .find((row) => row.message_type === "summary")
          if (!summary || !/^[a-f0-9]{8,64}$/.test(summary.snapshot_id ?? ""))
            throw new Error("backup returned no snapshot")
          await advance("verify")
          const metadata = await restic([
            "cat",
            "snapshot",
            summary.snapshot_id,
          ])
          if (metadata.code !== 0)
            throw new BackupCommandError(
              "backup snapshot verification failed",
              metadata.code
            )
          const saved = JSON.parse(metadata.stdout)
          if (
            saved.hostname !== input.workspaceId ||
            !saved.tags?.includes(`worktable-job:${input.jobId}`)
          )
            throw new Error("backup snapshot identity verification failed")
          // Expand any abbreviated CLI id through the exact snapshot listing.
          const listing = await restic(["snapshots", summary.snapshot_id])
          if (listing.code !== 0)
            throw new BackupCommandError(
              "backup snapshot lookup failed",
              listing.code
            )
          const matches = JSON.parse(listing.stdout)
          if (
            !Array.isArray(matches) ||
            matches.length !== 1 ||
            !DIGEST.test(matches[0]?.id)
          )
            throw new Error("backup snapshot lookup is ambiguous")
          snapshotId = matches[0].id
          const remote = await restic(["dump", snapshotId, "/snapshot.json"])
          if (remote.code !== 0)
            throw new BackupCommandError(
              "backup manifest read-back failed",
              remote.code
            )
          if (sha(remote.stdout) !== sha(bytes))
            throw new Error("backup manifest read-back failed")
        } finally {
          await removeWorkspaceTree(capture)
        }
      } else {
        snapshotId = input.snapshotId!
        const temporary = join(directory, "download.partial")
        const download = join(directory, "download")
        await advance("download", "downloading")
        await removeWorkspaceTree(temporary)
        try {
          const restored = await restic([
            "restore",
            snapshotId,
            "--target",
            temporary,
          ])
          if (restored.code !== 0)
            throw new BackupCommandError(
              "backup download failed",
              restored.code
            )
          await advance("inspect")
          const inspected = await core([
            "workspace-snapshot-inspect",
            temporary,
            input.workspaceId,
          ])
          await advance("parse-manifest")
          manifest = snapshotManifestResult(
            inspected
          ) as WorkspaceSnapshotManifest
          await advance("verify")
          if (manifest.sourceCheckpoint !== input.sourceCheckpoint)
            throw new Error("downloaded checkpoint does not match the catalog")
          await advance("publish")
          await removeWorkspaceTree(download)
          await rename(temporary, download)
        } finally {
          await removeWorkspaceTree(temporary)
        }
      }
      if (tracker.step !== "publish") await advance("publish")
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
        visitorCommentsCheckpoint: manifest.visitorComments?.checkpoint ?? null,
        workspaceStorageVersion: manifest.workspaceStorageVersion,
        capturedAt: manifest.capturedAt,
        bytes:
          manifest.files.reduce((total, file) => total + file.size, 0) +
          (manifest.teamState?.authentication.size ?? 0) +
          (manifest.teamState?.participants?.size ?? 0) +
          (manifest.visitorComments?.size ?? 0),
        completedAt: new Date().toISOString(),
      }
      await publishWorkerJson(directory, "result.json", result)
      return result
    }
  )
}

/**
 * The `worktable-backup <job-id>` entry point. Any failure leaves failure.json
 * with a secret-free `detail`; the credential input is always removed.
 */
export async function runBackupWorkerJob(
  jobId: string,
  tools: WorkerTools
): Promise<boolean> {
  const directory = join(tools.appDirectory, "operator-snapshots", jobId)
  const inputPath = join(directory, "input.json")
  try {
    const input = JSON.parse(
      await readBoundedRegularFile(inputPath, 32 * 1024)
    ) as BackupWorkerInput
    if (input.jobId !== jobId) throw new Error("backup job identity mismatch")
    await runBackupWorker(input, tools)
    return true
  } catch (error) {
    await publishWorkerJson(directory, "failure.json", {
      jobId,
      state: "failed",
      error:
        "The backup job failed. Retry after checking the runtime and backup storage.",
      detail: describeBackupFailure("input", error, {
        roots: [directory],
        secrets: [],
      }),
      at: Date.now(),
    })
    return false
  } finally {
    await rm(inputPath, { force: true })
  }
}

if (import.meta.main && process.argv[2] === "--version") {
  console.log("worktable-backup protocol 1")
} else if (import.meta.main) {
  const jobId = process.argv[2] ?? ""
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(jobId))
    throw new Error("expected backup job id")
  const succeeded = await runBackupWorkerJob(jobId, {
    appDirectory: process.env["WORKTABLE_APP_DIR"] ?? "/data/app",
    restic: "/app/cloud-backup/restic",
    server: ["/app/bin/worktable-server"],
  })
  if (!succeeded) process.exitCode = 1
}

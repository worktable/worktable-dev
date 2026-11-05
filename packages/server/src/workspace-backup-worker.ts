import type {
  BackupWorkerDiagnostics,
  BackupWorkerInput,
  BackupWorkerMaintainResult,
  BackupWorkerResult,
  VisitorCommentsCheckpoint,
} from "@worktable/hosted-contract"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
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
    authentication: { size: number; sha256: string }
    participants?: { size: number; sha256: string }
  }
  visitorComments?: {
    size: number
    sha256: string
    checkpoint: VisitorCommentsCheckpoint
  }
  files: Array<{ path: string; size: number; mtime: string; sha256: string }>
}

export interface WorkerTools {
  restic: string
  server: string[]
  appDirectory: string
}
const DIGEST = /^[a-f0-9]{64}$/
const sha = (value: string) => createHash("sha256").update(value).digest("hex")

/**
 * Restic's cache of repository metadata (index, snapshots and trees, never
 * file data) lives in app storage. It is dropped whenever it grows past this,
 * and restic fetches what it needs again.
 */
const RESTIC_CACHE_LIMIT_BYTES = 256 * 1024 * 1024

/** Remove the cache when it outgrows its limit. Returns its size before. */
export async function boundResticCache(
  directory: string,
  limitBytes = RESTIC_CACHE_LIMIT_BYTES
): Promise<number> {
  let total = 0
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else total += (await lstat(path)).size
    }
  }
  if (total > limitBytes) await rm(directory, { recursive: true, force: true })
  return total
}

/**
 * A regular file in a restic snapshot, by its path there: size, modification
 * time to the millisecond, and content hash.
 */
export type UploadedFile = [
  path: string,
  size: number,
  mtime: string,
  sha256: string,
]

/** The last snapshot this worker uploaded and verified, and its files. */
export interface BackupParent {
  version: 1
  repositoryId: string
  workspaceId: string
  snapshotId: string
  files: UploadedFile[]
}

function readBackupParent(value: unknown): BackupParent | undefined {
  const parent = value as Partial<BackupParent> | null
  if (
    parent?.version !== 1 ||
    typeof parent.repositoryId !== "string" ||
    typeof parent.workspaceId !== "string" ||
    typeof parent.snapshotId !== "string" ||
    !DIGEST.test(parent.snapshotId) ||
    !Array.isArray(parent.files) ||
    !parent.files.every(
      (file) =>
        Array.isArray(file) &&
        file.length === 4 &&
        typeof file[0] === "string" &&
        Number.isSafeInteger(file[1]) &&
        typeof file[2] === "string" &&
        typeof file[3] === "string"
    )
  )
    return undefined
  return parent as BackupParent
}

/**
 * Restic arguments that let an upload skip files unchanged since `parent`.
 *
 * Every capture is a fresh copy, so restic's default change detection (path,
 * size, mtime, ctime and inode must all match the parent) rereads every file.
 * `--ignore-inode` also ignores inode and ctime, and trusts path, size and
 * mtime alone. A capture keeps each file's source mtime, so a file edited
 * with its mtime put back would then keep its old bytes in the backup. That
 * happens only when this capture hashed different bytes for a path whose size
 * and mtime match the parent's, so then nothing is trusted and every file is
 * read. The parent is named explicitly, so restic compares with the snapshot
 * these files describe.
 */
export function incrementalUploadArguments(
  parent: BackupParent | undefined,
  files: UploadedFile[]
): string[] {
  if (!parent) return []
  const previous = new Map(parent.files.map((file) => [file[0], file]))
  for (const [path, size, mtime, sha256] of files) {
    const before = previous.get(path)
    if (
      before &&
      before[1] === size &&
      before[2] === mtime &&
      before[3] !== sha256
    )
      return []
  }
  return ["--parent", parent.snapshotId, "--ignore-inode"]
}

/** The capture command's diagnostics, when it printed any. */
function captureDiagnostics(
  stdout: string
): Omit<BackupWorkerDiagnostics["capture"], "ms"> {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue
    try {
      const value = JSON.parse(line)
      if (value?.command !== "workspace-snapshot") continue
      const report = value.capture ?? {}
      const number = (field: unknown) =>
        typeof field === "number" && Number.isFinite(field)
          ? Math.round(field)
          : undefined
      return {
        method: ["reflink", "copy"].includes(report.method)
          ? report.method
          : undefined,
        files: number(value.files),
        bytes: number(value.bytes),
        hashedFiles: number(report.hashedFiles),
        hashedBytes: number(report.hashedBytes),
        barrierMs: number(value.captureBarrierMs),
      }
    } catch {
      // Not the result line.
    }
  }
  return {}
}

/** The inspection's counts, printed beside the manifest by `--captured`. */
function inspectDiagnostics(
  stdout: string
): Omit<BackupWorkerDiagnostics["inspect"], "ms"> {
  for (const line of stdout.split("\n")) {
    if (!line.includes('"worktable.workspace-snapshot-inspection"')) continue
    try {
      const value = JSON.parse(line)
      if (
        Number.isSafeInteger(value.hashedFiles) &&
        Number.isSafeInteger(value.hashedBytes)
      )
        return {
          hashedFiles: value.hashedFiles,
          hashedBytes: value.hashedBytes,
        }
    } catch {
      // Not the inspection line.
    }
  }
  return {}
}

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
 * How long a stopped command has to exit after SIGTERM before SIGKILL. Restic
 * removes its repository lock on SIGTERM; a killed restic leaves the lock,
 * which then blocks every exclusive operation until an operator removes it.
 * Each job's deadline ends this long before it expires.
 */
const STOP_GRACE_MS = 15_000

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
    let forced: ReturnType<typeof setTimeout> | undefined
    const kill = () => {
      if (forced) return
      child.kill("SIGTERM")
      forced = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS)
    }
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
      clearTimeout(forced)
      signal.removeEventListener("abort", kill)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(forced)
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
  | "forget"
  | "prune"
  | "check"
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
    !["backup", "download", "maintain"].includes(input.kind) ||
    !input.repositoryPassword ||
    !input.repository ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= Date.now() + STOP_GRACE_MS
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
  if (input.kind === "maintain") validateMaintainInput(input)
}

/** Each list of a maintenance job, at most. */
const MAINTAIN_LIST_LIMIT = 10_000
/** Ids per `restic forget`, so orphans never overflow a command line. */
const FORGET_BATCH = 5_000
const DAY_MS = 86_400_000

/**
 * A `restic check --read-data-subset` value: "5%", "0.5%", or "n/t" with
 * 1 <= n <= t <= 256, restic's limit.
 */
function isReadDataSubset(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?%$/.test(value)) {
    const percent = Number(value.slice(0, -1))
    return percent > 0 && percent <= 100
  }
  const part = /^([1-9]\d{0,2})\/([1-9]\d{0,2})$/.exec(value)
  return !!part && Number(part[1]) <= Number(part[2]) && Number(part[2]) <= 256
}

/**
 * Maintenance forgets by the catalog's ids alone, so a list it cannot trust
 * refuses the whole job. The repository must be the catalogued one: an
 * unknown repository's old snapshots would all look uncatalogued.
 * `orphanBefore` is in milliseconds and at least a day before the job
 * expires, so a backup the catalog has yet to record is never an orphan.
 */
function validateMaintainInput(input: BackupWorkerInput) {
  const ids = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length <= MAINTAIN_LIST_LIMIT &&
    value.every((id) => typeof id === "string" && DIGEST.test(id))
  if (
    !input.repositoryId ||
    !ids(input.forget) ||
    !ids(input.keep) ||
    !Number.isSafeInteger(input.orphanBefore) ||
    input.orphanBefore! <= 1_600_000_000_000 ||
    input.orphanBefore! > input.expiresAt - DAY_MS
  )
    throw new Error("invalid maintenance job")
  const keep = new Set(input.keep)
  if (input.forget.some((id) => keep.has(id)))
    throw new Error("maintenance would forget a kept snapshot")
  if (
    input.readDataSubset !== undefined &&
    !isReadDataSubset(input.readDataSubset)
  )
    throw new Error("invalid repository check subset")
  const verify: unknown = input.verify
  if (verify === undefined) return
  const { snapshotId, sourceCheckpoint } = (verify ?? {}) as Record<
    string,
    unknown
  >
  if (
    typeof snapshotId !== "string" ||
    !DIGEST.test(snapshotId) ||
    typeof sourceCheckpoint !== "string" ||
    !DIGEST.test(sourceCheckpoint)
  )
    throw new Error("invalid maintenance verification")
  if (input.forget.includes(snapshotId))
    throw new Error("maintenance would forget the verified snapshot")
  if (!keep.has(snapshotId))
    throw new Error("maintenance must verify a kept snapshot")
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
 * Every regular file an upload stores, as `incrementalUploadArguments`
 * compares them, or undefined when the upload holds a file the manifest
 * does not describe.
 */
async function uploadedFiles(
  capture: string,
  manifest: WorkspaceSnapshotManifest,
  snapshotBytes: string
): Promise<UploadedFile[] | undefined> {
  const mtime = async (path: string) =>
    new Date((await lstat(join(capture, path))).mtimeMs).toISOString()
  const files: UploadedFile[] = manifest.files.map((file) => [
    `workspace/${file.path}`,
    file.size,
    file.mtime,
    file.sha256,
  ])
  const own: Array<[string, { size: number; sha256: string } | undefined]> = [
    ["team/auth.sqlite", manifest.teamState?.authentication],
    ["team/participants.json", manifest.teamState?.participants],
    ["app/visitor-comments.sqlite", manifest.visitorComments],
  ]
  for (const [path, state] of own)
    if (state) files.push([path, state.size, await mtime(path), state.sha256])
  if (manifest.teamState) {
    const described = new Set(files.map(([path]) => path))
    for (const name of await readdir(join(capture, "team")))
      if (!described.has(`team/${name}`)) return undefined
  }
  files.push([
    "snapshot.json",
    Buffer.byteLength(snapshotBytes),
    await mtime("snapshot.json"),
    sha(snapshotBytes),
  ])
  return files
}

/**
 * Same implementation is compiled for the Sprite and exercised with real restic.
 * A failure is rethrown as BackupWorkerFailure naming the step that failed.
 */
export async function runBackupWorker(
  input: BackupWorkerInput,
  tools: WorkerTools
): Promise<BackupWorkerResult | BackupWorkerMaintainResult> {
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
): Promise<BackupWorkerResult | BackupWorkerMaintainResult> {
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
  // A prune that repacks a whole repository can outlast an upload. A stopped
  // command's grace ends before the job's credentials and lease expire.
  const signal = AbortSignal.timeout(
    Math.min(
      Math.max(0, input.expiresAt - Date.now() - STOP_GRACE_MS),
      (input.kind === "maintain" ? 120 : 30) * 60_000
    )
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
  const resticCache = join(resolve(tools.appDirectory), "backup-cache")
  const parentRecord = join(root, "backup-parent.json")
  const restic = async (args: string[], cwd = directory) =>
    runBackupCommand(
      [
        tools.restic,
        "--cache-dir",
        resticCache,
        "--cleanup-cache",
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
  const snapshotExists = async (id: string) => {
    const listing = await restic(["snapshots", id])
    if (listing.code !== 0) return false
    try {
      const matches = JSON.parse(listing.stdout)
      return (
        Array.isArray(matches) &&
        matches.length === 1 &&
        matches[0]?.id === id &&
        matches[0]?.hostname === input.workspaceId
      )
    } catch {
      return false
    }
  }
  await advance("lock")
  return withCrossProcessLock(
    join(root, ".worker.lock"),
    { label: "Cloud backup worker", staleMs: 0, timeoutMs: 1000 },
    async () => {
      await advance("repository-check")
      await boundResticCache(resticCache)
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
      if (input.kind === "maintain")
        return maintainRepository(
          input,
          repositoryId,
          restic,
          advance,
          directory
        )
      let manifest: WorkspaceSnapshotManifest
      let snapshotId: string
      let diagnostics: BackupWorkerDiagnostics | undefined
      if (input.kind === "backup") {
        await advance("capture", "capturing")
        let startedAt = performance.now()
        const captured = await core([
          "workspace-snapshot",
          input.jobId,
          ...(input.captureBudgetMs === undefined
            ? []
            : [String(input.captureBudgetMs)]),
        ])
        const captureTimings = {
          ms: Math.round(performance.now() - startedAt),
          ...captureDiagnostics(captured),
        }
        const capture = join(directory, "capture")
        try {
          await advance("read-manifest")
          const bytes = await readBoundedRegularFile(
            join(capture, "snapshot.json"),
            32 * 1024 * 1024
          )
          await advance("inspect")
          startedAt = performance.now()
          // The capture vouches for files it wrote that are still unchanged.
          const inspected = await core([
            "workspace-snapshot-inspect",
            capture,
            input.workspaceId,
            "--captured",
          ])
          const inspectTimings = {
            ms: Math.round(performance.now() - startedAt),
            ...inspectDiagnostics(inspected),
          }
          await advance("parse-manifest")
          manifest = snapshotManifestResult(
            inspected
          ) as WorkspaceSnapshotManifest
          await advance("upload", "uploading")
          // Incremental uploads are an optimization: never a reason to fail.
          const uploaded = await uploadedFiles(capture, manifest, bytes).catch(
            () => undefined
          )
          let parent: BackupParent | undefined
          try {
            parent = readBackupParent(
              JSON.parse(
                await readBoundedRegularFile(parentRecord, 64 * 1024 * 1024)
              )
            )
          } catch {
            // No parent yet, or an unreadable one: read every file.
          }
          if (
            parent &&
            (parent.repositoryId !== repositoryId ||
              parent.workspaceId !== input.workspaceId ||
              !(await snapshotExists(parent.snapshotId)))
          )
            parent = undefined
          const incremental = uploaded
            ? incrementalUploadArguments(parent, uploaded)
            : []
          startedAt = performance.now()
          const backup = await restic(
            [
              "backup",
              "--host",
              input.workspaceId,
              "--group-by",
              "host",
              ...incremental,
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
          const count = (value: unknown) =>
            Number.isSafeInteger(value) ? (value as number) : undefined
          diagnostics = {
            capture: captureTimings,
            inspect: inspectTimings,
            upload: {
              ms: Math.round(performance.now() - startedAt),
              incremental: incremental.length > 0,
              filesNew: count(summary.files_new),
              filesChanged: count(summary.files_changed),
              filesUnmodified: count(summary.files_unmodified),
              bytesAdded: count(summary.data_added),
            },
          }
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
          // Verified, so it can be the next upload's parent. A record that
          // fails to replace the last one leaves that one, which still
          // describes its own snapshot.
          if (uploaded) {
            const record: BackupParent = {
              version: 1,
              repositoryId,
              workspaceId: input.workspaceId,
              snapshotId,
              files: uploaded,
            }
            await publishWorkerJson(root, "backup-parent.json", record).catch(
              () => undefined
            )
          }
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
        ...(diagnostics ? { diagnostics } : {}),
      }
      await publishWorkerJson(directory, "result.json", result)
      return result
    }
  )
}

type Restic = (
  args: string[]
) => Promise<{ code: number; stdout: string; stderr: string }>

/** Restic's exit code when the repository is locked by another process. */
const RESTIC_LOCKED = 11

function resticFailure(what: string, code: number) {
  return new BackupCommandError(
    code === RESTIC_LOCKED
      ? `${what} failed: the repository is locked`
      : `${what} failed (exit ${code})`,
    code
  )
}

async function listSnapshots(
  restic: Restic
): Promise<Array<{ id: string; hostname: unknown; time: number }>> {
  const listing = await restic(["snapshots"])
  if (listing.code !== 0)
    throw resticFailure("backup snapshot listing", listing.code)
  const rows: unknown = JSON.parse(listing.stdout)
  if (!Array.isArray(rows))
    throw new Error("backup snapshot listing is invalid")
  return rows.map(
    (row: { id?: unknown; hostname?: unknown; time?: unknown }) => {
      const time = typeof row?.time === "string" ? Date.parse(row.time) : NaN
      if (
        typeof row?.id !== "string" ||
        !DIGEST.test(row.id) ||
        !Number.isFinite(time)
      )
        throw new Error("backup snapshot listing is invalid")
      return { id: row.id, hostname: row.hostname, time }
    }
  )
}

/** The summary line `restic check --json` prints last. */
function checkSummary(stdout: string): {
  num_errors?: unknown
  broken_packs?: unknown
  suggest_repair_index?: unknown
  suggest_prune?: unknown
} {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue
    try {
      const row = JSON.parse(line)
      if (row?.message_type === "summary") return row
    } catch {
      // Not the summary line.
    }
  }
  throw new Error("backup repository check printed no summary")
}

/**
 * Forget what the catalog let go and uncatalogued partials older than
 * `orphanBefore`, then remove every byte no snapshot still uses. Restic's
 * keep rules and this machine's clock decide nothing. The operator lease
 * keeps backups out, and restic refuses a lock another process holds; that
 * lock is never removed here.
 */
async function maintainRepository(
  input: BackupWorkerInput,
  repositoryId: string,
  restic: Restic,
  advance: (step: BackupWorkerStep) => Promise<void>,
  directory: string
): Promise<BackupWorkerMaintainResult> {
  const keep = new Set(input.keep)
  const forget = new Set(input.forget)
  const before = await listSnapshots(restic)
  const present = new Set(before.map((snapshot) => snapshot.id))
  const forgotten = [...forget].filter((id) => present.has(id))
  const missing = [...forget].filter((id) => !present.has(id))
  const orphans = before
    .filter(
      (snapshot) =>
        !keep.has(snapshot.id) &&
        !forget.has(snapshot.id) &&
        snapshot.time < input.orphanBefore!
    )
    .map((snapshot) => snapshot.id)
  const removed = [...forgotten, ...orphans]
  // Nothing is forgotten unless the catalog and the repository agree on what
  // stays, and the newest restore point is there to read back.
  if (removed.length > 0 && !input.verify)
    throw new Error("maintenance must verify before forgetting")
  if (input.verify) {
    const target = before.find((row) => row.id === input.verify!.snapshotId)
    if (target?.hostname !== input.workspaceId)
      throw new Error("verified snapshot is not in the repository")
  }
  if ([...keep].some((id) => !present.has(id)))
    throw new Error("maintenance kept snapshot missing")
  await advance("forget")
  for (let start = 0; start < removed.length; start += FORGET_BATCH) {
    const batch = removed.slice(start, start + FORGET_BATCH)
    const result = await restic(["forget", "--quiet", "--", ...batch])
    if (result.code !== 0) throw resticFailure("backup forget", result.code)
  }
  await advance("prune")
  // Restic's default keeps up to 5% unused space, which can hold deleted
  // bytes for good.
  const pruned = await restic(["prune", "--quiet", "--max-unused", "0"])
  if (pruned.code !== 0) throw resticFailure("backup prune", pruned.code)
  const after = await listSnapshots(restic)
  const gone = new Set(removed)
  if (after.some((snapshot) => gone.has(snapshot.id)))
    throw new Error("backup forget left a snapshot behind")
  await advance("check")
  const checked = await restic([
    "check",
    "--quiet",
    ...(input.readDataSubset
      ? [`--read-data-subset=${input.readDataSubset}`]
      : []),
  ])
  if (checked.code !== 0)
    throw resticFailure("backup repository check", checked.code)
  // A pack the storage refused to delete leaves prune exiting 0 and check
  // suggesting another prune: deleted bytes are still there.
  const summary = checkSummary(checked.stdout)
  if (summary.suggest_prune === true)
    throw new Error("unused data remains after prune")
  if (
    summary.num_errors !== 0 ||
    summary.suggest_repair_index !== false ||
    (Array.isArray(summary.broken_packs) && summary.broken_packs.length > 0)
  )
    throw new Error("backup repository check found errors")
  let verified: string | null = null
  if (input.verify) {
    await advance("verify")
    const { snapshotId, sourceCheckpoint } = input.verify
    const snapshot = after.find((row) => row.id === snapshotId)
    if (snapshot?.hostname !== input.workspaceId)
      throw new Error("verified snapshot is not in the repository")
    const remote = await restic(["dump", snapshotId, "/snapshot.json"])
    if (remote.code !== 0)
      throw resticFailure("backup manifest read-back", remote.code)
    const manifest = JSON.parse(
      remote.stdout
    ) as Partial<WorkspaceSnapshotManifest> & { type?: unknown }
    if (
      manifest?.type !== "worktable.workspace-snapshot" ||
      manifest.workspaceId !== input.workspaceId ||
      manifest.sourceCheckpoint !== sourceCheckpoint
    )
      throw new Error("backup manifest read-back failed")
    verified = snapshotId
  }
  await advance("publish")
  const result: BackupWorkerMaintainResult = {
    version: 1,
    jobId: input.jobId,
    kind: "maintain",
    state: "complete",
    workspaceId: input.workspaceId,
    repositoryId,
    forgotten,
    missing,
    orphans,
    remaining: after.length,
    checked: input.readDataSubset ? "subset" : "structure",
    verified,
    completedAt: new Date().toISOString(),
  }
  await publishWorkerJson(directory, "result.json", result)
  return result
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
    // A maintenance job lists every catalogued snapshot id.
    const input = JSON.parse(
      await readBoundedRegularFile(inputPath, 2 * 1024 * 1024)
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

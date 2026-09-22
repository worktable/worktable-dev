import { ensureWorkspaceManifest, workspaceCacheKey } from "./workspace.ts"
import {
  WorkspaceExportPathError,
  type WorkspaceExportDiagnostics,
} from "./workspace-package-path.ts"
import type { WorkspaceClearJob } from "./workspace-clear-jobs.ts"
import { createHash, randomBytes } from "node:crypto"
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, join } from "node:path"
import { ensureAppDir } from "./app-storage.ts"
import { cleanupExpiredOperatorWorkspaceExports } from "./operator-export.ts"
import { withWorkspaceExportSnapshot } from "./workspace-export-coordinator.ts"
import {
  createWorkspaceReplacementPaths,
  discardCommittedWorkspaceReplacement,
  discardPreparedWorkspaceReplacement,
  discardRolledBackWorkspaceReplacement,
  prepareWorkspaceReplacement,
  type PreparedWorkspaceReplacement,
  type WorkspaceReplacementPaths,
} from "./workspace-replacement.ts"
import {
  scheduleWorkspaceReplacement,
  withWorkspaceExportLease,
} from "./workspace-replacement-coordinator.ts"
import {
  inspectWorkspaceExportV2,
  cleanupAbandonedWorkspaceExportCaptures,
  writeWorkspaceExportV2,
  WORKSPACE_EXPORT_V2_MAX_ARCHIVE_BYTES,
  type WorkspaceExportPhase,
  type WorkspaceExportHistoryPolicy,
  type WorkspaceExportV2Manifest,
} from "./workspace-transfer-v2.ts"

// Cloudflare's smallest documented request-body ceiling is 100 MB and a Worker
// isolate has 128 MB of memory. Eight MiB leaves ample room for auth/proxy work,
// while the gateway forwards each request body as a stream and core bounds the
// one chunk it materializes. The complete package is never buffered there.
export const WORKSPACE_TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024
export const WORKSPACE_TRANSFER_TTL_MS = 24 * 60 * 60 * 1000

type ExportState = "queued" | "running" | "complete" | "failed"
type ImportState =
  | "uploading"
  | "verifying"
  | "uploaded"
  | "preparing"
  | "ready"
  | "replacing"
  | "complete"
  | "failed"

export interface TransferJobBase {
  resetPending?: boolean
  workspaceKey?: string
  version: 1
  id: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  error?: string
}

export interface WorkspaceExportJob extends TransferJobBase {
  kind: "export"
  failure?: WorkspaceExportDiagnostics
  progress?: WorkspaceExportPhase
  recoveryFingerprint?: string
  recoveryJobId?: string
  revoked?: boolean
  state: ExportState
  history: WorkspaceExportHistoryPolicy
  downloadName?: string
  bytes?: number
  sha256?: string
  manifest?: WorkspaceExportV2Manifest
}

export interface WorkspaceImportJob extends TransferJobBase {
  kind: "import"
  state: ImportState
  fileName: string
  expectedBytes: number
  receivedBytes: number
  resumeFingerprint?: string
  expectedSha256?: string
  sha256?: string
  manifest?: WorkspaceExportV2Manifest
  preparation?: WorkspaceReplacementPaths
  prepared?: PreparedWorkspaceReplacement
}

export type WorkspaceTransferJob =
  | WorkspaceExportJob
  | WorkspaceImportJob
  | WorkspaceClearJob
export const activeClearJobs = new Set<string>()

const exportRuns = new Map<string, Promise<void>>()
const transferLocks = new Map<string, Promise<unknown>>()
const importRuns = new Map<string, Promise<void>>()
const exportDownloadLeases = new Map<string, number>()

let importRunHookForTests:
  | ((phase: "verifying" | "preparing") => Promise<void>)
  | null = null
let importChunkBeforePublishHookForTests: (() => Promise<void>) | null = null
let transferCleanupAfterReadHookForTests:
  | ((job: WorkspaceTransferJob) => Promise<void>)
  | null = null
const scheduledTransferCleanups = new Set<Promise<void>>()
let exportRunHookForTests: (() => Promise<void>) | null = null
let importRollbackCleanupHookForTests: (() => Promise<void>) | null = null
let jobWriteHookForTests:
  | ((job: WorkspaceTransferJob) => Promise<void>)
  | null = null

export function setWorkspaceImportRunHookForTests(
  hook: ((phase: "verifying" | "preparing") => Promise<void>) | null
): void {
  importRunHookForTests = hook
}

export function setWorkspaceImportChunkBeforePublishHookForTests(
  hook: (() => Promise<void>) | null
): void {
  importChunkBeforePublishHookForTests = hook
}

export function setWorkspaceTransferCleanupAfterReadHookForTests(
  hook: ((job: WorkspaceTransferJob) => Promise<void>) | null
): void {
  transferCleanupAfterReadHookForTests = hook
}

export async function waitForScheduledWorkspaceTransferCleanupsForTests(): Promise<void> {
  await Promise.all([...scheduledTransferCleanups])
}

export function setWorkspaceExportRunHookForTests(
  hook: (() => Promise<void>) | null
): void {
  exportRunHookForTests = hook
}

export function setWorkspaceImportRollbackCleanupHookForTests(
  hook: (() => Promise<void>) | null
): void {
  importRollbackCleanupHookForTests = hook
}

export function setWorkspaceTransferJobWriteHookForTests(
  hook: ((job: WorkspaceTransferJob) => Promise<void>) | null
): void {
  jobWriteHookForTests = hook
}

function transfersRoot(): string {
  return join(ensureAppDir(), "workspace-transfers", "jobs")
}

function jobDirectory(id: string): string {
  if (!/^wtx_[A-Za-z0-9_-]{20,64}$/.test(id)) {
    throw new Error("invalid workspace transfer id")
  }
  return join(transfersRoot(), id)
}

function jobPath(id: string): string {
  return join(jobDirectory(id), "job.json")
}

function packagePath(id: string): string {
  return join(jobDirectory(id), "workspace.wtb")
}

function nowIso(): string {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function writeJob(job: WorkspaceTransferJob): Promise<void> {
  await jobWriteHookForTests?.(job)
  const directory = jobDirectory(job.id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(
    directory,
    `.job-${randomBytes(6).toString("hex")}.partial`
  )
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporary, jobPath(job.id))
  await chmod(jobPath(job.id), 0o600)
}

class ForeignWorkspaceTransferError extends Error {
  constructor() {
    super("workspace transfer not found")
  }
}

async function readJob(id: string): Promise<WorkspaceTransferJob> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(jobPath(id), "utf8"))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("workspace transfer not found")
    }
    throw new Error("workspace transfer state is unreadable")
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("id" in parsed) ||
    parsed.id !== id ||
    !("kind" in parsed) ||
    (parsed.kind !== "export" &&
      parsed.kind !== "import" &&
      parsed.kind !== "clear")
  ) {
    throw new Error("workspace transfer state is invalid")
  }
  const job = parsed as WorkspaceTransferJob
  if (job.workspaceKey && job.workspaceKey !== workspaceCacheKey())
    throw new ForeignWorkspaceTransferError()
  return job
}

async function updateJob<T extends WorkspaceTransferJob>(
  job: T,
  patch: Partial<T>
): Promise<T> {
  const updated = {
    ...job,
    ...patch,
    updatedAt: nowIso(),
  } as T
  await writeJob(updated)
  return updated
}

async function withTransferLock<T>(
  id: string,
  work: () => Promise<T>
): Promise<T> {
  const predecessor = transferLocks.get(id) ?? Promise.resolve()
  const run = predecessor.then(work, work)
  transferLocks.set(id, run)
  try {
    return await run
  } finally {
    if (transferLocks.get(id) === run) transferLocks.delete(id)
  }
}

function isExpiredAndInactive(job: WorkspaceTransferJob, now: number): boolean {
  if (
    Date.parse(job.expiresAt) > now ||
    job.resetPending ||
    activeClearJobs.has(job.id) ||
    (job.kind === "clear" && job.cleanupPending)
  )
    return false
  if (job.kind === "export" && exportDownloadLeases.has(job.id)) return false
  if (job.kind === "export" && job.state === "running") {
    return !exportRuns.has(job.id)
  }
  if (
    job.kind === "import" &&
    (job.state === "preparing" || job.state === "verifying")
  ) {
    return !importRuns.has(job.id)
  }
  return job.state !== "replacing"
}

async function removeExpiredJob(
  job: WorkspaceTransferJob,
  now: number
): Promise<void> {
  if (!isExpiredAndInactive(job, now)) return
  if (
    (job.kind === "import" || job.kind === "clear") &&
    job.preparation?.stagingPath
  ) {
    await discardPreparedWorkspaceReplacement(job.preparation.stagingPath)
  }
  if (
    (job.kind === "import" || job.kind === "clear") &&
    job.prepared?.stagingPath
  ) {
    if (job.state === "complete") {
      await discardCommittedWorkspaceReplacement(
        job.prepared.stagingPath,
        job.prepared.backupPath
      )
    } else {
      await discardRolledBackWorkspaceReplacement(
        job.prepared.stagingPath,
        job.prepared.backupPath
      )
    }
  }
  await rm(jobDirectory(job.id), { recursive: true, force: true })
}

export async function cleanupExpiredWorkspaceTransfers(): Promise<void> {
  await mkdir(transfersRoot(), { recursive: true, mode: 0o700 })
  const now = Date.now()
  for (const entry of await readdir(transfersRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("wtx_")) continue
    let job: WorkspaceTransferJob
    try {
      job = await readJob(entry.name)
    } catch (error) {
      if (error instanceof ForeignWorkspaceTransferError) continue
      let info
      try {
        info = await stat(join(transfersRoot(), entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      if (info.mtimeMs < now - WORKSPACE_TRANSFER_TTL_MS) {
        await rm(join(transfersRoot(), entry.name), {
          recursive: true,
          force: true,
        })
      }
      continue
    }
    await transferCleanupAfterReadHookForTests?.(job)
    await withTransferLock(job.id, async () => {
      try {
        await removeExpiredJob(await readJob(job.id), now)
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "workspace transfer not found"
        ) {
          return
        }
        throw error
      }
    })
  }
}

function scheduleWorkspaceTransferCleanup(): void {
  const running = cleanupExpiredWorkspaceTransfers().catch((error) =>
    console.error("[workspace-transfer] background cleanup failed:", error)
  )
  scheduledTransferCleanups.add(running)
  void running.finally(() => scheduledTransferCleanups.delete(running))
}

function makeId(): string {
  return `wtx_${randomBytes(18).toString("base64url")}`
}

function safeDownloadName(manifest: WorkspaceExportV2Manifest): string {
  const date = manifest.exportedAt.slice(0, 10)
  const sanitized = manifest.source.workspaceName
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- portable filenames exclude C0 controls
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const name = [...sanitized].slice(0, 80).join("")
  return `${name || "Worktable"}-${date}.wtb`
}

function runExport(id: string): void {
  if (exportRuns.has(id)) return
  const running = withTransferLock(id, async () => {
    const stored = await readJob(id)
    if (
      stored.kind !== "export" ||
      stored.state === "complete" ||
      stored.revoked
    )
      return
    let job: WorkspaceExportJob = stored
    job = await updateJob(job, {
      state: "running",
      error: undefined,
      failure: undefined,
    })
    try {
      await exportRunHookForTests?.()
      const result = await withWorkspaceExportLease(() =>
        writeWorkspaceExportV2(packagePath(id), {
          history: job.history,
          recoveryFingerprint: job.recoveryFingerprint,
          onProgress: async (progress) => {
            job = await updateJob(job, { progress })
          },
          force: true,
          withCaptureBarrier: withWorkspaceExportSnapshot,
        })
      )
      await updateJob(job, {
        state: "complete",
        progress: undefined,
        bytes: result.bytes,
        sha256: result.sha256,
        manifest: result.manifest,
        downloadName: safeDownloadName(result.manifest),
        expiresAt: new Date(
          Date.now() + WORKSPACE_TRANSFER_TTL_MS
        ).toISOString(),
      })
    } catch (error) {
      await rm(packagePath(id), { force: true }).catch(() => undefined)
      await updateJob(job, {
        state: "failed",
        progress: undefined,
        failure:
          error instanceof WorkspaceExportPathError
            ? error.diagnostics
            : undefined,
        error: errorMessage(error),
        expiresAt: new Date(
          Date.now() + WORKSPACE_TRANSFER_TTL_MS
        ).toISOString(),
      })
    }
  })
    .catch((error) =>
      console.error(
        `[workspace-transfer] export runner failed for ${id}:`,
        error
      )
    )
    .finally(() => {
      if (exportRuns.get(id) === running) exportRuns.delete(id)
    })
  exportRuns.set(id, running)
}

export async function createWorkspaceExportJob(
  history: WorkspaceExportHistoryPolicy,
  options: { recoveryFingerprint?: string; id?: string } = {}
): Promise<WorkspaceExportJob> {
  scheduleWorkspaceTransferCleanup()
  const createdAt = nowIso()
  const job: WorkspaceExportJob = {
    version: 1,
    id: options.id ?? makeId(),
    workspaceKey: workspaceCacheKey(),
    recoveryFingerprint: options.recoveryFingerprint,
    kind: "export",
    state: "queued",
    history,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + WORKSPACE_TRANSFER_TTL_MS).toISOString(),
  }
  await writeJob(job)
  runExport(job.id)
  return job
}

export async function getWorkspaceExportJob(
  id: string
): Promise<WorkspaceExportJob> {
  const job = await readJob(id)
  if (job.kind !== "export")
    throw new Error("workspace transfer is not an export")
  if (
    (job.state === "queued" || job.state === "running") &&
    !exportRuns.has(job.id)
  ) {
    runExport(job.id)
  }
  return job
}

async function latestWorkspaceTransferJob(
  kind: WorkspaceTransferJob["kind"]
): Promise<WorkspaceTransferJob | null> {
  await mkdir(transfersRoot(), { recursive: true, mode: 0o700 })
  let latest: WorkspaceTransferJob | null = null
  const now = Date.now()
  for (const entry of await readdir(transfersRoot(), { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !/^wtx_[A-Za-z0-9_-]{20,64}$/.test(entry.name)
    ) {
      continue
    }
    let job: WorkspaceTransferJob
    try {
      job = await readJob(entry.name)
    } catch {
      continue
    }
    if (
      job.kind !== kind ||
      (job.kind === "export" && job.revoked) ||
      (Date.parse(job.expiresAt) <= now && isExpiredAndInactive(job, now))
    ) {
      continue
    }
    if (
      !latest ||
      Date.parse(job.createdAt) > Date.parse(latest.createdAt) ||
      (job.createdAt === latest.createdAt && job.id > latest.id)
    ) {
      latest = job
    }
  }
  return latest
}

export async function getCurrentWorkspaceExportJob(): Promise<WorkspaceExportJob | null> {
  const job = await latestWorkspaceTransferJob("export")
  return job ? getWorkspaceExportJob(job.id) : null
}

export async function waitForWorkspaceExportJob(
  id: string,
  options: { timeoutMs?: number } = {}
): Promise<WorkspaceExportJob> {
  await getWorkspaceExportJob(id)
  const running = exportRuns.get(id)
  if (running) {
    if (options.timeoutMs === undefined) {
      await running
    } else {
      const timeoutMs = Math.max(0, options.timeoutMs)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          running,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs)
            timer.unref?.()
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  }
  return getWorkspaceExportJob(id)
}

export async function openWorkspaceExportDownload(id: string): Promise<{
  job: WorkspaceExportJob
  body: ReadableStream<Uint8Array>
}> {
  return withTransferLock(id, async () => {
    let job = await getWorkspaceExportJob(id)
    if (job.state !== "complete" || job.revoked) {
      throw new Error("workspace export is not ready")
    }
    const handle = await open(packagePath(id), "r")
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size !== job.bytes) {
        throw new Error("workspace export artifact is unavailable")
      }
      job = await updateJob(job, {
        expiresAt: new Date(
          Date.now() + WORKSPACE_TRANSFER_TTL_MS
        ).toISOString(),
      })
      exportDownloadLeases.set(id, (exportDownloadLeases.get(id) ?? 0) + 1)
      let released = false
      const release = async () => {
        if (released) return
        released = true
        const remaining = (exportDownloadLeases.get(id) ?? 1) - 1
        if (remaining > 0) exportDownloadLeases.set(id, remaining)
        else exportDownloadLeases.delete(id)
        await handle.close().catch(() => undefined)
        if (!remaining) {
          const current = await readJob(id).catch(() => null)
          if (current?.kind === "export" && current.revoked)
            await rm(packagePath(id), { force: true }).catch(() => undefined)
        }
      }
      let position = 0
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const length = Math.min(64 * 1024, info.size - position)
            if (length <= 0) {
              controller.close()
              await release()
              return
            }
            const buffer = Buffer.allocUnsafe(length)
            const { bytesRead } = await handle.read(buffer, 0, length, position)
            if (bytesRead < 1) {
              controller.error(
                new Error("workspace export ended before its declared size")
              )
              await release()
              return
            }
            position += bytesRead
            controller.enqueue(buffer.subarray(0, bytesRead))
          } catch (error) {
            controller.error(error)
            await release()
          }
        },
        cancel: release,
      })
      return {
        job,
        body,
      }
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  })
}

export async function createWorkspaceImportJob(input: {
  fileName: string
  bytes: number
  resumeFingerprint?: string
  sha256?: string
}): Promise<WorkspaceImportJob> {
  scheduleWorkspaceTransferCleanup()
  if (
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > WORKSPACE_EXPORT_V2_MAX_ARCHIVE_BYTES
  ) {
    throw new Error("workspace package size is outside the supported limit")
  }
  if (input.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(input.sha256)) {
    throw new Error("workspace package sha256 is invalid")
  }
  if (
    input.resumeFingerprint !== undefined &&
    !/^[0-9a-f]{64}$/i.test(input.resumeFingerprint)
  ) {
    throw new Error("workspace package resume fingerprint is invalid")
  }
  const createdAt = nowIso()
  const job: WorkspaceImportJob = {
    version: 1,
    id: makeId(),
    kind: "import",
    workspaceKey: workspaceCacheKey(),
    state: "uploading",
    fileName: basename(input.fileName).slice(0, 255) || "workspace.wtb",
    expectedBytes: input.bytes,
    receivedBytes: 0,
    ...(input.resumeFingerprint
      ? { resumeFingerprint: input.resumeFingerprint.toLowerCase() }
      : {}),
    ...(input.sha256 ? { expectedSha256: input.sha256.toLowerCase() } : {}),
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + WORKSPACE_TRANSFER_TTL_MS).toISOString(),
  }
  const directory = jobDirectory(job.id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(packagePath(job.id), new Uint8Array(), {
      mode: 0o600,
      flag: "wx",
    })
    await writeJob(job)
    return job
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function hashPackage(path: string): Promise<string> {
  const hash = createHash("sha256")
  const file = Bun.file(path)
  for await (const chunk of file.stream()) hash.update(chunk)
  return hash.digest("hex")
}

async function publishImportFailure(
  id: string,
  expectedState: "verifying" | "preparing",
  error: unknown
): Promise<void> {
  await withTransferLock(id, async () => {
    const job = await readJob(id)
    if (job.kind !== "import" || job.state !== expectedState) return
    await updateJob(job, {
      state: "failed",
      preparation: undefined,
      error: errorMessage(error),
      expiresAt: new Date(Date.now() + WORKSPACE_TRANSFER_TTL_MS).toISOString(),
    })
  })
}

async function runWorkspaceImportVerification(id: string): Promise<void> {
  const job = await readJob(id)
  if (job.kind !== "import" || job.state !== "verifying") return
  try {
    await importRunHookForTests?.("verifying")
    const sha256 = await hashPackage(packagePath(job.id))
    if (job.expectedSha256 && sha256 !== job.expectedSha256) {
      throw new Error("workspace package hash does not match the upload")
    }
    const inspection = await inspectWorkspaceExportV2(packagePath(job.id))
    await withTransferLock(id, async () => {
      const current = await readJob(id)
      if (current.kind !== "import" || current.state !== "verifying") return
      await updateJob(current, {
        state: "uploaded",
        sha256,
        manifest: inspection.manifest,
        error: undefined,
        expiresAt: new Date(
          Date.now() + WORKSPACE_TRANSFER_TTL_MS
        ).toISOString(),
      })
    })
  } catch (error) {
    await publishImportFailure(id, "verifying", error)
  }
}

function startWorkspaceImportVerification(id: string): void {
  if (importRuns.has(id)) return
  const running = runWorkspaceImportVerification(id)
    .catch((error) =>
      console.error(
        `[workspace-transfer] verification runner failed for ${id}:`,
        error
      )
    )
    .finally(() => {
      if (importRuns.get(id) === running) importRuns.delete(id)
    })
  importRuns.set(id, running)
}

async function runWorkspaceImportPreparation(
  id: string,
  recoverInterrupted: boolean
): Promise<void> {
  let job = await readJob(id)
  if (job.kind !== "import" || job.state !== "preparing") return
  if (recoverInterrupted) {
    if (job.preparation?.stagingPath) {
      await discardPreparedWorkspaceReplacement(job.preparation.stagingPath)
    }
    job = await withTransferLock(id, async () => {
      const current = await readJob(id)
      if (current.kind !== "import" || current.state !== "preparing") {
        return current as WorkspaceImportJob
      }
      return updateJob(current, {
        preparation: createWorkspaceReplacementPaths(),
        error:
          "Workspace preparation was interrupted and resumed from the verified package.",
      })
    })
  }
  if (!job.preparation) {
    await publishImportFailure(
      id,
      "preparing",
      new Error("workspace import preparation paths are missing")
    )
    return
  }
  const preparation = job.preparation
  let completedStagingPath: string | null = null
  try {
    await importRunHookForTests?.("preparing")
    const currentSha256 = await hashPackage(packagePath(job.id))
    if (
      currentSha256 !== job.sha256 ||
      (job.expectedSha256 !== undefined && currentSha256 !== job.expectedSha256)
    ) {
      throw new Error("workspace package changed after verification")
    }
    const prepared = await prepareWorkspaceReplacement(
      packagePath(job.id),
      preparation
    )
    completedStagingPath = prepared.stagingPath
    let published = false
    await withTransferLock(id, async () => {
      const current = await readJob(id)
      if (
        current.kind !== "import" ||
        current.state !== "preparing" ||
        current.preparation?.stagingPath !== preparation.stagingPath ||
        current.preparation.backupPath !== preparation.backupPath
      ) {
        return
      }
      await updateJob(current, {
        state: "ready",
        preparation: undefined,
        prepared,
        error: undefined,
        expiresAt: new Date(
          Date.now() + WORKSPACE_TRANSFER_TTL_MS
        ).toISOString(),
      })
      published = true
    })
    if (!published) {
      await discardPreparedWorkspaceReplacement(prepared.stagingPath)
      completedStagingPath = null
    }
  } catch (error) {
    if (completedStagingPath) {
      await discardPreparedWorkspaceReplacement(completedStagingPath)
    }
    await publishImportFailure(id, "preparing", error)
  }
}

function startWorkspaceImportPreparation(
  id: string,
  recoverInterrupted: boolean
): void {
  if (importRuns.has(id)) return
  const running = runWorkspaceImportPreparation(id, recoverInterrupted)
    .catch((error) =>
      console.error(
        `[workspace-transfer] preparation runner failed for ${id}:`,
        error
      )
    )
    .finally(() => {
      if (importRuns.get(id) === running) importRuns.delete(id)
    })
  importRuns.set(id, running)
}

export async function appendWorkspaceImportChunk(input: {
  id: string
  start: number
  total: number
  bytes: Uint8Array
}): Promise<WorkspaceImportJob> {
  const job = await withTransferLock(input.id, async () => {
    let job = await readJob(input.id)
    if (job.kind !== "import") {
      throw new Error("workspace transfer is not an import")
    }
    const requestedEnd = input.start + input.bytes.byteLength
    if (
      input.total === job.expectedBytes &&
      input.bytes.byteLength >= 1 &&
      input.bytes.byteLength <= WORKSPACE_TRANSFER_CHUNK_BYTES &&
      input.start >= 0 &&
      requestedEnd <= job.receivedBytes
    ) {
      // The caller may have lost the response after this durable range was
      // accepted. Treat an already-recorded range as an idempotent retry.
      if (job.state === "uploading" || job.state === "verifying") {
        job = await updateJob(job, {
          ...(job.state === "uploading" &&
          job.receivedBytes === job.expectedBytes
            ? { state: "verifying" as const }
            : {}),
          expiresAt: new Date(
            Date.now() + WORKSPACE_TRANSFER_TTL_MS
          ).toISOString(),
        })
        return job
      }
      return job
    }
    if (job.state !== "uploading") {
      throw new Error("workspace import is not accepting upload chunks")
    }
    if (
      input.total !== job.expectedBytes ||
      input.start !== job.receivedBytes ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > WORKSPACE_TRANSFER_CHUNK_BYTES ||
      requestedEnd > job.expectedBytes
    ) {
      throw new Error("workspace import chunk range is invalid")
    }
    const handle = await open(packagePath(job.id), "r+")
    try {
      const { bytesWritten } = await handle.write(
        input.bytes,
        0,
        input.bytes.byteLength,
        input.start
      )
      if (bytesWritten !== input.bytes.byteLength) {
        throw new Error("workspace import chunk was only partially written")
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    await importChunkBeforePublishHookForTests?.()
    const receivedBytes = requestedEnd
    job = await updateJob(job, {
      receivedBytes,
      expiresAt: new Date(Date.now() + WORKSPACE_TRANSFER_TTL_MS).toISOString(),
    })
    if (receivedBytes !== job.expectedBytes) return job

    job = await updateJob(job, { state: "verifying" })
    return job
  })
  if (job.state === "verifying") {
    startWorkspaceImportVerification(job.id)
  }
  return job
}

export async function getWorkspaceImportJob(
  id: string
): Promise<WorkspaceImportJob> {
  const job = await readJob(id)
  if (job.kind !== "import")
    throw new Error("workspace transfer is not an import")
  if (job.state === "verifying") {
    startWorkspaceImportVerification(job.id)
  } else if (job.state === "preparing") {
    startWorkspaceImportPreparation(job.id, true)
  }
  return job
}

export async function getCurrentWorkspaceImportJob(): Promise<WorkspaceImportJob | null> {
  const job = await latestWorkspaceTransferJob("import")
  return job ? getWorkspaceImportJob(job.id) : null
}

export async function prepareWorkspaceImportJob(
  id: string
): Promise<WorkspaceImportJob> {
  const job = await withTransferLock(id, async () => {
    let job = await getWorkspaceImportJob(id)
    if (job.state === "ready") return job
    if (job.state === "preparing") return job
    if (
      (job.state !== "uploaded" && job.state !== "failed") ||
      !job.manifest ||
      !job.sha256 ||
      (job.expectedSha256 !== undefined && job.sha256 !== job.expectedSha256)
    ) {
      throw new Error("workspace import is not ready to prepare")
    }
    const preparation = createWorkspaceReplacementPaths()
    job = await updateJob(job, {
      state: "preparing",
      preparation,
      error: undefined,
    })
    return job
  })
  if (job.state === "preparing") {
    startWorkspaceImportPreparation(job.id, false)
  }
  return job
}

export async function waitForWorkspaceImportJob(
  id: string
): Promise<WorkspaceImportJob> {
  const job = await getWorkspaceImportJob(id)
  await importRuns.get(job.id)
  return getWorkspaceImportJob(id)
}

export async function replaceWorkspaceImportJob(
  id: string
): Promise<WorkspaceImportJob> {
  return withTransferLock(id, async () => {
    let job = await getWorkspaceImportJob(id)
    if (job.state !== "ready" || !job.prepared) {
      throw new Error("workspace import has not been prepared")
    }
    job = await updateJob(job, {
      state: "replacing",
      error: undefined,
    })
    const scheduled = job
    try {
      scheduleWorkspaceReplacement({
        options: { destinationCheckpointPaths: "local" },
        stagingPath: scheduled.prepared!.stagingPath,
        backupPath: scheduled.prepared!.backupPath,
        contentCheckpoint: scheduled.prepared!.contentCheckpoint,
        async onSucceeded() {
          let current = await getWorkspaceImportJob(id)
          const prepared = current.prepared
          current = await updateJob(current, {
            state: "complete",
            expiresAt: new Date(
              Date.now() + WORKSPACE_TRANSFER_TTL_MS
            ).toISOString(),
          })
          if (prepared) {
            await discardCommittedWorkspaceReplacement(
              prepared.stagingPath,
              prepared.backupPath
            )
            await updateJob(current, { prepared: undefined })
          }
          await rm(packagePath(id), { force: true })
        },
        async onFailed(error, options) {
          let current = await getWorkspaceImportJob(id)
          if (options?.recoveryIncomplete) {
            await updateJob(current, {
              state: "replacing",
              error: errorMessage(error),
            })
            return
          }
          if (current.state === "failed" && !current.prepared) return
          const prepared = current.prepared
          current = await updateJob(current, {
            state: "failed",
            error: errorMessage(error),
            expiresAt: new Date(
              Date.now() + WORKSPACE_TRANSFER_TTL_MS
            ).toISOString(),
          })
          if (prepared) {
            try {
              await importRollbackCleanupHookForTests?.()
              await discardRolledBackWorkspaceReplacement(
                prepared.stagingPath,
                prepared.backupPath
              )
            } catch (cleanupError) {
              console.error(
                "[workspace-transfer] rolled-back replacement cleanup failed:",
                cleanupError
              )
              return
            }
            await updateJob(current, { prepared: undefined })
          }
        },
      })
      return job
    } catch (error) {
      return await updateJob(job, {
        state: job.prepared ? "ready" : "failed",
        error: errorMessage(error),
        ...(!job.prepared
          ? {
              expiresAt: new Date(
                Date.now() + WORKSPACE_TRANSFER_TTL_MS
              ).toISOString(),
            }
          : {}),
      })
    }
  })
}

export async function recoverInterruptedWorkspaceTransferJobs(): Promise<
  string[]
> {
  await mkdir(transfersRoot(), { recursive: true, mode: 0o700 })
  const recovered: string[] = []
  for (const entry of await readdir(transfersRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("wtx_")) continue
    try {
      const job = await withTransferLock(entry.name, async () => {
        let job = await readJob(entry.name)
        if (job.kind === "clear") return job
        if (job.kind !== "import") return
        if (
          job.state === "verifying" ||
          (job.state === "uploading" && job.receivedBytes === job.expectedBytes)
        ) {
          if (job.state === "uploading") {
            job = await updateJob(job, { state: "verifying" })
          }
        }
        return job
      })
      if (!job) continue
      if (job.kind === "clear") {
        const clear = await import("./workspace-clear-jobs.ts")
        if (job.state === "complete" && job.prepared)
          await clear.finalizeWorkspaceClearJob(job.id)
        else if (job.state === "preparing")
          await clear.getWorkspaceClearJob(job.id)
        continue
      }
      if (job.state === "verifying") {
        startWorkspaceImportVerification(job.id)
        recovered.push(job.id)
      } else if (job.state === "preparing") {
        startWorkspaceImportPreparation(job.id, true)
        recovered.push(job.id)
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "workspace transfer not found"
      ) {
        continue
      }
      console.error(
        `[workspace-transfer] recovery failed for ${entry.name}:`,
        error
      )
    }
  }
  return recovered
}

export async function runWorkspaceTransferMaintenance(): Promise<void> {
  await cleanupAbandonedWorkspaceExportCaptures()
  await recoverInterruptedWorkspaceTransferJobs()
  await cleanupExpiredWorkspaceTransfers()
  await cleanupExpiredOperatorWorkspaceExports()
}

export function startWorkspaceTransferMaintenance(
  options: {
    schedule?: typeof setInterval
    cancel?: typeof clearInterval
    intervalMs?: number
    run?: () => Promise<void>
  } = {}
): () => Promise<void> {
  const schedule = options.schedule ?? setInterval
  const cancel = options.cancel ?? clearInterval
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000
  const maintenance = options.run ?? runWorkspaceTransferMaintenance
  let stopped = false
  let activeRun: Promise<void> | null = null
  const run = (): void => {
    if (stopped || activeRun) return
    const current = maintenance()
    activeRun = current
    void current
      .catch((error) =>
        console.error("[workspace-transfer] maintenance failed:", error)
      )
      .finally(() => {
        if (activeRun === current) activeRun = null
      })
  }
  run()
  const timer = schedule(run, intervalMs)
  timer.unref?.()
  return async () => {
    stopped = true
    cancel(timer)
    await activeRun
  }
}

/** Recovery consent is derived from the persisted failed job, never client-supplied paths. */
export async function recoverWorkspaceExportJob(
  id: string
): Promise<WorkspaceExportJob> {
  return withTransferLock(id, async () => {
    const job = await getWorkspaceExportJob(id)
    if (job.recoveryJobId) {
      try {
        return await getWorkspaceExportJob(job.recoveryJobId)
      } catch {
        /* interrupted before child creation */
      }
    }
    if (
      job.state !== "failed" ||
      !job.failure?.recoveryFingerprint ||
      Date.parse(job.expiresAt) <= Date.now()
    )
      throw new Error("workspace export recovery is not ready; export again")
    const childId = job.recoveryJobId ?? makeId()
    await updateJob(job, { recoveryJobId: childId })
    return createWorkspaceExportJob(job.history, {
      recoveryFingerprint: job.failure.recoveryFingerprint,
      id: childId,
    })
  })
}

/** Revocation is durable before deletion; open streams retain their existing lease. */
export async function revokeWorkspaceExports(): Promise<void> {
  await mkdir(transfersRoot(), { recursive: true, mode: 0o700 })
  for (const entry of await readdir(transfersRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("wtx_")) continue
    const job = await readJob(entry.name).catch(() => null)
    if (job?.kind !== "export") continue
    if (
      !job.workspaceKey &&
      job.manifest?.source.workspaceId !== ensureWorkspaceManifest().id
    )
      continue
    await withTransferLock(job.id, async () => {
      const current = await readJob(job.id)
      if (current.kind !== "export") return
      await updateJob(current, { revoked: true })
      if (!exportDownloadLeases.has(job.id))
        await rm(packagePath(job.id), { force: true })
    })
  }
}

export {
  makeId as createWorkspaceTransferId,
  writeJob as writeWorkspaceTransferJob,
  readJob as readWorkspaceTransferJob,
  updateJob as updateWorkspaceTransferJob,
  withTransferLock as withWorkspaceTransferLock,
  latestWorkspaceTransferJob,
}

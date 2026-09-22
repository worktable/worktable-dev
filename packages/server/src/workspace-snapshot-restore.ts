import { lstat, mkdir, open, rename } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { ensureAppDir } from "./app-storage.ts"
import { readBoundedRegularFile } from "./bounded-file.ts"
import { operatorSnapshotDirectory } from "./operator-snapshot.ts"
import { inspectWorkspaceSnapshot } from "./workspace-snapshot.ts"
import {
  createWorkspaceReplacementPaths,
  discardCommittedWorkspaceReplacement,
  discardRolledBackWorkspaceReplacement,
} from "./workspace-replacement.ts"
import {
  scheduleWorkspaceReplacement,
  withWorkspaceExportLease,
} from "./workspace-replacement-coordinator.ts"
import {
  inspectPortableWorkspaceTree,
  portableWorkspaceCheckpoint,
} from "./workspace-transfer-v2.ts"
import { getWorkspaceRoot } from "./workspace.ts"

export const LOCAL_OPERATOR_SNAPSHOT_RESTORE_PATH =
  "/internal/operator/workspace-snapshot-restore"
export interface SnapshotRestoreRequest {
  operationId: string
  workspaceId: string
  sourceCheckpoint: string
  safetyCheckpoint: string
}

/** Offline recovery runs before the replacement runtime's first server boot. */
export async function recoverMissingWorkspaceSnapshot(
  operationId: string,
  workspaceId: string,
  sourceCheckpoint: string
) {
  if (!/^[a-f0-9]{64}$/.test(sourceCheckpoint))
    throw new Error("invalid recovery checkpoint")
  const directory = await operatorSnapshotDirectory(operationId)
  const root = resolve(getWorkspaceRoot())
  return withCrossProcessLock(
    join(ensureAppDir(), "snapshot-recovery.lock"),
    { label: "Snapshot recovery", staleMs: 0, timeoutMs: 30000 },
    async () => {
      try {
        await lstat(root)
        throw new Error(
          "recovery requires an absent workspace; never overwrite an existing runtime"
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const downloaded = join(directory, "download")
      const manifest = await inspectWorkspaceSnapshot(downloaded, {
        workspaceId,
        sourceCheckpoint,
      })
      await rename(join(downloaded, "workspace"), root)
      const parent = await open(dirname(root), "r")
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
      return {
        operationId,
        state: "recovered" as const,
        workspaceId: manifest.workspaceId,
        sourceCheckpoint: manifest.sourceCheckpoint,
      }
    }
  )
}
interface RestoreJob extends SnapshotRestoreRequest {
  id: string
  kind: "snapshot"
  state: "replacing" | "complete" | "failed"
  updatedAt: string
  expiresAt: string
  error?: string
  prepared: ReturnType<typeof createWorkspaceReplacementPaths>
}

/** Read durable identity-bound status without depending on a live HTTP listener. */
export async function readWorkspaceSnapshotRestoreStatus(
  request: SnapshotRestoreRequest
) {
  await operatorSnapshotDirectory(request.operationId)
  let job: RestoreJob
  try {
    job = JSON.parse(
      await readBoundedRegularFile(
        join(
          ensureAppDir(),
          "workspace-transfers",
          "jobs",
          `wss_${request.operationId}`,
          "job.json"
        ),
        32 * 1024
      )
    ) as RestoreJob
  } catch (error) {
    if (
      error instanceof Error &&
      "reason" in error &&
      error.reason === "missing"
    )
      return { operationId: request.operationId, state: "missing" as const }
    throw error
  }
  if (
    job.id !== `wss_${request.operationId}` ||
    job.kind !== "snapshot" ||
    job.workspaceId !== request.workspaceId ||
    job.sourceCheckpoint !== request.sourceCheckpoint ||
    job.safetyCheckpoint !== request.safetyCheckpoint ||
    !["replacing", "complete", "failed"].includes(job.state)
  )
    throw new Error("restore status identity mismatch")
  return { operationId: request.operationId, state: job.state }
}

async function saveJob(directory: string, job: RestoreJob): Promise<void> {
  job.updatedAt = new Date().toISOString()
  const path = join(directory, `job-${process.pid}.partial`)
  const handle = await open(path, "w", 0o600)
  try {
    await handle.writeFile(JSON.stringify(job))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(path, join(directory, "job.json"))
  const dir = await open(directory, "r")
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

/**
 * The Cloud caller first stores a safety capture durably. Cutover checks that
 * exact full tree after stopping writers. An intervening edit aborts safely;
 * uploading a safety snapshot never requires holding writers across network I/O.
 */
export async function restoreLiveWorkspaceSnapshot(
  request: SnapshotRestoreRequest
) {
  if (
    !/^[a-f0-9]{64}$/.test(request.sourceCheckpoint) ||
    !/^[a-f0-9]{64}$/.test(request.safetyCheckpoint) ||
    !request.workspaceId
  )
    throw new Error("invalid checkpoint restore request")
  const operatorDirectory = await operatorSnapshotDirectory(request.operationId)
  const id = `wss_${request.operationId}`
  const jobDirectory = join(ensureAppDir(), "workspace-transfers", "jobs", id)
  await mkdir(jobDirectory, { recursive: true, mode: 0o700 })
  const info = await lstat(jobDirectory)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("invalid restore job directory")
  return withCrossProcessLock(
    join(jobDirectory, "prepare.lock"),
    { label: "Snapshot restore", staleMs: 0, timeoutMs: 30000 },
    async () => {
      try {
        const existing = JSON.parse(
          await readBoundedRegularFile(
            join(jobDirectory, "job.json"),
            32 * 1024
          )
        ) as RestoreJob
        if (
          existing.sourceCheckpoint !== request.sourceCheckpoint ||
          existing.safetyCheckpoint !== request.safetyCheckpoint ||
          existing.workspaceId !== request.workspaceId
        )
          throw new Error("restore operation id is already in use")
        return { operationId: request.operationId, state: existing.state }
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "reason" in error &&
            error.reason === "missing"
          )
        )
          throw error
      }
      return withWorkspaceExportLease(async () => {
        const downloaded = join(operatorDirectory, "download")
        const snapshot = await inspectWorkspaceSnapshot(downloaded, request)
        const job: RestoreJob = {
          ...request,
          id,
          kind: "snapshot",
          state: "replacing",
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          prepared: createWorkspaceReplacementPaths(),
        }
        // Recovery knows both sibling paths before any move or live-root mutation.
        await saveJob(jobDirectory, job)
        try {
          await rename(join(downloaded, "workspace"), job.prepared.stagingPath)
          scheduleWorkspaceReplacement({
            ...job.prepared,
            contentCheckpoint: snapshot.contentCheckpoint,
            options: {
              manifest: "checkpoint",
              expectedSourceCheckpoint: snapshot.sourceCheckpoint,
              validateBeforeSwap: async () => {
                const live = portableWorkspaceCheckpoint(
                  await inspectPortableWorkspaceTree(getWorkspaceRoot())
                )
                if (live !== request.safetyCheckpoint)
                  throw new Error(
                    "workspace changed after its safety backup; retry the restore"
                  )
              },
            },
            onSucceeded: async () => {
              job.state = "complete"
              await saveJob(jobDirectory, job)
              await discardCommittedWorkspaceReplacement(
                job.prepared.stagingPath,
                job.prepared.backupPath
              )
            },
            onFailed: async (_error, options) => {
              // An ambiguous swap remains recoverable and fenced until startup.
              if (options?.recoveryIncomplete) return
              job.state = "failed"
              job.error =
                "Checkpoint restore failed; the current workspace was retained."
              await saveJob(jobDirectory, job)
              await discardRolledBackWorkspaceReplacement(
                job.prepared.stagingPath,
                job.prepared.backupPath
              )
            },
          })
        } catch (error) {
          job.state = "failed"
          job.error =
            "Checkpoint preparation failed; the current workspace was retained."
          await saveJob(jobDirectory, job)
          await discardRolledBackWorkspaceReplacement(
            job.prepared.stagingPath,
            job.prepared.backupPath
          )
          throw error
        }
        return { operationId: request.operationId, state: "replacing" as const }
      })
    }
  )
}

import {
  resetTeamSpacePoliciesAfterContentReplacement,
  prepareTeamSpacePolicyResetForMissingRootRecovery,
  finalizePendingTeamSpacePolicyReset,
} from "./team-policy.ts"
import {
  restoreTeamBackupState,
  TeamBackupStateSchema,
  type TeamBackupState,
} from "./team-backup.ts"
import { lstat, mkdir, open, rename } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { ensureAppDir } from "./app-storage.ts"
import { readBoundedRegularFile } from "./bounded-file.ts"
import { operatorSnapshotDirectory } from "./operator-snapshot.ts"
import {
  restoreSharingPolicy,
  finalizeRestoredSharingPolicy,
} from "./share-links-store.ts"
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
  calculateWorkspaceContentCheckpoint,
} from "./workspace-transfer-v2.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { convertStagedWorkspaceStorageV2 } from "./document-storage-migration-v2.ts"
import type { VisitorCommentsCheckpoint } from "@worktable/hosted-contract"
import {
  holdVisitorCommentsAtCheckpoint,
  restoreVisitorCommentBackup,
  VisitorCommentsCheckpointSchema,
  VisitorCommentBackupStateSchema,
  type VisitorCommentBackupState,
} from "./visitor-comment-backup.ts"

export const LOCAL_OPERATOR_SNAPSHOT_RESTORE_PATH =
  "/internal/operator/workspace-snapshot-restore"
export interface SnapshotRestoreRequest {
  operationId: string
  workspaceId: string
  sourceCheckpoint: string
  safetyCheckpoint: string
  /** Missing means an older caller, safe only when no private store exists. */
  safetyVisitorCommentsCheckpoint?: VisitorCommentsCheckpoint | null
}

function privateCheckpointIdentity(value: unknown): string | undefined {
  return value === undefined
    ? undefined
    : JSON.stringify(VisitorCommentsCheckpointSchema.nullable().parse(value))
}

/** Offline recovery runs before the replacement runtime's first server boot. */
let missingRootRecoveryHookForTests: (() => void) | null = null
export function setMissingRootRecoveryHookForTests(
  hook: (() => void) | null
): void {
  missingRootRecoveryHookForTests = hook
}

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
      await convertStagedWorkspaceStorageV2(join(downloaded, "workspace"))
      if (!manifest.teamState)
        prepareTeamSpacePolicyResetForMissingRootRecovery(manifest.workspaceId)
      // The owner's share link policy comes back only onto a machine with no
      // links store, so it never replaces a newer one; links never come back.
      // An unpublished restore stays retryable, including a different snapshot.
      await restoreSharingPolicy(manifest.sharingPolicy ?? null)
      // Publish private state first while there is no live workspace. A crash
      // before the rename leaves recovery retryable; after it, both are present.
      await restoreVisitorCommentBackup(
        downloaded,
        manifest.visitorComments ?? null,
        manifest.workspaceId
      )
      await rename(join(downloaded, "workspace"), root)
      finalizeRestoredSharingPolicy()
      missingRootRecoveryHookForTests?.()
      if (manifest.teamState)
        await restoreTeamBackupState(downloaded, manifest.teamState)
      else finalizePendingTeamSpacePolicyReset()
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
  teamState?: TeamBackupState
  teamRestored?: boolean
  visitorComments?: VisitorCommentBackupState
  visitorCommentsRestored?: boolean
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
    privateCheckpointIdentity(job.safetyVisitorCommentsCheckpoint) !==
      privateCheckpointIdentity(request.safetyVisitorCommentsCheckpoint) ||
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
  privateCheckpointIdentity(request.safetyVisitorCommentsCheckpoint)
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
          privateCheckpointIdentity(
            existing.safetyVisitorCommentsCheckpoint
          ) !==
            privateCheckpointIdentity(
              request.safetyVisitorCommentsCheckpoint
            ) ||
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
          ...(snapshot.teamState ? { teamState: snapshot.teamState } : {}),
          ...(snapshot.visitorComments
            ? { visitorComments: snapshot.visitorComments }
            : {}),
          state: "replacing",
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          prepared: createWorkspaceReplacementPaths(),
        }
        // Recovery knows both sibling paths before any move or live-root mutation.
        await saveJob(jobDirectory, job)
        let releasePrivateWrites: (() => void) | undefined
        try {
          await rename(join(downloaded, "workspace"), job.prepared.stagingPath)
          await convertStagedWorkspaceStorageV2(job.prepared.stagingPath)
          const convertedSourceCheckpoint = portableWorkspaceCheckpoint(
            await inspectPortableWorkspaceTree(job.prepared.stagingPath)
          )
          scheduleWorkspaceReplacement({
            ...job.prepared,
            contentCheckpoint: await calculateWorkspaceContentCheckpoint(
              job.prepared.stagingPath
            ),
            options: {
              manifest: "checkpoint",
              expectedSourceCheckpoint: convertedSourceCheckpoint,
              validateBeforeSwap: async () => {
                const live = portableWorkspaceCheckpoint(
                  await inspectPortableWorkspaceTree(getWorkspaceRoot())
                )
                if (live !== request.safetyCheckpoint)
                  throw new Error(
                    "workspace changed after its safety backup; retry the restore"
                  )
                releasePrivateWrites = holdVisitorCommentsAtCheckpoint(
                  request.safetyVisitorCommentsCheckpoint
                )
              },
            },
            onCommitted: async () => {
              if (job.teamState) {
                await restoreTeamBackupState(downloaded, job.teamState)
                job.teamRestored = true
                await saveJob(jobDirectory, job)
              } else resetTeamSpacePoliciesAfterContentReplacement()
              await restoreVisitorCommentBackup(
                downloaded,
                job.visitorComments ?? null,
                job.workspaceId
              )
              job.visitorCommentsRestored = true
              await saveJob(jobDirectory, job)
              releasePrivateWrites?.()
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
              releasePrivateWrites?.()
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
          releasePrivateWrites?.()
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

/** Complete app-private restore before boot reopens a committed replacement. */
export async function finalizeCommittedTeamSnapshotRestore(
  jobId: string
): Promise<void> {
  if (!/^wss_[A-Za-z0-9_-]{8,80}$/.test(jobId)) return
  const directory = join(ensureAppDir(), "workspace-transfers", "jobs", jobId)
  const job = JSON.parse(
    await readBoundedRegularFile(join(directory, "job.json"), 128 * 1024)
  ) as RestoreJob
  if (job.kind !== "snapshot" || job.id !== jobId) return
  const operationDirectory = await operatorSnapshotDirectory(job.operationId)
  if (!job.teamRestored) {
    if (job.teamState)
      await restoreTeamBackupState(
        join(operationDirectory, "download"),
        TeamBackupStateSchema.parse(job.teamState)
      )
    else resetTeamSpacePoliciesAfterContentReplacement()
    job.teamRestored = true
    await saveJob(directory, job)
  }
  if (!job.visitorCommentsRestored) {
    const state = job.visitorComments
      ? VisitorCommentBackupStateSchema.parse(job.visitorComments)
      : null
    await restoreVisitorCommentBackup(
      join(operationDirectory, "download"),
      state,
      job.workspaceId
    )
    job.visitorCommentsRestored = true
    await saveJob(directory, job)
  }
}

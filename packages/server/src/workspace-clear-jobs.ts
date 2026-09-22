import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  clearedWorkspaceManifest,
  ensureWorkspaceManifest,
  getWorkspaceRoot,
  workspaceCacheKey,
  type WorkspaceManifest,
} from "./workspace.ts"
import { calculateLocalWorkspaceContentCheckpoints } from "./workspace-transfer-v2.ts"
import { withWorkspaceExportSnapshot } from "./workspace-export-coordinator.ts"
import {
  scheduleWorkspaceReplacement,
  withWorkspaceExportLease,
} from "./workspace-replacement-coordinator.ts"
import {
  createWorkspaceReplacementPaths,
  discardCommittedWorkspaceReplacement,
  discardPreparedWorkspaceReplacement,
  discardRolledBackWorkspaceReplacement,
  type WorkspaceReplacementPaths,
} from "./workspace-replacement.ts"
import {
  activeClearJobs,
  createWorkspaceTransferId,
  latestWorkspaceTransferJob,
  readWorkspaceTransferJob,
  revokeWorkspaceExports,
  updateWorkspaceTransferJob,
  withWorkspaceTransferLock,
  writeWorkspaceTransferJob,
  WORKSPACE_TRANSFER_TTL_MS,
  type TransferJobBase,
} from "./workspace-transfer-jobs.ts"

export interface WorkspaceClearJob extends TransferJobBase {
  kind: "clear"
  state: "preparing" | "ready" | "replacing" | "complete" | "failed"
  workspaceId: string
  workspaceName: string
  confirmationText: string
  reviewRevision?: string
  files?: number
  bytes?: number
  cleanupPending?: boolean
  preparation?: WorkspaceReplacementPaths
  prepared?: WorkspaceReplacementPaths & {
    contentCheckpoint: string
    destinationCheckpoint: string
  }
}

function startPreparation(id: string): void {
  if (activeClearJobs.has(id)) return
  activeClearJobs.add(id)
  // The initiating HTTP request must finish before the snapshot barrier drains requests.
  setTimeout(() => {
    void withWorkspaceTransferLock(id, async () => {
      const stored = await readWorkspaceTransferJob(id)
      if (
        stored.kind !== "clear" ||
        stored.state !== "preparing" ||
        !stored.preparation
      )
        return
      let job: WorkspaceClearJob = stored
      const paths = stored.preparation
      try {
        await discardPreparedWorkspaceReplacement(paths.stagingPath)
        const reviewed = await withWorkspaceExportLease(() =>
          withWorkspaceExportSnapshot(async () => {
            const manifest = JSON.parse(
              await readFile(
                join(getWorkspaceRoot(), "worktable.workspace.json"),
                "utf8"
              )
            ) as WorkspaceManifest
            if (
              manifest.id !== job.workspaceId ||
              manifest.name !== job.workspaceName
            )
              throw new Error("Workspace identity changed. Review clear again.")
            const checkpoint =
              await calculateLocalWorkspaceContentCheckpoints(
                getWorkspaceRoot()
              )
            return { manifest, checkpoint }
          })
        )
        await mkdir(paths.stagingPath, { mode: 0o700 })
        for (const name of ["spaces", "threads", "versions"])
          await mkdir(join(paths.stagingPath, name))
        await writeFile(
          join(paths.stagingPath, "worktable.workspace.json"),
          JSON.stringify(clearedWorkspaceManifest(reviewed.manifest), null, 2) +
            "\n",
          { mode: 0o600 }
        )
        const staged = await calculateLocalWorkspaceContentCheckpoints(
          paths.stagingPath
        )
        job = await updateWorkspaceTransferJob(job, {
          state: "ready",
          preparation: undefined,
          prepared: {
            ...paths,
            contentCheckpoint: staged.workspaceContentCheckpoint,
            destinationCheckpoint:
              reviewed.checkpoint.workspaceContentCheckpoint,
          },
          files: Math.max(0, reviewed.checkpoint.files - 1),
          bytes: reviewed.checkpoint.bytes,
          reviewRevision: randomBytes(24).toString("base64url"),
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        })
      } catch (error) {
        await discardPreparedWorkspaceReplacement(paths.stagingPath)
        await updateWorkspaceTransferJob(job, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          preparation: undefined,
        })
      }
    })
      .catch((error) =>
        console.error("[workspace-clear] preparation failed", error)
      )
      .finally(() => activeClearJobs.delete(id))
  }, 0)
}

export async function createWorkspaceClearJob(): Promise<WorkspaceClearJob> {
  const current = await getCurrentWorkspaceClearJob()
  if (
    current &&
    ["preparing", "ready", "replacing"].includes(current.state) &&
    Date.parse(current.expiresAt) > Date.now()
  )
    return current
  const workspace = ensureWorkspaceManifest()
  const now = new Date().toISOString()
  const job: WorkspaceClearJob = {
    version: 1,
    id: createWorkspaceTransferId(),
    kind: "clear",
    state: "preparing",
    workspaceKey: workspaceCacheKey(),
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    confirmationText: `CLEAR ${workspace.name}`,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + WORKSPACE_TRANSFER_TTL_MS).toISOString(),
    preparation: createWorkspaceReplacementPaths(),
  }
  await writeWorkspaceTransferJob(job)
  startPreparation(job.id)
  return job
}

export async function getWorkspaceClearJob(
  id: string
): Promise<WorkspaceClearJob> {
  const job = await readWorkspaceTransferJob(id)
  if (job.kind !== "clear") throw new Error("workspace clear not found")
  if (job.state === "preparing") startPreparation(id)
  return job
}

export async function getCurrentWorkspaceClearJob(): Promise<WorkspaceClearJob | null> {
  const job = await latestWorkspaceTransferJob("clear")
  return job ? getWorkspaceClearJob(job.id) : null
}

export async function finalizeWorkspaceClearJob(id: string): Promise<void> {
  await withWorkspaceTransferLock(id, async () => {
    const job = await getWorkspaceClearJob(id)
    if (job.state !== "complete" || !job.prepared) return
    // Keep the receipt and backup until all required cleanup is durable.
    await revokeWorkspaceExports()
    await discardCommittedWorkspaceReplacement(
      job.prepared.stagingPath,
      job.prepared.backupPath
    )
    await updateWorkspaceTransferJob(job, {
      prepared: undefined,
      cleanupPending: false,
    })
  })
}

export async function confirmWorkspaceClearJob(
  id: string,
  confirmation: unknown,
  reviewRevision: unknown
): Promise<WorkspaceClearJob> {
  return withWorkspaceTransferLock(id, async () => {
    let job = await getWorkspaceClearJob(id)
    if (
      confirmation !== job.confirmationText ||
      reviewRevision !== job.reviewRevision
    )
      throw new Error(
        "Type the exact confirmation phrase to clear this workspace."
      )
    if (job.state === "replacing" || job.state === "complete") return job
    const workspace = ensureWorkspaceManifest()
    if (
      job.state !== "ready" ||
      !job.prepared ||
      Date.parse(job.expiresAt) <= Date.now() ||
      workspace.id !== job.workspaceId ||
      workspace.name !== job.workspaceName
    )
      throw new Error("Clear review expired. Review the workspace again.")
    job = await updateWorkspaceTransferJob(job, {
      state: "replacing",
      error: undefined,
    })
    const prepared = job.prepared!
    try {
      scheduleWorkspaceReplacement({
        ...prepared,
        options: {
          checkpointPaths: "local",
          destinationCheckpointPaths: "local",
          manifest: "clear-content",
        },
        expectedDestinationContentCheckpoint: prepared.destinationCheckpoint,
        async onCommitted() {
          const current = await getWorkspaceClearJob(id)
          await updateWorkspaceTransferJob(current, {
            state: "complete",
            cleanupPending: true,
            expiresAt: new Date(
              Date.now() + WORKSPACE_TRANSFER_TTL_MS
            ).toISOString(),
          })
          await revokeWorkspaceExports()
        },
        async onSucceeded() {
          await finalizeWorkspaceClearJob(id)
        },
        async onFailed(error, options) {
          const current = await getWorkspaceClearJob(id)
          if (options?.recoveryIncomplete) {
            await updateWorkspaceTransferJob(current, { error: String(error) })
            return
          }
          const failed = await updateWorkspaceTransferJob(current, {
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
            expiresAt: new Date(
              Date.now() + WORKSPACE_TRANSFER_TTL_MS
            ).toISOString(),
          })
          await discardRolledBackWorkspaceReplacement(
            prepared.stagingPath,
            prepared.backupPath
          )
          await updateWorkspaceTransferJob(failed, { prepared: undefined })
        },
      })
    } catch (error) {
      return updateWorkspaceTransferJob(job, {
        state: "ready",
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return job
  })
}

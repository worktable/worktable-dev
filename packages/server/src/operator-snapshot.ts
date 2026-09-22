import { mkdir, lstat } from "node:fs/promises"
import { join } from "node:path"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { ensureAppDir } from "./app-storage.ts"
import {
  writeWorkspaceSnapshot,
  inspectWorkspaceSnapshot,
} from "./workspace-snapshot.ts"
import { withWorkspaceExportSnapshot } from "./workspace-export-coordinator.ts"
import { withWorkspaceExportLease } from "./workspace-replacement-coordinator.ts"

export const LOCAL_OPERATOR_SNAPSHOT_PATH =
  "/internal/operator/workspace-snapshot"
export const SNAPSHOT_OPERATION_ID = /^[A-Za-z0-9_-]{8,80}$/

/** No caller-selected path reaches the local maintenance capability. */
export async function operatorSnapshotDirectory(
  operationId: string
): Promise<string> {
  if (!SNAPSHOT_OPERATION_ID.test(operationId))
    throw new Error("invalid snapshot operation id")
  const root = join(ensureAppDir(), "operator-snapshots")
  const directory = join(root, operationId)
  for (const path of [root, directory]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("snapshot staging must be a real directory")
  }
  return directory
}

/** Idempotent capture. An existing result is verified before it is adopted. */
export async function writeLiveOperatorWorkspaceSnapshot(
  operationId: string,
  maxCaptureMs?: number
) {
  if (
    maxCaptureMs !== undefined &&
    (!Number.isSafeInteger(maxCaptureMs) ||
      maxCaptureMs < 1 ||
      maxCaptureMs > 30000)
  )
    throw new Error("capture budget must be between 1 and 30000 milliseconds")
  const directory = await operatorSnapshotDirectory(operationId)
  const destination = join(directory, "capture")
  return withCrossProcessLock(
    join(directory, "capture.lock"),
    { label: "Snapshot capture", staleMs: 0, timeoutMs: 30000 },
    () =>
      withWorkspaceExportLease(async () => {
        let exists = false
        try {
          await lstat(destination)
          exists = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        let captureBarrierMs: number | undefined
        const cancellation =
          maxCaptureMs === undefined ? undefined : new AbortController()
        const startedAt = performance.now()
        const manifest = exists
          ? await inspectWorkspaceSnapshot(destination)
          : await writeWorkspaceSnapshot(destination, {
              signal: cancellation?.signal,
              withCaptureBarrier: async (capture) => {
                const timer = cancellation
                  ? setTimeout(
                      () =>
                        cancellation.abort(
                          new Error("Snapshot capture budget exceeded")
                        ),
                      maxCaptureMs
                    )
                  : undefined
                try {
                  return await withWorkspaceExportSnapshot(capture, {
                    onBarrierComplete: (duration) => {
                      captureBarrierMs = duration
                    },
                  })
                } finally {
                  clearTimeout(timer)
                }
              },
            })
        return {
          command: "workspace-snapshot" as const,
          operationId,
          destination,
          snapshotId: manifest.snapshotId,
          workspaceId: manifest.workspaceId,
          workspaceStorageVersion: manifest.workspaceStorageVersion,
          sourceCheckpoint: manifest.sourceCheckpoint,
          contentCheckpoint: manifest.contentCheckpoint,
          capturedAt: manifest.capturedAt,
          captureBarrierMs,
          publicationMs: performance.now() - startedAt,
          files: manifest.files.length,
          bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
        }
      })
  )
}

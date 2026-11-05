import { z } from "zod"

const checkpoint = z.object({
  id: z.string(),
  capturedAt: z.number(),
  bytes: z.number(),
  reason: z.enum(["automatic", "manual", "safety"]),
})
const operationState = z.enum(["running", "complete", "failed", "attention"])
export const CloudBackupStatus = z.object({
  workspaceName: z.string(),
  automatic: z.boolean(),
  intervalMinutes: z.number(),
  retentionDays: z.number().nullable(),
  canCapture: z.boolean(),
  canRestore: z.boolean(),
  runtimeAvailable: z.boolean(),
  latest: checkpoint.nullable(),
  checkpoints: z.array(checkpoint),
  cursor: z.string().nullable(),
  selected: checkpoint.nullable(),
  backup: z.object({ state: operationState, updatedAt: z.number() }).nullable(),
  restore: z
    .object({
      state: operationState,
      phase: z.enum(["downloading", "safeguarding", "applying"]),
      updatedAt: z.number(),
      checkpointAt: z.number(),
      safetyId: z.string().nullable(),
    })
    .nullable(),
})
export type CloudBackupStatus = z.infer<typeof CloudBackupStatus>

export interface BackupWorkerInput {
  version: 1
  jobId: string
  kind: "backup" | "download" | "maintain"
  workspaceId: string
  repository: string
  repositoryPassword: string
  repositoryId?: string
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
  }
  expiresAt: number
  snapshotId?: string
  sourceCheckpoint?: string
  captureBudgetMs?: number
  /** Maintain: catalogued snapshot ids to forget. */
  forget?: string[]
  /** Maintain: every snapshot id the catalog still holds. Never forgotten. */
  keep?: string[]
  /**
   * Maintain, epoch ms: a snapshot in neither list whose restic time is
   * earlier is an uncatalogued partial, and is forgotten. At most
   * `expiresAt` minus 24 hours.
   */
  orphanBefore?: number
  /** Maintain: `restic check --read-data-subset`: "5%", or "n/t" with t <= 256. */
  readDataSubset?: string
  /**
   * Maintain: the newest catalogued checkpoint, read back after the prune.
   * Required whenever anything would be forgotten.
   */
  verify?: { snapshotId: string; sourceCheckpoint: string }
}
export interface VisitorCommentsCheckpoint {
  incarnation: string
  revision: number
}

export interface BackupWorkerResult {
  version: 1
  jobId: string
  kind: "backup" | "download"
  state: "complete"
  workspaceId: string
  repositoryId: string
  snapshotId: string
  captureId: string
  sourceCheckpoint: string
  contentCheckpoint: string
  /** Null records that the safety capture had no private comment store. */
  visitorCommentsCheckpoint?: VisitorCommentsCheckpoint | null
  workspaceStorageVersion: 1 | 2
  capturedAt: string
  bytes: number
  completedAt: string
  /** Where a backup spent its time. Optional; nothing depends on it. */
  diagnostics?: BackupWorkerDiagnostics
}

export interface BackupWorkerMaintainResult {
  version: 1
  jobId: string
  kind: "maintain"
  state: "complete"
  workspaceId: string
  repositoryId: string
  /** Catalogued ids actually forgotten. */
  forgotten: string[]
  /** Ids in `forget` that were already gone from the repository. */
  missing: string[]
  /** Uncatalogued ids forgotten. */
  orphans: string[]
  /** Snapshots left after the prune. */
  remaining: number
  /** "structure" reads no file data; "subset" also read `readDataSubset`. */
  checked: "structure" | "subset"
  /** The snapshot whose manifest was read back, or null when none was asked. */
  verified: string | null
  completedAt: string
}

/** Durations in milliseconds, sizes in bytes. */
export interface BackupWorkerDiagnostics {
  capture: {
    ms: number
    /** "reflink" or "copy", when the server reported how it captured. */
    method?: string
    files?: number
    bytes?: number
    /** Files whose bytes were hashed; the rest reused an earlier hash. */
    hashedFiles?: number
    hashedBytes?: number
    barrierMs?: number
  }
  inspect: {
    ms: number
    hashedFiles?: number
    hashedBytes?: number
  }
  upload: {
    ms: number
    /** Unchanged files were taken from the previous snapshot unread. */
    incremental: boolean
    filesNew?: number
    filesChanged?: number
    filesUnmodified?: number
    bytesAdded?: number
  }
}

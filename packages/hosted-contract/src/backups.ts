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
  kind: "backup" | "download"
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
}
export interface BackupWorkerResult {
  version: 1
  jobId: string
  kind: BackupWorkerInput["kind"]
  state: "complete"
  workspaceId: string
  repositoryId: string
  snapshotId: string
  captureId: string
  sourceCheckpoint: string
  contentCheckpoint: string
  workspaceStorageVersion: 1 | 2
  capturedAt: string
  bytes: number
  completedAt: string
}

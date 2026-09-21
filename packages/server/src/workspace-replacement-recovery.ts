import {
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { getAppDir } from "./app-storage.ts"
import { WORKSPACE_TRANSFER_TTL_MS } from "./workspace-transfer-jobs.ts"
import { removeWorkspaceTreeSync } from "./workspace-tree-cleanup.ts"
import { getWorkspaceRoot } from "./workspace.ts"

export const DOCUMENT_STORAGE_MIGRATION_RECEIPT_TTL_MS =
  7 * 24 * 60 * 60 * 1_000

interface RecoverableJob {
  id: string
  kind: "import" | "document-storage-v2"
  state: string
  updatedAt: string
  expiresAt: string
  error?: string
  prepared?: {
    stagingPath?: string
    backupPath?: string
  }
  recovery?: {
    state: "complete"
    backupPath: string
  }
}

export interface WorkspaceReplacementRecovery {
  id: string
  kind: RecoverableJob["kind"]
  state: "complete" | "failed"
  backupPath?: string
}

function realDirectory(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function realFile(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function generatedArtifactPath(
  path: string,
  workspaceParent: string,
  workspaceName: string,
  kind: "replace" | "backup"
): boolean {
  const prefix = `.${workspaceName}.worktable-${kind}-`
  return (
    dirname(path) === workspaceParent &&
    basename(path).startsWith(prefix) &&
    /^[0-9a-f]{20}$/u.test(basename(path).slice(prefix.length))
  )
}

function updateJob(path: string, job: RecoverableJob): void {
  const updated = {
    ...job,
    updatedAt: new Date().toISOString(),
  }
  const temporary = `${path}.${process.pid}.recovery`
  writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(temporary, path)
}

function finishRecovery(
  path: string,
  job: RecoverableJob,
  state: "complete" | "failed",
  error: string | undefined,
  cleanup: () => void
): void {
  job.state = state
  job.expiresAt = new Date(
    Date.now() +
      (state === "complete" && job.kind === "document-storage-v2"
        ? DOCUMENT_STORAGE_MIGRATION_RECEIPT_TTL_MS
        : WORKSPACE_TRANSFER_TTL_MS)
  ).toISOString()
  if (
    state === "complete" &&
    job.kind === "document-storage-v2" &&
    job.prepared?.backupPath
  ) {
    job.recovery = {
      state: "complete",
      backupPath: `${resolve(job.prepared.backupPath)}.committed`,
    }
  }
  if (error) job.error = error
  else delete job.error
  // The terminal status becomes durable before its transaction marker is
  // removed. A crash during cleanup therefore retries cleanup, never
  // reclassifies the workspace.
  updateJob(path, job)
  cleanup()
  delete job.prepared
  updateJob(path, job)
}

function recoveryResult(job: RecoverableJob): WorkspaceReplacementRecovery {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state === "complete" ? "complete" : "failed",
    ...(job.recovery?.backupPath
      ? { backupPath: job.recovery.backupPath }
      : {}),
  }
}

/**
 * Restore the old workspace after a process/host crash inside the two-rename
 * replacement window. This runs before workspace adoption can create a fresh
 * manifest in a temporarily absent root.
 */
export function recoverInterruptedWorkspaceReplacements(): string[]
export function recoverInterruptedWorkspaceReplacements(options: {
  details: true
}): WorkspaceReplacementRecovery[]
export function recoverInterruptedWorkspaceReplacements(options?: {
  details: true
}): string[] | WorkspaceReplacementRecovery[] {
  const workspaceRoot = resolve(getWorkspaceRoot())
  const workspaceParent = dirname(workspaceRoot)
  const workspaceName = basename(workspaceRoot)
  const jobsRoot = join(getAppDir(), "workspace-transfers", "jobs")
  const recovered: WorkspaceReplacementRecovery[] = []

  if (!realDirectory(jobsRoot)) return recovered

  for (const entry of readdirSync(jobsRoot, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      (!entry.name.startsWith("wtx_") && !entry.name.startsWith("wsm_"))
    ) {
      continue
    }
    const path = join(jobsRoot, entry.name, "job.json")
    let job: RecoverableJob
    try {
      job = JSON.parse(readFileSync(path, "utf8")) as RecoverableJob
    } catch {
      continue
    }
    if (
      job.id !== entry.name ||
      (job.kind !== "import" && job.kind !== "document-storage-v2") ||
      !["replacing", "complete", "failed"].includes(job.state)
    ) {
      continue
    }
    if (!job.prepared) {
      if (Date.parse(job.expiresAt) <= Date.now()) {
        rmSync(dirname(path), { recursive: true, force: true })
        continue
      }
      const committed = resolve(job.recovery?.backupPath ?? "")
      if (
        options?.details &&
        job.kind === "document-storage-v2" &&
        job.state === "complete" &&
        job.recovery?.state === "complete" &&
        committed.endsWith(".committed") &&
        generatedArtifactPath(
          committed.slice(0, -".committed".length),
          workspaceParent,
          workspaceName,
          "backup"
        ) &&
        realDirectory(committed)
      ) {
        recovered.push(recoveryResult(job))
      }
      continue
    }
    const staging = resolve(job.prepared?.stagingPath ?? "")
    const backup = resolve(job.prepared?.backupPath ?? "")
    if (
      !generatedArtifactPath(
        staging,
        workspaceParent,
        workspaceName,
        "replace"
      ) ||
      !generatedArtifactPath(backup, workspaceParent, workspaceName, "backup")
    ) {
      continue
    }

    const committed = `${backup}.committed`
    const rollbackMarker = `${backup}.rollback`
    const failedReplacement = `${staging}.failed`
    const cleanupCommitted = () => {
      if (job.kind === "import") removeWorkspaceTreeSync(committed)
      rmSync(rollbackMarker, { force: true })
      removeWorkspaceTreeSync(failedReplacement)
    }
    const cleanupRolledBack = () => {
      removeWorkspaceTreeSync(staging)
      removeWorkspaceTreeSync(failedReplacement)
      rmSync(rollbackMarker, { force: true })
    }

    if (job.state === "complete") {
      finishRecovery(path, job, "complete", undefined, cleanupCommitted)
      recovered.push(recoveryResult(job))
      continue
    }
    if (job.state === "failed") {
      finishRecovery(path, job, "failed", job.error, cleanupRolledBack)
      recovered.push(recoveryResult(job))
      continue
    }

    const activeExists = realDirectory(workspaceRoot)
    const stagingExists = realDirectory(staging)
    const backupExists = realDirectory(backup)
    const committedExists = realDirectory(committed)
    const rollbackStarted = realFile(rollbackMarker)

    if (rollbackStarted) {
      const interruptedNew = `${staging}.interrupted-${process.pid}`
      removeWorkspaceTreeSync(interruptedNew)
      if (backupExists) {
        if (activeExists) renameSync(workspaceRoot, interruptedNew)
        renameSync(backup, workspaceRoot)
      }
      removeWorkspaceTreeSync(interruptedNew)
      finishRecovery(
        path,
        job,
        "failed",
        "Worktable completed an interrupted rollback; the original workspace is active.",
        cleanupRolledBack
      )
      recovered.push(recoveryResult(job))
      continue
    }
    if (committedExists) {
      if (!activeExists) {
        // The imported tree disappeared after the commit point. The only
        // recoverable content is the old backup, so restore it and report
        // failure rather than adopting an absent workspace.
        renameSync(committed, workspaceRoot)
        finishRecovery(
          path,
          job,
          "failed",
          "The committed imported workspace was missing; Worktable restored the original workspace.",
          cleanupRolledBack
        )
      } else {
        finishRecovery(path, job, "complete", undefined, cleanupCommitted)
      }
      recovered.push(recoveryResult(job))
      continue
    }
    if (backupExists) {
      const interruptedNew = `${staging}.interrupted-${process.pid}`
      removeWorkspaceTreeSync(interruptedNew)
      if (activeExists) renameSync(workspaceRoot, interruptedNew)
      renameSync(backup, workspaceRoot)
      removeWorkspaceTreeSync(staging)
      removeWorkspaceTreeSync(interruptedNew)
      finishRecovery(
        path,
        job,
        "failed",
        "Worktable recovered the original workspace after an interrupted replacement.",
        cleanupRolledBack
      )
      recovered.push(recoveryResult(job))
      continue
    }
    if (stagingExists) {
      // Confirmation was durable but the first swap rename had not happened.
      removeWorkspaceTreeSync(staging)
      finishRecovery(
        path,
        job,
        "failed",
        "Workspace replacement was interrupted before the atomic swap; the original workspace is unchanged.",
        cleanupRolledBack
      )
      recovered.push(recoveryResult(job))
      continue
    }
    if (activeExists) {
      // Marker-free active-only state is ambiguous (older builds could reach
      // it after either commit or rollback). Never claim an import succeeded
      // without its durable commit artifact.
      finishRecovery(
        path,
        job,
        "failed",
        "Workspace replacement outcome was ambiguous after interruption; the active workspace was left unchanged.",
        cleanupRolledBack
      )
      recovered.push(recoveryResult(job))
    }
  }
  return options?.details ? recovered : recovered.map((entry) => entry.id)
}

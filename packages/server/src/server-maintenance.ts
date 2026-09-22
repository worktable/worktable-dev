import {
  requestLiveOperatorWorkspaceExport,
  type LiveOperatorWorkspaceExportResult,
} from "./operator-export.ts"
import { readFileSync } from "node:fs"
import {
  localOperatorTokenPath,
  LOCAL_OPERATOR_TOKEN_HEADER,
} from "./operator-export.ts"
import {
  LOCAL_OPERATOR_SNAPSHOT_PATH,
  SNAPSHOT_OPERATION_ID,
} from "./operator-snapshot.ts"
import { inspectWorkspaceSnapshot } from "./workspace-snapshot.ts"
import { readWorkspaceStorageLayoutAt } from "./workspace-storage-v2.ts"
import { LOCAL_OPERATOR_BACKUP_AUDIT_PATH } from "./workspace-backup-notifier.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import {
  LOCAL_OPERATOR_SNAPSHOT_RESTORE_PATH,
  recoverMissingWorkspaceSnapshot,
  readWorkspaceSnapshotRestoreStatus,
} from "./workspace-snapshot-restore.ts"

export type WorkspaceExportMaintenanceResult = LiveOperatorWorkspaceExportResult

/**
 * Handle deployment-neutral maintenance commands for the compiled server.
 *
 * The hosted provisioner can execute the same server binary beside a running
 * service. This command delegates to that live server so its writer flush,
 * mutation barrier, and replacement lease remain the only snapshot boundary.
 */
export async function runServerMaintenance(
  argv: string[],
  writeResult: (value: string) => void = console.log,
  requestExport: (
    destination: string
  ) => Promise<WorkspaceExportMaintenanceResult> = requestLiveOperatorWorkspaceExport
): Promise<boolean> {
  const auditIndex = argv.lastIndexOf("workspace-backup-audit")
  if (auditIndex !== -1) {
    if (auditIndex !== argv.length - 1)
      throw new Error("usage: worktable-server workspace-backup-audit")
    const port = Number(process.env["PORT"] ?? "7480")
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error("invalid local operator port")
    const response = await fetch(
      `http://127.0.0.1:${port}${LOCAL_OPERATOR_BACKUP_AUDIT_PATH}`,
      {
        method: "POST",
        headers: {
          [LOCAL_OPERATOR_TOKEN_HEADER]: readFileSync(
            localOperatorTokenPath(),
            "utf8"
          ).trim(),
        },
      }
    )
    if (!response.ok)
      throw new Error(`backup audit failed: HTTP ${response.status}`)
    writeResult(JSON.stringify(await response.json()))
    return true
  }
  const statusIndex = argv.lastIndexOf("workspace-snapshot-restore-status")
  if (statusIndex !== -1) {
    if (statusIndex !== argv.length - 5)
      throw new Error(
        "usage: worktable-server workspace-snapshot-restore-status <operation-id> <workspace-id> <source-checkpoint> <safety-checkpoint>"
      )
    writeResult(
      JSON.stringify(
        await readWorkspaceSnapshotRestoreStatus({
          operationId: argv[statusIndex + 1]!,
          workspaceId: argv[statusIndex + 2]!,
          sourceCheckpoint: argv[statusIndex + 3]!,
          safetyCheckpoint: argv[statusIndex + 4]!,
        })
      )
    )
    return true
  }
  const restoreIndex = argv.lastIndexOf("workspace-snapshot-restore")
  if (restoreIndex !== -1) {
    if (restoreIndex !== argv.length - 5)
      throw new Error(
        "usage: worktable-server workspace-snapshot-restore <operation-id> <workspace-id> <source-checkpoint> <safety-checkpoint>"
      )
    const port = Number(process.env["PORT"] ?? "7480")
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error("invalid local operator port")
    const response = await fetch(
      `http://127.0.0.1:${port}${LOCAL_OPERATOR_SNAPSHOT_RESTORE_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [LOCAL_OPERATOR_TOKEN_HEADER]: readFileSync(
            localOperatorTokenPath(),
            "utf8"
          ).trim(),
        },
        body: JSON.stringify({
          operationId: argv[restoreIndex + 1],
          workspaceId: argv[restoreIndex + 2],
          sourceCheckpoint: argv[restoreIndex + 3],
          safetyCheckpoint: argv[restoreIndex + 4],
        }),
      }
    )
    if (!response.ok)
      throw new Error(`live snapshot restore failed: HTTP ${response.status}`)
    writeResult(JSON.stringify(await response.json()))
    return true
  }
  const recoverIndex = argv.lastIndexOf("workspace-snapshot-recover")
  if (recoverIndex !== -1) {
    if (recoverIndex !== argv.length - 4)
      throw new Error(
        "usage: worktable-server workspace-snapshot-recover <operation-id> <workspace-id> <source-checkpoint>"
      )
    writeResult(
      JSON.stringify(
        await recoverMissingWorkspaceSnapshot(
          argv[recoverIndex + 1]!,
          argv[recoverIndex + 2]!,
          argv[recoverIndex + 3]!
        )
      )
    )
    return true
  }
  const snapshotIndex = argv.lastIndexOf("workspace-snapshot")
  if (snapshotIndex !== -1) {
    const operationId = argv[snapshotIndex + 1]
    const maxCaptureMs =
      argv[snapshotIndex + 2] === undefined
        ? undefined
        : Number(argv[snapshotIndex + 2])
    if (
      (snapshotIndex !== argv.length - 2 &&
        snapshotIndex !== argv.length - 3) ||
      !operationId ||
      !SNAPSHOT_OPERATION_ID.test(operationId) ||
      (maxCaptureMs !== undefined &&
        (!Number.isSafeInteger(maxCaptureMs) ||
          maxCaptureMs < 1 ||
          maxCaptureMs > 30000))
    )
      throw new Error(
        "usage: worktable-server workspace-snapshot <operation-id> [max-capture-ms]"
      )
    const port = Number(process.env["PORT"] ?? "7480")
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error("invalid local operator port")
    const response = await fetch(
      `http://127.0.0.1:${port}${LOCAL_OPERATOR_SNAPSHOT_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [LOCAL_OPERATOR_TOKEN_HEADER]: readFileSync(
            localOperatorTokenPath(),
            "utf8"
          ).trim(),
        },
        body: JSON.stringify({ operationId, maxCaptureMs }),
      }
    )
    const value = await response.json()
    if (!response.ok)
      throw new Error(`live snapshot failed: HTTP ${response.status}`)
    writeResult(JSON.stringify(value))
    return true
  }
  const inspectIndex = argv.lastIndexOf("workspace-snapshot-inspect")
  if (inspectIndex !== -1) {
    if (inspectIndex !== argv.length - 3)
      throw new Error(
        "usage: worktable-server workspace-snapshot-inspect <directory> <workspace-id>"
      )
    const result = await inspectWorkspaceSnapshot(argv[inspectIndex + 1]!, {
      workspaceId: argv[inspectIndex + 2]!,
    })
    writeResult(JSON.stringify(result))
    return true
  }
  const identityIndex = argv.lastIndexOf("workspace-inspect")
  if (identityIndex !== -1) {
    if (identityIndex !== argv.length - 1)
      throw new Error("usage: worktable-server workspace-inspect")
    const layout = await readWorkspaceStorageLayoutAt(getWorkspaceRoot())
    if (layout.kind !== "v1" && layout.kind !== "v2")
      throw new Error("workspace manifest is invalid or unsupported")
    writeResult(
      JSON.stringify({
        command: "workspace-inspect",
        workspaceId: layout.manifest["id"],
        workspaceStorageVersion: layout.version,
      })
    )
    return true
  }
  const commandIndex = argv.lastIndexOf("workspace-export")
  if (commandIndex === -1) return false
  if (commandIndex !== argv.length - 2 || !argv[commandIndex + 1]) {
    throw new Error("usage: worktable-server workspace-export <destination>")
  }

  const destination = argv[commandIndex + 1]!
  const result = await requestExport(destination)
  writeResult(JSON.stringify(result))
  return true
}

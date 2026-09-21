import {
  requestLiveOperatorWorkspaceExport,
  type LiveOperatorWorkspaceExportResult,
} from "./operator-export.ts"

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

import { CloudBackupStatus } from "@worktable/hosted-contract"
import { fetchJSON } from "./http"

export async function getCloudBackups(
  options: {
    cursor?: string
    checkpoint?: string
  } = {}
): Promise<CloudBackupStatus> {
  const params = new URLSearchParams(options)
  return CloudBackupStatus.parse(await fetchJSON(`/api/backups?${params}`))
}

export function requestCloudBackup(input: {
  action: "capture" | "restore"
  requestId: string
  checkpoint?: string
}) {
  return fetchJSON<{ accepted: true }>(`/api/backups/${input.action}`, {
    method: "POST",
    body: JSON.stringify({
      requestId: input.requestId,
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    }),
  })
}

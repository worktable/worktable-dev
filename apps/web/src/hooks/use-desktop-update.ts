import { useQuery } from "@tanstack/react-query"
import {
  getDesktopUpdateStatus,
  mayHaveDesktopUpdates,
  type DesktopUpdateStatus,
} from "@/lib/desktop-updates"

export const DESKTOP_UPDATE_QUERY_KEY = ["desktop", "update"] as const

const ACTIVE_POLL_MS = 1_500
const IDLE_POLL_MS = 60_000

function inProgress(status: DesktopUpdateStatus | null | undefined): boolean {
  return (
    status?.state === "checking" ||
    status?.state === "downloading" ||
    status?.state === "installing"
  )
}

/**
 * Worktable Desktop's own update, when this page is a Desktop local workspace.
 * `data` is null everywhere else, so callers fall back to the server's update
 * controls. Polls quickly only while a check or download is running.
 */
export function useDesktopUpdate() {
  return useQuery({
    queryKey: DESKTOP_UPDATE_QUERY_KEY,
    queryFn: getDesktopUpdateStatus,
    enabled: mayHaveDesktopUpdates(),
    retry: false,
    refetchInterval: (query) =>
      inProgress(query.state.data) ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    refetchOnWindowFocus: "always",
  })
}

/** True when Desktop has an update downloaded and waiting for a restart. */
export function useDesktopUpdateReady(): boolean {
  return useDesktopUpdate().data?.canRestart ?? false
}

import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  getDesktopUpdateStatus,
  mayHaveDesktopUpdates,
  type DesktopUpdateStatus,
} from "@/lib/desktop-updates"
import { onOpenSettings } from "@/lib/settings-open"

export const DESKTOP_UPDATE_QUERY_KEY = ["desktop", "update"] as const

const ACTIVE_POLL_MS = 1_500
const IDLE_POLL_MS = 60_000
const REQUESTED_CHECK_WINDOW_MS = 30_000

// Desktop starts a requested check after the command returns, so the first
// read can still say "idle". Poll quickly until a newer check is recorded.
let checkRequestedAt = 0

/** Call when the app asks Desktop to check, before the command is sent. */
export function noteDesktopCheckRequested(now = Date.now()): void {
  checkRequestedAt = now
}

export function awaitingRequestedCheck(
  status: DesktopUpdateStatus | null | undefined,
  now = Date.now(),
  requestedAt = checkRequestedAt
): boolean {
  if (!requestedAt || now - requestedAt > REQUESTED_CHECK_WINDOW_MS) {
    return false
  }
  // Desktop records check times in whole seconds.
  return (status?.lastCheck?.checkedAt ?? 0) < Math.floor(requestedAt / 1000)
}

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
  const queryClient = useQueryClient()
  const available = mayHaveDesktopUpdates()
  // Desktop's menu checks for updates and opens System in one step.
  useEffect(() => {
    if (!available) return
    return onOpenSettings((section) => {
      if (section !== "system") return
      noteDesktopCheckRequested()
      void queryClient.invalidateQueries({ queryKey: DESKTOP_UPDATE_QUERY_KEY })
    })
  }, [available, queryClient])
  return useQuery({
    queryKey: DESKTOP_UPDATE_QUERY_KEY,
    queryFn: getDesktopUpdateStatus,
    enabled: available,
    retry: false,
    refetchInterval: (query) =>
      inProgress(query.state.data) || awaitingRequestedCheck(query.state.data)
        ? ACTIVE_POLL_MS
        : IDLE_POLL_MS,
    refetchOnWindowFocus: "always",
  })
}

/** True when Desktop has an update downloaded and waiting for a restart. */
export function useDesktopUpdateReady(): boolean {
  return useDesktopUpdate().data?.canRestart ?? false
}

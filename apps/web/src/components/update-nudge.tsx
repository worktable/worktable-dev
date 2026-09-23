import { useEffect } from "react"
import { toast } from "@worktable/ui/components/sonner"
import { useUpdateAvailability } from "@/hooks/use-update-availability"
import { openSettings } from "@/lib/settings-open"
import {
  announceUpdateWhenVisible,
  seenUpdateVersion,
} from "@/lib/update-notification"

/**
 * One-time toast when a newer Worktable release is known. Rides the passive
 * (cache-only) availability signal, so it never triggers a network check; the
 * action jumps straight to Settings → System, where the actual update runs.
 * Renders nothing — mounted once in the app shell.
 */
export function UpdateNudge() {
  const available = useUpdateAvailability()
  const latest = available?.latest ?? null
  const fresh = available?.checkStatus === "fresh"

  useEffect(() => {
    if (!latest || !fresh || seenUpdateVersion() === latest) return

    return announceUpdateWhenVisible(latest, () => {
      toast.info(`Worktable ${latest} is available`, {
        id: "update-nudge",
        duration: 15_000,
        description: "Review it in Settings when you're ready.",
        action: {
          label: "Review update",
          onClick: () => openSettings("system"),
        },
      })
    })
  }, [fresh, latest])

  return null
}

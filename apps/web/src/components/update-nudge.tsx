import { useEffect } from "react"
import { toast } from "@worktable/ui/components/sonner"
import { useUpdateAvailability } from "@/hooks/use-update-availability"
import { useDesktopUpdate } from "@/hooks/use-desktop-update"
import { restartDesktopToUpdate } from "@/lib/desktop-updates"
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
  const desktop = useDesktopUpdate().data
  // Desktop downloads updates itself; announce one once it is ready to install.
  const desktopReady = desktop?.canRestart ? desktop.availableVersion : null

  useEffect(() => {
    if (!desktopReady || seenUpdateVersion() === desktopReady) return

    return announceUpdateWhenVisible(desktopReady, () => {
      toast.info(`Worktable ${desktopReady} is ready`, {
        id: "update-nudge",
        duration: 15_000,
        description: "Restart to finish updating.",
        action: {
          label: "Restart",
          onClick: () => {
            restartDesktopToUpdate().catch((error: unknown) => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Could not restart to update."
              )
            })
          },
        },
      })
    })
  }, [desktopReady])

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

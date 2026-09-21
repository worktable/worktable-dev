import { useEffect } from "react"
import { toast } from "@worktable/ui/components/sonner"
import { useUpdateAvailability } from "@/hooks/use-update-availability"
import { openSettings } from "@/lib/settings-open"
import {
  markUpdateVersionSeen,
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

    let announced = false
    const announce = () => {
      if (announced || document.visibilityState !== "visible") return
      announced = true
      document.removeEventListener("visibilitychange", announce)
      // A different tab may have announced this release while this one was
      // hidden. Re-read shared storage at the moment the toast becomes visible.
      if (seenUpdateVersion() === latest) return
      markUpdateVersionSeen(latest)
      toast.info(`Worktable ${latest} is available`, {
        id: "update-nudge",
        duration: 15_000,
        description: "Review it in Settings when you're ready.",
        action: {
          label: "Review update",
          onClick: () => openSettings("system"),
        },
      })
    }

    if (document.visibilityState === "visible") {
      announce()
      return
    }
    document.addEventListener("visibilitychange", announce)
    return () => document.removeEventListener("visibilitychange", announce)
  }, [fresh, latest])

  return null
}

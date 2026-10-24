import { useEffect } from "react"
import { desktopAgentOffer, presentAgentOffer } from "@/lib/desktop-agent-offer"

/**
 * After Worktable Desktop opens a Worktable other than the one agents on this
 * Mac use, offers to move them here. Closing the toast keeps them where they
 * are. Renders nothing; the app shell loads it only inside Desktop.
 */
export function DesktopAgentOffer() {
  useEffect(() => {
    let cancelled = false
    void desktopAgentOffer().then((offer) => {
      if (!cancelled && offer) presentAgentOffer(offer)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return null
}

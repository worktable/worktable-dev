import { useEffect, useRef, useState } from "react"
import {
  desktopAgentOffer,
  presentAgentOffer,
  type AgentOffer,
} from "@/lib/desktop-agent-offer"
import { useWorkspace } from "@/lib/queries"

/**
 * After Worktable Desktop opens a Worktable other than the one agents on this
 * Mac use, offers to move them here. Closing the toast keeps them where they
 * are. The offer names this Worktable as the page knows it, since setup
 * renames a new one after Desktop opened it. Renders nothing; the app shell
 * loads it only inside Desktop.
 */
export function DesktopAgentOffer() {
  const name = useWorkspace().data?.name.trim()
  const [offer, setOffer] = useState<AgentOffer | null>(null)
  const shown = useRef<ReturnType<typeof presentAgentOffer> | null>(null)

  useEffect(() => {
    let cancelled = false
    void desktopAgentOffer().then((waiting) => {
      if (!cancelled) setOffer(waiting)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!offer) return
    const worktable = name || offer.worktable
    if (shown.current) shown.current.rename(worktable)
    else shown.current = presentAgentOffer({ ...offer, worktable })
  }, [offer, name])

  return null
}

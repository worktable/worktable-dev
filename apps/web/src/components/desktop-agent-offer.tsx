import { useEffect } from "react"
import { toast } from "@worktable/ui/components/sonner"
import {
  answerDesktopAgentOffer,
  desktopAgentOffer,
  insideDesktop,
} from "@/lib/desktop-connection"

/**
 * After Worktable Desktop opens a Worktable other than the one agents on this
 * Mac use, offers to move them here. Closing the toast keeps them where they
 * are. Renders nothing; mounted once in the app shell.
 */
export function DesktopAgentOffer() {
  useEffect(() => {
    if (!insideDesktop()) return
    let cancelled = false
    void desktopAgentOffer().then((offer) => {
      if (cancelled || !offer) return
      let answered = false
      const answer = (switchAgents: boolean) => {
        if (answered) return
        answered = true
        answerDesktopAgentOffer(switchAgents).then(
          () => {
            if (switchAgents) toast.success(`Agents now use ${offer.worktable}.`)
          },
          (error: unknown) => {
            if (switchAgents) {
              console.error("[desktop] Switching agents failed:", error)
              toast.error("Couldn’t switch agents.")
            }
          }
        )
      }
      toast.info(`Your agents still use ${offer.agentWorktable}.`, {
        id: "desktop-agent-offer",
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        action: {
          label: `Switch them to ${offer.worktable}`,
          onClick: () => answer(true),
        },
        onDismiss: () => answer(false),
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  return null
}

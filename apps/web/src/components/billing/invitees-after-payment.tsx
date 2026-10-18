import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import { CLOUD_PLANS } from "@worktable/hosted-contract/plans"
import { roomFor, useCloudPlan } from "@/lib/cloud-plan"
import { invitePeople } from "@/lib/invite-people"
import { forgetKeptInvitees, keptInvitees } from "@/lib/kept-invitees"
import { useWorkspace } from "@/lib/queries"
import { noteSetupChanged } from "@/lib/setup"

/**
 * Back from paying for a plan: invite the people typed before leaving, once
 * the plan holds them, and say how it went.
 */
export default function InviteesAfterPayment() {
  const queryClient = useQueryClient()
  const workspaceId = useWorkspace().data?.id
  const { plan } = useCloudPlan()
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !workspaceId || !plan) return
    const emails = keptInvitees(workspaceId)
    // Still on Solo: payment hasn't arrived yet, so they keep waiting.
    if (!emails?.length || plan.plan === "solo") return
    started.current = true
    forgetKeptInvitees(workspaceId)
    const name = CLOUD_PLANS[plan.plan].name
    if (!roomFor(plan, emails.length)) {
      // Named, so they can be invited once there is room.
      toast(`${name} plan active. It has no room to invite ${emails.join(", ")}.`)
      return
    }
    void invitePeople(emails).then((results) => {
      const failed = results.filter((result) => result.error)
      const sent = results.length - failed.length
      const sentLine = sent
        ? ` ${sent === 1 ? "1 invitation" : `${sent} invitations`} sent.`
        : ""
      const failedLine = failed.length
        ? ` Couldn’t invite ${failed.map((result) => result.email).join(", ")}.`
        : ""
      toast(`${name} plan active.${sentLine}${failedLine}`)
      void queryClient.invalidateQueries({ queryKey: ["team", "invitations"] })
      // The people count moved; the plan's room is read again.
      noteSetupChanged(queryClient)
    })
  }, [workspaceId, plan, queryClient])
  return null
}

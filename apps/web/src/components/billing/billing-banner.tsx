import { lazy, Suspense, useState, useSyncExternalStore } from "react"
import { useMutation } from "@tanstack/react-query"
import { TriangleAlert } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { MEMBER_GRACE_NOTICE_MS, useCloudPlan } from "@/lib/cloud-plan"
import { anyKeptInvitees } from "@/lib/kept-invitees"
import { usePersonalSetup } from "@/lib/setup"

const InviteesAfterPayment = lazy(() => import("./invitees-after-payment"))
const unchanging = () => () => {}

/**
 * Invites the people kept across a payment. It loads only when someone is
 * waiting, so every other page pays nothing for it.
 */
export function KeptInvitees() {
  // Read on the client only; storage doesn't announce its changes here.
  const waiting = useSyncExternalStore(unchanging, anyKeptInvitees, () => false)
  return waiting ? (
    <Suspense fallback={null}>
      <InviteesAfterPayment />
    </Suspense>
  ) : null
}

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" })

/**
 * A failed payment, said to owners from the start and to members in the
 * last two days before access locks.
 */
export function BillingBanner() {
  const { plan, worktableName } = useCloudPlan()
  const { person } = usePersonalSetup()
  // Billing's client loads on click: it brings the schemas that check
  // billing replies, which no page needs before then.
  const portal = useMutation({
    mutationFn: async () =>
      (await import("@/lib/billing-api")).openCloudBillingPortal(),
  })
  // Read once a page; the banner doesn't need to appear mid-visit.
  const [now] = useState(() => Date.now())
  if (!plan || plan.access !== "grace" || !plan.graceEndsAt) return null
  const owner = person?.role !== "member"
  if (!owner && now < plan.graceEndsAt - MEMBER_GRACE_NOTICE_MS)
    return null
  const date = day.format(plan.graceEndsAt)
  const payer = plan.payerName || "The person who pays for it"
  const message = !owner
    ? `${worktableName}'s subscription needs attention. ${payer} manages billing.`
    : plan.isPayer
      ? `Payment for ${worktableName} failed. Update the card by ${date} to keep access.`
      : `Payment for ${worktableName} failed. ${payer} needs to update the card by ${date} to keep access.`
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-foreground print:hidden"
    >
      <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {plan.isPayer ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={portal.isPending}
          onClick={() => portal.mutate()}
        >
          {portal.isPending ? "Opening…" : "Update card"}
        </Button>
      ) : null}
    </div>
  )
}

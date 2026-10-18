import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { TriangleAlert } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { MEMBER_GRACE_NOTICE_MS, useCloudPlan } from "@/lib/cloud-plan"
import { usePersonalSetup } from "@/lib/setup"

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
  const payer = plan.payerName || "the person who pays for it"
  const message = !owner
    ? `${worktableName}'s payment needs attention. Contact ${payer} about billing.`
    : plan.isPayer
      ? `Payment for ${worktableName} failed. Update the card by ${date} to keep access.`
      : `Payment for ${worktableName} failed. Contact ${payer} to update the card by ${date}.`
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
      {portal.isError ? (
        <span role="alert" className="w-full text-destructive">
          {portal.error.message || "Couldn’t open billing. Try again."}
        </span>
      ) : null}
    </div>
  )
}

import { lazy, Suspense, useSyncExternalStore } from "react"
import { useWorkspace } from "@/lib/queries"
import { anyKeptInvitees } from "@/lib/kept-invitees"

const BillingBanner = lazy(() =>
  import("./billing-banner").then((module) => ({ default: module.BillingBanner }))
)
const InviteesAfterPayment = lazy(() => import("./invitees-after-payment"))
const unchanging = () => () => {}

/**
 * Cloud billing on every page: the payment banner while a payment is
 * overdue, and the invitations kept across a payment. Each loads only when
 * it has something to do, so other pages pay nothing for them.
 */
export function BillingRoot() {
  const overdue = useWorkspace().data?.cloudPlan?.access === "grace"
  // Read on the client only; storage doesn't announce its changes here.
  const waiting = useSyncExternalStore(unchanging, anyKeptInvitees, () => false)
  return (
    <Suspense fallback={null}>
      {overdue ? <BillingBanner /> : null}
      {waiting ? <InviteesAfterPayment /> : null}
    </Suspense>
  )
}

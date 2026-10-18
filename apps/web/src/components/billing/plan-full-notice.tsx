import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  CLOUD_PLANS,
  PAID_CLOUD_PLAN_IDS,
  type PaidCloudPlanId,
} from "@worktable/hosted-contract/plans"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import {
  planPrice,
  planSummary,
  upgradeFor,
  type CloudPlan,
} from "@/lib/cloud-plan"
import { keepInviteesForPayment } from "@/lib/kept-invitees"
import { queryKeys, useWorkspace } from "@/lib/queries"

function PlanChoice({
  options,
  value,
  onChange,
}: {
  options: readonly PaidCloudPlanId[]
  value: PaidCloudPlanId
  onChange: (plan: PaidCloudPlanId) => void
}) {
  return (
    <div role="radiogroup" aria-label="Plan" className="mt-3 space-y-2">
      {options.map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={cn(
            "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            value === id
              ? "border-primary bg-surface-tint/50"
              : "border-border hover:border-input-hover"
          )}
        >
          <span
            className={cn(
              "grid size-4 shrink-0 place-items-center rounded-full border",
              value === id ? "border-primary" : "border-input"
            )}
          >
            {value === id && <span className="size-2 rounded-full bg-primary" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="font-medium text-foreground">
              {CLOUD_PLANS[id].name}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {planSummary(id)}
            </span>
          </span>
          <span className="shrink-0 text-muted-foreground">{planPrice(id)}</span>
        </button>
      ))}
    </div>
  )
}

function ContactUs({ worktableName }: { worktableName: string }) {
  return (
    <a
      className="font-medium text-primary-text hover:underline"
      href={`mailto:${CLOUD_PLANS.business.supportEmail}?subject=${encodeURIComponent(`More people for ${worktableName}`)}`}
    >
      Contact us
    </a>
  )
}

/**
 * Shown where people invite, when the plan can't hold who they're adding.
 * On Solo it is how a Worktable gets a paid plan. Only plans that hold
 * everyone being added are offered.
 */
export function PlanFullNotice({
  plan,
  worktableName,
  adding,
  invitees,
  onBeforeCheckout,
}: {
  plan: CloudPlan
  worktableName: string
  /** How many people are being added. */
  adding: number
  /** Who is being added, invited once payment brings a plan that holds them. */
  invitees?: string[]
  /** Keep what was typed some other way before leaving for payment. */
  onBeforeCheckout?: () => void
}) {
  const queryClient = useQueryClient()
  const workspaceId = useWorkspace().data?.id
  const needed = plan.people + Math.max(adding, 1)
  const fitting = PAID_CLOUD_PLAN_IDS.filter(
    (id) => CLOUD_PLANS[id].peopleLimit >= needed
  )
  const [picked, setChoice] = useState<PaidCloudPlanId | null>(null)
  const choice = picked && fitting.includes(picked) ? picked : fitting[0]
  const checkout = useMutation({
    mutationFn: async (target: PaidCloudPlanId) => {
      const billing = await import("@/lib/billing-api")
      if (onBeforeCheckout) onBeforeCheckout()
      else if (workspaceId && invitees?.length)
        keepInviteesForPayment(workspaceId, invitees)
      await billing.openCloudBillingCheckout(target)
    },
  })
  const change = useMutation({
    // Billing's client loads on click, with the schemas it checks replies with.
    mutationFn: async (target: PaidCloudPlanId) =>
      (await import("@/lib/billing-api")).changeCloudPlan(target),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspace,
        exact: true,
      })
      void queryClient.invalidateQueries({ queryKey: ["cloud", "billing"] })
    },
  })
  const error = checkout.error ?? change.error
  const next = upgradeFor(plan)
  const payerName = plan.payerName || "the person who pays for it"

  let body: React.ReactNode
  if (!next) {
    body = (
      <p>
        {worktableName} has reached {plan.peopleLimit} people.{" "}
        <ContactUs worktableName={worktableName} /> to go further.
      </p>
    )
  } else if (plan.isPayer && !choice) {
    // Paying for any plan here would still leave someone out.
    body = (
      <p>
        Plans hold up to {CLOUD_PLANS.business.peopleLimit} people.{" "}
        <ContactUs worktableName={worktableName} /> for more.
      </p>
    )
  } else if (plan.plan === "solo") {
    body = plan.isPayer && choice ? (
      <>
        <p>Inviting people needs a paid plan for {worktableName}.</p>
        <PlanChoice options={fitting} value={choice} onChange={setChoice} />
        <Button
          type="button"
          size="sm"
          className="mt-3"
          disabled={checkout.isPending}
          onClick={() => checkout.mutate(choice)}
        >
          {checkout.isPending ? "Opening payment…" : "Continue to payment"}
        </Button>
      </>
    ) : (
      <p>
        Inviting people needs a paid plan for {worktableName}. Ask {payerName}{" "}
        to choose one.
      </p>
    )
  } else if (plan.isPayer) {
    body = (
      <>
        <p>
          {worktableName}&apos;s plan has room for {plan.peopleLimit} people,
          and {plan.people} {plan.people === 1 ? "is" : "are"} in or invited.{" "}
          {CLOUD_PLANS[next].name} holds up to {CLOUD_PLANS[next].peopleLimit}{" "}
          for {planPrice(next)}.
        </p>
        <Button
          type="button"
          size="sm"
          className="mt-3"
          disabled={change.isPending}
          onClick={() => change.mutate(next)}
        >
          {change.isPending
            ? "Changing plan…"
            : `Upgrade to ${CLOUD_PLANS[next].name}`}
        </Button>
      </>
    )
  } else {
    body = (
      <p>
        {worktableName} is full. Ask {payerName} to change the plan. We&apos;ve
        let them know.
      </p>
    )
  }

  return (
    <div
      role="status"
      className="rounded-lg border border-border bg-surface-inset px-3.5 py-3 text-sm leading-6 text-foreground"
    >
      {body}
      {error ? (
        <p className="mt-2 text-destructive" role="alert">
          {error instanceof Error ? error.message : "Something went wrong."}
        </p>
      ) : null}
    </div>
  )
}

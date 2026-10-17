import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  CLOUD_PLANS,
  PAID_CLOUD_PLAN_IDS,
  type PaidCloudPlanId,
} from "@worktable/hosted-contract"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import { changeCloudPlan, openCloudBillingCheckout } from "@/lib/billing-api"
import {
  planPrice,
  planSummary,
  upgradeFor,
  type CloudPlan,
} from "@/lib/cloud-plan"
import { queryKeys } from "@/lib/queries"

function PlanChoice({
  value,
  onChange,
}: {
  value: PaidCloudPlanId
  onChange: (plan: PaidCloudPlanId) => void
}) {
  return (
    <div role="radiogroup" aria-label="Plan" className="mt-3 space-y-2">
      {PAID_CLOUD_PLAN_IDS.map((id) => (
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

/**
 * Shown where people invite, when the plan can't hold who they're adding.
 * On Solo it is how a Worktable gets a paid plan.
 */
export function PlanFullNotice({
  plan,
  worktableName,
  adding,
  onBeforeCheckout,
}: {
  plan: CloudPlan
  worktableName: string
  /** How many people are being added. */
  adding: number
  /** Keep what was typed before leaving for payment. */
  onBeforeCheckout?: () => void
}) {
  const queryClient = useQueryClient()
  const needed = plan.people + Math.max(adding, 1)
  const [choice, setChoice] = useState<PaidCloudPlanId>(
    CLOUD_PLANS.team.peopleLimit >= needed ? "team" : "business"
  )
  const checkout = useMutation({
    mutationFn: async (target: PaidCloudPlanId) => {
      onBeforeCheckout?.()
      await openCloudBillingCheckout(target)
    },
  })
  const change = useMutation({
    mutationFn: changeCloudPlan,
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
  if (plan.plan === "solo") {
    body = plan.isPayer ? (
      <>
        <p>Inviting people needs a paid plan for {worktableName}.</p>
        <PlanChoice value={choice} onChange={setChoice} />
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
  } else if (!next) {
    body = (
      <p>
        {worktableName} has reached {plan.peopleLimit} people.{" "}
        <a
          className="font-medium text-primary-text hover:underline"
          href={`mailto:${CLOUD_PLANS.business.supportEmail}?subject=${encodeURIComponent(`More people for ${worktableName}`)}`}
        >
          Contact us
        </a>{" "}
        to go further.
      </p>
    )
  } else if (plan.isPayer) {
    body = (
      <>
        <p>
          {worktableName}&apos;s plan has room for {plan.peopleLimit} people,
          and {plan.people} {plan.people === 1 ? "is" : "are"} in or invited.
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
            : `Move to ${CLOUD_PLANS[next].name}, ${planPrice(next)}`}
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

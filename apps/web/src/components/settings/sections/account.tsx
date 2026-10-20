import { HttpError } from "@/lib/http"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CLOUD_PLANS,
  LOCKED_RETENTION_DAYS,
  PAID_CLOUD_PLAN_IDS,
  type BillingStatus,
  type PaidCloudPlanId,
} from "@worktable/hosted-contract"
import { useState } from "react"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { Button } from "@worktable/ui/components/button"
import { Badge } from "@worktable/ui/components/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@worktable/ui/components/card"
import { Callout } from "@worktable/ui/components/callout"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { Download, ExternalLink, Gift, TriangleAlert } from "lucide-react"
import { getConnection } from "@/lib/system-api"
import {
  cancelCloudPlan,
  changeCloudPlan,
  downloadCloudWorkspace,
  getCloudBillingStatus,
  openCloudBillingCheckout,
  openCloudBillingPortal,
} from "@/lib/billing-api"
import { useCloudPlan } from "@/lib/cloud-plan"
import { queryKeys } from "@/lib/queries"
import { useSettingsSectionActive } from "../settings-dialog"

export function AccountSection() {
  const sectionActive = useSettingsSectionActive()
  const connectionQuery = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    enabled: sectionActive,
    staleTime: 30_000,
  })
  const cloudAccount = connectionQuery.data?.mcpAuthMode === "oauth"
  const billingQuery = useQuery({
    queryKey: ["cloud", "billing"],
    queryFn: getCloudBillingStatus,
    enabled: sectionActive && cloudAccount,
    staleTime: 15_000,
  })
  const queryClient = useQueryClient()
  const { plan: cloudPlan, worktableName } = useCloudPlan()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["cloud", "billing"] })
    void queryClient.invalidateQueries({
      queryKey: queryKeys.workspace,
      exact: true,
    })
  }
  const portal = useMutation({
    mutationFn: openCloudBillingPortal,
  })
  const checkout = useMutation({
    mutationFn: (plan?: PaidCloudPlanId) => openCloudBillingCheckout(plan),
  })
  const change = useMutation({
    mutationFn: changeCloudPlan,
    onSuccess: refresh,
  })
  const cancel = useMutation({
    mutationFn: cancelCloudPlan,
    onSuccess: refresh,
  })
  const actionError = [checkout, portal, change, cancel].find(
    (action) => action.isError
  )?.error

  if (connectionQuery.isLoading) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Checking your session…
      </p>
    )
  }

  if (connectionQuery.isError || !connectionQuery.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn&rsquo;t read this Worktable&rsquo;s session information.
      </p>
    )
  }

  if (connectionQuery.data.mcpAuthMode !== "oauth") {
    return (
      <p className="text-sm text-muted-foreground">
        Cloud account settings aren&rsquo;t available for this Worktable.
      </p>
    )
  }

  return (
    <>
      <section className="flex flex-col gap-3">
        {billingQuery.isLoading ? (
          <Card size="sm">
            <CardContent>
              <p className="text-sm text-muted-foreground" role="status">
                Checking your subscription…
              </p>
            </CardContent>
          </Card>
        ) : billingQuery.error instanceof HttpError &&
          billingQuery.error.status === 403 &&
          (billingQuery.error.body as { code?: string })?.code ===
            "BILLING_PAYER_REQUIRED" ? (
          <p className="text-sm text-muted-foreground">
            {`Contact ${cloudPlan?.payerName || "the person who pays for it"} about ${worktableName}'s plan and billing.`}
          </p>
        ) : billingQuery.isError || !billingQuery.data ? (
          <Card size="sm">
            <CardContent className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 text-warning" />
              <p className="text-sm text-muted-foreground">
                We couldn&rsquo;t load your subscription.{" "}
                <a
                  className="text-primary-text underline underline-offset-4"
                  href={`mailto:${CLOUD_PLANS.team.supportEmail}`}
                >
                  Contact support
                </a>
                .
              </p>
            </CardContent>
          </Card>
        ) : (
          <SubscriptionCard
            billing={billingQuery.data}
            people={cloudPlan?.people ?? null}
            worktableName={worktableName}
            pending={
              checkout.isPending
                ? "checkout"
                : portal.isPending
                  ? "portal"
                  : change.isPending
                    ? "change"
                    : cancel.isPending
                      ? "cancel"
                      : null
            }
            error={actionError?.message}
            onCheckout={(plan) => checkout.mutate(plan)}
            onPortal={() => portal.mutate()}
            onChangePlan={(plan) => change.mutateAsync(plan)}
            onCancel={() => cancel.mutate()}
          />
        )}
      </section>
    </>
  )
}

/** "$49", or "$7.99" when there are cents. */
function formatPrice(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
  }).format(amount / 100)
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(timestamp)
}

export function SubscriptionCard({
  billing,
  people = null,
  worktableName = "This Worktable",
  pending = null,
  error,
  onCheckout,
  onPortal,
  onChangePlan = () => {},
  onCancel = () => {},
}: {
  billing: BillingStatus
  /** Members plus pending invitations, when known. */
  people?: number | null
  worktableName?: string
  /** The action under way, so its button says so. */
  pending?: "checkout" | "portal" | "change" | "cancel" | null
  error?: string
  onCheckout: (plan?: PaidCloudPlanId) => void
  onPortal: () => void
  onChangePlan?: (plan: PaidCloudPlanId) => Promise<unknown> | void
  onCancel?: () => void
}) {
  const [cancelling, setCancelling] = useState(false)
  const [changingTo, setChangingTo] = useState<PaidCloudPlanId | null>(null)
  const plan = billing.plan
  const complimentary = billing.access === "complimentary"
  const paymentRequired = billing.access === "payment_required"
  const inGrace = billing.access === "grace"
  const locked = billing.access === "locked"
  const solo = plan.id === "solo"
  const cancelsAtEnd = Boolean(billing.subscription?.cancelAtPeriodEnd)
  const date = billing.subscription?.currentPeriodEnd
  const status = complimentary
    ? null
    : locked
      ? "Locked"
      : inGrace
        ? "Payment due"
        : paymentRequired
          ? "Payment required"
          : cancelsAtEnd
            ? "Cancels at period end"
            : solo
              ? null
              : "Active"
  const summary = complimentary
    ? "Boss tier"
    : [
        solo ? "Free" : `${formatPrice(plan.amount, plan.currency)} monthly`,
        !date || locked || inGrace || solo
          ? null
          : cancelsAtEnd
            ? `Ends ${formatDate(date)}`
            : `Renews ${formatDate(date)}`,
      ]
        .filter(Boolean)
        .join(" · ")
  const fitsSolo = people === null || people <= 1
  const busy = pending !== null
  // Solo pays through checkout; a running plan moves at once.
  const others: Array<{ id: PaidCloudPlanId; via: "checkout" | "change" }> =
    solo && billing.canCheckout
      ? PAID_CLOUD_PLAN_IDS.map((id) => ({ id, via: "checkout" as const }))
      : billing.canChangeTo.map((id) => ({ id, via: "change" as const }))
  const primary =
    locked || paymentRequired
      ? "checkout"
      : inGrace
        ? "portal"
        : (others.find((other) => CLOUD_PLANS[other.id].amount > plan.amount)
            ?.id ?? null)

  return (
    <div className="flex flex-col gap-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {complimentary ? (
              <Gift className="size-4 text-primary-text" />
            ) : null}
            {complimentary ? "VIP" : plan.name}
            {status ? (
              <Badge variant={locked || inGrace ? "destructive" : "secondary"}>
                {status}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>{summary}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {inGrace && billing.subscription?.graceEndsAt ? (
            <Callout variant="warning">
              Payment for {worktableName} failed. Update the card by{" "}
              {formatDate(billing.subscription.graceEndsAt)} to keep access.
            </Callout>
          ) : null}
          {locked ? (
            <Callout variant="warning">
              {billing.deletesAt
                ? `${worktableName} is locked. Restart the subscription, or export it before ${formatDate(billing.deletesAt)}, when it will be deleted.`
                : `${worktableName} is locked. Restart the subscription, or export it.`}
            </Callout>
          ) : null}
          {people !== null && !complimentary ? (
            <PeopleMeter people={people} limit={plan.peopleLimit} />
          ) : null}
          {others.length && !locked ? (
            <ul className="flex flex-col gap-2">
              {others.map(({ id, via }) => {
                const other = CLOUD_PLANS[id]
                const up = other.amount > plan.amount
                const tooMany = people !== null && people > other.peopleLimit
                return (
                  <li
                    key={id}
                    className="flex items-center gap-3 rounded-lg bg-surface-inset px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">
                        {other.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Up to {other.peopleLimit} people ·{" "}
                        {formatPrice(other.amount, plan.currency)} monthly
                      </p>
                    </div>
                    <PlanButton
                      reason={
                        tooMany
                          ? `Remove ${people! - other.peopleLimit} ${people! - other.peopleLimit === 1 ? "person" : "people"} to fit ${other.name}`
                          : null
                      }
                      variant={primary === id ? "default" : "outline"}
                      disabled={busy || tooMany}
                      onClick={() =>
                        via === "checkout" ? onCheckout(id) : setChangingTo(id)
                      }
                    >
                      {(via === "checkout" && pending === "checkout") ||
                      (via === "change" && pending === "change")
                        ? "Changing…"
                        : up
                          ? "Upgrade"
                          : "Downgrade"}
                    </PlanButton>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {(!solo && billing.canCheckout) ||
          billing.canManageBilling ||
          (locked && billing.canExport) ? (
            <div className="flex flex-wrap items-center gap-2">
              {!solo && billing.canCheckout ? (
                <Button size="sm" disabled={busy} onClick={() => onCheckout()}>
                  {pending === "checkout"
                    ? "Opening payment…"
                    : locked
                      ? "Restart subscription"
                      : "Subscribe"}
                </Button>
              ) : null}
              {billing.canManageBilling ? (
                <Button
                  variant={primary === "portal" ? "default" : "outline"}
                  size="sm"
                  disabled={busy}
                  onClick={onPortal}
                >
                  <ExternalLink className="size-4" />
                  {pending === "portal"
                    ? "Opening…"
                    : inGrace
                      ? "Update card"
                      : "Manage payment"}
                </Button>
              ) : null}
              {locked && billing.canExport ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={downloadCloudWorkspace}
                >
                  <Download className="size-4" />
                  Export
                </Button>
              ) : null}
              {billing.canManageBilling && !solo && !locked && !cancelsAtEnd ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-muted-foreground"
                  disabled={busy}
                  onClick={() => setCancelling(true)}
                >
                  Cancel plan
                </Button>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
      {changingTo ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setChangingTo(null)
          }}
          title={
            CLOUD_PLANS[changingTo].amount > plan.amount
              ? `Upgrade to ${CLOUD_PLANS[changingTo].name}?`
              : `Downgrade to ${CLOUD_PLANS[changingTo].name}?`
          }
          description={`${worktableName} moves to ${CLOUD_PLANS[changingTo].name} now, at ${formatPrice(CLOUD_PLANS[changingTo].amount, plan.currency)} monthly. The difference for the rest of this period is settled on your next bill.`}
          confirmLabel={
            CLOUD_PLANS[changingTo].amount > plan.amount
              ? "Upgrade"
              : "Downgrade"
          }
          loading={pending === "change"}
          loadingLabel="Changing…"
          onConfirm={async () => {
            // Stay open while the change runs; a failure shows here to retry.
            try {
              await onChangePlan(changingTo)
              setChangingTo(null)
            } catch {
              // The error shows in the dialog, which stays open to retry.
            }
          }}
        >
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title={`Cancel ${plan.name}?`}
        description={
          !date
            ? `${worktableName} moves to Solo at the end of this period.`
            : fitsSolo
              ? `${worktableName} stays on ${plan.name} until ${formatDate(date)}, then moves to Solo.`
              : `${worktableName} stays on ${plan.name} until ${formatDate(date)}. Then it locks, because Solo holds one person, and you can export it for ${LOCKED_RETENTION_DAYS} days.`
        }
        confirmLabel="Cancel plan"
        cancelLabel="Keep plan"
        variant="destructive"
        loading={pending === "cancel"}
        loadingLabel="Cancelling…"
        onConfirm={() => {
          onCancel()
          setCancelling(false)
        }}
      />
    </div>
  )
}

/** A plan change, with why it can't happen yet on hover. */
function PlanButton({
  reason,
  variant,
  disabled,
  onClick,
  children,
}: {
  reason: string | null
  variant: "default" | "outline"
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  const button = (
    <Button size="sm" variant={variant} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  )
  if (!reason) return button
  // A disabled button takes no pointer, so the wrapper carries the hint.
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger render={<span tabIndex={0} aria-label={reason} />}>
          {button}
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** How full the plan is, counting pending invitations. */
function PeopleMeter({ people, limit }: { people: number; limit: number }) {
  const full = people >= limit
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">People</span>
        <span
          className={full ? "font-medium text-foreground" : "text-foreground"}
        >
          {people} of {limit}
        </span>
      </div>
      <div
        role="meter"
        aria-label="People on this plan"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={people}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={
            full
              ? "h-full rounded-full bg-warning"
              : "h-full rounded-full bg-primary"
          }
          style={{ width: `${Math.min(100, (people / limit) * 100)}%` }}
        />
      </div>
    </div>
  )
}

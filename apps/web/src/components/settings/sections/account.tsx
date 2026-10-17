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
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@worktable/ui/components/card"
import {
  CreditCard,
  Download,
  ExternalLink,
  Gift,
  TriangleAlert,
} from "lucide-react"
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
  const change = useMutation({ mutationFn: changeCloudPlan, onSuccess: refresh })
  const cancel = useMutation({ mutationFn: cancelCloudPlan, onSuccess: refresh })
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
        <h3 className="text-sm font-medium text-foreground">Subscription</h3>
        {billingQuery.isLoading ? (
          <Card size="sm">
            <CardContent>
              <p className="text-sm text-muted-foreground" role="status">
                Checking your subscription…
              </p>
            </CardContent>
          </Card>
        ) : billingQuery.error instanceof HttpError && billingQuery.error.status === 403 && (billingQuery.error.body as {code?: string})?.code === "BILLING_PAYER_REQUIRED" ? (
          <p className="text-sm text-muted-foreground">
            {cloudPlan?.payerName
              ? `${cloudPlan.payerName} manages billing for ${worktableName}.`
              : `Billing for ${worktableName} is managed by the person who pays for it.`}
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
            onChangePlan={(plan) => change.mutate(plan)}
            onCancel={() => cancel.mutate()}
          />
        )}

      </section>

    </>
  )
}

function formatPrice(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
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
  onChangePlan?: (plan: PaidCloudPlanId) => void
  onCancel?: () => void
}) {
  const [cancelling, setCancelling] = useState(false)
  const plan = billing.plan
  const complimentary = billing.access === "complimentary"
  const paymentRequired = billing.access === "payment_required"
  const inGrace = billing.access === "grace"
  const locked = billing.access === "locked"
  const solo = plan.id === "solo"
  const cancelsAtEnd = Boolean(billing.subscription?.cancelAtPeriodEnd)
  const price =
    plan.amount === 0 ? "Free" : `${formatPrice(plan.amount, plan.currency)} a month`
  const title = complimentary ? "VIP" : plan.name
  const description = complimentary
    ? "Boss tier"
    : solo
      ? "Free · Just you and your agents"
      : `${price} · Up to ${plan.peopleLimit} people`
  const badge = complimentary
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
  const date = billing.subscription?.currentPeriodEnd
  const dateLine = !date || locked || inGrace
    ? null
    : cancelsAtEnd
      ? `${plan.name} until ${formatDate(date)}`
      : `Next charge ${formatDate(date)}`
  const fitsSolo = people === null || people <= 1
  const showExport = locked && billing.canExport
  const busy = pending !== null

  return (
    <div className="flex flex-col gap-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {complimentary ? (
              <Gift className="size-4 text-primary-text" />
            ) : (
              <CreditCard className="size-4 text-primary-text" />
            )}
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
          {badge ? (
            <CardAction>
              <Badge variant="secondary">{badge}</Badge>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {people !== null || dateLine ? (
            <p className="text-sm text-muted-foreground">
              {[
                people !== null && !complimentary
                  ? `${people} of ${plan.peopleLimit} ${plan.peopleLimit === 1 ? "person" : "people"}`
                  : null,
                dateLine,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {inGrace && billing.subscription?.graceEndsAt ? (
            <div className="flex gap-2 rounded-lg bg-warning/10 p-3 text-sm text-foreground">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>
                Payment for {worktableName} failed. Update the card by{" "}
                {formatDate(billing.subscription.graceEndsAt)} to keep access.
              </p>
            </div>
          ) : null}
          {locked ? (
            <p className="text-sm text-muted-foreground">
              {billing.deletesAt
                ? `${worktableName} is locked. Export it before ${formatDate(billing.deletesAt)}, when it will be deleted.`
                : `${worktableName} is locked. You can still export it.`}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {solo && billing.canCheckout
              ? PAID_CLOUD_PLAN_IDS.map((id, index) => (
                  <Button
                    key={id}
                    size="sm"
                    variant={index === 0 ? "default" : "outline"}
                    disabled={busy}
                    onClick={() => onCheckout(id)}
                  >
                    {pending === "checkout"
                      ? "Opening payment…"
                      : `Move to ${CLOUD_PLANS[id].name}, ${formatPrice(CLOUD_PLANS[id].amount, plan.currency)} a month`}
                  </Button>
                ))
              : null}
            {!solo && billing.canCheckout ? (
              <Button size="sm" disabled={busy} onClick={() => onCheckout()}>
                <CreditCard className="size-4" />
                {pending === "checkout"
                  ? "Opening payment…"
                  : locked
                    ? "Restart subscription"
                    : "Subscribe"}
              </Button>
            ) : null}
            {billing.canChangeTo.map((id) => {
              const fits = people === null || people <= CLOUD_PLANS[id].peopleLimit
              return (
                <Button
                  key={id}
                  size="sm"
                  disabled={busy || !fits}
                  title={
                    fits
                      ? undefined
                      : `Remove ${people! - CLOUD_PLANS[id].peopleLimit} people before moving to ${CLOUD_PLANS[id].name}`
                  }
                  onClick={() => onChangePlan(id)}
                >
                  {pending === "change"
                    ? "Changing plan…"
                    : `Move to ${CLOUD_PLANS[id].name}, ${formatPrice(CLOUD_PLANS[id].amount, plan.currency)} a month`}
                </Button>
              )
            })}
            {billing.canManageBilling ? (
              <Button
                variant={inGrace && !billing.canCheckout ? "default" : "outline"}
                size="sm"
                disabled={busy}
                onClick={onPortal}
              >
                <ExternalLink className="size-4" />
                {pending === "portal" ? "Opening…" : "Manage payment"}
              </Button>
            ) : null}
            {billing.canManageBilling && !solo && !locked && !cancelsAtEnd ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setCancelling(true)}
              >
                Cancel plan
              </Button>
            ) : null}
          </div>
          {billing.canChangeTo.some(
            (id) => people !== null && people > CLOUD_PLANS[id].peopleLimit
          ) ? (
            <p className="text-xs text-muted-foreground">
              {billing.canChangeTo
                .filter((id) => people !== null && people > CLOUD_PLANS[id].peopleLimit)
                .map(
                  (id) =>
                    `Remove ${people! - CLOUD_PLANS[id].peopleLimit} people before moving to ${CLOUD_PLANS[id].name}.`
                )
                .join(" ")}
            </p>
          ) : null}
          {showExport ? (
            <button
              className="flex w-fit items-center gap-1.5 text-sm font-medium text-primary-text underline underline-offset-4"
              type="button"
              onClick={downloadCloudWorkspace}
            >
              <Download className="size-4" />
              Export
            </button>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <p className="px-1 text-sm text-muted-foreground">
        <a
          className="text-primary-text underline underline-offset-4"
          href="https://www.worktable.cloud/terms#refunds"
          target="_blank"
          rel="noopener noreferrer"
        >
          Refund policy
        </a>
      </p>
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

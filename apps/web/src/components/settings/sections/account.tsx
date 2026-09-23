import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { CLOUD_PERSONAL_PLAN } from "@worktable/hosted-contract"
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
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import {
  CreditCard,
  Download,
  ExternalLink,
  Gift,
  LogOut,
  TriangleAlert,
} from "lucide-react"
import { getConnection } from "@/lib/system-api"
import { submitCloudLogout } from "@/lib/cloud-logout"
import {
  downloadCloudWorkspace,
  getCloudBillingStatus,
  openCloudBillingCheckout,
  openCloudBillingPortal,
} from "@/lib/billing-api"
import { useSettingsSectionActive } from "../settings-dialog"

export function AccountSection() {
  const sectionActive = useSettingsSectionActive()
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
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
  const portal = useMutation({
    mutationFn: openCloudBillingPortal,
  })
  const checkout = useMutation({
    mutationFn: openCloudBillingCheckout,
  })

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
        ) : billingQuery.isError || !billingQuery.data ? (
          <Card size="sm">
            <CardContent className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 text-warning" />
              <p className="text-sm text-muted-foreground">
                We couldn&rsquo;t load your subscription.{" "}
                <a
                  className="text-primary-text underline underline-offset-4"
                  href={`mailto:${CLOUD_PERSONAL_PLAN.supportEmail}`}
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
            checkoutPending={checkout.isPending}
            checkoutError={
              checkout.isError ? checkout.error.message : undefined
            }
            onCheckout={() => checkout.mutate()}
            portalPending={portal.isPending}
            portalError={portal.isError ? portal.error.message : undefined}
            onPortal={() => portal.mutate()}
          />
        )}

        <h3 className="text-sm font-medium text-foreground">Session</h3>
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Signed in on this browser
            </p>
          </div>
          <Button variant="outline" onClick={() => setSignOutOpen(true)}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Your agents stay connected when you sign out.
        </p>
      </section>

      <ConfirmDialog
        open={signOutOpen}
        onOpenChange={(open) => {
          if (!signingOut) setSignOutOpen(open)
        }}
        title="Sign out of Worktable?"
        description="This signs you out on this browser. Your agents stay connected and your data stays intact."
        confirmLabel="Sign out"
        loadingLabel="Signing out…"
        loading={signingOut}
        icon={<LogOut className="size-5 text-primary" />}
        onConfirm={async () => {
          setSigningOut(true)
          await submitCloudLogout()
        }}
      />
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

function formatUtcDeadline(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(timestamp)
}

export function SubscriptionCard({
  billing,
  checkoutPending,
  checkoutError,
  onCheckout,
  portalPending,
  portalError,
  onPortal,
}: {
  billing: Awaited<ReturnType<typeof getCloudBillingStatus>>
  checkoutPending: boolean
  checkoutError?: string
  onCheckout: () => void
  portalPending: boolean
  portalError?: string
  onPortal: () => void
}) {
  const complimentary = billing.access === "complimentary"
  const paymentRequired = billing.access === "payment_required"
  const inGrace = billing.access === "grace"
  const locked = billing.access === "locked"
  const price = `${formatPrice(billing.plan.amount, billing.plan.currency)} USD + tax / ${billing.plan.interval}`
  const title = complimentary
    ? "VIP"
    : locked
      ? "Subscription expired"
      : inGrace
        ? "Payment due"
        : paymentRequired
          ? "Payment required"
          : price
  const description = complimentary
    ? "Boss tier"
    : locked || inGrace || paymentRequired
      ? price
      : "Billed monthly."
  const statusLabel = billing.subscription?.cancelAtPeriodEnd
    ? "Cancels at period end"
    : "Active"
  const date = billing.subscription?.currentPeriodEnd
  const dateLabel = billing.subscription?.cancelAtPeriodEnd
    ? "Access through"
    : inGrace
      ? "Paid period ended"
      : locked
        ? "Access ended"
        : "Renews"
  const showExport = locked && billing.canExport
  const hasContent = Boolean(
    date ||
    inGrace ||
    locked ||
    billing.canCheckout ||
    billing.canManageBilling ||
    showExport ||
    checkoutError ||
    portalError
  )

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
          {!complimentary && !locked && !inGrace && !paymentRequired ? (
            <CardAction>
              <Badge variant="secondary">{statusLabel}</Badge>
            </CardAction>
          ) : null}
        </CardHeader>
        {hasContent ? (
          <CardContent className="flex flex-col gap-4">
            {date ? (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">
                  {dateLabel}:
                </span>{" "}
                {billing.subscription?.cancelAtPeriodEnd
                  ? formatUtcDeadline(date)
                  : formatDate(date)}
              </p>
            ) : null}
            {inGrace && billing.subscription?.graceEndsAt ? (
              <div className="flex gap-2 rounded-lg bg-warning/10 p-3 text-sm text-foreground">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <p>
                  Update your payment method by{" "}
                  {formatUtcDeadline(billing.subscription.graceEndsAt)} to avoid
                  export-only access.
                </p>
              </div>
            ) : null}
            {locked ? (
              <p className="text-sm text-muted-foreground">
                Your Worktable data is available for export only. Resubscribe to
                continue access.
              </p>
            ) : null}
            {billing.canCheckout || billing.canManageBilling ? (
              <div className="flex flex-wrap gap-2">
                {billing.canCheckout ? (
                  <Button
                    size="sm"
                    disabled={checkoutPending}
                    onClick={onCheckout}
                  >
                    <CreditCard className="size-4" />
                    {checkoutPending
                      ? "Opening checkout…"
                      : locked
                        ? "Restart subscription"
                        : "Subscribe"}
                  </Button>
                ) : null}
                {billing.canManageBilling ? (
                  <Button
                    variant={
                      inGrace && !billing.canCheckout ? "default" : "outline"
                    }
                    size="sm"
                    disabled={portalPending}
                    onClick={onPortal}
                  >
                    <ExternalLink className="size-4" />
                    {portalPending ? "Opening…" : "Manage billing"}
                  </Button>
                ) : null}
              </div>
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
            {checkoutError ? (
              <p className="text-sm text-destructive" role="alert">
                {checkoutError}
              </p>
            ) : null}
            {portalError ? (
              <p className="text-sm text-destructive" role="alert">
                {portalError}
              </p>
            ) : null}
          </CardContent>
        ) : null}
      </Card>
      <p className="px-1 text-xs text-muted-foreground">
        <a
          className="text-primary-text underline underline-offset-4"
          href="https://www.worktable.cloud/terms#refunds"
          target="_blank"
          rel="noopener noreferrer"
        >
          Refund policy
        </a>
      </p>
    </div>
  )
}

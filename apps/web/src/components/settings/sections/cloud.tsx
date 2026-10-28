import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@worktable/ui/components/badge"
import { Button } from "@worktable/ui/components/button"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { CopyField } from "@worktable/ui/components/copy-field"
import { Disclosure } from "@worktable/ui/components/disclosure"
import { InfoTip } from "@worktable/ui/components/info-tip"
import { Switch } from "@worktable/ui/components/switch"
import { cn } from "@worktable/ui/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { fetchJSON, HttpError } from "@/lib/http"
import { queryKeys } from "@/lib/queries"
import { SettingsGroup } from "../settings-group"
import { useSettingsSectionActive } from "../settings-dialog"

type Status = {
  state: string
  enabled: boolean | null
  cloudOrigin: string
  mcpUrl?: string
  billingWorkspaceId?: string
  teamAuthorizationRequired?: boolean
  account: {
    user: { id: string; email?: string; name?: string } | null
    signingIn: boolean
    error?: string
  }
}
type Tone = "success" | "warning" | "danger" | "neutral"
const STATES: Record<string, { label: string; tone: Tone; busy?: boolean }> = {
  connecting: { label: "Connecting", tone: "neutral", busy: true },
  online: { label: "Online", tone: "success" },
  offline: { label: "Offline", tone: "warning" },
  locked: { label: "Subscription required", tone: "danger" },
  paused: { label: "Paused", tone: "neutral" },
  revoked: { label: "Unlinked", tone: "neutral" },
  unlinking: { label: "Unlinking", tone: "neutral", busy: true },
  error: { label: "Can’t connect", tone: "danger" },
}
const DOTS: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground",
}

/** The link's state beside its switch: a dot and a word. */
function LinkStatus({ state }: { state: string }) {
  const status = STATES[state]
  if (!status) return null
  return (
    <Badge variant="outline" role="status" className="text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          DOTS[status.tone],
          status.busy && "animate-pulse motion-reduce:animate-none"
        )}
      />
      {status.label}
    </Badge>
  )
}

function LinkDetails() {
  return (
    <InfoTip label="About Worktable Link">
      <p>
        Worktable Link lets AI apps on any device reach this Worktable. Your
        files stay on this device, private to you, the agents you allow and
        people you share with.
      </p>
    </InfoTip>
  )
}

export function CloudSection({ active: enabled }: { active?: boolean } = {}) {
  const sectionActive = useSettingsSectionActive()
  const active = enabled ?? sectionActive
  const client = useQueryClient()
  const [signInUrl, setSignInUrl] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  // A choice belongs to the account that made it.
  const [chosen, setChosen] = useState<{ userId?: string; id: string } | null>(
    null
  )
  const query = useQuery({
    queryKey: ["linked"],
    queryFn: () => fetchJSON<Status>("/api/linked"),
    enabled: active,
    refetchInterval: active ? 3000 : false,
  })
  const subscriptions = useQuery({
    queryKey: ["linked-subscriptions", query.data?.account.user?.id],
    queryFn: () =>
      fetchJSON<{
        worktables: Array<{ id: string; name: string; access: string }>
      }>("/api/linked/subscriptions"),
    enabled: active && Boolean(query.data?.account.user),
  })
  const userId = query.data?.account.user?.id
  const subscriptionId = chosen?.userId === userId ? (chosen?.id ?? null) : null
  const setSubscriptionId = (id: string | null) =>
    setChosen(id ? { userId, id } : null)
  // A choice made here wins over the stored one, so a paused or locked link
  // can move to another subscription.
  const selectedSubscription =
    subscriptionId ??
    query.data?.billingWorkspaceId ??
    (subscriptions.data?.worktables.length === 1
      ? subscriptions.data.worktables[0]!.id
      : undefined)
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["linked"] })
    void client.invalidateQueries({ queryKey: ["system", "deployment"] })
  }
  useEffect(() => {
    void client.invalidateQueries({ queryKey: ["system", "deployment"] })
  }, [client, query.data?.state])
  // The Worktable menu lists this account's Worktables and this one's Link,
  // so it asks again once either changes.
  const menuUserId = query.data?.account.user?.id ?? ""
  const menuEnabled = query.data?.enabled
  const shownMenuFacts = useRef<{
    userId: string
    enabled: boolean | null
  } | null>(null)
  useEffect(() => {
    if (menuEnabled === undefined) return
    const previous = shownMenuFacts.current
    if (previous && previous.userId !== menuUserId) {
      // A failed refresh may retain this account's list, never another account's.
      void client.resetQueries({
        queryKey: queryKeys.worktableMenu,
        exact: true,
      })
    } else if (previous && previous.enabled !== menuEnabled) {
      void client.invalidateQueries({
        queryKey: queryKeys.worktableMenu,
        exact: true,
      })
    }
    shownMenuFacts.current = { userId: menuUserId, enabled: menuEnabled }
  }, [client, menuUserId, menuEnabled])
  const signIn = useMutation({
    mutationFn: () =>
      fetchJSON<{ url: string }>("/api/linked/account", { method: "POST" }),
    onSuccess: (data) => {
      setSignInUrl(data.url)
      invalidate()
    },
  })
  const signOut = useMutation({
    mutationFn: () => fetchJSON("/api/linked/account", { method: "DELETE" }),
    onSuccess: () => {
      setSignInUrl(null)
      invalidate()
    },
  })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      fetchJSON("/api/linked", {
        method: "PATCH",
        body: JSON.stringify({
          enabled,
          ...(enabled && selectedSubscription
            ? { workspaceId: selectedSubscription }
            : {}),
        }),
      }),
    onSettled: invalidate,
  })
  const disconnect = useMutation({
    mutationFn: () => fetchJSON("/api/linked", { method: "DELETE" }),
    onSuccess: () => {
      setConfirm(false)
      invalidate()
    },
  })
  async function openSignIn() {
    // Open synchronously for browser popup policies. Desktop may instead use the fallback link.
    const tab = window.open("about:blank", "_blank")
    if (tab) tab.opener = null
    try {
      const { url } = await signIn.mutateAsync()
      if (tab) tab.location.replace(url)
    } catch {
      tab?.close()
    }
  }
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking connection…
      </p>
    )
  if (query.isError)
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          Could not check this device.
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    )
  const data = query.data
  const error =
    signIn.error ?? signOut.error ?? toggle.error ?? disconnect.error
  const failureCode =
    error instanceof HttpError && error.body && typeof error.body === "object"
      ? (error.body as { code?: string }).code
      : undefined
  const subscriptionRequired =
    data.state === "locked" ||
    failureCode === "BILLING_REQUIRED" ||
    failureCode === "BILLING_LOCKED"
  const linked = !["unlinked", "awaiting_approval", "revoked"].includes(
    data.state
  )
  const linkDisabled =
    !data.account.user ||
    (!data.enabled && !selectedSubscription) ||
    toggle.isPending ||
    disconnect.isPending ||
    data.state === "unlinking"
  const linkTooltip = !data.account.user
    ? "Sign in to Worktable Cloud to enable this connection."
    : !data.enabled && !selectedSubscription
      ? "Choose a Worktable for this device."
      : disconnect.isPending || data.state === "unlinking"
        ? "Unlinking this device…"
        : toggle.isPending
          ? "Updating connection…"
          : data.enabled
            ? "Turn off to pause AI connections and document sharing."
            : "Enable AI connections and document sharing."
  return (
    <section className="flex min-w-0 flex-col gap-6">
      <SettingsGroup title="Account">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {data.account.user ? (
            <>
              <span className="min-w-0 text-sm break-all">
                {data.account.user.email ||
                  data.account.user.name ||
                  "Signed in"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={signOut.isPending || toggle.isPending}
                onClick={() => signOut.mutate()}
              >
                Sign out
              </Button>
            </>
          ) : (
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                Not signed in
              </span>
              <Button
                disabled={signIn.isPending}
                onClick={() => void openSignIn()}
              >
                {signIn.isPending ? "Opening sign-in" : "Sign in"}
              </Button>
              {signInUrl && data.account.signingIn && (
                <a
                  className="w-full text-sm text-primary-text underline underline-offset-4"
                  href={signInUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Continue sign-in
                </a>
              )}
            </div>
          )}
        </div>
      </SettingsGroup>
      <SettingsGroup title="Connection">
        <div className="flex flex-col gap-4">
          {data.teamAuthorizationRequired && (
            <p className="text-sm text-muted-foreground">
              Teams is enabled. Turn on Worktable Link to connect your Cloud
              account to your member account.
            </p>
          )}
          {data.account.user && !data.mcpUrl && (
            <div className="flex flex-col gap-2">
              <label
                htmlFor="link-subscription"
                className="text-sm font-medium"
              >
                Worktable
              </label>
              <Select
                value={selectedSubscription ?? ""}
                onValueChange={setSubscriptionId}
                disabled={toggle.isPending}
              >
                <SelectTrigger id="link-subscription">
                  <SelectValue placeholder="Choose a Worktable">
                    {
                      subscriptions.data?.worktables.find(
                        (worktable) => worktable.id === selectedSubscription
                      )?.name
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {subscriptions.data?.worktables.map((worktable) => (
                    <SelectItem key={worktable.id} value={worktable.id}>
                      {worktable.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {subscriptions.isError && (
                <Button
                  variant="outline"
                  onClick={() => void subscriptions.refetch()}
                >
                  Retry
                </Button>
              )}
              {subscriptions.data?.worktables.length === 0 && (
                <a
                  className="text-sm text-primary-text underline underline-offset-4"
                  href={data.cloudOrigin}
                  target="_blank"
                  rel="noreferrer"
                >
                  Create a Cloud Worktable
                </a>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-6">
            <div className="flex items-center gap-1.5">
              <label htmlFor="worktable-link" className="text-sm font-medium">
                Worktable Link
              </label>
              <LinkDetails />
            </div>
            <div className="flex min-h-11 shrink-0 items-center gap-3">
              {data.enabled !== null && <LinkStatus state={data.state} />}
              {data.enabled === null ? (
                <span role="status" className="text-sm text-muted-foreground">
                  {["offline", "error"].includes(data.state)
                    ? "Unavailable"
                    : "Checking…"}
                </span>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="inline-flex"
                        role="group"
                        aria-label="Worktable Link"
                        tabIndex={linkDisabled ? 0 : undefined}
                      />
                    }
                  >
                    <Switch
                      id="worktable-link"
                      aria-label="Worktable Link"
                      checked={
                        toggle.isPending ? toggle.variables : data.enabled
                      }
                      disabled={linkDisabled}
                      onCheckedChange={(enabled) => toggle.mutate(enabled)}
                    />
                  </TooltipTrigger>
                  <TooltipContent>{linkTooltip}</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
          {data.mcpUrl && (
            <Disclosure title="Connect another app">
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  For apps without the official Worktable plugin. Add it as a
                  custom connector.
                </p>
                <CopyField label="MCP URL" value={data.mcpUrl} />
              </div>
            </Disclosure>
          )}
          {subscriptionRequired && (
            <a
              className="text-sm text-primary-text underline underline-offset-4"
              href={
                selectedSubscription
                  ? `${data.cloudOrigin}/t/${encodeURIComponent(selectedSubscription)}/signup`
                  : data.cloudOrigin
              }
              target="_blank"
              rel="noreferrer"
            >
              Manage subscription
            </a>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <a
            className="text-sm text-primary-text underline underline-offset-4"
            href={`${data.cloudOrigin}/linked`}
            target="_blank"
            rel="noreferrer"
          >
            Manage devices
          </a>
          {(linked ||
            data.state === "awaiting_approval" ||
            data.state === "revoked") && (
            <Button
              variant="ghost"
              disabled={data.state === "unlinking" || toggle.isPending}
              onClick={() => setConfirm(true)}
            >
              Unlink
            </Button>
          )}
        </div>
      </SettingsGroup>
      {(error || data.account.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error?.message ?? data.account.error}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Unlink this device?"
        description="Connected AI apps and share links will stop working. Your documents stay on this device."
        confirmLabel="Unlink"
        loadingLabel="Unlinking"
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </section>
  )
}

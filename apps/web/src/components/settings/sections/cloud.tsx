import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { CopyField } from "@worktable/ui/components/copy-field"
import { Switch } from "@worktable/ui/components/switch"
import { fetchJSON, HttpError } from "@/lib/http"
import { useSettingsSectionActive } from "../settings-dialog"

type Status = {
  state: string
  enabled: boolean | null
  cloudOrigin: string
  mcpUrl?: string
  account: {
    user: { id: string; email?: string; name?: string } | null
    signingIn: boolean
    error?: string
  }
}
const STATES: Record<string, string> = {
  connecting: "Connecting…",
  online: "Connected",
  offline: "Offline",
  locked: "Subscription required",
  paused: "Paused",
  revoked: "Device unlinked",
  unlinking: "Unlinking…",
  error: "Could not connect",
}

export function CloudSection() {
  const active = useSettingsSectionActive()
  const client = useQueryClient()
  const [signInUrl, setSignInUrl] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const query = useQuery({
    queryKey: ["linked"],
    queryFn: () => fetchJSON<Status>("/api/linked"),
    enabled: active,
    refetchInterval: active ? 3000 : false,
  })
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["linked"] })
    void client.invalidateQueries({ queryKey: ["system", "deployment"] })
  }
  useEffect(() => {
    void client.invalidateQueries({ queryKey: ["system", "deployment"] })
  }, [client, query.data?.state])
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
        body: JSON.stringify({ enabled }),
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
  return (
    <section className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {data.account.user ? (
          <>
            <span className="min-w-0 text-sm break-all">
              {data.account.user.email || data.account.user.name || "Signed in"}
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
          <div className="flex flex-col items-start gap-3">
            <Button
              disabled={signIn.isPending}
              onClick={() => void openSignIn()}
            >
              {signIn.isPending
                ? "Opening sign-in…"
                : "Sign in to Worktable Cloud"}
            </Button>
            {signInUrl && data.account.signingIn && (
              <a
                className="text-sm text-primary-text underline underline-offset-4"
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
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-6">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="worktable-link" className="text-sm font-medium">
              Worktable Link
            </label>
            <p
              id="worktable-link-description"
              className="text-sm text-muted-foreground"
            >
              Connect approved AI apps and share documents from this device.
            </p>
          </div>
          <div className="flex min-h-11 shrink-0 items-center">
            {data.enabled === null ? (
              <span role="status" className="text-xs text-muted-foreground">
                {["offline", "error"].includes(data.state)
                  ? "Unavailable"
                  : "Checking…"}
              </span>
            ) : (
              <Switch
                id="worktable-link"
                aria-label="Worktable Link"
                aria-describedby="worktable-link-description"
                checked={toggle.isPending ? toggle.variables : data.enabled}
                disabled={
                  !data.account.user ||
                  toggle.isPending ||
                  disconnect.isPending ||
                  data.state === "unlinking"
                }
                onCheckedChange={(enabled) => toggle.mutate(enabled)}
              />
            )}
          </div>
        </div>
        {data.enabled !== null && STATES[data.state] && (
          <p role="status" className="text-xs text-muted-foreground">
            {STATES[data.state]}
          </p>
        )}
        {data.mcpUrl && <CopyField label="MCP URL" value={data.mcpUrl} />}
        {subscriptionRequired && (
          <a
            className="text-sm text-primary-text underline underline-offset-4"
            href={`${data.cloudOrigin}/signup`}
            target="_blank"
            rel="noreferrer"
          >
            Manage subscription
          </a>
        )}
      </div>
      {(error || data.account.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error?.message ?? data.account.error}
        </p>
      )}
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
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Unlink this device?"
        description="Connected AI apps and share links will stop working. Your documents stay on this device."
        confirmLabel="Unlink"
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </section>
  )
}

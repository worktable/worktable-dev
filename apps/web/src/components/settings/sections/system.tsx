import { SourceCodeLink } from "@/components/source-code-link"
import { useCallback, useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import { Check, Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { CopyField } from "@worktable/ui/components/copy-field"
import { SettingRow } from "@worktable/ui/components/setting-row"
import { Switch } from "@worktable/ui/components/switch"
import {
  getConnection,
  checkSystemVersionNow,
  CACHED_SYSTEM_VERSION_QUERY_KEY,
  getHealth,
  getSystemVersion,
  getUpdateStatus,
  UPDATE_CHECK_FRESH_MS,
  SYSTEM_VERSION_QUERY_KEY,
  startUpdate,
  type SystemVersion,
  type UpdateStatus,
} from "@/lib/system-api"
import { markUpdateVersionSeen } from "@/lib/update-notification"
import { RelativeTime } from "@/lib/time"
import { useWorkspace } from "@/lib/queries"
import { useServerSettings } from "@/hooks/use-server-settings"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { useSettingsPatch } from "../use-settings-patch"
import { useSettingsSectionActive } from "../settings-dialog"

// Local phases distinct from the server's UpdateState: the UI also models
// "starting" (POST in flight), "current" (the worker's `noop` verdict — asked
// for latest, already on it), and derives an "in-flight"/"reconnecting" view
// from the polled status + health, none of which the server tracks itself.
type Phase = "idle" | "starting" | "current" | "succeeded" | "failed"

const POLL_MS = 2000
const UPDATE_STATUS_QUERY_KEY = ["system", "update"] as const

function isInFlight(status: UpdateStatus | undefined): boolean {
  return status?.state === "running" || status?.state === "restarting"
}

function hasFreshVersionCheck(
  version: SystemVersion | undefined,
  observedAt: number
): boolean {
  if (version?.checkStatus !== "fresh" || !version.checkedAt) return false
  if (observedAt <= 0) return false
  // The server is authoritative about freshness. Measure expiry from when this
  // browser received that verdict so server/browser clock skew cannot reject a
  // newly returned check (or keep one alive indefinitely).
  const observedAge = Math.max(0, Date.now() - observedAt)
  return observedAge < (version.checkTtlRemainingMs ?? UPDATE_CHECK_FRESH_MS)
}

// The System settings section. The nav rail / tab strip already names the
// section, so no repeated heading — group headers carry the hierarchy.
export function SystemSection() {
  const deploymentQuery = useDeploymentInfo()
  const deployment = deploymentQuery.data
  const cloud = deployment?.mode === "cloud"

  if (cloud) {
    return <AboutGroup cloud />
  }

  return (
    <div className="flex flex-col gap-6">
      <AboutGroup />
      {deployment?.capabilities.softwareUpdates ? (
        <SoftwareUpdateSection />
      ) : null}
      {deployment?.capabilities.updateChecks ? <AutoUpdateGroup /> : null}
    </div>
  )
}

// ── About ────────────────────────────────────────────────────────────────────

// Read-only install facts. Version reuses the ["system","version"] cache (same
// key the update group reads — one source). Address is the bind-facing origin;
// the workspace path is a CopyField (the one value genuinely worth copying —
// you paste it into a terminal or file browser).
function AboutGroup({ cloud = false }: { cloud?: boolean }) {
  const sectionActive = useSettingsSectionActive()
  // Same gate as the update group below: /version may contact the release host.
  const versionQuery = useQuery({
    queryKey: SYSTEM_VERSION_QUERY_KEY,
    queryFn: getSystemVersion,
    staleTime: 30_000,
    enabled: sectionActive,
    refetchOnMount: (q) =>
      hasFreshVersionCheck(q.state.data, q.state.dataUpdatedAt)
        ? true
        : "always",
    refetchInterval: (q) => {
      const version = q.state.data
      if (
        !sectionActive ||
        version?.checkStatus !== "fresh" ||
        !version.checkedAt
      ) {
        return false
      }
      if (q.state.fetchStatus === "fetching") return false
      if (q.state.error) return 5 * 60_000
      const remaining = version.checkTtlRemainingMs ?? UPDATE_CHECK_FRESH_MS
      const untilExpiry = q.state.dataUpdatedAt + remaining - Date.now()
      return untilExpiry > 0 ? Math.max(1_000, untilExpiry) : 5 * 60_000
    },
  })
  const connectionQuery = useQuery({
    queryKey: ["system", "connection"],
    queryFn: getConnection,
    staleTime: 30_000,
  })
  const workspaceQuery = useWorkspace()

  const root = workspaceQuery.data?.root

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">About</h3>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        {cloud ? <AboutRow label="Product" value="Worktable Cloud" /> : null}
        <AboutRow
          label="Version"
          value={versionQuery.data ? `v${versionQuery.data.current}` : null}
        />
        <AboutRow
          label="Address"
          value={connectionQuery.data?.origin ?? null}
        />
        {!cloud &&
          (root ? (
            <CopyField label="Worktable folder" value={root} />
          ) : (
            <AboutRow label="Worktable folder" value={null} />
          ))}
      </div>
      <SourceCodeLink sourceUrl={versionQuery.data?.sourceUrl} />
      {cloud ? (
        <p className="text-xs text-muted-foreground">
          Worktable Cloud is updated automatically.
        </p>
      ) : null}
    </section>
  )
}

function AboutRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="shrink-0 text-sm text-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
        {value ?? "—"}
      </span>
    </div>
  )
}

// ── Automatic update checks ──────────────────────────────────────────────────

function AutoUpdateGroup() {
  const settingsQuery = useServerSettings()
  const patch = useSettingsPatch()
  const settings = settingsQuery.data

  return (
    <section className="flex flex-col gap-3">
      <div className="rounded-xl border border-border bg-card p-4">
        {settingsQuery.isError ? (
          <p className="text-sm text-muted-foreground">
            Update settings require owner access.
          </p>
        ) : (
          <SettingRow
            label="Check for updates automatically"
            description="Checks about every 6 hours."
          >
            <Switch
              checked={settings?.updates.autoCheck ?? false}
              disabled={!settings || patch.isPending}
              onCheckedChange={(v) =>
                patch.mutate({ updates: { autoCheck: v } })
              }
            />
          </SettingRow>
        )}
      </div>
    </section>
  )
}

function SoftwareUpdateSection() {
  const sectionActive = useSettingsSectionActive()
  const queryClient = useQueryClient()
  // Gated on the section being shown: GET /version can contact the release
  // host (TTL-cached update check), which must not happen just because the
  // dialog opened on another tab — especially with auto-check turned off.
  // Once an update is started the queries below keep the flow alive even if
  // the user switches away mid-restart.
  const versionQuery = useQuery({
    queryKey: SYSTEM_VERSION_QUERY_KEY,
    queryFn: getSystemVersion,
    staleTime: 30_000,
    enabled: sectionActive,
  })
  const publishVersionResult = useCallback(
    (version: SystemVersion) => {
      queryClient.setQueryData(SYSTEM_VERSION_QUERY_KEY, version)
      queryClient.setQueryData(CACHED_SYSTEM_VERSION_QUERY_KEY, version)
    },
    [queryClient]
  )
  const checkMutation = useMutation({
    mutationFn: checkSystemVersionNow,
    onSuccess: publishVersionResult,
  })
  const {
    error: checkMutationError,
    isError: checkMutationIsError,
    reset: resetCheckMutation,
    submittedAt: checkMutationSubmittedAt,
  } = checkMutation
  const checkError = checkMutationError
    ? checkMutationError instanceof Error
      ? checkMutationError.message
      : "The update check failed."
    : null

  useEffect(() => {
    if (!versionQuery.data) return
    queryClient.setQueryData(CACHED_SYSTEM_VERSION_QUERY_KEY, versionQuery.data)
    // A later successful GET supersedes an older manual-POST failure. Do not
    // reset merely because that failure caused this component to re-render:
    // the GET result must have been written after the mutation began.
    if (
      checkMutationIsError &&
      versionQuery.dataUpdatedAt > checkMutationSubmittedAt
    ) {
      resetCheckMutation()
    }
  }, [
    checkMutationIsError,
    checkMutationSubmittedAt,
    queryClient,
    resetCheckMutation,
    versionQuery.data,
    versionQuery.dataUpdatedAt,
  ])

  useEffect(() => {
    const version = versionQuery.data
    if (
      sectionActive &&
      version?.checkStatus === "fresh" &&
      version.updateAvailable &&
      version.latest
    ) {
      // Only count the release as seen while the user is actually on System.
      // A request may finish after they navigate to another Settings section.
      markUpdateVersionSeen(version.latest)
    }
  }, [sectionActive, versionQuery.data])

  // Only event-handler state lives here; the terminal phase is DERIVED from the
  // queries below (no setState-in-effect). `started` flips when the user clicks
  // Update; `startBaseline` captures the version we updated from; `startError`
  // holds a POST-time failure.
  const [started, setStarted] = useState(false)
  const [startBaseline, setStartBaseline] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  // "Engaged" = an authoritative in-flight status was observed during THIS
  // open, either from the update POST or by resuming an existing operation. A
  // local click alone cannot engage the persisted marker: until the POST writes
  // `running`, the query may still contain the previous update's terminal state.
  // This section remounts on each open, so the latch resets per session.
  const [engaged, setEngaged] = useState(false)
  const celebrated = useRef(false)

  // The status marker self-polls only while an update is actually in flight, so
  // there's no manual interval to manage.
  const statusQuery = useQuery({
    queryKey: UPDATE_STATUS_QUERY_KEY,
    queryFn: getUpdateStatus,
    refetchInterval: (q) => (isInFlight(q.state.data) ? POLL_MS : false),
  })

  const serverInFlight = isInFlight(statusQuery.data)
  const active = started || serverInFlight
  // Guarded setState during render (not an effect) — the supported way to adjust
  // state from a derived value. Latch only after the server reports an operation
  // in flight; `started` is browser-local and may coexist briefly with an old
  // terminal marker while the POST is pending.
  if (!engaged && serverInFlight) setEngaged(true)

  // While the service restarts, /health goes unreachable then returns on the new
  // version — the most direct "it worked" signal. Poll it only while active.
  const healthQuery = useQuery({
    queryKey: ["system", "health"],
    queryFn: getHealth,
    enabled: active,
    refetchInterval: active ? POLL_MS : false,
    retry: false,
    gcTime: 0,
  })

  // The version we updated from: a local click captures it directly; a resumed
  // (already-running) update reads it from the marker.
  const baseline =
    startBaseline ?? (serverInFlight ? (statusQuery.data?.from ?? null) : null)

  const versionFlipped =
    !!baseline && !!healthQuery.data && healthQuery.data.version !== baseline
  // A `noop` success means the worker verified we're already on the latest
  // release and installed nothing — report "already up to date", never the
  // updated-and-reloading celebration (nothing changed to reload onto).
  const alreadyCurrent =
    !versionFlipped &&
    engaged &&
    statusQuery.data?.state === "succeeded" &&
    statusQuery.data.noop === true
  // Trust the marker's terminal state only once engaged, so a past update's
  // persisted marker can't re-fire (reload) on open, and a resumed update's
  // failure isn't hidden.
  const succeeded =
    versionFlipped ||
    (engaged &&
      statusQuery.data?.state === "succeeded" &&
      !statusQuery.data.noop)
  const failedMsg =
    startError ??
    (engaged && statusQuery.data?.state === "failed"
      ? (statusQuery.data.error ?? "Update failed.")
      : null)

  const phase: Phase = succeeded
    ? "succeeded"
    : alreadyCurrent
      ? "current"
      : failedMsg
        ? "failed"
        : started && !serverInFlight && !healthQuery.data
          ? "starting"
          : "idle"
  const inFlight = active && !succeeded && !failedMsg && !alreadyCurrent
  const reconnecting = inFlight && healthQuery.isError
  // The concrete version this attempt is installing. Prefer the worker's
  // resolved target once it is in flight; while the POST is pending, use the
  // fresh release the user approved instead of the previous marker's target.
  const markerTarget = serverInFlight ? statusQuery.data?.to : null
  const targetVersion =
    markerTarget && markerTarget !== "latest"
      ? markerTarget
      : started
        ? (versionQuery.data?.latest ?? null)
        : null

  // One-shot celebration when the update lands. No setState here — just the
  // toast and reload onto the new build.
  useEffect(() => {
    if (succeeded && !celebrated.current) {
      celebrated.current = true
      toast.success("Worktable updated. Reloading…")
      setTimeout(() => window.location.reload(), 1500)
    }
  }, [succeeded])

  async function beginUpdate() {
    if (!hasFreshVersionCheck(versionQuery.data, versionQuery.dataUpdatedAt)) {
      void versionQuery.refetch()
      return
    }
    setStartError(null)
    setStartBaseline(versionQuery.data?.current ?? null)
    setStarted(true)
    try {
      const status = await startUpdate(versionQuery.data?.latest ?? undefined)
      // The POST response is the first authoritative state for this attempt.
      // Cancel any older GET before publishing it so a previous update's
      // persisted `succeeded`/`failed` result cannot win the transition race.
      await queryClient.cancelQueries({ queryKey: UPDATE_STATUS_QUERY_KEY })
      queryClient.setQueryData(UPDATE_STATUS_QUERY_KEY, status)
      if (isInFlight(status)) setEngaged(true)
    } catch (err) {
      setStartError(
        err instanceof Error ? err.message : "Could not start the update."
      )
      return
    }
    void statusQuery.refetch()
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Software update</h3>
        {versionQuery.data && (
          <span className="font-mono text-xs text-muted-foreground">
            v{versionQuery.data.current}
          </span>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        {versionQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Checking version…</p>
        ) : versionQuery.isError ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-destructive">
              Couldn’t read the current version.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void versionQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <UpdateBody
            canUpdate={versionQuery.data?.canUpdate ?? false}
            hasEmbeddedInstaller={
              versionQuery.data?.hasEmbeddedInstaller ?? false
            }
            latest={versionQuery.data?.latest ?? null}
            updateAvailable={versionQuery.data?.updateAvailable ?? false}
            checkStatus={
              versionQuery.data?.checkStatus === "fresh" &&
              !hasFreshVersionCheck(
                versionQuery.data,
                versionQuery.dataUpdatedAt
              )
                ? "stale"
                : (versionQuery.data?.checkStatus ?? "unchecked")
            }
            checkedAt={versionQuery.data?.checkedAt ?? null}
            lastAttemptAt={versionQuery.data?.lastAttemptAt ?? null}
            target={targetVersion}
            phase={phase}
            inFlight={inFlight}
            reconnecting={reconnecting}
            error={failedMsg}
            onUpdate={beginUpdate}
            onCheck={() => checkMutation.mutate()}
            checking={checkMutation.isPending}
            checkError={checkError}
          />
        )}
      </div>
    </section>
  )
}

function UpdateBody({
  canUpdate,
  hasEmbeddedInstaller,
  latest,
  updateAvailable,
  checkStatus,
  checkedAt,
  lastAttemptAt,
  target,
  phase,
  inFlight,
  reconnecting,
  error,
  onUpdate,
  onCheck,
  checking,
  checkError,
}: {
  canUpdate: boolean
  hasEmbeddedInstaller: boolean
  latest: string | null
  updateAvailable: boolean
  checkStatus: SystemVersion["checkStatus"]
  checkedAt: string | null
  lastAttemptAt: string | null
  target: string | null
  phase: Phase
  inFlight: boolean
  reconnecting: boolean
  error: string | null
  onUpdate: () => void
  onCheck: () => void
  checking: boolean
  checkError: string | null
}) {
  if (phase === "succeeded") {
    return (
      <StatusRow icon={<Check className="size-4 text-primary-text" />}>
        Updated. Reloading Worktable…
      </StatusRow>
    )
  }

  if (phase === "current") {
    return (
      <StatusRow icon={<Check className="size-4 text-primary-text" />}>
        You’re already on the latest version.
      </StatusRow>
    )
  }

  if (inFlight) {
    return (
      <StatusRow
        icon={<Loader2 className="size-4 animate-spin text-primary-text" />}
      >
        {reconnecting
          ? "Worktable is restarting on the new version. Reconnecting…"
          : target
            ? `Downloading and applying v${target}…`
            : "Downloading and applying the update…"}
        <span className="mt-1 block text-xs text-muted-foreground">
          This page will reconnect automatically when it’s ready.
        </span>
      </StatusRow>
    )
  }

  if (!hasEmbeddedInstaller) {
    return (
      <p className="text-sm text-muted-foreground">
        Run the install command again to update Worktable.
      </p>
    )
  }

  const checkButtonLabel =
    checkStatus === "failed"
      ? "Retry"
      : checkStatus === "unchecked"
        ? "Check now"
        : "Check again"
  const checkUnavailable =
    checkStatus === "disabled" || checkStatus === "unsupported"
  const canOfferUpdate =
    !checkError &&
    checkStatus === "fresh" &&
    updateAvailable &&
    latest &&
    canUpdate

  let message: string
  if (checkStatus === "failed") {
    message = latest
      ? `Worktable couldn’t confirm whether v${latest} is still the latest release. Try the check again when you’re online.`
      : "Worktable couldn’t reach the release server. Try the check again when you’re online."
  } else if (checkStatus === "stale") {
    message = latest
      ? `The last known release is v${latest}, but that result is out of date. Check again before updating.`
      : "The update information is out of date. Check again before updating."
  } else if (checkStatus === "unchecked") {
    message = "Worktable hasn’t completed an update check yet."
  } else if (checkStatus === "disabled") {
    message = "Update checks are disabled for this install."
  } else if (!canUpdate) {
    message = "Updating isn’t available for this install."
  } else if (updateAvailable && latest) {
    message = `Version ${latest} is available. Worktable will briefly restart and this page will reconnect on its own.`
  } else if (latest) {
    message = "No newer release was found."
  } else {
    message = "No release information is available yet."
  }

  const timestamp =
    checkStatus === "failed" ? lastAttemptAt : (checkedAt ?? lastAttemptAt)

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{message}</p>
      {timestamp ? (
        <p
          className="text-xs text-muted-foreground"
          title={new Date(timestamp).toLocaleString()}
        >
          {checkStatus === "failed" ? "Last attempt" : "Last checked"}{" "}
          <RelativeTime iso={timestamp} />
        </p>
      ) : null}
      {checkError ? (
        <StatusRow icon={<TriangleAlert className="size-4 text-destructive" />}>
          <span className="text-destructive">
            Couldn’t check for updates. {checkError}
          </span>
        </StatusRow>
      ) : null}
      {phase === "failed" && error && (
        <StatusRow icon={<TriangleAlert className="size-4 text-destructive" />}>
          <span className="text-destructive">{error}</span>
        </StatusRow>
      )}
      <div className="flex flex-wrap gap-2">
        {canOfferUpdate ? (
          <Button onClick={onUpdate} disabled={checking}>
            <RefreshCw className="size-4" />
            {phase === "failed" ? "Try update again" : `Update to ${latest}`}
          </Button>
        ) : null}
        {!checkUnavailable ? (
          <Button
            type="button"
            variant={canOfferUpdate ? "outline" : "default"}
            onClick={onCheck}
            disabled={checking}
          >
            {checking ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {checking ? "Checking…" : checkButtonLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function StatusRow({
  icon,
  children,
}: {
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 text-sm text-foreground">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div>{children}</div>
    </div>
  )
}

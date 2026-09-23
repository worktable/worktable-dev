import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CLOUD_PERSONAL_PLAN,
  type CloudBackupStatus,
} from "@worktable/hosted-contract"
import { Button } from "@worktable/ui/components/button"
import { Card, CardContent } from "@worktable/ui/components/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { Badge } from "@worktable/ui/components/badge"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { Skeleton } from "@worktable/ui/components/skeleton"
import {
  Check,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  type LucideIcon,
} from "lucide-react"
import { getCloudBackups, requestCloudBackup } from "@/lib/backups-api"
import { getWorkspace } from "@/lib/api"
import { clearPersistedThreadDrafts } from "@/lib/thread-drafts"
import { clearPersistedDrawingDrafts } from "@/lib/drawing-drafts"
import { useSettingsSectionActive } from "../settings-dialog"

type Checkpoint = CloudBackupStatus["checkpoints"][number]
const queryKey = ["cloud", "backups"] as const
const date = (value: number) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value)
// getRandomValues also works on a LAN HTTP development origin.
const requestId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")

export function BackupsSection() {
  const active = useSettingsSectionActive()
  const client = useQueryClient()
  const [cursor, setCursor] = useState<string>()
  const [selected, setSelected] = useState<Checkpoint | null>(null)
  const [selectError, setSelectError] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const observedRestore = useRef<number | null>(null)
  const history = useQuery({
    queryKey: [...queryKey, cursor ?? "latest"],
    queryFn: () => getCloudBackups(cursor ? { cursor } : {}),
    enabled: active,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.restore?.state === "running" ||
      query.state.data?.backup?.state === "running"
        ? 5000
        : active
          ? 30000
          : false,
  })
  const status = history.data
  const operation = useMutation({
    mutationFn: requestCloudBackup,
    retry: false,
    onSettled: async () => {
      setSelected(null)
      await client.invalidateQueries({ queryKey })
    },
  })

  // Match the import flow: refetch restored content and discard drafts from
  // before the replacement. The collaboration epoch resets live editors.
  useEffect(() => {
    const restore = status?.restore
    if (!restore) return
    if (restore.state === "running") observedRestore.current = restore.updatedAt
    if (restore.state === "complete" && observedRestore.current !== null) {
      observedRestore.current = null
      void getWorkspace()
        .then((workspace) => {
          clearPersistedThreadDrafts(workspace.id)
          clearPersistedDrawingDrafts(workspace.id)
          void client.invalidateQueries()
        })
        .catch(() => {
          void client.invalidateQueries()
        })
    }
  }, [status?.restore, client])

  async function selectSafety(id: string) {
    setSelecting(true)
    setSelectError(false)
    try {
      const result = await getCloudBackups({ checkpoint: id })
      if (!result.selected || !result.canRestore) throw new Error("Unavailable")
      setSelected(result.selected)
    } catch {
      setSelectError(true)
    } finally {
      setSelecting(false)
    }
  }

  if (!status)
    return history.isError ? (
      <div className="flex flex-col items-start gap-3" role="alert">
        <p className="text-sm text-muted-foreground">Couldn’t load backups.</p>
        <Button variant="outline" onClick={() => void history.refetch()}>
          Try again
        </Button>
        <a
          className="text-sm text-primary-text underline underline-offset-4"
          href="/api/backups/recovery"
        >
          Open recovery page
        </a>
      </div>
    ) : (
      <div
        className="flex flex-col gap-3"
        role="status"
        aria-label="Loading backups"
      >
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )

  const busy =
    operation.isPending ||
    status.backup?.state === "running" ||
    status.restore?.state === "running"
  const canRestore = status.canRestore && !busy && !history.isError
  const restore = status.restore
  const notice = backupNotice(status)

  return (
    <section className="flex flex-col gap-5">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {status.automatic
                ? status.intervalMinutes === 60
                  ? "Hourly backups"
                  : `Backups every ${status.intervalMinutes} minutes`
                : "Automatic backups off"}
            </p>
            {status.latest && (
              <p className="mt-1 text-sm text-muted-foreground">
                Last backup {date(status.latest.capturedAt)}
              </p>
            )}
            {status.retentionDays && (
              <p className="mt-1 text-sm text-muted-foreground">
                Kept for {status.retentionDays} days
              </p>
            )}
          </div>
          <Button
            disabled={!status.canCapture || busy || history.isError}
            onClick={() =>
              operation.mutate({ action: "capture", requestId: requestId() })
            }
          >
            {status.backup?.state === "running" ? (
              <>
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                Backing up…
              </>
            ) : (
              "Back up now"
            )}
          </Button>
        </CardContent>
      </Card>

      {(operation.isError || selectError || history.isError) && (
        <div role="alert" className="text-sm text-destructive">
          {operation.isError
            ? "Request status unknown. Refresh before retrying."
            : selectError
              ? "Couldn’t open that backup."
              : "Couldn’t refresh backups."}
          <BackupIconAction
            icon={RefreshCw}
            label="Refresh backups"
            tooltip="Refresh"
            disabled={history.isFetching}
            spinning={history.isFetching}
            onClick={() => {
              setSelectError(false)
              void history.refetch()
            }}
          />
        </div>
      )}

      {notice && (
        <div
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"
          role={notice.error ? "alert" : "status"}
        >
          <div className="flex min-w-0 items-center gap-2">
            {busy ? (
              <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
            ) : notice.undo ? (
              <Check className="size-4 shrink-0 text-success" />
            ) : null}
            <span>
              {notice.title}
              {notice.description && (
                <span className="ml-1 text-muted-foreground">
                  {notice.description}
                </span>
              )}
            </span>
          </div>
          {notice.support && (
            <a
              className="text-primary-text underline underline-offset-4"
              href={`mailto:${CLOUD_PERSONAL_PLAN.supportEmail}`}
            >
              Contact support
            </a>
          )}
          {notice.undo && restore?.safetyId && (
            <Button
              variant="link"
              className="px-0"
              aria-label="Undo this restore"
              disabled={!canRestore || selecting}
              onClick={() => void selectSafety(restore.safetyId!)}
            >
              Undo
            </Button>
          )}
        </div>
      )}

      {!status.runtimeAvailable && !busy && (
        <p className="text-sm text-muted-foreground">
          Worktable unavailable.{" "}
          <a
            className="text-primary-text underline underline-offset-4"
            href="/api/backups/recovery"
          >
            Open recovery page
          </a>
          .
        </p>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium">History</h4>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
            <BackupIconAction
              icon={RefreshCw}
              label="Refresh backups"
              tooltip="Refresh"
              disabled={history.isFetching}
              spinning={history.isFetching}
              onClick={() => void history.refetch()}
            />
          </div>
        </div>
        <Card>
          <CardContent>
            {status.checkpoints.length ? (
              <ul className="divide-y divide-border" aria-label="Saved backups">
                {status.checkpoints.map((checkpoint) => (
                  <li
                    key={checkpoint.id}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm">{date(checkpoint.capturedAt)}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {checkpoint.reason !== "automatic" && (
                          <Badge variant="secondary">
                            {checkpoint.reason === "safety"
                              ? "Before restore"
                              : "Manual"}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <BackupIconAction
                      icon={RotateCcw}
                      tooltip="Restore backup"
                      label={`Restore backup from ${date(checkpoint.capturedAt)}`}
                      disabled={!canRestore}
                      onClick={() => setSelected(checkpoint)}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-6 text-sm text-muted-foreground">
                No backups yet.
              </p>
            )}
          </CardContent>
        </Card>
        {(cursor || status.cursor) && (
          <div className="flex justify-end gap-2">
            {cursor && (
              <Button variant="ghost" onClick={() => setCursor(undefined)}>
                Newest
              </Button>
            )}
            {status.cursor && (
              <Button variant="ghost" onClick={() => setCursor(status.cursor!)}>
                Older backups
              </Button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !operation.isPending) setSelected(null)
        }}
        title="Restore this backup?"
        description="Replaces all content for everyone. You can undo this restore."
        confirmLabel="Restore backup"
        confirmDisabled={!canRestore}
        loadingLabel="Starting restore…"
        loading={operation.isPending}
        icon={<RotateCcw className="size-5 text-primary" />}
        onConfirm={() => {
          if (selected && canRestore)
            operation.mutate({
              action: "restore",
              requestId: requestId(),
              checkpoint: selected.id,
            })
        }}
      >
        <div className="flex flex-col gap-3 text-sm">
          <p className="font-medium">{selected && date(selected.capturedAt)}</p>
          <p className="text-muted-foreground">
            Editing pauses during restore.
          </p>
          {!canRestore && <p role="alert">Restore unavailable right now.</p>}
        </div>
      </ConfirmDialog>
    </section>
  )
}

function BackupIconAction({
  icon: Icon,
  label,
  tooltip,
  disabled,
  spinning = false,
  onClick,
}: {
  icon: LucideIcon
  label: string
  tooltip: string
  disabled?: boolean
  spinning?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 text-muted-foreground sm:size-9"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          <Icon
            aria-hidden="true"
            className={
              spinning
                ? "size-4 animate-spin motion-reduce:animate-none"
                : "size-4"
            }
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

function backupNotice(status: CloudBackupStatus): {
  title: string
  description?: string
  error?: boolean
  support?: boolean
  undo?: boolean
} | null {
  const restore = status.restore
  if (restore?.state === "running")
    return {
      title: "Restoring…",
      description: restore.phase === "applying" ? "Editing paused." : undefined,
    }
  if (restore?.state === "attention")
    return {
      title: "Restore needs attention",
      error: true,
      support: true,
    }
  if (status.backup?.state === "running") return null
  if (
    status.backup &&
    ["failed", "attention"].includes(status.backup.state) &&
    (!restore || status.backup.updatedAt > restore.updatedAt)
  )
    return {
      title:
        status.backup.state === "attention"
          ? "Backup needs attention"
          : "Backup failed",
      error: true,
      support: status.backup.state === "attention",
    }
  if (restore?.state === "failed")
    return {
      title: "Restore failed. Try again.",
      error: true,
    }
  if (
    restore?.state === "complete" &&
    (!status.backup || restore.updatedAt >= status.backup.updatedAt)
  )
    return {
      title: `Restored to ${date(restore.checkpointAt)}`,
      undo: true,
    }
  return null
}

import { Skeleton } from "@worktable/ui/components/skeleton"
import { cn } from "@worktable/ui/lib/utils"
import { humanBytes } from "@/lib/bytes"
import type { StorageUsage } from "@/lib/system-api"
import { useEffect } from "react"
import { useServerSettings } from "@/hooks/use-server-settings"
import { OperationStatus } from "../operation-status"
import { useSettingsSectionActive } from "../settings-dialog"

/**
 * What Worktable keeps besides people's files. None of it counts toward the
 * limit: the server keeps it within its own allowance, oldest first.
 */
const KEPT: { key: keyof StorageUsage["parts"]; label: string }[] = [
  { key: "history", label: "Version History" },
  { key: "trash", label: "Deleted Items" },
  { key: "derived", label: "Indexes & Caches" },
  { key: "transfers", label: "Transfers" },
]

/** Settings read this recently are current enough when Data opens. */
const FRESH_MS = 2_000

// Storage, under Data: how much of its limit this Worktable's files take,
// and, apart, what Worktable keeps besides them, read-only. It comes with the settings the Data page already loads, read
// again each time Data opens (the server answers from memory); no polling.
// At the limit the server removes the oldest history first; what it removed
// shows here.
export function StorageSection() {
  const settings = useServerSettings()
  const active = useSettingsSectionActive()
  const { refetch, dataUpdatedAt } = settings
  useEffect(() => {
    // A read just made, by this or anything else, is current: no repeat.
    if (active && Date.now() - dataUpdatedAt > FRESH_MS) void refetch()
  }, [active, dataUpdatedAt, refetch])
  const storage = settings.data?.storage ?? null
  const limit = storage?.limit
  // People's files: what the limit counts.
  const counted = limit ? (limit.countedBytes ?? storage.parts.live.bytes) : 0
  const share = storage && limit ? counted / limit.bytes : 0
  return (
    <div className="flex flex-col gap-3 rounded-xl card-surface p-4">
      {limit && share >= 1 ? (
        <OperationStatus state="error">
          At the limit. Delete something to make room.
        </OperationStatus>
      ) : limit && share >= limit.warnAt ? (
        <OperationStatus state="attention">Close to the limit.</OperationStatus>
      ) : null}
      <StorageRow
        label="Used"
        value={
          storage
            ? limit
              ? `${humanBytes(counted)} of ${humanBytes(limit.bytes)}`
              : humanBytes(storage.parts.live.bytes)
            : null
        }
        strong
      />
      <div className="flex flex-col gap-3 border-t border-border pt-3">
        {KEPT.map(({ key, label }) => (
          <StorageRow
            key={key}
            label={label}
            value={storage ? humanBytes(storage.parts[key].bytes) : null}
          />
        ))}
        <StorageRow
          label="Files"
          value={storage ? storage.total.files.toLocaleString() : null}
        />
        {storage?.pruned ? (
          <StorageRow
            label="Removed History"
            value={humanBytes(storage.pruned.bytes)}
          />
        ) : null}
      </div>
    </div>
  )
}

function StorageRow({
  label,
  value,
  strong = false,
}: {
  label: string
  value: string | null
  strong?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span
        className={cn("shrink-0 text-sm text-foreground", strong && "font-medium")}
      >
        {label}
      </span>
      {value === null ? (
        // Until the server's first count, a few seconds after it starts.
        <Skeleton className="h-4 w-14" />
      ) : (
        <span
          className={cn(
            "min-w-0 truncate text-sm tabular-nums",
            strong ? "font-medium text-foreground" : "text-muted-foreground"
          )}
        >
          {value}
        </span>
      )}
    </div>
  )
}

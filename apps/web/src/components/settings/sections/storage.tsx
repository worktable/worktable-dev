import { Skeleton } from "@worktable/ui/components/skeleton"
import { cn } from "@worktable/ui/lib/utils"
import { humanBytes } from "@/lib/bytes"
import type { StorageUsage } from "@/lib/system-api"
import { useServerSettings } from "@/hooks/use-server-settings"

const PARTS: { key: keyof StorageUsage["parts"]; label: string }[] = [
  { key: "live", label: "Docs & Files" },
  { key: "history", label: "Version History" },
  { key: "trash", label: "Deleted Items" },
  { key: "transfers", label: "Transfers" },
  { key: "derived", label: "Indexes & Caches" },
]

// Storage, under Data: what this Worktable takes on disk, read-only. It comes
// with the settings the Data page already loads; the server keeps the count.
export function StorageSection() {
  const storage = useServerSettings().data?.storage ?? null
  return (
    <div className="flex flex-col gap-3 rounded-xl card-surface p-4">
      <StorageRow
        label="Total"
        value={storage ? humanBytes(storage.total.bytes) : null}
        strong
      />
      {PARTS.map(({ key, label }) => (
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

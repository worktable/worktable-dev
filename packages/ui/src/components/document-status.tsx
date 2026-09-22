import { Loader2, Wifi, WifiOff } from "lucide-react"

export type DocumentStatusState = "opening" | "syncing" | "synced" | "offline"

const states = {
  opening: {
    label: "Opening",
    icon: Loader2,
    color: "text-muted-foreground",
    busy: true,
  },
  syncing: {
    label: "Syncing",
    icon: Loader2,
    color: "text-muted-foreground",
    busy: true,
  },
  synced: { label: "Synced", icon: Wifi, color: "text-success", busy: false },
  offline: {
    label: "Offline",
    icon: WifiOff,
    color: "text-warning",
    busy: false,
  },
} as const

/** Shared by the initial HTML, reading preview, and live collaboration state. */
export function DocumentStatus({
  state,
  announce = true,
}: {
  state: DocumentStatusState
  announce?: boolean
}) {
  const { label, icon: Icon, color, busy } = states[state]
  return (
    <div
      data-document-status={state}
      role="status"
      aria-live={announce ? "polite" : "off"}
      aria-label={state === "opening" ? "Opening document" : undefined}
      className="worktable-document-status rounded-full bg-popover/95 px-3 py-1.5 shadow-lg ring-1 ring-border/60 backdrop-blur-sm"
    >
      <div className={`flex items-center gap-1.5 text-xs font-medium ${color}`}>
        <Icon
          aria-hidden="true"
          className={`h-3.5 w-3.5 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`}
        />
        <span>{label}</span>
      </div>
    </div>
  )
}

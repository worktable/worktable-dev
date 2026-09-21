import { useEffect, useRef, useState } from "react"
import { useWorkspace } from "@/lib/queries"
import type { WorkspaceInfo, WorkspaceMode } from "@/lib/api"

const LABELS: Record<Exclude<WorkspaceMode, "daily">, string> = {
  sandbox: "Sandbox copy",
  staging: "Staging",
  fixture: "Fixture",
}

function chipLabel(ws: WorkspaceInfo): string {
  if (ws.mode === "fixture" && ws.provenance?.fixtureName) {
    return `Fixture: ${ws.provenance.fixtureName}`
  }
  return LABELS[ws.mode as Exclude<WorkspaceMode, "daily">] ?? ws.mode
}

/**
 * A subtle bronze status chip next to the wordmark, shown ONLY when the workspace is
 * not the real ("daily") one — so a disposable sandbox copy / staging / fixture is
 * unmistakable without being noisy. Hover/click reveals an opaque popover with detail.
 * DESIGN_SYSTEM: bronze = status (not a clickable-primary); the popover is opaque
 * (`bg-popover`, no backdrop-filter).
 */
export function ProvenanceChip() {
  const { data: ws } = useWorkspace()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  // Close after a short delay so moving the pointer from the chip across the gap to the
  // popover does not dismiss it before it's hovered.
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  useEffect(() => () => cancelClose(), [])

  if (!ws || ws.mode === "daily") return null

  const p = ws.provenance
  const snapDate = p?.snapshotAt ? new Date(p.snapshotAt) : null
  const snapshot =
    snapDate && !Number.isNaN(snapDate.getTime())
      ? snapDate.toLocaleString()
      : null
  const label = chipLabel(ws)

  return (
    <div
      ref={ref}
      className="relative shrink-0"
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        // Open on hover/focus/click. Click sets open (does not toggle), so a hover-then-
        // click on desktop never closes it; outside-click / Escape close it.
        onMouseEnter={() => {
          cancelClose()
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onClick={() => {
          cancelClose()
          setOpen(true)
        }}
        className="flex items-center gap-1.5 rounded-full border border-accent-bronze bg-surface-tint px-2 py-0.5 text-xs font-medium text-accent-bronze-ink"
        aria-label={`Workspace provenance: ${label}`}
      >
        <span className="size-1.5 rounded-full bg-accent-bronze" aria-hidden />
        {label}
      </button>
      {open && (
        <div
          role="status"
          onMouseEnter={cancelClose}
          className="overlay-floating absolute top-full left-0 z-50 mt-1.5 w-64 rounded-md bg-popover p-3 text-xs text-popover-foreground"
        >
          <div className="font-semibold">
            {label}
            {p?.disposable ? " — disposable" : ""}
          </div>
          {p?.source?.label && (
            <div className="mt-1.5 text-muted-foreground">
              From:{" "}
              <span className="text-popover-foreground">{p.source.label}</span>
              {p.source.path ? (
                <span className="mt-0.5 block truncate opacity-70">
                  {p.source.path}
                </span>
              ) : null}
            </div>
          )}
          {snapshot && (
            <div className="mt-1.5 text-muted-foreground">
              Snapshotted: {snapshot}
            </div>
          )}
          {p?.oneWay && (
            <div className="mt-1.5 text-muted-foreground">
              Edits here never sync back to the source.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

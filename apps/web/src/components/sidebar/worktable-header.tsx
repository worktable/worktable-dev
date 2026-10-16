import { Check, ChevronsUpDown, Cloud, Laptop, Settings } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { recognitionColor, type RecognitionColor } from "@worktable/types"
import { ProvenanceChip } from "@/components/provenance-chip"
import { recognitionSolid } from "@/lib/recognition"
import { useWorkspace } from "@/lib/queries"
import { openSettings } from "@/lib/settings-open"
import { RUNTIME_BASE_PATH } from "@/lib/runtime-path"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/** Where this Worktable lives, as this tab already knows it. */
function WorktableLocation() {
  if (RUNTIME_BASE_PATH) {
    return <Cloud aria-label="Worktable Cloud" className="size-3.5 shrink-0" />
  }
  if (LOOPBACK_HOSTS.has(window.location.hostname)) {
    return <Laptop aria-label="This computer" className="size-3.5 shrink-0" />
  }
  return <span className="min-w-0 truncate">{window.location.host}</span>
}

function WorktableTile({ name, color }: { name: string; color: RecognitionColor }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold"
      style={recognitionSolid(color)}
    >
      {name.trim().charAt(0).toUpperCase() || "W"}
    </span>
  )
}

/**
 * The current Worktable, which opens the Worktable menu. Desktop draws its
 * titlebar over the sidebar's first row, so there the menu takes the row
 * below an empty drag row; older Desktop builds style that row only.
 */
export function WorktableHeader() {
  const { data: workspace } = useWorkspace()
  const name = workspace?.name ?? "Worktable"
  const color = recognitionColor(workspace?.color, workspace?.id ?? name)
  const desktop =
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-worktable-desktop")

  const switcher = (
    <div className="flex h-12 shrink-0 items-center gap-1 px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`${name}, Worktable menu`}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-180 hover:bg-sidebar-hover has-[[data-popup-open]]:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent"
            />
          }
        >
          <WorktableTile name={name} color={color} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
            {name}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/40" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className="min-w-64">
          <DropdownMenuItem>
            <WorktableTile name={name} color={color} />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="flex min-w-0 max-w-32 items-center text-xs text-muted-foreground">
              <WorktableLocation />
            </span>
            <Check className="size-3.5 shrink-0 text-primary" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => openSettings("general")}>
            <Settings className="mr-2 size-4" />
            Worktable Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProvenanceChip />
    </div>
  )

  if (!desktop) return switcher
  return (
    <>
      <div
        data-tauri-drag-region="deep"
        data-worktable-sidebar-header
        className="flex h-12 shrink-0 items-center px-3"
      />
      {switcher}
    </>
  )
}

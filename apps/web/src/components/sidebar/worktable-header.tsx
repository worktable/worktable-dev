import { lazy, Suspense, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeftRight, Check, ChevronsUpDown, Cloud, Laptop, Settings } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { recognitionColor, type RecognitionColor } from "@worktable/types/recognition"
import { ProvenanceChip } from "@/components/provenance-chip"
import { recognitionSolid } from "@/lib/recognition"
import { useWorkspace } from "@/lib/queries"
import { openSettings } from "@/lib/settings-open"
import { RUNTIME_BASE_PATH } from "@/lib/runtime-path"
import { insideDesktop, switchDesktopWorktable } from "@/lib/desktop-connection"
import { toast } from "@worktable/ui/components/sonner"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import type { MenuSurface } from "@/lib/worktable-menu"

/** The menu's list; Settings refreshes it when the Cloud account or Link changes. */
export const WORKTABLE_MENU_QUERY_KEY = ["worktable-menu"] as const

// The list and its data load when the menu first opens.
const loadList = () => import("./worktable-menu-list")
const WorktableMenuList = lazy(loadList)

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

export function WorktableTile({ name, color }: { name: string; color: RecognitionColor }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-xs font-semibold"
      style={recognitionSolid(color)}
    >
      {name.trim().charAt(0).toUpperCase() || "W"}
    </span>
  )
}

/**
 * The current Worktable, which opens the Worktable menu: every Worktable the
 * person can reach, in groups, then the actions. Desktop draws its titlebar
 * over the sidebar's first row, so there the menu takes the row below an
 * empty drag row; older Desktop builds style that row only.
 */
export function WorktableHeader() {
  const { data: workspace } = useWorkspace()
  const name = workspace?.name ?? "Worktable"
  const color = recognitionColor(workspace?.color, workspace?.id ?? name)
  const desktop =
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-worktable-desktop")
  // On Cloud, the other Worktables are listed outside this one.
  const cloud = useDeploymentInfo().data?.mode === "cloud"
  const surface: MenuSurface =
    desktop && insideDesktop() ? "desktop" : cloud ? "cloud" : "local"
  const cloudPage = Boolean(RUNTIME_BASE_PATH)
  // One list request when the menu first opens, kept for the tab.
  const [opened, setOpened] = useState(false)
  const { data: listed } = useQuery({
    queryKey: WORKTABLE_MENU_QUERY_KEY,
    queryFn: async () => (await import("@/lib/worktable-menu")).loadWorktableMenu(surface, cloudPage),
    enabled: opened,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
  const currentRow = (
    <DropdownMenuItem>
      <WorktableTile name={name} color={color} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="flex min-w-0 max-w-32 items-center text-xs text-muted-foreground">
        <WorktableLocation />
      </span>
      <Check className="size-3.5 shrink-0 text-primary" />
    </DropdownMenuItem>
  )
  const settings = (
    <DropdownMenuItem onClick={() => openSettings("general")}>
      <Settings className="mr-2 size-4" />
      Worktable Settings
    </DropdownMenuItem>
  )
  // As the menu was before the list, and while it loads.
  const fallback = (
    <>
      {currentRow}
      <DropdownMenuSeparator />
      {surface === "desktop" && (
        <DropdownMenuItem
          onClick={() =>
            void switchDesktopWorktable().then((outcome) => {
              if (outcome === "unsaved") {
                toast.error("Couldn’t save the drawing. Try again.")
              } else if (outcome === "unavailable") {
                toast.error(
                  "Choose Change Connection from the Workspace menu to switch."
                )
              } else if (outcome === "failed") {
                toast.error("Couldn’t switch Worktables. Try again.")
              }
            })
          }
        >
          <ArrowLeftRight className="mr-2 size-4" />
          Switch Worktable
        </DropdownMenuItem>
      )}
      {surface === "cloud" && (
        <DropdownMenuItem render={<a href="/" />}>
          <ArrowLeftRight className="mr-2 size-4" />
          Switch Worktable
        </DropdownMenuItem>
      )}
      {settings}
    </>
  )

  const switcher = (
    <div className="flex h-12 shrink-0 items-center gap-1 px-2">
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open || opened) return
          setOpened(true)
          void loadList()
        }}
      >
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
          {listed ? (
            <Suspense fallback={fallback}>
              <WorktableMenuList
                surface={surface}
                data={listed}
                workspaceId={workspace?.id}
                currentHostedId={cloudPage ? RUNTIME_BASE_PATH.slice("/t/".length) : null}
                current={{ name, color }}
                currentRow={currentRow}
                settings={settings}
                fallback={fallback}
              />
            </Suspense>
          ) : (
            fallback
          )}
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

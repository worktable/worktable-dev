import { TruncatedText } from "@worktable/ui/components/truncated-text"
import { lazy, Suspense, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowLeftRight,
  Check,
  ChevronsUpDown,
  Cloud,
  Laptop,
  Plus,
  Settings,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import {
  recognitionColor,
  type RecognitionColor,
} from "@worktable/types/recognition"
import { ProvenanceChip } from "@/components/provenance-chip"
import { recognitionSolid } from "@/lib/recognition"
import { queryKeys, useWorkspace } from "@/lib/queries"
import { openSettings } from "@/lib/settings-open"
import { RUNTIME_BASE_PATH } from "@/lib/runtime-path"
import { insideDesktop, switchDesktopWorktable } from "@/lib/desktop-connection"
import { Skeleton } from "@worktable/ui/components/skeleton"
import { toast } from "@worktable/ui/components/sonner"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import type { MenuSurface } from "@/lib/worktable-menu"

// Warm the list and its data together when the person approaches the menu.
const loadList = () => import("./worktable-menu-list")
const WorktableMenuList = lazy(loadList)
// The list already warms this dependency on intent. Keep it off the startup
// graph for pages that never open the menu.
const Badge = lazy(() =>
  import("@worktable/ui/components/badge").then((module) => ({
    default: module.Badge,
  }))
)

function WorktableMenuLoading() {
  return (
    <div role="status" aria-label="Loading Worktables" className="py-1">
      <div aria-hidden="true">
        {[0, 1].map((row) => (
          <div key={row} className="flex items-center gap-1.5 px-1.5 py-1">
            <Skeleton className="size-6 rounded-md bg-surface-tint motion-reduce:animate-none" />
            <Skeleton className="h-3 w-28 bg-surface-tint motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  )
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/** Where this Worktable lives, as this tab already knows it. */
function WorktableLocation() {
  if (RUNTIME_BASE_PATH) {
    return <Cloud aria-label="Worktable Cloud" className="size-3.5 shrink-0" />
  }
  if (LOOPBACK_HOSTS.has(window.location.hostname)) {
    return <Laptop aria-label="This computer" className="size-3.5 shrink-0" />
  }
  return <TruncatedText text={window.location.host} />
}

export function WorktableTile({
  name,
  color,
}: {
  name: string
  color: RecognitionColor
}) {
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
  const deployment = useDeploymentInfo().data
  const cloud = Boolean(RUNTIME_BASE_PATH) || deployment?.mode === "cloud"
  const surface: MenuSurface =
    desktop && insideDesktop() ? "desktop" : cloud ? "cloud" : "local"
  const cloudPage = Boolean(RUNTIME_BASE_PATH)
  // Each source can render as soon as it is ready. Successful lists stay cached
  // for the tab; neither closing the menu nor hovering again starts a request.
  const [prepared, setPrepared] = useState(false)
  const directory = useQuery({
    queryKey: queryKeys.worktableMenu,
    queryFn: async () =>
      (await import("@/lib/worktable-menu")).loadCloudDirectory(cloudPage),
    enabled: prepared,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
  const thisMac = useQuery({
    queryKey: queryKeys.worktableMenuDesktop,
    queryFn: async () =>
      (await import("@/lib/desktop-worktables")).desktopWorktables(),
    enabled: prepared && surface === "desktop",
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
  const prepare = () => {
    setPrepared(true)
    void loadList().catch(() => {})
  }
  const listed = directory.data
  const data = {
    thisMac: thisMac.data?.worktables ?? null,
    directory:
      listed && !listed.device && thisMac.data?.device
        ? { ...listed, device: thisMac.data.device }
        : (listed ?? null),
  }
  const loading =
    directory.isPending || (surface === "desktop" && thisMac.isPending)
  const status = loading ? (
    <WorktableMenuLoading />
  ) : directory.isError ? (
    <>
      <div role="status" className="px-1.5 py-2 text-xs text-muted-foreground">
        {listed ? "Couldn’t refresh Worktables." : "Couldn’t load Worktables."}
      </div>
      <DropdownMenuItem
        closeOnClick={false}
        disabled={directory.isFetching}
        onClick={() => void directory.refetch()}
      >
        Retry
      </DropdownMenuItem>
    </>
  ) : null
  const currentRow = (
    <DropdownMenuItem aria-current="true">
      <WorktableTile name={name} color={color} />
      <TruncatedText text={name} className="flex-1" />
      {thisMac.data?.worktables.some(
        (worktable) => worktable.current && worktable.linked
      ) && (
        <Suspense fallback={null}>
          <Badge variant="outline">Link</Badge>
        </Suspense>
      )}
      <span className="flex max-w-32 min-w-0 items-center text-xs text-muted-foreground">
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
  // Older Desktop builds still open their native chooser.
  const fallbackActions = (
    <>
      {surface !== "local" && <DropdownMenuSeparator />}
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
        <DropdownMenuItem render={<a href="/gateway/worktables/new" />}>
          <Plus className="mr-2 size-4" />
          New Worktable
        </DropdownMenuItem>
      )}
    </>
  )

  const switcher = (
    <div className="flex h-12 shrink-0 items-center gap-1 px-2">
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return
          prepare()
          if (directory.isError) void directory.refetch()
        }}
      >
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`${name}, Worktable menu`}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") prepare()
              }}
              onFocus={prepare}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-180 hover:bg-sidebar-hover has-[[data-popup-open]]:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent"
            />
          }
        >
          <WorktableTile name={name} color={color} />
          <TruncatedText
            text={name}
            className="flex-1 text-sm font-semibold tracking-tight"
          />
          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/40" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className="min-w-64">
          {currentRow}
          <Suspense
            fallback={
              <>
                <WorktableMenuLoading />
                {fallbackActions}
              </>
            }
          >
            <WorktableMenuList
              surface={surface}
              data={data}
              workspaceId={workspace?.id}
              currentHostedId={
                cloudPage ? RUNTIME_BASE_PATH.slice("/t/".length) : null
              }
              status={status}
              fallbackActions={fallbackActions}
            />
          </Suspense>
          <DropdownMenuSeparator />
          {settings}
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

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowLeftRight,
  Check,
  ChevronsUpDown,
  Cloud,
  Folder,
  Laptop,
  Plus,
  Settings,
} from "lucide-react"
import { Badge } from "@worktable/ui/components/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { cn } from "@worktable/ui/lib/utils"
import { recognitionColor, type RecognitionColor } from "@worktable/types/recognition"
import { ProvenanceChip } from "@/components/provenance-chip"
import { recognitionSolid } from "@/lib/recognition"
import { useWorkspace } from "@/lib/queries"
import { openSettings } from "@/lib/settings-open"
import { RUNTIME_BASE_PATH } from "@/lib/runtime-path"
import {
  insideDesktop,
  openInDesktop,
  switchDesktopWorktable,
} from "@/lib/desktop-connection"
import {
  loadWorktableMenu,
  worktableMenuGroups,
  type MenuRow,
  type MenuSurface,
} from "@/lib/worktable-menu"
import { toast } from "@worktable/ui/components/sonner"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"

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
      className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-xs font-semibold"
      style={recognitionSolid(color)}
    >
      {name.trim().charAt(0).toUpperCase() || "W"}
    </span>
  )
}

/** A Worktable's state beside its name: a dot, and its device or Offline. */
function DeviceState({ device, online }: { device: string; online: boolean }) {
  return (
    <span className="flex min-w-0 max-w-32 items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", online ? "bg-success" : "bg-warning")}
      />
      <span className="min-w-0 truncate">{online ? device : "Offline"}</span>
    </span>
  )
}

const CurrentCheck = () => <Check className="size-3.5 shrink-0 text-primary" />

function reportOpen(outcome: Awaited<ReturnType<typeof openInDesktop>>) {
  if (outcome === "unsaved") toast.error("Couldn’t save the drawing. Try again.")
  else if (outcome === "not-worktable") toast.error("That folder isn’t a Worktable.")
  else if (outcome === "failed") toast.error("Couldn’t switch Worktables. Try again.")
}

function MenuRowItem({
  row,
  surface,
  current,
}: {
  row: MenuRow
  surface: MenuSurface
  current: { name: string; color: RecognitionColor }
}) {
  const shownCurrent = row.kind !== "device" && row.current
  const tile = (
    <WorktableTile
      name={shownCurrent ? current.name : row.name}
      color={shownCurrent ? current.color : recognitionColor(undefined, row.id)}
    />
  )
  const name = (
    <span className="min-w-0 flex-1 truncate">{shownCurrent ? current.name : row.name}</span>
  )
  if (row.kind === "device") {
    return (
      <DropdownMenuItem
        disabled={!row.href}
        {...(row.href
          ? { render: <a href={row.href} target="_blank" rel="noreferrer" /> }
          : {})}
      >
        {tile}
        {name}
        <DeviceState device={row.device} online={row.online} />
      </DropdownMenuItem>
    )
  }
  if (shownCurrent) {
    return (
      <DropdownMenuItem>
        {tile}
        {name}
        {row.kind === "this-mac" && row.linked && <Badge variant="outline">Link</Badge>}
        <CurrentCheck />
      </DropdownMenuItem>
    )
  }
  if (row.kind === "this-mac" || surface === "desktop") {
    return (
      <DropdownMenuItem
        onClick={() =>
          void openInDesktop(
            row.kind === "this-mac" ? { kind: "local", id: row.id } : { kind: "cloud", id: row.id }
          ).then(reportOpen)
        }
      >
        {tile}
        {name}
        {row.kind === "this-mac" && row.linked && <Badge variant="outline">Link</Badge>}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuItem render={<a href={row.href} />}>
      {tile}
      {name}
    </DropdownMenuItem>
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
  // The list is asked for when the menu first opens, then kept for the tab.
  const [opened, setOpened] = useState(false)
  const menu = useQuery({
    queryKey: ["worktable-menu", surface, cloudPage],
    queryFn: () => loadWorktableMenu(surface, cloudPage),
    enabled: opened,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
  const data = menu.data
  const groups = data
    ? worktableMenuGroups({
        surface,
        data,
        localIds: data.thisMac?.map((worktable) => worktable.id) ?? (workspace?.id ? [workspace.id] : []),
        currentHostedId: cloudPage ? RUNTIME_BASE_PATH.slice("/t/".length) : null,
      })
    : []
  // Desktop lists this Mac's Worktables, elsewhere Cloud lists the rest.
  // Before that, or without it, the menu is as it was.
  const listed =
    groups.length > 0 && (surface === "desktop" ? !!data?.thisMac : !!data?.directory)
  // A local or self-hosted page lists the others below itself.
  const currentFirst = listed && surface === "local"
  const currentRow = (
    <DropdownMenuItem>
      <WorktableTile name={name} color={color} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="flex min-w-0 max-w-32 items-center text-xs text-muted-foreground">
        <WorktableLocation />
      </span>
      <CurrentCheck />
    </DropdownMenuItem>
  )

  const switcher = (
    <div className="flex h-12 shrink-0 items-center gap-1 px-2">
      <DropdownMenu onOpenChange={(open) => open && setOpened(true)}>
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
          {(!listed || currentFirst) && currentRow}
          {listed &&
            groups.map((group) => (
              <DropdownMenuGroup key={group.label}>
                <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                {group.rows.map((row) => (
                  <MenuRowItem
                    key={`${row.kind}:${row.id}`}
                    row={row}
                    surface={surface}
                    current={{ name, color }}
                  />
                ))}
              </DropdownMenuGroup>
            ))}
          <DropdownMenuSeparator />
          {surface === "desktop" && !listed && (
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
          {surface === "desktop" && listed && (
            <>
              <DropdownMenuItem
                onClick={() =>
                  void switchDesktopWorktable().then((outcome) =>
                    reportOpen(outcome === "unavailable" ? "failed" : outcome)
                  )
                }
              >
                <Plus className="mr-2 size-4" />
                New Worktable
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void openInDesktop({ kind: "folder" }).then(reportOpen)}
              >
                <Folder className="mr-2 size-4" />
                Open Folder
              </DropdownMenuItem>
            </>
          )}
          {surface === "cloud" && !listed && (
            <DropdownMenuItem render={<a href="/" />}>
              <ArrowLeftRight className="mr-2 size-4" />
              Switch Worktable
            </DropdownMenuItem>
          )}
          {surface === "cloud" && listed && (
            <DropdownMenuItem render={<a href="/gateway/worktables/new" />}>
              <Plus className="mr-2 size-4" />
              New Worktable
            </DropdownMenuItem>
          )}
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

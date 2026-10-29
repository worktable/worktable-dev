import { TruncatedText } from "@worktable/ui/components/truncated-text"
import type { ReactNode } from "react"
import { Folder, Plus } from "lucide-react"
import { Badge } from "@worktable/ui/components/badge"
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@worktable/ui/components/dropdown-menu"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import { recognitionColor } from "@worktable/types/recognition"
import { switchDesktopWorktable } from "@/lib/desktop-connection"
import { openInDesktop } from "@/lib/desktop-worktables"
import {
  isLoopbackHost,
  worktableMenuGroups,
  type MenuRow,
  type MenuSurface,
  type WorktableMenuData,
} from "@/lib/worktable-menu"
import { WorktableTile } from "./worktable-header"

/** A Worktable's state beside its name: a dot, and its device or Offline. */
function DeviceState({ device, online }: { device: string; online: boolean }) {
  return (
    <span className="flex max-w-32 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          online ? "bg-success" : "bg-warning"
        )}
      />
      <TruncatedText text={online ? device : "Offline"} />
    </span>
  )
}

function reportOpen(outcome: Awaited<ReturnType<typeof openInDesktop>>) {
  if (outcome === "unsaved")
    toast.error("Couldn’t save the drawing. Try again.")
  else if (outcome === "not-worktable")
    toast.error("That folder isn’t a Worktable.")
  else if (outcome === "failed")
    toast.error("Couldn’t switch Worktables. Try again.")
}

function MenuRowItem({ row, surface }: { row: MenuRow; surface: MenuSurface }) {
  const name = row.name
  const label = (
    <>
      <WorktableTile name={name} color={recognitionColor(undefined, row.id)} />
      <TruncatedText text={name} className="flex-1" />
      {row.kind === "this-mac" && row.linked && (
        <Badge variant="outline">Link</Badge>
      )}
    </>
  )
  if (row.kind === "device") {
    // Another device's Worktable opens at its own address, in the browser.
    // Without an address that works here, the row shows where it is and does
    // nothing.
    const href = row.href
    return (
      <DropdownMenuItem
        disabled={!href}
        {...(href
          ? { render: <a href={href} target="_blank" rel="noreferrer" /> }
          : {})}
      >
        {label}
        <DeviceState device={row.device} online={row.online} />
      </DropdownMenuItem>
    )
  }
  // Desktop opens this Mac's and hosted Worktables in its own window.
  if (row.kind === "this-mac" || surface === "desktop") {
    return (
      <DropdownMenuItem
        onClick={() =>
          void openInDesktop(
            row.kind === "this-mac"
              ? { kind: "local", id: row.id }
              : { kind: "cloud", id: row.id }
          ).then(reportOpen)
        }
      >
        {label}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuItem render={<a href={row.href} />}>{label}</DropdownMenuItem>
  )
}

/**
 * Entries arrive independently; the current Worktable and Settings stay mounted
 * in the header, outside this lazy region.
 */
export default function WorktableMenuList({
  surface,
  data,
  workspaceId,
  currentHostedId,
  status,
  fallbackActions,
}: {
  surface: MenuSurface
  data: WorktableMenuData
  workspaceId: string | undefined
  currentHostedId: string | null
  status: ReactNode
  fallbackActions: ReactNode
}) {
  const groups = worktableMenuGroups({
    surface,
    data,
    localIds:
      data.thisMac?.map((worktable) => worktable.id) ??
      (workspaceId ? [workspaceId] : []),
    currentHostedId,
    onDevice: surface === "desktop" || isLoopbackHost(window.location.hostname),
  })
  // The current Worktable has one stable row above the groups, including while
  // Cloud is loading. Keep other rows keyed across partial list updates.
  // Older Desktop builds keep their chooser when the list API is unavailable.
  const others = (surface === "desktop" && data.thisMac === null ? [] : groups)
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => row.kind === "device" || !row.current),
    }))
    .filter((group) => group.rows.length > 0)
  return (
    <>
      {others.map((group) => (
        <DropdownMenuGroup key={group.label}>
          <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
          {group.rows.map((row) => (
            <MenuRowItem
              key={`${row.kind}:${row.id}`}
              row={row}
              surface={surface}
            />
          ))}
        </DropdownMenuGroup>
      ))}
      {status}
      {surface === "desktop" && data.thisMac !== null ? (
        <>
          <DropdownMenuSeparator />
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
            onClick={() =>
              void openInDesktop({ kind: "folder" }).then(reportOpen)
            }
          >
            <Folder className="mr-2 size-4" />
            Open Folder
          </DropdownMenuItem>
        </>
      ) : (
        fallbackActions
      )}
    </>
  )
}

import type { ReactNode } from "react"
import { Check, Folder, Plus } from "lucide-react"
import { Badge } from "@worktable/ui/components/badge"
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@worktable/ui/components/dropdown-menu"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import {
  recognitionColor,
  type RecognitionColor,
} from "@worktable/types/recognition"
import { switchDesktopWorktable } from "@/lib/desktop-connection"
import { openInDesktop } from "@/lib/desktop-worktables"
import {
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
      <span className="min-w-0 truncate">{online ? device : "Offline"}</span>
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
  const name = shownCurrent ? current.name : row.name
  const label = (
    <>
      <WorktableTile
        name={name}
        color={
          shownCurrent ? current.color : recognitionColor(undefined, row.id)
        }
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {row.kind === "this-mac" && row.linked && (
        <Badge variant="outline">Link</Badge>
      )}
    </>
  )
  if (row.kind === "device") {
    // Another device's Worktable opens at its own address, in the browser.
    return (
      <DropdownMenuItem
        disabled={!row.href}
        {...(row.href
          ? { render: <a href={row.href} target="_blank" rel="noreferrer" /> }
          : {})}
      >
        {label}
        <DeviceState device={row.device} online={row.online} />
      </DropdownMenuItem>
    )
  }
  if (shownCurrent) {
    return (
      <DropdownMenuItem>
        {label}
        <Check className="size-3.5 shrink-0 text-primary" />
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
 * The Worktable menu's list, loaded with its data when the menu first opens.
 * Without anything to list it shows the menu as it was.
 */
export default function WorktableMenuList({
  surface,
  data,
  workspaceId,
  currentHostedId,
  current,
  currentRow,
  settings,
  fallback,
}: {
  surface: MenuSurface
  data: WorktableMenuData
  workspaceId: string | undefined
  currentHostedId: string | null
  current: { name: string; color: RecognitionColor }
  currentRow: ReactNode
  settings: ReactNode
  fallback: ReactNode
}) {
  const groups = worktableMenuGroups({
    surface,
    data,
    localIds:
      data.thisMac?.map((worktable) => worktable.id) ??
      (workspaceId ? [workspaceId] : []),
    currentHostedId,
  })
  // Desktop lists this Mac's Worktables, elsewhere Cloud lists the rest.
  const listed =
    groups.length > 0 &&
    (surface === "desktop" ? !!data.thisMac : !!data.directory)
  if (!listed) return fallback
  return (
    <>
      {/* A local or self-hosted page lists the others below itself. */}
      {surface === "local" && currentRow}
      {groups.map((group) => (
        <DropdownMenuGroup key={group.label}>
          <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
          {group.rows.map((row) => (
            <MenuRowItem
              key={`${row.kind}:${row.id}`}
              row={row}
              surface={surface}
              current={current}
            />
          ))}
        </DropdownMenuGroup>
      ))}
      <DropdownMenuSeparator />
      {surface === "desktop" && (
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
            onClick={() =>
              void openInDesktop({ kind: "folder" }).then(reportOpen)
            }
          >
            <Folder className="mr-2 size-4" />
            Open Folder
          </DropdownMenuItem>
        </>
      )}
      {surface === "cloud" && (
        <DropdownMenuItem render={<a href="/gateway/worktables/new" />}>
          <Plus className="mr-2 size-4" />
          New Worktable
        </DropdownMenuItem>
      )}
      {settings}
    </>
  )
}

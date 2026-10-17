import type { ReactNode } from "react"
import {
  FolderPlus,
  MoreVertical,
  Pencil,
  Plus,
  SquarePlus,
  X,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { useIsMobile } from "@/hooks/use-mobile"

const headingAction =
  "flex h-8 w-9 items-center justify-center rounded-md text-sidebar-foreground/30 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-foreground sm:size-6"

/**
 * A sidebar section's heading: Pinned, each of the person's groups, and
 * Spaces for the rest all look alike. The name folds the section; a folded
 * section shows how many Spaces it holds.
 */
export function SectionHeading({
  label,
  count,
  open,
  onToggle,
  actions,
  revealActions = true,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  /** Actions appear on hover, except on touch screens where they always show. */
  revealActions?: boolean
}) {
  return (
    <div className="group/section mt-2 flex items-center pr-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-3 py-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase transition-colors hover:text-sidebar-foreground/65 sm:min-h-6"
      >
        <span className="min-w-0 truncate">{label}</span>
        {!open && (
          <span className="shrink-0 font-medium tracking-normal">{count}</span>
        )}
      </button>
      {actions && (
        <div
          className={`flex shrink-0 items-center ${
            revealActions
              ? "opacity-100 transition-opacity focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 sm:opacity-0 sm:group-hover/section:opacity-100"
              : ""
          }`}
        >
          {actions}
        </div>
      )}
    </div>
  )
}

/** The Spaces heading's +: a Space, or a group to sort Spaces into. */
export function NewSpaceOrGroupButton({
  onNewSpace,
  onNewGroup,
}: {
  onNewSpace: () => void
  onNewGroup: (() => void) | null
}) {
  if (!onNewGroup) {
    return (
      <button
        type="button"
        aria-label="New Space"
        title="New Space"
        onClick={onNewSpace}
        className={headingAction}
      >
        <Plus className="size-3.5" />
      </button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="New Space or Group"
            title="New"
            className={headingAction}
          />
        }
      >
        <Plus className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
        <DropdownMenuItem onClick={onNewSpace}>
          <SquarePlus className="mr-2 size-4" />
          Space
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onNewGroup}>
          <FolderPlus className="mr-2 size-4" />
          Group
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A group heading's own actions: a Space in it, and its menu. Phones show
 * only the menu, which holds New Space too.
 */
export function GroupActions({
  name,
  onNewSpace,
  onRename,
  onRemove,
}: {
  name: string
  onNewSpace: () => void
  onRename: () => void
  onRemove: () => void
}) {
  const isMobile = useIsMobile()
  return (
    <>
      {!isMobile && (
        <button
          type="button"
          aria-label={`New Space in ${name}`}
          title="New Space"
          onClick={onNewSpace}
          className={headingAction}
        >
          <Plus className="size-3.5" />
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`${name} options`}
              className={headingAction}
            />
          }
        >
          <MoreVertical className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="mr-2 size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onNewSpace}>
            <SquarePlus className="mr-2 size-4" />
            New Space
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onRemove}>
            <X className="mr-2 size-4" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

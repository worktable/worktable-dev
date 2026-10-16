import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Plus,
  SquarePlus,
  X,
} from "lucide-react"
import type { PersonalGroup } from "@worktable/types"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { sortedGroups } from "@/lib/personal-navigation"

const headingAction =
  "flex size-6 items-center justify-center rounded-md text-sidebar-foreground/30 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground has-[[data-popup-open]]:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent"

/**
 * The Spaces heading: which of the person's groups the list shows, once they
 * have one, and what to create.
 */
export function SpacesHeading({
  groups,
  focus,
  onFocus,
  onNewSpace,
  onNewGroup,
}: {
  groups: readonly PersonalGroup[] | null
  focus: PersonalGroup | null
  onFocus: (groupId: string | null) => void
  onNewSpace: () => void
  onNewGroup: (() => void) | null
}) {
  return (
    <div className="mb-1 flex items-center gap-1 px-3 pr-1">
      <p className="flex-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
        Spaces
      </p>
      {groups && groups.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={`Showing ${focus ? focus.name : "all Spaces"}`}
                className={`flex h-6 max-w-32 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground data-[popup-open]:bg-sidebar-accent ${
                  focus
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-sidebar-foreground/50"
                }`}
              />
            }
          >
            <span className="min-w-0 truncate">{focus ? focus.name : "All"}</span>
            <ChevronDown className="size-3 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-48">
            <DropdownMenuItem onClick={() => onFocus(null)}>
              <LayoutGrid className="mr-2 size-4" />
              All Spaces
              {!focus && <Check className="ml-auto size-3.5 text-primary" />}
            </DropdownMenuItem>
            {sortedGroups(groups).map((group) => (
              <DropdownMenuItem key={group.id} onClick={() => onFocus(group.id)}>
                <FolderOpen className="mr-2 size-4" />
                <span className="min-w-0 truncate">{group.name}</span>
                {focus?.id === group.id && (
                  <Check className="ml-auto size-3.5 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
            {onNewGroup && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onNewGroup}>
                  <FolderPlus className="mr-2 size-4" />
                  New Group
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onNewGroup ? (
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
      ) : (
        <button
          type="button"
          aria-label="New Space"
          title="New Space"
          onClick={onNewSpace}
          className={headingAction}
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** A group's label: it collapses the group and holds the group's own actions. */
export function GroupLabel({
  name,
  open,
  onToggle,
  onNewSpace,
  onRename,
  onRemove,
}: {
  name: string
  open: boolean
  onToggle: () => void
  onNewSpace?: () => void
  onRename?: () => void
  onRemove?: () => void
}) {
  return (
    <div className="group/group relative mt-1 flex items-center rounded-md pr-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 py-1 pl-3 text-xs font-medium text-sidebar-foreground/45 transition-colors hover:text-sidebar-foreground/70 sm:min-h-0"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 truncate">{name}</span>
      </button>
      {(onNewSpace || onRename || onRemove) && (
        <div className="flex shrink-0 items-center opacity-100 transition-opacity focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 sm:opacity-0 sm:group-hover/group:opacity-100">
          {onNewSpace && (
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
              <MoreHorizontal className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
              {onRename && (
                <DropdownMenuItem onClick={onRename}>
                  <Pencil className="mr-2 size-4" />
                  Rename
                </DropdownMenuItem>
              )}
              {onNewSpace && (
                <DropdownMenuItem onClick={onNewSpace}>
                  <SquarePlus className="mr-2 size-4" />
                  New Space
                </DropdownMenuItem>
              )}
              {onRemove && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onRemove}>
                    <X className="mr-2 size-4" />
                    Remove
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
}

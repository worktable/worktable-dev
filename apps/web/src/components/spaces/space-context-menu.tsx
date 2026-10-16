import { browserTeamMemberId } from "@/lib/team-context"
import { lazy, Suspense, useState, useEffect, type ReactNode } from "react"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@worktable/ui/components/dropdown-menu"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
} from "@worktable/ui/components/responsive-dialog"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import {
  MoreVertical,
  Pencil,
  Trash,
  Archive,
  RotateCcw,
  FolderOpen,
  LayoutGrid,
  Check,
  Trash2,
  AlertTriangle,
  Smile,
  ArrowUpDown,
  ArrowDownAZ,
  Clock3,
  GripVertical,
  Pin,
  PinOff,
  FolderPlus,
} from "lucide-react"
import type { RecognitionColor } from "@worktable/types/recognition"
import { useIsMobile } from "@/hooks/use-mobile"
import type { PersonalGroup } from "@worktable/types"
import { sortedGroups } from "@/lib/personal-navigation"
import type { DocSortMode } from "@/lib/tree"
import { NewSubmenu } from "@/components/spaces/space-new-menu"

// Loaded when first opened: the icon catalog and colors stay off startup.
const SpaceAppearanceDialog = lazy(() =>
  import("./space-appearance-dialog").then((module) => ({
    default: module.SpaceAppearanceDialog,
  }))
)
const SpaceAccessEditor = lazy(() => import("./space-access-editor").then(module => ({default: module.SpaceAccessEditor})))

// ── Context Menu Button ──────────────────────────────────────

interface SpaceContextMenuProps {
  spaceId?: string
  canEdit?: boolean
  canManageAccess?: boolean
  spaceName: string
  spaceIcon?: string
  /** The Space's color, chosen or default. */
  spaceColor: RecognitionColor
  archived?: boolean
  /** Creation choices, listed first where the row has no + of its own. */
  newItems?: ReactNode
  /**
   * The person's own arrangement, when they have one: pinning and groups
   * change only their sidebar, so they need no Space permission.
   */
  personal?: {
    pinned: boolean
    groups: readonly PersonalGroup[]
    groupId: string | null
    onTogglePin: () => void
    onChangeGroup: (groupId: string | null) => void
    onNewGroup: () => void
  }
  docSort: DocSortMode
  onChangeDocSort: (sort: DocSortMode) => void
  onRename: (newName: string) => void
  onChangeIcon: (icon: string) => void
  onChangeColor: (color: RecognitionColor) => Promise<void>
  onArchive?: () => void
  onRestore?: () => void
  onDelete: () => void
}

const DOC_SORT_OPTIONS: {
  mode: DocSortMode
  label: string
  icon: typeof Check
}[] = [
  { mode: "custom", label: "Custom Order", icon: GripVertical },
  { mode: "alphabetical", label: "Alphabetical", icon: ArrowDownAZ },
  { mode: "updated", label: "Last Updated", icon: Clock3 },
]

export function SpaceContextMenuButton({
  spaceId,
  canEdit = true,
  canManageAccess = false,
  spaceName,
  spaceIcon,
  spaceColor,
  archived,
  newItems,
  personal,
  docSort,
  onChangeDocSort,
  onRename,
  onChangeIcon,
  onChangeColor,
  onArchive,
  onRestore,
  onDelete,
}: SpaceContextMenuProps) {
  const [accessOpen, setAccessOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  // On a team, renaming, archiving and deleting a Space affect everyone, so
  // they follow access management. Solo keeps the edit rule.
  const canAdminister = browserTeamMemberId() ? canManageAccess : canEdit

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex size-9 items-center justify-center rounded-md text-sidebar-foreground/30 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-foreground sm:size-6"
          render={<button type="button" />}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-48">
          {newItems && <NewSubmenu>{newItems}</NewSubmenu>}
          {personal && (
            <>
              <DropdownMenuItem onClick={personal.onTogglePin}>
                {personal.pinned ? (
                  <PinOff className="mr-2 h-4 w-4" />
                ) : (
                  <Pin className="mr-2 h-4 w-4" />
                )}
                {personal.pinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderOpen className="mr-2 h-4 w-4" />
                  Change Group
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => personal.onChangeGroup(null)}>
                    <LayoutGrid className="mr-2 h-4 w-4" />
                    None
                    {!personal.groupId && (
                      <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                    )}
                  </DropdownMenuItem>
                  {sortedGroups(personal.groups).map((group) => (
                    <DropdownMenuItem
                      key={group.id}
                      onClick={() => personal.onChangeGroup(group.id)}
                    >
                      <FolderOpen className="mr-2 h-4 w-4" />
                      <span className="min-w-0 truncate">{group.name}</span>
                      {personal.groupId === group.id && (
                        <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                      )}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={personal.onNewGroup}>
                    <FolderPlus className="mr-2 h-4 w-4" />
                    New Group
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
            </>
          )}
          {canManageAccess && spaceId && <DropdownMenuItem onClick={() => setAccessOpen(true)}>Manage Access</DropdownMenuItem>}
          <DropdownMenuItem disabled={!canAdminister} onClick={() => setRenameOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canAdminister} onClick={() => setIconPickerOpen(true)}>
            <Smile className="mr-2 h-4 w-4" />
            Icon and Color
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!canEdit}>
              <ArrowUpDown className="mr-2 h-4 w-4" />
              Sort
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {DOC_SORT_OPTIONS.map(({ mode, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={mode}
                  onClick={() => onChangeDocSort(mode)}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                  {docSort === mode && (
                    <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {(archived ? onRestore : onArchive) && (
            <DropdownMenuItem disabled={!canAdminister}
              onClick={archived ? onRestore : onArchive}>
              {archived ? (
                <RotateCcw className="mr-2 h-4 w-4" />
              ) : (
                <Archive className="mr-2 h-4 w-4" />
              )}
              {archived ? "Restore" : "Archive"}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={!canAdminister}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {accessOpen && spaceId && <Suspense fallback={null}><SpaceAccessEditor spaceId={spaceId} onClose={() => setAccessOpen(false)} /></Suspense>}
      <SpaceRenameDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        onRename={onRename}
        currentName={spaceName}
      />

      <SpaceDeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={onDelete}
        spaceName={spaceName}
      />

      {iconPickerOpen && (
        <Suspense fallback={null}>
          <SpaceAppearanceDialog
            open
            onClose={() => setIconPickerOpen(false)}
            onSelect={onChangeIcon}
            currentIcon={spaceIcon}
            currentColor={spaceColor}
            onSelectColor={onChangeColor}
          />
        </Suspense>
      )}
    </>
  )
}

// ── Rename Dialog ────────────────────────────────────────────

function SpaceRenameDialog({
  open,
  onClose,
  onRename,
  currentName,
}: {
  open: boolean
  onClose: () => void
  onRename: (newName: string) => void
  currentName: string
}) {
  const [newName, setNewName] = useState("")
  const [pending, setPending] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    if (open) {
      setNewName(currentName)
      setPending(false)
    }
  }, [open, currentName])

  const handleRename = async () => {
    if (!newName.trim() || newName.trim() === currentName) {
      onClose()
      return
    }
    setPending(true)
    onRename(newName.trim())
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && newName.trim()) {
      void handleRename()
    }
  }

  const hasChanged = newName.trim() !== "" && newName.trim() !== currentName

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Pencil className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>Rename Space</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Enter a new name for this space.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <div className="space-y-2">
            <label htmlFor="space-new-name" className="text-sm font-medium">
              New name
            </label>
            <Input
              id="space-new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-9"
              autoFocus={!isMobile}
            />
          </div>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleRename} disabled={!hasChanged || pending}>
            {pending ? "Renaming…" : "Rename"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

// ── Delete Dialog ────────────────────────────────────────────

function SpaceDeleteDialog({
  open,
  onClose,
  onConfirm,
  spaceName,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  spaceName: string
}) {
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open) setPending(false)
  }, [open])

  const handleConfirm = () => {
    setPending(true)
    onConfirm()
    onClose()
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
            <Trash2 className="h-5 w-5 text-destructive" />
          </div>
          <ResponsiveDialogTitle>Delete Space</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Are you sure you want to delete{" "}
            <span className="font-medium text-foreground">
              &ldquo;{spaceName}&rdquo;
            </span>
            ?
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <div className="flex items-start gap-3 rounded-lg border border-warning/25 bg-warning/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-muted-foreground">
              This space and all its documents and HTML docs will be moved to
              trash.
            </p>
          </div>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

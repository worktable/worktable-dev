import { useState, useEffect } from "react"
import { useScrollFade } from "@/hooks/use-scroll-fade"
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
} from "lucide-react"
import { getIcon, ALL_ICON_NAMES } from "@/lib/icons"
import { useIsMobile } from "@/hooks/use-mobile"
import { useSpaces } from "@/lib/queries"
import type { DocSortMode } from "@/lib/tree"

// ── Context Menu Button ──────────────────────────────────────

interface SpaceContextMenuProps {
  spaceName: string
  spaceIcon?: string
  currentGroup?: string
  archived?: boolean
  docSort: DocSortMode
  onChangeDocSort: (sort: DocSortMode) => void
  onRename: (newName: string) => void
  onChangeIcon: (icon: string) => void
  onChangeGroup: (group: string | undefined) => void
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

/** Derive available groups from existing spaces (plus "None") */
function useAvailableGroups(currentGroup?: string): string[] {
  const { data: spaces } = useSpaces()
  const groups = new Set<string>()
  if (spaces) {
    for (const s of spaces) {
      if (s.group) groups.add(s.group)
    }
  }
  // Ensure the current group is always listed even if no other space uses it
  if (currentGroup) groups.add(currentGroup)
  return [...groups].sort()
}

/** Pretty-print a group slug: "side-quests" → "Side Quests" */
function formatGroupLabel(group: string): string {
  return group
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

export function SpaceContextMenuButton({
  spaceName,
  spaceIcon,
  currentGroup,
  archived,
  docSort,
  onChangeDocSort,
  onRename,
  onChangeIcon,
  onChangeGroup,
  onArchive,
  onRestore,
  onDelete,
}: SpaceContextMenuProps) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const groups = useAvailableGroups(currentGroup)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex size-9 items-center justify-center rounded-md text-sidebar-foreground/30 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground sm:size-6"
          render={<button type="button" />}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-48">
          <DropdownMenuItem onClick={() => setRenameOpen(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setIconPickerOpen(true)}>
            <Smile className="mr-2 h-4 w-4" />
            Change Icon
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderOpen className="mr-2 h-4 w-4" />
              Change Group
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => onChangeGroup(undefined)}>
                <LayoutGrid className="mr-2 h-4 w-4" />
                None
                {!currentGroup && (
                  <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                )}
              </DropdownMenuItem>
              {groups.map((group) => (
                <DropdownMenuItem
                  key={group}
                  onClick={() => onChangeGroup(group)}
                >
                  <FolderOpen className="mr-2 h-4 w-4" />
                  {formatGroupLabel(group)}
                  {currentGroup === group && (
                    <Check className="ml-auto h-3.5 w-3.5 text-primary" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowUpDown className="mr-2 h-4 w-4" />
              Sort Docs
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
            <DropdownMenuItem onClick={archived ? onRestore : onArchive}>
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
            onClick={() => setDeleteOpen(true)}
          >
            <Trash className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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

      <IconPickerDialog
        open={iconPickerOpen}
        onClose={() => setIconPickerOpen(false)}
        onSelect={onChangeIcon}
        currentIcon={spaceIcon}
      />
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

// ── Icon Picker Dialog ───────────────────────────────────────

/** Popular/common icons shown by default before searching */
const POPULAR_ICONS = [
  "folder",
  "file-text",
  "star",
  "heart",
  "bookmark",
  "target",
  "zap",
  "rocket",
  "lightbulb",
  "code",
  "database",
  "globe",
  "search",
  "settings",
  "users",
  "briefcase",
  "calendar",
  "map",
  "music",
  "camera",
  "shield",
  "layers",
  "package",
  "brain",
  "palette",
  "cpu",
  "eye",
  "flask-conical",
  "layout-dashboard",
  "tag",
  "bar-chart-3",
  "message-square",
  "book-open",
  "pen-tool",
  "compass",
  "trophy",
  "wrench",
  "box",
  "grid-3x3",
]

function IconPickerDialog({
  open,
  onClose,
  onSelect,
  currentIcon,
}: {
  open: boolean
  onClose: () => void
  onSelect: (icon: string) => void
  currentIcon?: string
}) {
  const [query, setQuery] = useState("")
  const iconGridRef = useScrollFade<HTMLDivElement>()

  // Reset search when dialog opens
  useEffect(() => {
    if (open) setQuery("")
  }, [open])

  const handleSelect = (icon: string) => {
    onSelect(icon)
    onClose()
  }

  const trimmed = query.trim().toLowerCase()
  const displayIcons = trimmed
    ? ALL_ICON_NAMES.filter((name) => name.includes(trimmed)).slice(0, 80)
    : POPULAR_ICONS

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Smile className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>Change Icon</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Search {ALL_ICON_NAMES.length.toLocaleString()} icons or pick from
            popular ones below.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <Input
            placeholder="Search icons..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            className="mb-3"
          />
          <div
            ref={iconGridRef}
            className="scroll-fade grid max-h-64 grid-cols-8 gap-1 overflow-y-auto"
            style={{ "--sf-size": "20px" } as React.CSSProperties}
          >
            {displayIcons.map((iconKey) => {
              const IconComp = getIcon(iconKey)
              if (!IconComp) return null
              const isActive = currentIcon === iconKey
              return (
                <button
                  key={iconKey}
                  type="button"
                  onClick={() => handleSelect(iconKey)}
                  title={iconKey}
                  className={`flex size-9 items-center justify-center rounded-md transition-colors duration-150 ${
                    isActive
                      ? "bg-surface-selected text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  }`}
                >
                  <IconComp className="size-4" />
                </button>
              )
            })}
            {displayIcons.length === 0 && trimmed && (
              <p className="col-span-8 py-4 text-center text-sm text-muted-foreground">
                No icons matching &ldquo;{trimmed}&rdquo;
              </p>
            )}
          </div>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

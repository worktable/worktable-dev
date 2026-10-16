import { useState } from "react"
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
import { useIsMobile } from "@/hooks/use-mobile"
import { LayoutGrid, Layers, FolderOpen } from "lucide-react"
import { IconSearchGrid } from "@/components/icon-search-grid"
import { sortedGroups } from "@/components/sidebar/space-groups"
import { moveToGroup, usePersonalNavigation } from "@/lib/personal-navigation"

interface NewSpaceDialogProps {
  open: boolean
  onClose: () => void
  /** Creates the Space and resolves with its id, or undefined if it failed. */
  onCreate: (data: { name: string; icon?: string }) => Promise<string | undefined>
  /** One of the person's own groups to place the new Space in. */
  defaultGroup?: string | null
}

export function NewSpaceDialog({
  open,
  onClose,
  onCreate,
  defaultGroup,
}: NewSpaceDialogProps) {
  const [name, setName] = useState("")
  const [selectedIcon, setSelectedIcon] = useState("rocket")
  const [selectedGroup, setSelectedGroup] = useState<string | null>(
    defaultGroup ?? null
  )
  const [creating, setCreating] = useState(false)
  const isMobile = useIsMobile()
  const { navigation, update } = usePersonalNavigation()
  const groups = navigation ? sortedGroups(navigation.groups) : []

  // Each opening starts fresh, in the group it was opened for.
  const [openedFor, setOpenedFor] = useState<string | null | undefined>()
  const openKey = open ? (defaultGroup ?? null) : undefined
  if (openKey !== openedFor) {
    setOpenedFor(openKey)
    if (open) {
      setName("")
      setSelectedIcon("rocket")
      setSelectedGroup(defaultGroup ?? null)
      setCreating(false)
    }
  }

  const handleCreate = async () => {
    if (!name.trim() || creating) return
    setCreating(true)
    const group = groups.some((g) => g.id === selectedGroup) ? selectedGroup : null
    const created = onCreate({ name: name.trim(), icon: selectedIcon })
    setName("")
    onClose()
    setCreating(false)
    // The Space is shared; the group it sits in is the creator's own choice.
    const spaceId = await created
    if (spaceId && group) {
      void update(
        moveToGroup(spaceId, group),
        "The Space was created, but couldn't be added to the group"
      )
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && name.trim()) {
      handleCreate()
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Layers className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>New Space</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Create a space to organize your documents and HTML docs.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          {/* Name */}
          <div className="space-y-2">
            <label htmlFor="space-name" className="text-sm font-medium">
              Space name
            </label>
            <Input
              id="space-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="My Space"
              className="h-9"
              autoFocus={!isMobile}
            />
          </div>

          {/* Group */}
          {groups.length > 0 && <div className="space-y-2">
            <label className="text-sm font-medium">Group</label>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedGroup(null)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-150 ${
                  selectedGroup === null
                    ? "bg-surface-selected text-primary"
                    : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                <LayoutGrid className="size-3.5" />
                None
              </button>
              {groups.map((group) => {
                const isActive = selectedGroup === group.id
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setSelectedGroup(group.id)}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-150 ${
                      isActive
                        ? "bg-surface-selected text-primary"
                        : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <FolderOpen className="size-3.5" />
                    {group.name}
                  </button>
                )
              })}
            </div>
          </div>}

          {/* Icon */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Icon</label>
            <IconSearchGrid
              selected={selectedIcon}
              onSelect={setSelectedIcon}
              columns={9}
              className="max-h-40"
            />
          </div>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!name.trim() || creating}>
            {creating ? "Creating..." : "Create space"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

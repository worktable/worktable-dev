import { useState, useEffect } from "react"
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
import {
  Briefcase,
  LayoutGrid,
  Layers,
  FolderOpen,
  Rocket,
  Target,
  Church,
} from "lucide-react"
import { IconSearchGrid } from "@/components/icon-search-grid"
import { useSpaces } from "@/lib/queries"

// Icon hints for known group slugs
const GROUP_ICONS: Record<string, typeof Briefcase> = {
  work: Briefcase,
  career: Briefcase,
  "side-quests": Rocket,
  church: Church,
  meta: Target,
}

function formatGroupLabel(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

interface NewSpaceDialogProps {
  open: boolean
  onClose: () => void
  onCreate: (data: { name: string; icon?: string; group?: string }) => void
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
  const { data: spaces } = useSpaces()

  // Derive groups from existing spaces
  const availableGroups = (() => {
    const groups = new Set<string>()
    if (spaces) {
      for (const s of spaces) {
        if (s.group) groups.add(s.group)
      }
    }
    return [...groups].sort()
  })()

  useEffect(() => {
    if (open) {
      setName("")
      setSelectedIcon("rocket")
      setSelectedGroup(defaultGroup ?? null)
      setCreating(false)
    }
  }, [open, defaultGroup])

  const handleCreate = async () => {
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      onCreate({
        name: name.trim(),
        icon: selectedIcon,
        group: selectedGroup ?? undefined,
      })
      setName("")
      onClose()
    } finally {
      setCreating(false)
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
          <div className="space-y-2">
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
              {availableGroups.map((groupId) => {
                const Icon = GROUP_ICONS[groupId] ?? FolderOpen
                const isActive = selectedGroup === groupId
                return (
                  <button
                    key={groupId}
                    type="button"
                    onClick={() => setSelectedGroup(groupId)}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-150 ${
                      isActive
                        ? "bg-surface-selected text-primary"
                        : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <Icon className="size-3.5" />
                    {formatGroupLabel(groupId)}
                  </button>
                )
              })}
            </div>
          </div>

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

import { useState, useEffect, useMemo } from "react"
import { useScrollFade } from "@/hooks/use-scroll-fade"
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
  icons,
} from "lucide-react"
import { getIcon } from "@/lib/icons"
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

/** Convert PascalCase to kebab-case */
function toKebab(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
}

/** All icon names in kebab-case, computed once */
const ALL_ICON_NAMES = Object.keys(icons).map(toKebab).sort()

/** Popular icons shown before user searches */
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
  const newIconGridRef = useScrollFade<HTMLDivElement>()
  const [selectedGroup, setSelectedGroup] = useState<string | null>(
    defaultGroup ?? null
  )
  const [iconQuery, setIconQuery] = useState("")
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
      setIconQuery("")
      setCreating(false)
    }
  }, [open, defaultGroup])

  const displayIcons = useMemo(() => {
    const trimmed = iconQuery.trim().toLowerCase()
    if (!trimmed) return POPULAR_ICONS
    return ALL_ICON_NAMES.filter((n) => n.includes(trimmed)).slice(0, 80)
  }, [iconQuery])

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
            <Input
              placeholder="Search icons..."
              value={iconQuery}
              onChange={(e) => setIconQuery(e.target.value)}
              className="mb-2"
            />
            <div
              ref={newIconGridRef}
              className="scroll-fade grid max-h-40 grid-cols-9 gap-1 overflow-y-auto"
              style={{ "--sf-size": "20px" } as React.CSSProperties}
            >
              {displayIcons.map((iconKey) => {
                const IconComp = getIcon(iconKey)
                if (!IconComp) return null
                const isActive = selectedIcon === iconKey
                return (
                  <button
                    key={iconKey}
                    type="button"
                    onClick={() => setSelectedIcon(iconKey)}
                    title={iconKey}
                    className={`flex size-8 items-center justify-center rounded-md transition-colors duration-150 ${
                      isActive
                        ? "bg-surface-selected text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <IconComp className="size-4" />
                  </button>
                )
              })}
              {displayIcons.length === 0 && iconQuery.trim() && (
                <p className="col-span-9 py-2 text-center text-xs text-muted-foreground">
                  No icons matching &ldquo;{iconQuery.trim()}&rdquo;
                </p>
              )}
            </div>
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

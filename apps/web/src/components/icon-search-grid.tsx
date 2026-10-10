import { useState, type CSSProperties, type ReactNode } from "react"
import { Input } from "@worktable/ui/components/input"
import { cn } from "@worktable/ui/lib/utils"

import { useScrollFade } from "@/hooks/use-scroll-fade"
import { ALL_ICON_NAMES, getIcon } from "@/lib/icons"

/** Common icons shown before searching. */
export const POPULAR_ICONS = [
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

const GRID_COLUMNS = { 8: "grid-cols-8", 9: "grid-cols-9" } as const
const CELL_SIZE = { 8: "size-9", 9: "size-8" } as const

/** Search the Lucide icon library and pick one, as Spaces and agents do. */
export function IconSearchGrid({
  selected,
  onSelect,
  columns = 8,
  className,
  autoFocus,
  leading,
}: {
  selected?: string | null
  onSelect: (icon: string) => void
  columns?: keyof typeof GRID_COLUMNS
  /** Height limit for the scrolling grid, such as `max-h-40`. */
  className?: string
  autoFocus?: boolean
  /** A first cell offered before the library icons, shown until a search. */
  leading?: ReactNode
}) {
  const [query, setQuery] = useState("")
  const gridRef = useScrollFade<HTMLDivElement>()
  const trimmed = query.trim().toLowerCase()
  const icons = trimmed
    ? ALL_ICON_NAMES.filter((name) => name.includes(trimmed)).slice(0, 80)
    : POPULAR_ICONS

  return (
    <div>
      <Input
        placeholder="Search icons..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus={autoFocus}
        className="mb-2"
      />
      <div
        ref={gridRef}
        className={cn(
          "scroll-fade grid gap-1 overflow-y-auto",
          GRID_COLUMNS[columns],
          className ?? "max-h-64"
        )}
        style={{ "--sf-size": "20px" } as CSSProperties}
      >
        {trimmed ? null : leading}
        {icons.map((iconKey) => {
          const IconComp = getIcon(iconKey)
          if (!IconComp) return null
          return (
            <button
              key={iconKey}
              type="button"
              onClick={() => onSelect(iconKey)}
              title={iconKey}
              aria-label={iconKey}
              aria-pressed={selected === iconKey}
              className={cn(
                "flex items-center justify-center rounded-md transition-colors duration-150",
                CELL_SIZE[columns],
                selected === iconKey
                  ? "bg-surface-selected text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <IconComp className="size-4" />
            </button>
          )
        })}
        {icons.length === 0 && trimmed ? (
          <p className="col-span-full py-2 text-center text-xs text-muted-foreground">
            No icons matching &ldquo;{trimmed}&rdquo;
          </p>
        ) : null}
      </div>
    </div>
  )
}

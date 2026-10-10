import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { Input } from "@worktable/ui/components/input"
import { cn } from "@worktable/ui/lib/utils"

import { useScrollFade } from "@/hooks/use-scroll-fade"
import { loadIconCatalog, NamedIcon, POPULAR_ICONS } from "@/lib/icons"

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
  // Popular icons render at once; searching needs every name, so fetch the
  // catalog as soon as the picker opens.
  const [allNames, setAllNames] = useState<readonly string[] | null>(null)
  useEffect(() => {
    let active = true
    loadIconCatalog().then(
      (catalog) => {
        if (active) setAllNames(catalog.ALL_ICON_NAMES)
      },
      // Popular icons still work; search stays empty rather than claim no match.
      () => {}
    )
    return () => {
      active = false
    }
  }, [])
  const gridRef = useScrollFade<HTMLDivElement>()
  const trimmed = query.trim().toLowerCase()
  const icons = trimmed
    ? (allNames ?? []).filter((name) => name.includes(trimmed)).slice(0, 80)
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
        {icons.map((iconKey) => (
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
            <NamedIcon name={iconKey} className="size-4" />
          </button>
        ))}
        {icons.length === 0 && trimmed && allNames ? (
          <p className="col-span-full py-2 text-center text-xs text-muted-foreground">
            No icons matching &ldquo;{trimmed}&rdquo;
          </p>
        ) : null}
      </div>
    </div>
  )
}

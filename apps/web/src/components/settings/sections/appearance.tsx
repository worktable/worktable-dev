import { cn } from "@worktable/ui/lib/utils"
import { useTheme } from "@/components/theme-provider"
import {
  setSidebarLayout,
  useSidebarLayout,
  type SidebarLayout,
} from "@/lib/sidebar-live"

type ThemeValue = "system" | "light" | "dark"

// Hand-drawn token-built thumbnails — a page rect with a sidebar bar. No assets;
// the swatches read the same in either resolved theme (they're literal colors).
const THEME_OPTIONS: { value: ThemeValue; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

export function AppearanceSection() {
  return (
    <div className="flex flex-col gap-6">
      <ThemeGroup />
      <SidebarGroup />
    </div>
  )
}

// ── Theme ────────────────────────────────────────────────────────────────────

function ThemeThumbnail({ value }: { value: ThemeValue }) {
  if (value === "light") {
    return (
      <div className="flex h-full w-full overflow-hidden rounded bg-white">
        <div className="h-full w-1/3 bg-neutral-200" />
      </div>
    )
  }
  if (value === "dark") {
    return (
      <div className="flex h-full w-full overflow-hidden rounded bg-neutral-900">
        <div className="h-full w-1/3 bg-neutral-800" />
      </div>
    )
  }
  // System: half light, half dark — each half keeps its own sidebar bar.
  return (
    <div className="flex h-full w-full overflow-hidden rounded">
      <div className="flex h-full w-1/2 bg-white">
        <div className="h-full w-1/3 bg-neutral-200" />
      </div>
      <div className="flex h-full w-1/2 bg-neutral-900">
        <div className="h-full w-1/3 bg-neutral-800" />
      </div>
    </div>
  )
}

function ThemeGroup() {
  const { theme, setTheme } = useTheme()

  // Arrow-key navigation across the radios (optional polish); Enter/Space select
  // is handled natively via the button role fallback below.
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
    e.preventDefault()
    const index = THEME_OPTIONS.findIndex((o) => o.value === theme)
    const delta = e.key === "ArrowRight" ? 1 : -1
    const next =
      THEME_OPTIONS[
        (index + delta + THEME_OPTIONS.length) % THEME_OPTIONS.length
      ]
    setTheme(next.value)
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Theme</h3>

      <div className="flex flex-col gap-3 rounded-xl card-surface p-4">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-3"
          onKeyDown={handleKeyDown}
        >
          {THEME_OPTIONS.map((option) => {
            const selected = theme === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTheme(option.value)}
                className="flex flex-col items-center gap-2 outline-none"
              >
                <span
                  className={cn(
                    "block h-14 w-full rounded-lg border border-border p-1 transition-shadow",
                    selected && "ring-2 ring-primary"
                  )}
                >
                  <ThemeThumbnail value={option.value} />
                </span>
                <span
                  className={cn(
                    "text-sm",
                    selected ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {option.label}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-sm text-muted-foreground">
          Shortcut: press <kbd className="inline-code-accent font-mono">d</kbd>{" "}
          to toggle.
        </p>
      </div>
    </section>
  )
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

const SIDEBAR_OPTIONS: { value: SidebarLayout; label: string }[] = [
  { value: "tree", label: "Folders and Docs" },
  { value: "folders", label: "Folders Only" },
]

/** A sidebar with rows, beside a list when folders open as lists. */
function SidebarThumbnail({ value }: { value: SidebarLayout }) {
  const rows = value === "tree" ? [3, 5, 4, 5, 3, 4] : [3, 4, 3]
  return (
    <div className="flex h-full w-full gap-1 overflow-hidden rounded bg-muted/40 p-1">
      <div className="flex w-1/3 flex-col gap-1 rounded-sm bg-muted p-1">
        {rows.map((width, index) => (
          <span
            key={index}
            className="h-1 rounded-full bg-muted-foreground/30"
            style={{ width: `${width * 18}%`, marginLeft: index % 2 && value === "tree" ? "20%" : 0 }}
          />
        ))}
      </div>
      {value === "folders" && (
        <div className="flex w-1/4 flex-col gap-1 border-r border-border/60 p-1">
          {[5, 4, 5].map((width, index) => (
            <span
              key={index}
              className="h-1 rounded-full bg-muted-foreground/25"
              style={{ width: `${width * 18}%` }}
            />
          ))}
        </div>
      )}
      <div className="flex-1" />
    </div>
  )
}

function SidebarGroup() {
  const layout = useSidebarLayout()
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Sidebar</h3>
      <div className="flex flex-col gap-3 rounded-xl card-surface p-4">
        <div role="radiogroup" aria-label="Sidebar" className="grid grid-cols-2 gap-3">
          {SIDEBAR_OPTIONS.map((option) => {
            const selected = layout === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setSidebarLayout(option.value)}
                className="flex flex-col items-center gap-2 outline-none"
              >
                <span
                  className={cn(
                    "block h-14 w-full rounded-lg border border-border p-1 transition-shadow",
                    selected && "ring-2 ring-primary"
                  )}
                >
                  <SidebarThumbnail value={option.value} />
                </span>
                <span
                  className={cn(
                    "text-sm",
                    selected ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {option.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

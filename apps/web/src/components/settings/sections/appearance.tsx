import { cn } from "@worktable/ui/lib/utils"
import { useTheme } from "@/components/theme-provider"
import {
  setSidebarLayout,
  useSidebarLayout,
  type SidebarLayout,
} from "@/lib/list-beside"

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

/** One row of a pictured sidebar or list: an icon and a line of text. */
function PictureRow({
  kind,
  width,
  indent = false,
  open = false,
}: {
  kind: "folder" | "doc"
  /** The line's length, as a share of the row. */
  width: number
  indent?: boolean
  /** The open doc or folder, marked as the app marks it. */
  open?: boolean
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-[3px] px-1 py-[3px]",
        indent && "ml-2",
        open && "bg-sidebar-accent"
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-[1.5px]",
          kind === "folder"
            ? "bg-primary/55"
            : open
              ? "bg-primary/70"
              : "bg-muted-foreground/35"
        )}
      />
      <span
        className={cn(
          "h-[3px] rounded-full",
          open ? "bg-primary/60" : "bg-muted-foreground/30"
        )}
        style={{ width: `${width}%` }}
      />
    </span>
  )
}

/** The page beside the sidebar: a title and a few lines of text. */
function PicturePage() {
  return (
    <span className="flex flex-1 flex-col gap-1 px-2.5 py-2.5">
      <span className="h-1.5 w-1/2 rounded-full bg-foreground/25" />
      {[90, 80, 86, 60].map((width, index) => (
        <span
          key={index}
          className="h-[3px] rounded-full bg-muted-foreground/20"
          style={{ width: `${width}%` }}
        />
      ))}
    </span>
  )
}

/**
 * A small window in the app's colors: the sidebar as the style shows it,
 * with docs under their folders, or folders alone and a folder's docs
 * listed beside the page.
 */
function SidebarThumbnail({ value }: { value: SidebarLayout }) {
  return (
    <span className="flex h-full w-full overflow-hidden rounded bg-background">
      <span className="flex w-[38%] shrink-0 flex-col gap-px bg-sidebar p-1">
        {value === "tree" ? (
          <>
            <PictureRow kind="folder" width={55} />
            <PictureRow kind="doc" width={62} indent />
            <PictureRow kind="doc" width={50} indent open />
            <PictureRow kind="doc" width={58} indent />
            <PictureRow kind="folder" width={45} />
            <PictureRow kind="folder" width={60} />
          </>
        ) : (
          <>
            <PictureRow kind="folder" width={55} />
            <PictureRow kind="folder" width={45} open />
            <PictureRow kind="folder" width={60} />
            <PictureRow kind="folder" width={40} />
          </>
        )}
      </span>
      {value === "folders" && (
        <span className="flex w-[30%] shrink-0 flex-col gap-px border-r border-border/70 p-1">
          <PictureRow kind="doc" width={62} />
          <PictureRow kind="doc" width={50} open />
          <PictureRow kind="doc" width={58} />
          <PictureRow kind="doc" width={44} />
        </span>
      )}
      <PicturePage />
    </span>
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
                    "block h-[5.5rem] w-full rounded-lg border border-border p-1 transition-shadow",
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

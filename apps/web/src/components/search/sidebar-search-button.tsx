import type { ReactNode } from "react"
import { Command, Search } from "lucide-react"
import { useWorkspace } from "@/lib/queries"
import { openSearch } from "@/lib/search-open"

/** The keys that open search: Command on Apple's keyboards, Ctrl elsewhere. */
function shortcutKeys(): ReadonlyArray<{ id: string; key: ReactNode }> {
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  return [
    mac
      ? { id: "command", key: <Command className="size-3" /> }
      : { id: "ctrl", key: "Ctrl" },
    { id: "k", key: "K" },
  ]
}

/**
 * The sidebar's way into search. It sits where a search field would and
 * reads as one, and opens search over the page.
 */
export function SidebarSearchButton({ onOpen }: { onOpen?: () => void }) {
  const worktableName = useWorkspace().data?.name ?? "Worktable"
  return (
    <button
      type="button"
      aria-label="Search"
      aria-haspopup="dialog"
      onClick={() => {
        onOpen?.()
        openSearch()
      }}
      className="well well-interactive flex h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-input px-3 text-sm text-sidebar-foreground/50 transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Search className="size-4 shrink-0 text-sidebar-foreground/40" />
      <span className="min-w-0 flex-1 truncate text-left">
        Search {worktableName}…
      </span>
      {/* Each key on its own cap; none on a touch screen. */}
      <span
        aria-hidden
        className="flex shrink-0 items-center gap-1 pointer-coarse:hidden"
      >
        {shortcutKeys().map(({ id, key }) => (
          <kbd
            key={id}
            className="inline-code-accent flex h-5 min-w-5 items-center justify-center font-sans text-xs leading-none"
          >
            {key}
          </kbd>
        ))}
      </span>
    </button>
  )
}

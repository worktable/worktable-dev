import { Search } from "lucide-react"
import { useWorkspace } from "@/lib/queries"
import { openSearch } from "@/lib/search-open"

/** Cmd on Apple's keyboards, Ctrl elsewhere. */
function shortcutLabel(): string {
  return typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘K"
    : "Ctrl K"
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
      className="well well-interactive flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input px-3 text-sm text-sidebar-foreground/50 transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Search className="size-4 shrink-0 text-sidebar-foreground/40" />
      <span className="min-w-0 flex-1 truncate text-left">
        Search {worktableName}…
      </span>
      {/* No keys to press on a touch screen. */}
      <kbd className="inline-code-accent shrink-0 font-mono text-[0.6875rem] pointer-coarse:hidden">
        {shortcutLabel()}
      </kbd>
    </button>
  )
}

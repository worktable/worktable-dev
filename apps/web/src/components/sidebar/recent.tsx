import { Link, useRouterState, type LinkProps } from "@tanstack/react-router"
import { ChevronRight, X } from "lucide-react"
import { useLayoutEffect, useMemo, useRef } from "react"
import { TruncatedText } from "@worktable/ui/components/truncated-text"
import { cn } from "@worktable/ui/lib/utils"
import { ScrollFadeArea } from "@/components/scroll-fade-area"
import { RecentOpenIcon } from "@/components/sidebar/recent-open-icon"
import { SectionHeading } from "@/components/sidebar/space-groups"
import { listRecent, useFolderColumnFits, useRecentListed } from "@/lib/list-beside"
import { useSpaces, useWorkspace } from "@/lib/queries"
import {
  openFromRecent,
  recentOpenSpace,
  useRecentOpens,
  type RecentOpen,
} from "@/lib/recent-opens"
import { markTreeNavigation } from "@/lib/sidebar-live"

/** Rows Recent shows in the sidebar before See All. */
const RECENT_ROWS = 4

/**
 * What this person opened on this device, in Spaces they can still open,
 * with the names of those Spaces.
 */
function useRecent(): { opens: RecentOpen[]; spaceNames: Map<string, string> } {
  const opens = useRecentOpens(useWorkspace().data?.id)
  const { data: spaces } = useSpaces()
  return useMemo(() => {
    const spaceNames = new Map(spaces?.map((space) => [space.id, space.name]))
    return {
      opens: opens.filter((open) => {
        const spaceId = recentOpenSpace(open)
        // A Space's pages show once its list confirms access.
        return !spaceId || spaceNames.has(spaceId)
      }),
      spaceNames,
    }
  }, [opens, spaces])
}

function useCurrentPath(): string {
  return useRouterState({ select: (state) => state.location.pathname })
}

/** Opening a page from Recent leaves Recent's order, and the tree, as they are. */
function openedFromRecent(open: RecentOpen) {
  openFromRecent(open.path)
  markTreeNavigation()
}

/** Rows Recent shows: every one when a single extra would hide behind See All. */
function recentRows(opens: readonly RecentOpen[]): {
  shown: readonly RecentOpen[]
  hidden: number
} {
  if (opens.length <= RECENT_ROWS + 1) return { shown: opens, hidden: 0 }
  return { shown: opens.slice(0, RECENT_ROWS), hidden: opens.length - RECENT_ROWS }
}

const sidebarRow =
  "flex min-h-10 min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-180 sm:min-h-0"

/** Recent in the sidebar: the latest few pages opened here, then See All. */
export function RecentSidebarSection({
  open,
  onToggle,
  onNavigate,
}: {
  open: boolean
  onToggle: () => void
  /** Called as a row opens a page (closes the sidebar on a phone). */
  onNavigate: () => void
}) {
  const { opens } = useRecent()
  const current = useCurrentPath()
  const listed = useRecentListed()
  const fits = useFolderColumnFits()
  if (opens.length === 0) return null
  const { shown, hidden } = recentRows(opens)
  const seeAllClass = `${sidebarRow} ${
    listed
      ? "bg-sidebar-accent font-medium text-sidebar-primary"
      : "text-sidebar-foreground/50 hover:bg-sidebar-hover hover:text-sidebar-foreground"
  }`
  const seeAllBody = (
    <>
      <span aria-hidden className="size-4 shrink-0" />
      <span>See All</span>
      <ChevronRight aria-hidden className="-ml-1 size-3.5 shrink-0" />
    </>
  )
  return (
    <div>
      <SectionHeading
        label="Recent"
        count={opens.length}
        open={open}
        onToggle={onToggle}
        revealActions={false}
      />
      {open && (
        <nav aria-label="Recent" className="space-y-0.5">
          {shown.map((item) => {
            const active = item.path === current
            return (
              <Link
                key={item.path}
                {...({ to: item.path } as LinkProps)}
                onClick={() => {
                  openedFromRecent(item)
                  onNavigate()
                }}
                draggable={false}
                aria-current={active ? "page" : undefined}
                className={`${sidebarRow} ${
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-primary"
                    : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
                }`}
              >
                <RecentOpenIcon
                  open={item}
                  className={`size-4 shrink-0 ${
                    active ? "text-sidebar-primary" : "text-sidebar-foreground/30"
                  }`}
                />
                <TruncatedText text={item.title} className="min-w-0 flex-1" />
              </Link>
            )
          })}
          {hidden > 0 &&
            (fits ? (
              // A wide screen lists the rest beside the page, wherever it is.
              <button
                type="button"
                onClick={() => listRecent(!listed)}
                aria-expanded={listed}
                className={`${seeAllClass} w-full text-left`}
              >
                {seeAllBody}
              </button>
            ) : (
              <Link to="/recent" onClick={onNavigate} className={seeAllClass}>
                {seeAllBody}
              </Link>
            ))}
        </nav>
      )}
    </div>
  )
}

const listRow =
  "flex h-9 min-w-0 items-center gap-2 rounded-md px-3 text-sm transition-colors"

function RecentItems({ variant }: { variant: "column" | "page" }) {
  const { opens, spaceNames } = useRecent()
  const current = useCurrentPath()
  if (opens.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted-foreground">Nothing opened yet.</p>
  }
  return (
    <nav aria-label="Recent">
      {opens.map((item) => {
        const active = item.path === current
        const spaceId = recentOpenSpace(item)
        const spaceName = spaceId ? spaceNames.get(spaceId) : undefined
        return (
          <Link
            key={item.path}
            {...({ to: item.path } as LinkProps)}
            onClick={() => openedFromRecent(item)}
            aria-current={active ? "page" : undefined}
            data-active={active ? "" : undefined}
            className={cn(
              listRow,
              active
                ? "bg-sidebar-accent font-medium text-primary"
                : "text-foreground/80 hover:bg-accent hover:text-foreground"
            )}
          >
            <RecentOpenIcon
              open={item}
              className={cn(
                "size-4 shrink-0",
                active ? "text-primary" : "text-muted-foreground/60"
              )}
            />
            <TruncatedText text={item.title} className="min-w-0 flex-1" />
            {/* Pages share names across Spaces; the Space tells them apart. */}
            {spaceName && (
              <TruncatedText
                text={spaceName}
                className={cn(
                  "max-w-[40%] shrink-0 text-xs font-normal text-muted-foreground/70",
                  variant === "page" && "max-w-[50%]"
                )}
              />
            )}
          </Link>
        )
      })}
    </nav>
  )
}

/** Recent's list beside the page, from See All on a wide screen. */
export function RecentList() {
  const asideRef = useRef<HTMLElement>(null)
  // Opens at its top; moving between its pages leaves it where it was.
  useLayoutEffect(() => {
    const list = asideRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (list) list.scrollTop = 0
  }, [])
  return (
    <aside
      ref={asideRef}
      aria-label="Recent"
      className="flex h-full w-72 flex-col border-r border-border/60 bg-background"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 px-3">
        {/* Nothing else on the page names this list. */}
        <span className="text-sm font-medium text-muted-foreground">Recent</span>
        <button
          type="button"
          aria-label="Close list"
          onClick={() => listRecent(false)}
          className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <ScrollFadeArea
        fadeSize={24}
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:opacity-0 [&_[data-slot=scroll-area-scrollbar]]:transition-opacity [&_[data-slot=scroll-area-scrollbar]]:duration-300 [&:hover_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <div className="px-2 pb-4">
          <RecentItems variant="column" />
        </div>
      </ScrollFadeArea>
    </aside>
  )
}

/** Recent's page, for a screen too narrow for the list beside the page. */
export function RecentPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
      <h1 className="mb-4 font-display text-2xl font-semibold text-foreground">Recent</h1>
      <RecentItems variant="page" />
    </div>
  )
}

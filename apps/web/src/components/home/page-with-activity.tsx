import { useEffect, useState, type ReactNode } from "react"
import { cn } from "@worktable/ui/lib/utils"
import {
  CONTEXT_PANEL_RAIL_WIDTH,
  ContextPanelRail,
  DesktopContextPanel,
} from "@/components/desktop-context-panel"
import { ActivityPanel } from "@/components/home/activity-feed"
import { useScrollFade } from "@/hooks/use-scroll-fade"

/** Whether the window matches a media query; null until mounted. */
function useMediaQuery(media: string): boolean | null {
  const [matches, setMatches] = useState<boolean | null>(null)
  useEffect(() => {
    const query = window.matchMedia(media)
    const update = () => setMatches(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [media])
  return matches
}

// The side panel starts collapsed; opening it holds on this device.
const ACTIVITY_OPEN_KEY = "worktable-home-activity-open"

function useActivityOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(ACTIVITY_OPEN_KEY) === "true"
    } catch {
      return false
    }
  })
  const remember = (value: boolean) => {
    setOpen(value)
    try {
      localStorage.setItem(ACTIVITY_OPEN_KEY, String(value))
    } catch {
      // The choice still holds until the page reloads.
    }
  }
  return [open, remember]
}

/**
 * Home and Space Home: the page scrolls on its own beside a full-height
 * Activity panel, collapsed to a rail until opened. Narrower windows show
 * recent Activity under the page.
 */
export function PageWithActivity({
  spaceId,
  className,
  children,
}: {
  spaceId?: string
  className?: string
  children: ReactNode
}) {
  const scrollRef = useScrollFade<HTMLDivElement>(8, { top: false })
  // The panel matches other side panels, with more room on wide screens.
  const panelWidth = useMediaQuery("(min-width: 1600px)") ? 448 : 384
  // Both placements stay in the layout; only the visible one loads.
  const wide = useMediaQuery("(min-width: 1280px)")
  const [activityOpen, setActivityOpen] = useActivityOpen()
  return (
    <div className={cn("xl:flex xl:h-full", className)}>
      <div
        ref={scrollRef}
        className="scroll-fade min-w-0 xl:flex-1 xl:overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl space-y-9 px-4 py-8 sm:px-8 lg:py-10">
          {children}
          <ActivityPanel
            spaceId={spaceId}
            limit={8}
            enabled={wide === false}
            className="border-t border-border pt-8 xl:hidden"
          />
        </div>
      </div>
      <DesktopContextPanel
        open
        width={activityOpen ? panelWidth : CONTEXT_PANEL_RAIL_WIDTH}
      >
        {activityOpen ? (
          <ActivityPanel
            spaceId={spaceId}
            limit={40}
            enabled={wide === true}
            onCollapse={() => setActivityOpen(false)}
            className="h-full p-5 pr-4"
          />
        ) : (
          <ContextPanelRail
            label="Activity"
            onExpand={() => setActivityOpen(true)}
          />
        )}
      </DesktopContextPanel>
    </div>
  )
}

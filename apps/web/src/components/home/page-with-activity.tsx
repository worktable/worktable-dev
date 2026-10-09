import { useEffect, useState, type ReactNode } from "react"
import { cn } from "@worktable/ui/lib/utils"
import { DesktopContextPanel } from "@/components/desktop-context-panel"
import { ActivityPanel } from "@/components/home/activity-feed"
import { useScrollFade } from "@/hooks/use-scroll-fade"

const WIDE_QUERY = "(min-width: 1600px)"

/** The same width as other side panels, with more room on wide screens. */
function usePanelWidth(): number {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY)
    const update = () => setWide(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return wide ? 448 : 384
}

/**
 * Home and Space Home: the page scrolls on its own beside a full-height
 * Activity panel. Narrower windows show recent Activity under the page.
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
  const panelWidth = usePanelWidth()
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
            className="border-t border-border pt-8 xl:hidden"
          />
        </div>
      </div>
      <DesktopContextPanel open width={panelWidth}>
        <ActivityPanel spaceId={spaceId} limit={40} className="h-full p-5 pr-4" />
      </DesktopContextPanel>
    </div>
  )
}

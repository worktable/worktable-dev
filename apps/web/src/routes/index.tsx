import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { WorktableAppIcon } from "@/components/worktable-app-icon"
import { HomeNewMenu } from "@/components/home/home-new-menu"
import { PendingSection, RecentSection } from "@/components/home/home-sections"
import { useSpaces, useWorkspace } from "@/lib/queries"
import { getSpaceArchiveInfo } from "@/lib/spaces"
import { isGettingStartedSpace } from "@/lib/setup"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <WorktableAppIcon className="mb-5 size-14" />
      <h2 className="text-base font-medium text-foreground">
        Welcome to Worktable
      </h2>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Create documents in the sidebar, or ask an AI agent to create a visual
        HTML doc.
      </p>
    </div>
  )
}

function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning"
  if (hour >= 12 && hour < 17) return "Good afternoon"
  return "Good evening"
}

/**
 * Today's date and greeting, rendered after mount so server and browser time
 * zones agree.
 */
function useToday(): { date: string; greeting: string } | null {
  const [today, setToday] = useState<{ date: string; greeting: string } | null>(
    null
  )
  useEffect(() => {
    const update = () => {
      const now = new Date()
      setToday({
        date: now.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        }),
        greeting: greetingFor(now.getHours()),
      })
    }
    update()
    const timer = window.setInterval(update, 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return today
}

function HomePage() {
  const { data: spaces } = useSpaces()
  const { data: workspace } = useWorkspace()
  const today = useToday()
  // An unnamed owner is just greeted.
  const name = workspace?.person?.name?.trim()
  const greeted = name && name !== "Owner" ? name : undefined

  const newMenuSpaces = useMemo(
    () =>
      (spaces ?? []).filter(
        (space) => !getSpaceArchiveInfo(space) && !isGettingStartedSpace(space)
      ),
    [spaces]
  )

  // Home does not wait for the Spaces list: Recent and Pending load on their
  // own, and only a workspace known to be empty shows welcome.
  if (spaces?.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-8 sm:px-8 lg:py-10">
      <header className="flex items-start justify-between gap-4 px-0.5">
        <div className="min-w-0">
          <h1 className="min-h-9 font-display text-[1.9rem] leading-tight font-semibold tracking-tight text-balance text-foreground sm:min-h-11 sm:text-[2.6rem]">
            {today ? `${today.greeting}${greeted ? `, ${greeted}` : ""}.` : null}
          </h1>
          <p className="mt-1.5 min-h-5 text-sm text-muted-foreground">
            {today?.date}
          </p>
        </div>
        <HomeNewMenu spaces={newMenuSpaces} />
      </header>

      <PendingSection />
      <RecentSection />
    </div>
  )
}

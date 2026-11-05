import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { WorktableAppIcon } from "@/components/worktable-app-icon"
import { HomeNewMenu } from "@/components/home/home-new-menu"
import {
  ArchivingSoonSection,
  GettingStartedRow,
  PendingSection,
  RecentSection,
} from "@/components/home/home-sections"
import { useSpaces, useWorkspace } from "@/lib/queries"
import { getSpaceArchiveInfo } from "@/lib/spaces"
import { isGettingStartedSpace } from "@/lib/setup"

export const Route = createFileRoute("/")({
  component: HomePage,
})

/** A Worktable with no Spaces yet starts with one. */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <WorktableAppIcon className="mb-5 size-14" />
      <h2 className="text-base font-medium text-foreground">
        Welcome to Worktable
      </h2>
      <div className="mt-4">
        <HomeNewMenu spaces={[]} />
      </div>
    </div>
  )
}

function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning"
  if (hour >= 12 && hour < 17) return "Good afternoon"
  return "Good evening"
}

/** The greeting for the reader's hour, set after mount so time zones agree. */
function useGreeting(): string | null {
  const [greeting, setGreeting] = useState<string | null>(null)
  useEffect(() => {
    const update = () => setGreeting(greetingFor(new Date().getHours()))
    update()
    const timer = window.setInterval(update, 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return greeting
}

function HomePage() {
  const { data: spaces } = useSpaces()
  const { data: workspace } = useWorkspace()
  const greeting = useGreeting()
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
      <header className="flex items-center justify-between gap-4 px-0.5">
        <h1 className="min-h-9 min-w-0 font-display text-[1.75rem] leading-9 font-semibold tracking-tight text-balance text-foreground sm:text-[2rem] sm:leading-10">
          {greeting ? `${greeting}${greeted ? `, ${greeted}` : ""}.` : null}
        </h1>
        <HomeNewMenu spaces={newMenuSpaces} />
      </header>

      <GettingStartedRow />
      <PendingSection />
      <RecentSection />
      <ArchivingSoonSection />
    </div>
  )
}

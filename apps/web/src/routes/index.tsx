import { useMemo, useSyncExternalStore } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { WorktableAppIcon } from "@/components/worktable-app-icon"
import { HomeNewMenu } from "@/components/home/home-new-menu"
import {
  ArchivingSoonSection,
  GettingStartedRow,
  HomeSummary,
  LatestWorkSection,
  YourTurnSection,
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

const unchanging = () => () => {}

/**
 * The greeting for the reader's hour. The server's render has none, so its
 * time zone never shows.
 */
function useGreeting(): string | null {
  return useSyncExternalStore(
    unchanging,
    () => greetingFor(new Date().getHours()),
    () => null
  )
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

  // Home does not wait for the Spaces list: its sections load on their own,
  // and only a workspace known to be empty shows welcome.
  if (spaces?.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <EmptyState />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-7 px-4 py-6 sm:px-8 sm:py-8 lg:py-10">
      <header className="flex items-start justify-between gap-4 px-0.5">
        <div className="min-w-0">
          <h1 className="min-h-8 font-display text-[1.5rem] leading-8 font-semibold tracking-tight text-balance text-foreground sm:text-[1.75rem] sm:leading-9">
            {greeting ? `${greeting}${greeted ? `, ${greeted}` : ""}.` : null}
          </h1>
          <HomeSummary />
        </div>
        <HomeNewMenu spaces={newMenuSpaces} />
      </header>

      <GettingStartedRow />
      <YourTurnSection />
      <LatestWorkSection />
      <ArchivingSoonSection />
    </div>
  )
}

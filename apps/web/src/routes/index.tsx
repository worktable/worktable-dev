import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { WorktableAppIcon } from "@/components/worktable-app-icon"
import { ActivityColumn } from "@/components/home/activity-feed"
import { HomeNewMenu } from "@/components/home/home-new-menu"
import {
  PendingSection,
  RecentRows,
  TemporaryGroup,
  type RecentItem,
} from "@/components/home/home-sections"
import { useSpaces } from "@/lib/queries"
import { useRecentDocuments } from "@/lib/lifetime"
import { getSpaceArchiveInfo } from "@/lib/spaces"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"

export const Route = createFileRoute("/")({
  component: HomePage,
})

const RECENT_ROWS = 8

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

/** Today's date, rendered after mount so server and browser time zones agree. */
function useToday(): string | null {
  const [today, setToday] = useState<string | null>(null)
  useEffect(() => {
    const update = () =>
      setToday(
        new Date().toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        })
      )
    update()
    const timer = window.setInterval(update, 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return today
}

function HomePage() {
  const { data: spaces, isLoading } = useSpaces()
  const today = useToday()
  const [spaceFilter, setSpaceFilter] = useState<string | undefined>()
  const [showAll, setShowAll] = useState(false)

  const recent = useRecentDocuments({
    sort: "updated",
    includeTemporary: false,
    ...(spaceFilter ? { spaceId: spaceFilter } : {}),
  })
  // Temporary docs come from the same feed with lifetimes included.
  const withTemporary = useRecentDocuments({
    sort: "updated",
    includeTemporary: true,
    limit: 100,
    ...(spaceFilter ? { spaceId: spaceFilter } : {}),
  })

  const activeSpaces = useMemo(() => {
    const active = (spaces ?? []).filter((space) => !getSpaceArchiveInfo(space))
    const lastActivity = new Map(
      (recent.data?.spaces ?? []).map((entry) => [
        entry.spaceId,
        entry.lastActivityAt ?? "",
      ])
    )
    return active.sort((a, b) =>
      (lastActivity.get(b.id) ?? "").localeCompare(lastActivity.get(a.id) ?? "")
    )
  }, [spaces, recent.data])

  const recentItems: RecentItem[] = (recent.data?.items ?? []).map((item) => ({
    spaceId: item.spaceId,
    spaceName: spaceFilter ? undefined : item.spaceName,
    document: item.document,
  }))
  const temporaryItems: RecentItem[] = (withTemporary.data?.items ?? [])
    .filter((item) => item.document.lifetime === "temporary")
    .map((item) => ({
      spaceId: item.spaceId,
      spaceName: spaceFilter ? undefined : item.spaceName,
      document: item.document,
    }))

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-8">
        <div className="mb-8 h-9 w-72 animate-pulse rounded-lg bg-muted/30" />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/20" />
          ))}
        </div>
      </div>
    )
  }

  if (!spaces || spaces.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <EmptyState />
      </div>
    )
  }

  const visibleRecent = showAll ? recentItems : recentItems.slice(0, RECENT_ROWS)

  return (
    <div className="mx-auto grid max-w-6xl gap-x-12 gap-y-10 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_17.5rem] lg:py-10">
      <div className="min-w-0 space-y-9">
        <header className="flex items-start justify-between gap-4">
          <h1 className="min-h-9 font-display text-[1.65rem] leading-tight font-semibold tracking-tight text-foreground sm:min-h-10 sm:text-[2rem]">
            {today}
          </h1>
          <HomeNewMenu spaces={activeSpaces} />
        </header>

        <PendingSection />

        <div className="space-y-5">
        <section aria-labelledby="recent-heading">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2
              id="recent-heading"
              className="text-sm font-semibold text-foreground"
            >
              Recent
            </h2>
            <Select
              value={spaceFilter ?? "all"}
              onValueChange={(value) =>
                setSpaceFilter(!value || value === "all" ? undefined : String(value))
              }
            >
              <SelectTrigger
                aria-label="Filter by Space"
                className="h-8 w-auto max-w-48 border-none bg-transparent text-muted-foreground shadow-none hover:text-foreground"
              >
                <SelectValue>
                  {(value: string) =>
                    value === "all"
                      ? "All Spaces"
                      : (activeSpaces.find((space) => space.id === value)?.name ??
                        "All Spaces")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">All Spaces</SelectItem>
                {activeSpaces.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {recent.isLoading ? (
            <div className="space-y-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse rounded-lg bg-muted/20" />
              ))}
            </div>
          ) : recent.isError ? (
            <p className="text-sm text-muted-foreground">
              Couldn’t load recent docs.{" "}
              <button
                type="button"
                className="text-primary-text hover:underline"
                onClick={() => void recent.refetch()}
              >
                Try again
              </button>
            </p>
          ) : recentItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <>
              <RecentRows items={visibleRecent} />
              {!showAll && recentItems.length > RECENT_ROWS && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mt-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  Show more
                </button>
              )}
            </>
          )}
        </section>
        <TemporaryGroup items={temporaryItems} />
        </div>
      </div>

      <aside className="min-w-0 lg:border-l lg:border-border lg:pl-8">
        <ActivityColumn />
      </aside>
    </div>
  )
}

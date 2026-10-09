import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Folder, Users } from "lucide-react"
import { useMemo } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { Button } from "@worktable/ui/components/button"
import { ActivityItem, ActorBadge } from "@/components/home/activity-feed"
import { clockTime, groupByDay } from "@/lib/activity-format"
import { useActivityAgents, useActivityPages } from "@/lib/activity"
import { useSpaces } from "@/lib/queries"
import { getSpaceArchiveInfo } from "@/lib/spaces"

interface ActivitySearch {
  spaceId?: string
  actor?: "person" | "agent"
  /** One agent, by its activity actor id. */
  agent?: string
}

export const Route = createFileRoute("/activity")({
  validateSearch: (search: Record<string, unknown>): ActivitySearch => ({
    ...(typeof search["spaceId"] === "string" && search["spaceId"]
      ? { spaceId: search["spaceId"] }
      : {}),
    ...(search["actor"] === "person" || search["actor"] === "agent"
      ? { actor: search["actor"] }
      : {}),
    ...(typeof search["agent"] === "string" && search["agent"]
      ? { agent: search["agent"] }
      : {}),
  }),
  component: ActivityPage,
})

const ACTORS: Record<string, string> = {
  all: "Everyone",
  person: "You",
  agent: "All agents",
}

function ActivityPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: "/activity" })
  const { data: spaces } = useSpaces()
  const pages = useActivityPages({
    ...(search.spaceId ? { spaceId: search.spaceId } : {}),
    ...(search.agent
      ? { actorId: search.agent }
      : search.actor
        ? { actor: search.actor }
        : {}),
    limit: 50,
  })
  const { data: agentData } = useActivityAgents(search.spaceId)
  const agents = agentData?.agents ?? []
  const who = search.agent ? `agent:${search.agent}` : (search.actor ?? "all")
  const names = useMemo(
    () => new Map((spaces ?? []).map((space) => [space.id, space.name])),
    [spaces]
  )
  const activeSpaces = (spaces ?? []).filter(
    (space) => !getSpaceArchiveInfo(space) || space.id === search.spaceId
  )
  const entries = pages.data?.pages.flatMap((page) => page.entries) ?? []

  const setSearch = (next: ActivitySearch) =>
    void navigate({ search: next, replace: true })

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 lg:py-10">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-[2rem]">
        Activity
      </h1>
      <div className="mt-5 flex flex-wrap gap-2">
        <Select
          value={search.spaceId ?? "all"}
          onValueChange={(value) =>
            setSearch({
              ...search,
              spaceId: !value || value === "all" ? undefined : String(value),
            })
          }
        >
          <SelectTrigger aria-label="Filter by Space" className="h-8 w-auto">
            <Folder className="size-3.5 text-muted-foreground" />
            <SelectValue>
              {(value: string) =>
                value === "all" ? "All Spaces" : (names.get(value) ?? value)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Spaces</SelectItem>
            {activeSpaces.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={who}
          onValueChange={(value) => {
            const next = String(value ?? "all")
            setSearch({
              ...(search.spaceId ? { spaceId: search.spaceId } : {}),
              ...(next === "person" || next === "agent" ? { actor: next } : {}),
              ...(next.startsWith("agent:") ? { agent: next.slice(6) } : {}),
            })
          }}
        >
          <SelectTrigger aria-label="Filter by who" className="h-8 w-auto">
            <Users className="size-3.5 text-muted-foreground" />
            <SelectValue>
              {(value: string) =>
                value.startsWith("agent:")
                  ? (agents.find((agent) => `agent:${agent.id}` === value)
                      ?.name ?? "Agent")
                  : (ACTORS[value] ?? ACTORS["all"])
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ACTORS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
            {agents.length > 0 && <SelectSeparator />}
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={`agent:${agent.id}`}>
                <span className="flex items-center gap-2">
                  <ActorBadge actor={agent} />
                  {agent.name ?? "Agent"}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {pages.isPending ? (
        <div className="mt-8 space-y-3">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="h-10 animate-pulse rounded-lg bg-muted/20"
            />
          ))}
        </div>
      ) : pages.isError && !pages.data ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Couldn’t load activity.{" "}
          <button
            type="button"
            className="text-primary-text hover:underline"
            onClick={() => void pages.refetch()}
          >
            Try again
          </button>
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <div className="mt-4">
          {groupByDay(entries).map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h2 className="mt-6 mb-3 flex items-center gap-3 text-xs font-semibold text-foreground after:h-px after:flex-1 after:bg-border">
                {group.label}
              </h2>
              <ul>
                {group.items.map((entry, index) => (
                  <ActivityItem
                    key={entry.id}
                    entry={entry}
                    last={index === group.items.length - 1}
                    hideTime
                    leading={
                      <span className="w-16 shrink-0 pr-1 text-right text-xs leading-5 text-muted-foreground/70 tabular-nums">
                        {clockTime(entry.at)}
                      </span>
                    }
                    spaceName={
                      entry.spaceId && !search.spaceId
                        ? names.get(entry.spaceId)
                        : undefined
                    }
                  />
                ))}
              </ul>
            </section>
          ))}
          {pages.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="mt-6"
              disabled={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              {pages.isFetchingNextPage ? "Loading…" : "Show older"}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

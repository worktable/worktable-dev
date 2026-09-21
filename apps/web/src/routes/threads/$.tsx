import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import type { ThreadLocation } from "@worktable/types"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { ThreadsView } from "@/components/threads/threads-view"
import { useSpaces } from "@/lib/queries"
import { threadScopeContains, type ThreadListScope } from "@/lib/threads-api"
import { threadsQueryOptions } from "@/lib/threads-queries"
import { useWorktableThreadSubscription } from "@/lib/ws"

interface ThreadsSearch {
  location: "all" | "worktable" | "space"
  spaceId?: string
}

export const Route = createFileRoute("/threads/$")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): ThreadsSearch => {
    const location =
      search.location === "worktable" || search.location === "space"
        ? search.location
        : "all"
    const spaceId =
      location === "space" && typeof search.spaceId === "string"
        ? search.spaceId
        : undefined
    return {
      location: spaceId ? location : location === "space" ? "all" : location,
      spaceId,
    }
  },
  beforeLoad: ({ context, search }) => {
    const scope = searchToScope(search)
    void context.queryClient.prefetchQuery(threadsQueryOptions(scope))
  },
  component: GlobalThreadsPage,
})

function searchToScope(search: ThreadsSearch): ThreadListScope {
  if (search.location === "worktable") return { kind: "worktable" }
  if (search.location === "space" && search.spaceId) {
    return { kind: "space", spaceId: search.spaceId }
  }
  return { kind: "all" }
}

function parseSelectedThread(splat: string | undefined): {
  location: ThreadLocation
  threadId: string
} {
  const parts = (splat ?? "").split("/").filter(Boolean)
  if (parts[0] === "worktable" && parts.length === 2) {
    return { location: { kind: "worktable" }, threadId: parts[1]! }
  }
  if (parts[0] === "spaces" && parts.length === 3) {
    return {
      location: { kind: "space", spaceId: parts[1]! },
      threadId: parts[2]!,
    }
  }
  return { location: { kind: "worktable" }, threadId: "" }
}

function threadSplat(location: ThreadLocation, threadId: string): string {
  return location.kind === "worktable"
    ? `worktable/${threadId}`
    : `spaces/${location.spaceId}/${threadId}`
}

function GlobalThreadsPage() {
  const { _splat } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const spacesQuery = useSpaces()
  const spaces = spacesQuery.data ?? []
  const activeSpaces = spaces.filter((space) => {
    const archive = space.settings["archive"]
    return (
      !archive ||
      typeof archive !== "object" ||
      typeof (archive as Record<string, unknown>)["archivedAt"] !== "string"
    )
  })
  const scope = searchToScope(search)
  const selected = parseSelectedThread(_splat)
  const scopeKey =
    scope.kind === "space" ? `space:${scope.spaceId}` : scope.kind
  const defaultCreateLocation: ThreadLocation =
    scope.kind === "space" ? scope : { kind: "worktable" }
  const [createLocationOverride, setCreateLocationOverride] = useState<{
    scopeKey: string
    location: ThreadLocation
  } | null>(null)
  const createLocation =
    createLocationOverride?.scopeKey === scopeKey
      ? createLocationOverride.location
      : defaultCreateLocation
  const setCreateLocation = (location: ThreadLocation) =>
    setCreateLocationOverride({ scopeKey, location })
  useWorktableThreadSubscription()

  const spaceNames = new Map(spaces.map((space) => [space.id, space.name]))
  const locationLabel = (location: ThreadLocation) =>
    location.kind === "worktable"
      ? "Worktable"
      : (spaceNames.get(location.spaceId) ?? "Space")

  const setFilter = (value: string) => {
    const next =
      value === "worktable"
        ? { location: "worktable" as const }
        : value.startsWith("space:")
          ? {
              location: "space" as const,
              spaceId: value.slice("space:".length),
            }
          : { location: "all" as const }
    const nextScope = searchToScope(next)
    const keepSelection =
      Boolean(selected.threadId) &&
      threadScopeContains(nextScope, selected.location)
    void navigate({
      to: "/threads/$",
      params: { _splat: keepSelection ? _splat : "" },
      search: next,
    })
  }

  const filterValue =
    scope.kind === "all"
      ? "all"
      : scope.kind === "worktable"
        ? "worktable"
        : `space:${scope.spaceId}`

  return (
    <ThreadsView
      listScope={scope}
      threadId={selected.threadId}
      selectedLocation={selected.location}
      createLocation={createLocation}
      showLocations={scope.kind === "all"}
      locationLabel={locationLabel}
      headerControl={
        <Select
          value={filterValue}
          onValueChange={(value) => {
            if (value) setFilter(value)
          }}
        >
          <SelectTrigger aria-label="Thread location filter" className="w-full">
            <SelectValue>
              {scope.kind === "all"
                ? "All threads"
                : scope.kind === "worktable"
                  ? "Worktable"
                  : (spaceNames.get(scope.spaceId) ?? "Space")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All threads</SelectItem>
            <SelectItem value="worktable">Worktable</SelectItem>
            {activeSpaces.map((space) => (
              <SelectItem key={space.id} value={`space:${space.id}`}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      locationControl={
        <ThreadLocationControl
          spaces={activeSpaces}
          value={createLocation}
          onChange={setCreateLocation}
        />
      }
      onNavigateThread={(location, threadId) => {
        void navigate({
          to: "/threads/$",
          params: { _splat: threadSplat(location, threadId) },
          search,
        })
      }}
      onNavigateNew={() => {
        void navigate({
          to: "/threads/$",
          params: { _splat: "" },
          search,
        })
      }}
    />
  )
}

function ThreadLocationControl({
  spaces,
  value,
  onChange,
}: {
  spaces: Array<{ id: string; name: string }>
  value: ThreadLocation
  onChange: (location: ThreadLocation) => void
}) {
  const selectedValue =
    value.kind === "worktable" ? "worktable" : `space:${value.spaceId}`
  const selectedLabel =
    value.kind === "worktable"
      ? "Worktable"
      : (spaces.find((space) => space.id === value.spaceId)?.name ?? "Space")

  return (
    <Select
      value={selectedValue}
      onValueChange={(nextValue) => {
        if (!nextValue) return
        onChange(
          nextValue === "worktable"
            ? { kind: "worktable" }
            : {
                kind: "space",
                spaceId: nextValue.slice("space:".length),
              }
        )
      }}
    >
      <SelectTrigger
        aria-label="Thread location"
        className="h-8 w-auto max-w-40 shrink-0 rounded-full border-transparent bg-transparent px-2.5 text-xs shadow-none hover:bg-muted max-sm:h-11"
      >
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="worktable">Worktable</SelectItem>
        {spaces.map((space) => (
          <SelectItem key={space.id} value={`space:${space.id}`}>
            {space.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

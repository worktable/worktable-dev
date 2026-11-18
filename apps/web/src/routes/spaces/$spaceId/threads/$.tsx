import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useCallback } from "react"
import type { ThreadLocation } from "@worktable/types"
import { ThreadViewSelect } from "@/components/threads/thread-view-select"
import { ThreadsView } from "@/components/threads/threads-view"
import {
  parseThreadListView,
  type ThreadListView,
} from "@/lib/thread-list-view"
import { preloadThread, threadsQueryOptions } from "@/lib/threads-queries"

interface SpaceThreadsSearch {
  /** Absent for the reader's own threads. */
  view?: Exclude<ThreadListView, "mine">
}

export const Route = createFileRoute("/spaces/$spaceId/threads/$")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): SpaceThreadsSearch => {
    const view = parseThreadListView(search.view)
    return view === "mine" ? {} : { view }
  },
  beforeLoad: ({ context, params, search, preload }) => {
    const location = { kind: "space", spaceId: params.spaceId } as const
    void context.queryClient.prefetchQuery(
      threadsQueryOptions(location, search.view === "archived")
    )
    if (preload && params._splat) {
      preloadThread(context.queryClient, location, params._splat)
    }
  },
  component: SpaceThreadsPage,
})

function SpaceThreadsPage() {
  const { spaceId, _splat } = Route.useParams()
  const search = Route.useSearch()
  const threadId = _splat ?? ""
  const navigate = useNavigate()
  const location = { kind: "space", spaceId } satisfies ThreadLocation
  const setView = (view: ThreadListView) => {
    void navigate({
      to: "/spaces/$spaceId/threads/$",
      params: { spaceId, _splat: threadId },
      search: view === "mine" ? {} : { view },
    })
  }
  const threadLink = useCallback(
    (_: ThreadLocation, nextThreadId: string) => ({
      to: "/spaces/$spaceId/threads/$" as const,
      params: { spaceId, _splat: nextThreadId },
      search,
    }),
    [search, spaceId]
  )

  return (
    <ThreadsView
      listScope={location}
      view={search.view ?? "mine"}
      onViewChange={setView}
      headerControl={
        <ThreadViewSelect
          value={search.view ?? "mine"}
          onChange={setView}
          className="w-full"
        />
      }
      threadId={threadId}
      selectedLocation={location}
      createLocation={location}
      locationLabel={() => "This Space"}
      threadLink={threadLink}
      onNavigateNew={() => {
        void navigate({
          to: "/spaces/$spaceId/threads/$",
          params: { spaceId, _splat: "" },
          search,
        })
      }}
    />
  )
}

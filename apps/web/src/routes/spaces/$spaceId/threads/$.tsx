import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMessageOpenings } from "@/lib/message-openings"
import { useCallback, useMemo } from "react"
import type { ThreadLocation } from "@worktable/types"
import { ThreadViewSelect } from "@/components/threads/thread-view-select"
import { ThreadsView } from "@/components/threads/threads-view"
import { useShownThreadView, useThreadListFilter } from "@/lib/thread-lifetime"
import {
  threadMessageSearch,
  threadViewSearch,
  withoutMessage,
  type ThreadListView,
} from "@/lib/thread-list-view"
import { preloadThread, threadsQueryOptions } from "@/lib/threads-queries"

export const Route = createFileRoute("/spaces/$spaceId/threads/$")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    ...threadViewSearch(search.view),
    ...threadMessageSearch(search.message),
  }),
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
  // The message a search opened the thread at belongs to that thread alone.
  const routeSearch = Route.useSearch()
  const message = routeSearch.message
  // Choosing the same result again leaves the address alone; the count moves.
  const openKey = String(useMessageOpenings())
  const search = useMemo(() => withoutMessage(routeSearch), [routeSearch])
  const threadId = _splat ?? ""
  const navigate = useNavigate()
  const location = { kind: "space", spaceId } satisfies ThreadLocation
  const [filter, rememberFilter] = useThreadListFilter()
  // The list shows the open thread even when the remembered filter doesn't.
  const [view, pickView] = useShownThreadView(
    location,
    threadId,
    search.view ?? filter
  )
  const setView = (next: ThreadListView) => {
    pickView()
    if (next !== "archived") rememberFilter(next)
    if ((next === "archived") === (search.view === "archived")) return
    void navigate({
      to: "/spaces/$spaceId/threads/$",
      params: { spaceId, _splat: threadId },
      search: threadViewSearch(next),
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
      view={view}
      onViewChange={setView}
      headerControl={
        <ThreadViewSelect
          value={view}
          onChange={setView}
          className="w-full"
        />
      }
      threadId={threadId}
      {...(message ? { openAt: message, openKey } : {})}
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

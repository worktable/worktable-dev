import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useCallback } from "react"
import type { ThreadLocation } from "@worktable/types"
import { ThreadsView } from "@/components/threads/threads-view"
import { preloadThread, threadsQueryOptions } from "@/lib/threads-queries"

export const Route = createFileRoute("/spaces/$spaceId/threads/$")({
  ssr: false,
  beforeLoad: ({ context, params, preload }) => {
    const location = { kind: "space", spaceId: params.spaceId } as const
    void context.queryClient.prefetchQuery(threadsQueryOptions(location))
    if (preload && params._splat) {
      preloadThread(context.queryClient, location, params._splat)
    }
  },
  component: SpaceThreadsPage,
})

function SpaceThreadsPage() {
  const { spaceId, _splat } = Route.useParams()
  const threadId = _splat ?? ""
  const navigate = useNavigate()
  const location = { kind: "space", spaceId } satisfies ThreadLocation
  const threadLink = useCallback(
    (_: ThreadLocation, nextThreadId: string) => ({
      to: "/spaces/$spaceId/threads/$" as const,
      params: { spaceId, _splat: nextThreadId },
    }),
    [spaceId]
  )

  return (
    <ThreadsView
      listScope={location}
      threadId={threadId}
      selectedLocation={location}
      createLocation={location}
      locationLabel={() => "This Space"}
      threadLink={threadLink}
      onNavigateNew={() => {
        void navigate({
          to: "/spaces/$spaceId/threads/$",
          params: { spaceId, _splat: "" },
        })
      }}
    />
  )
}

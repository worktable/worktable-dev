import { createFileRoute, useNavigate } from "@tanstack/react-router"
import type { ThreadLocation } from "@worktable/types"
import { ThreadsView } from "@/components/threads/threads-view"
import { threadsQueryOptions } from "@/lib/threads-queries"

export const Route = createFileRoute("/spaces/$spaceId/threads/$")({
  ssr: false,
  beforeLoad: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      threadsQueryOptions({ kind: "space", spaceId: params.spaceId })
    )
  },
  component: SpaceThreadsPage,
})

function SpaceThreadsPage() {
  const { spaceId, _splat } = Route.useParams()
  const threadId = _splat ?? ""
  const navigate = useNavigate()
  const location = { kind: "space", spaceId } satisfies ThreadLocation

  return (
    <ThreadsView
      listScope={location}
      threadId={threadId}
      selectedLocation={location}
      createLocation={location}
      locationLabel={() => "This Space"}
      onNavigateThread={(_, nextThreadId) => {
        void navigate({
          to: "/spaces/$spaceId/threads/$",
          params: { spaceId, _splat: nextThreadId },
        })
      }}
      onNavigateNew={() => {
        void navigate({
          to: "/spaces/$spaceId/threads/$",
          params: { spaceId, _splat: "" },
        })
      }}
    />
  )
}

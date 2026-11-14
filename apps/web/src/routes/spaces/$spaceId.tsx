import type { SpaceView } from "@/lib/api"
import {
  createFileRoute,
  Outlet,
  useChildMatches,
  useRouter,
} from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useState } from "react"
import { Archive, RotateCcw } from "lucide-react"
import { browserTeamMemberId } from "@/lib/team-context"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { restoreSpace } from "@/lib/api"
import { spaceQueryOptions, useSpace, useSpaces } from "@/lib/queries"
import { RelativeTime } from "@/lib/time"
import { useSpaceSubscription } from "@/lib/ws"
import { gettingStartedSpace } from "@/lib/setup"

const isGettingStarted = (space: SpaceView) => gettingStartedSpace([space]) !== null

// Only the Getting Started Space shows this, and it carries agent setup;
// other Spaces and their documents don't load it.
const GettingStartedHome = lazy(() =>
  import("@/components/getting-started/getting-started-home").then((module) => ({
    default: module.GettingStartedHome,
  }))
)

// Space Home's page. A document opens in this layout without it, so it is
// its own chunk, asked for as the navigation starts and not after this
// layout renders.
const loadSpaceOverview = () => import("@/components/spaces/space-overview")
const SpaceOverview = lazy(() =>
  loadSpaceOverview().then((module) => ({ default: module.SpaceOverview }))
)

export const Route = createFileRoute("/spaces/$spaceId")({
  ssr: false,
  // Warm space details without delaying SPA-shell hydration. Overview-only
  // document/collection queries start when the overview actually mounts.
  // Awaiting here makes the first client tree contain live data while the static
  // shell still contains its pending UI, which React correctly rejects.
  beforeLoad: ({ context, params, location }) => {
    void context.queryClient.prefetchQuery(spaceQueryOptions(params.spaceId))
    if (/^\/spaces\/[^/]+\/?$/.test(location.pathname)) void loadSpaceOverview()
  },
  component: SpaceDetailPage,
})

function getSpaceArchiveInfo(settings: Record<string, unknown>) {
  const value = settings["archive"]
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate["archivedAt"] !== "string" ||
    typeof candidate["archivedBy"] !== "string"
  ) {
    return undefined
  }

  return {
    archivedAt: candidate["archivedAt"],
    archivedBy: candidate["archivedBy"],
    reason:
      typeof candidate["reason"] === "string" ? candidate["reason"] : undefined,
  }
}

function ArchivedSpaceBanner({
  archivedAt,
  onRestore,
  restoring,
}: {
  archivedAt: string
  onRestore?: () => void
  restoring: boolean
}) {
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-8">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-foreground">
        <div className="flex items-center gap-2">
          <Archive className="size-4 shrink-0 text-warning" />
          <span>
            This space is archived. Archived <RelativeTime iso={archivedAt} />.
          </span>
        </div>
        {onRestore && (
          <Button size="sm" variant="outline" onClick={onRestore} disabled={restoring}>
            <RotateCcw className="mr-2 size-4" />
            {restoring ? "Restoring..." : "Restore"}
          </Button>
        )}
      </div>
    </div>
  )
}

function SpaceDetailPage() {
  const { spaceId } = Route.useParams()
  const { data, isLoading, isError, refetch } = useSpace(spaceId)
  // The sidebar's Space list already holds the name, description and
  // settings, so the overview renders in place while the details (pins)
  // load, instead of swapping in a differently shaped placeholder.
  const { data: spaces, isLoading: spacesLoading } = useSpaces()
  const space = data?.space ?? spaces?.find((entry) => entry.id === spaceId)
  const router = useRouter()
  const [restoring, setRestoring] = useState(false)
  const reconcileRouteAfterReconnect = useCallback(
    () => router.invalidate(),
    [router]
  )

  useSpaceSubscription(spaceId, {
    reconcileRoute: reconcileRouteAfterReconnect,
  })

  // Decide from the matches being rendered, which arrive together with this
  // Space's params. Matching the location instead reads the previous one
  // until a navigation settles, so opening a document in another Space
  // would first mount that Space's overview.
  const hasChildRoute = useChildMatches({
    select: (matches) => matches.length > 0,
  })

  const archiveInfo = space ? getSpaceArchiveInfo(space.settings) : undefined
  // On a team, restoring a Space follows access management.
  const canRestore =
    !browserTeamMemberId() || space?.permissions?.manage === true

  const handleRestore = async () => {
    setRestoring(true)
    try {
      await restoreSpace(spaceId)
      await router.invalidate()
      toast.success("Space restored")
    } catch (err) {
      console.error("Failed to restore space:", err)
      toast.error("Failed to restore space")
    } finally {
      setRestoring(false)
    }
  }

  if (hasChildRoute) {
    return (
      <>
        {archiveInfo && (
          <ArchivedSpaceBanner
            archivedAt={archiveInfo.archivedAt}
            onRestore={canRestore ? () => void handleRestore() : undefined}
            restoring={restoring}
          />
        )}
        <Outlet />
      </>
    )
  }

  if (!space && !isLoading && !spacesLoading) return null

  return (
    <div className="xl:flex xl:h-full xl:flex-col">
      {archiveInfo && (
        <ArchivedSpaceBanner
          archivedAt={archiveInfo.archivedAt}
          onRestore={canRestore ? () => void handleRestore() : undefined}
          restoring={restoring}
        />
      )}
      {space && isGettingStarted(space) ? (
        <Suspense fallback={null}>
          <GettingStartedHome />
        </Suspense>
      ) : (
        <Suspense fallback={null}>
          <SpaceOverview
            // A folder filter belongs to one Space; start each Space unfiltered.
            key={spaceId}
            spaceId={spaceId}
            space={space}
            spaceName={space?.name}
            pins={data ? (data.pins ?? []) : undefined}
            onRetryPins={isError ? () => void refetch() : undefined}
            canEdit={space?.permissions?.edit !== false}
          />
        </Suspense>
      )}
    </div>
  )
}

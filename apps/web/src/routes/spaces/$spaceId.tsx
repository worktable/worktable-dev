import type { SpaceView } from "@/lib/api"
import {
  createFileRoute,
  Outlet,
  useChildMatches,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useState } from "react"
import { Archive, RotateCcw } from "lucide-react"
import { browserTeamMemberId } from "@/lib/team-context"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { restoreSpace } from "@/lib/api"
import { homeFeedQueryOptions } from "@/lib/home"
import { spaceQueryOptions, useSpace, useSpaces } from "@/lib/queries"
import { RelativeTime } from "@/lib/time"
import { useSpaceSubscription } from "@/lib/ws"
import { gettingStartedSpace } from "@/lib/setup"
import {
  loadSpaceOverview,
  spaceOverviewComponent,
} from "@/components/spaces/space-overview-loader"
import { routeFolder, useListBeside } from "@/lib/list-beside"
// Small, and part of the page frame, so it opens without a load to wait on.
import { FolderList } from "@/components/spaces/folder-list"
import { useFolderColumnFits } from "@/hooks/use-folder-column"

const isGettingStarted = (space: SpaceView) => gettingStartedSpace([space]) !== null

// Only the Getting Started Space shows this, and it carries agent setup;
// other Spaces and their documents don't load it.
const GettingStartedHome = lazy(() =>
  import("@/components/getting-started/getting-started-home").then((module) => ({
    default: module.GettingStartedHome,
  }))
)


export const Route = createFileRoute("/spaces/$spaceId")({
  ssr: false,
  // Warm space details without delaying SPA-shell hydration. For Space Home,
  // also its page's code and its Latest feed, which its content waits for, so
  // a hover has them in before the click; its other document and collection
  // queries start when the overview mounts. Awaiting here makes the first
  // client tree contain live data while the static shell still contains its
  // pending UI, which React correctly rejects.
  beforeLoad: ({ context, params, location }) => {
    void context.queryClient.prefetchQuery(spaceQueryOptions(params.spaceId))
    if (/^\/spaces\/[^/]+\/?$/.test(location.pathname)) {
      void loadSpaceOverview()
      void context.queryClient.prefetchQuery(
        homeFeedQueryOptions({ spaceId: params.spaceId })
      )
    }
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
  // Space Home's page, chosen once so a chunk landing later never remounts it.
  const [SpaceOverview] = useState(spaceOverviewComponent)
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
  // A document or folder page keeps one frame, with or without a folder's
  // list beside it, so opening or closing the list never remounts the page.
  const routeFolderPath = useRouterState({
    select: (state) => routeFolder(state.location.pathname, spaceId),
  })
  const inFolder = routeFolderPath !== null
  const listBeside = useListBeside(spaceId)
  const fits = useFolderColumnFits()
  // The list keeps showing its folder while it slides closed.
  const [shownList, setShownList] = useState(listBeside)
  if (listBeside !== null && listBeside !== shownList) setShownList(listBeside)

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
        {inFolder ? (
          // A row at every width: pages that fill the screen (HTML Docs,
          // drawings, PDFs) take their height from it.
          <div className="flex min-h-full">
            {fits && (
              <div
                // Slides like the main sidebar; overflow-clip keeps the list
                // sticky in the page's scroll while it is clipped.
                className="shrink-0 overflow-clip transition-[width] duration-300 ease-in-out motion-reduce:transition-none"
                style={{ width: listBeside !== null ? "18rem" : 0 }}
                inert={listBeside === null}
              >
                {shownList !== null && (
                  <FolderList spaceId={spaceId} folder={shownList} variant="column" />
                )}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <Outlet />
            </div>
          </div>
        ) : (
          <Outlet />
        )}
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

import type { SpaceView } from "@/lib/api"
import { SpaceIcon } from "@/components/spaces/space-icon"
import {
  createFileRoute,
  Link,
  Outlet,
  useChildMatches,
  useRouter,
} from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useMemo, useState } from "react"
import {
  Archive,
  ArrowRight,
  Database,
  Folder,
  Plus,
  RotateCcw,
} from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { browserTeamMemberId } from "@/lib/team-context"
import type {
  DocumentSummary,
  ResolvedStartHerePin,
  WithContentRevision,
} from "@worktable/types"
import { recognitionColor } from "@worktable/types/recognition"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import {
  ArchivingWeek,
  pageColumns,
  pinGrid,
  PinTile,
  PinTilesSkeleton,
  PlaceCard,
  sectionHeading,
  sideColumn,
} from "@/components/home/home-cards"
import { LatestRuns, LatestSkeleton } from "@/components/home/home-latest"
import { PageWithActivity } from "@/components/home/page-with-activity"
import { PendingSection } from "@/components/home/home-sections"
import { useHomeFeed } from "@/lib/home"
import { recognitionChip } from "@/lib/recognition"
import { SpaceNewMenu } from "@/components/spaces/space-new-menu"
import { activityQueryKeys } from "@/lib/activity"
import { restoreSpace } from "@/lib/api"
import { useDocuments } from "@/lib/documents-queries"
import { setPins } from "@/lib/lifetime"
import {
  spaceQueryOptions,
  useRecordCollections,
  useSpace,
  useSpaces,
} from "@/lib/queries"
import { RelativeTime } from "@/lib/time"
import { humanizeSegment } from "@/lib/tree"
import { useSpaceSubscription } from "@/lib/ws"
import { MemberWelcome } from "@/components/getting-started/member-welcome"
import { gettingStartedSpace } from "@/lib/setup"

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
  // Warm space details without delaying SPA-shell hydration. Overview-only
  // document/collection queries start when the overview actually mounts.
  // Awaiting here makes the first client tree contain live data while the static
  // shell still contains its pending UI, which React correctly rejects.
  beforeLoad: ({ context, params }) => {
    void context.queryClient.prefetchQuery(spaceQueryOptions(params.spaceId))
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

/** Top-level folders shown as cards; the rest are chips. */
const FOLDER_CARDS = 4

function SpaceOverview({
  spaceId,
  space,
  spaceName,
  pins,
  onRetryPins,
  canEdit,
}: {
  spaceId: string
  space: SpaceView | undefined
  /** Undefined only until the Space list or details arrive. */
  spaceName: string | undefined
  /** Undefined while the Space's details load. */
  pins: WithContentRevision<ResolvedStartHerePin>[] | undefined
  /** Set when the details failed, so the pins show a retry. */
  onRetryPins?: () => void
  canEdit: boolean
}) {
  const [folder, setFolder] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const { data: documentItems } = useDocuments(spaceId)
  const { data: collections } = useRecordCollections(spaceId)
  const feed = useHomeFeed({ spaceId, ...(folder ? { folder } : {}) })

  const documents = (documentItems ?? []).filter(
    (item): item is DocumentSummary => item.kind === "document" && !item.archived
  )
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const document of documents) {
      const [top, ...rest] = document.path.split("/")
      if (top && rest.length > 0) counts.set(top, (counts.get(top) ?? 0) + 1)
    }
    return counts
  }, [documents])
  // The busiest folders of the last two weeks are cards, most recent first;
  // every other folder is a chip.
  const places = (feed.data?.places ?? []).filter((place) =>
    folderCounts.has(place.id)
  )
  const cards = places.slice(0, FOLDER_CARDS)
  const chips = [...folderCounts.keys()]
    .filter((name) => !cards.some((place) => place.id === name))
    .sort((a, b) => a.localeCompare(b))
  const temporary = documents
    .filter((document) => document.lifetime === "temporary")
    .map((document) => ({ spaceId, document }))
  const runs = feed.data?.runs ?? []
  const shownPins = pins ?? []
  // Pins make the side column; Archiving alone sits under the page.
  const hasSide = shownPins.length > 0 || Boolean(onRetryPins)
  // The Space list already says how many pins to expect while they load.
  const savedPins: unknown = space?.settings?.["startHere"]
  const expectedPins = !pins && Array.isArray(savedPins) ? savedPins.length : 0
  const tint = recognitionChip(recognitionColor(space?.settings?.color, spaceId))
  const chooseFolder = (name: string) =>
    setFolder((current) => (current === name ? null : name))

  const unpin = async (path: string) => {
    try {
      await setPins(
        spaceId,
        shownPins
          .filter((pin) => pin.path !== path)
          .map((pin) => ({ path: pin.path, ...(pin.note ? { note: pin.note } : {}) }))
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: spaceQueryOptions(spaceId).queryKey,
          exact: true,
        }),
        queryClient.invalidateQueries({ queryKey: activityQueryKeys.all }),
      ])
    } catch (error) {
      console.error("Failed to unpin:", error)
      toast.error("Couldn’t unpin. Try again.")
    }
  }
  const folderOf = (path: string) =>
    path.includes("/") ? path.slice(0, path.indexOf("/")) : null
  const chip =
    "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[0.8rem] transition-colors"

  return (
    <PageWithActivity
      wide
      spaceId={spaceId}
      className="xl:h-auto xl:min-h-0 xl:flex-1"
    >
      <header className="flex items-start justify-between gap-4">
        {spaceName === undefined ? (
          <div className="h-[2.1rem] w-56 animate-pulse rounded-lg bg-muted sm:h-10" />
        ) : (
          <div className="flex min-w-0 items-center gap-3">
            {space && <SpaceIcon space={space} size="lg" />}
            <h1 className="min-w-0 font-display text-[1.65rem] leading-tight font-semibold tracking-tight text-foreground sm:text-[2rem]">
              {spaceName}
            </h1>
          </div>
        )}
        {canEdit && (
          <SpaceNewMenu
            spaceId={spaceId}
            trigger={
              <Button size="sm" className="shrink-0">
                <Plus className="size-4" />
                New
              </Button>
            }
          />
        )}
      </header>

      <MemberWelcome spaceId={spaceId} />

      <div
        className={cn(
          "flex flex-col gap-9",
          (hasSide || expectedPins > 0) && pageColumns
        )}
      >
        <div className="order-1 flex min-w-0 flex-col gap-9">
          <PendingSection spaceId={spaceId} />
          <section aria-labelledby="recent-heading" className="min-w-0">
          <div className="mb-2.5 flex items-baseline gap-2">
            <h2 id="recent-heading" className={sectionHeading}>
              {folder ? humanizeSegment(folder) : "Latest"}
            </h2>
            {folder && (
              <button
                type="button"
                onClick={() => setFolder(null)}
                className="text-[0.8125rem] text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
            <Link
              to="/activity"
              search={{ spaceId }}
              className="ml-auto inline-flex items-center gap-1 text-[0.8125rem] text-muted-foreground hover:text-foreground"
            >
              Activity
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
          {feed.isPending ? (
            <LatestSkeleton />
          ) : feed.isError && !feed.data ? (
            <p className="text-sm text-muted-foreground">
              Couldn’t load the latest work.{" "}
              <button
                type="button"
                className="text-primary-text hover:underline"
                onClick={() => void feed.refetch()}
              >
                Try again
              </button>
            </p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {folder ? "Nothing here in two weeks." : "Nothing in two weeks."}
            </p>
          ) : (
            <LatestRuns
              runs={runs}
              place={(run) => {
                const name = run.docs[0] ? folderOf(run.docs[0].path) : null
                return name ? (
                  <>
                    <Folder className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">
                      {humanizeSegment(name)}
                    </span>
                  </>
                ) : null
              }}
            />
          )}
          </section>
        </div>

        <aside
          className={cn(
            "order-2 contents",
            (hasSide || expectedPins > 0) && sideColumn
          )}
        >
          {expectedPins > 0 && !onRetryPins && (
            <section aria-hidden className="order-2 min-w-0">
              <h2 className={cn(sectionHeading, "mb-2.5")}>Pinned</h2>
              <PinTilesSkeleton count={expectedPins} />
            </section>
          )}
          {(shownPins.length > 0 || onRetryPins) && (
            <section aria-labelledby="pinned-heading" className="order-2 min-w-0">
              <h2 id="pinned-heading" className={cn(sectionHeading, "mb-2.5")}>
                Pinned
              </h2>
              {!pins && onRetryPins ? (
                <p className="text-sm text-muted-foreground">
                  Couldn’t load pins.{" "}
                  <button
                    type="button"
                    className="text-primary-text hover:underline"
                    onClick={onRetryPins}
                  >
                    Try again
                  </button>
                </p>
              ) : (
                <div className={pinGrid}>
                  {shownPins.map((pin) => {
                    const name = folderOf(pin.path)
                    return (
                      <PinTile
                        key={pin.path}
                        spaceId={spaceId}
                        path={pin.path}
                        title={pin.title ?? pin.path}
                        formatId={pin.format?.id}
                        revision={pin.revision}
                        tint={tint}
                        disabled={
                          pin.status === "active"
                            ? undefined
                            : pin.status === "archived"
                              ? "Archived"
                              : "Missing"
                        }
                        place={
                          name ? (
                            <>
                              <Folder className="size-3.5 shrink-0" />
                              <span className="min-w-0 truncate">
                                {humanizeSegment(name)}
                              </span>
                            </>
                          ) : undefined
                        }
                        onUnpin={canEdit ? () => void unpin(pin.path) : undefined}
                      />
                    )
                  })}
                </div>
              )}
            </section>
          )}
          <div className="order-4 empty:hidden">
            <ArchivingWeek items={temporary} side={hasSide || expectedPins > 0} />
          </div>
        </aside>

        {folderCounts.size > 0 && (
          <section
            aria-labelledby="folders-heading"
            className="order-3 min-w-0 @3xl/page:col-span-2"
          >
            <h2 id="folders-heading" className={cn(sectionHeading, "mb-2.5")}>
              Folders
            </h2>
            {cards.length > 0 && (
              <div className="mb-2.5 grid grid-cols-2 gap-3 @3xl/page:grid-cols-4">
                {cards.map((place) => (
                  <PlaceCard
                    key={place.id}
                    icon={<Folder className="size-4 shrink-0 text-muted-foreground" />}
                    name={humanizeSegment(place.id)}
                    count={folderCounts.get(place.id)}
                    days={place.days}
                    who={place.who}
                    actors={place.actors}
                    lastAt={place.lastAt}
                    onOpen={() => chooseFolder(place.id)}
                  >
                    <button
                      type="button"
                      aria-pressed={folder === place.id}
                      aria-label={humanizeSegment(place.id)}
                      onClick={() => chooseFolder(place.id)}
                      className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground/20"
                    />
                  </PlaceCard>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {chips.map((name) => {
                const active = folder === name
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={active}
                    onClick={() => chooseFolder(name)}
                    className={cn(
                      chip,
                      active
                        ? "border-foreground/20 bg-surface-selected text-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/15 hover:text-foreground"
                    )}
                  >
                    <Folder className="size-3.5" />
                    {humanizeSegment(name)}
                    <span className="text-muted-foreground/60 tabular-nums">
                      {folderCounts.get(name)}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {(collections?.length ?? 0) > 0 && (
          <section
            aria-labelledby="records-heading"
            className="order-3 min-w-0 @3xl/page:col-span-2"
          >
            <h2 id="records-heading" className={cn(sectionHeading, "mb-2.5")}>
              Records
            </h2>
            <div className="flex flex-wrap gap-2">
              {(collections ?? []).map((collection) => (
                <Link
                  key={collection.id}
                  to="/spaces/$spaceId/records/$"
                  params={{ spaceId, _splat: collection.id }}
                  className={cn(
                    chip,
                    "border-border text-muted-foreground hover:border-foreground/15 hover:text-foreground"
                  )}
                >
                  <Database className="size-3.5" />
                  {collection.name}
                  <span className="text-muted-foreground/60 tabular-nums">
                    {collection.count}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </PageWithActivity>
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
      )}
    </div>
  )
}

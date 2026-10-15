import {
  createFileRoute,
  Link,
  Outlet,
  useChildMatches,
  useRouter,
} from "@tanstack/react-router"
import { useCallback, useMemo, useState } from "react"
import { Archive, Database, Folder, Plus, RotateCcw } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { browserTeamMemberId } from "@/lib/team-context"
import type {
  DocumentSummary,
  RecordCollectionSummary,
  ResolvedStartHerePin,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { PageWithActivity } from "@/components/home/page-with-activity"
import {
  PendingSection,
  RecentRows,
  TemporaryGroup,
  type RecentItem,
} from "@/components/home/home-sections"
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

function PinnedSection({
  spaceId,
  pins,
  onRetry,
}: {
  spaceId: string
  /** Undefined while the Space's details load. */
  pins: ResolvedStartHerePin[] | undefined
  /** Set when the details failed, so the pins show a retry, not a placeholder. */
  onRetry?: () => void
}) {
  const { data: spaceDetail } = useSpace(spaceId)
  const queryClient = useQueryClient()
  const unpin = async (path: string) => {
    try {
      await setPins(
        spaceId,
        (pins ?? [])
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

  return (
    <section aria-labelledby="pinned-heading">
      <h2 id="pinned-heading" className="mb-2 text-sm font-semibold text-foreground">
        Pinned
      </h2>
      {!pins && onRetry ? (
        <p className="text-sm text-muted-foreground">
          Couldn’t load pins.{" "}
          <button
            type="button"
            className="text-primary-text hover:underline"
            onClick={onRetry}
          >
            Try again
          </button>
        </p>
      ) : !pins ? (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          <div className="h-[3.375rem] animate-pulse rounded-xl bg-muted" />
        </div>
      ) : pins.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Pin the brief or current plan from its menu.
        </p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {pins.map((pin) => (
            <div
              key={pin.path}
              className="card-surface card-surface-interactive group relative rounded-xl px-4 py-3.5"
            >
              {pin.status === "active" && (
                <Link
                  to="/spaces/$spaceId/documents/$"
                  params={{ spaceId, _splat: pin.path }}
                  className="absolute inset-0 rounded-xl"
                  aria-label={pin.title ?? pin.path}
                />
              )}
              <div className="flex min-w-0 items-center gap-2">
                <DocumentFormatIcon
                  formatId={pin.format?.id}
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {pin.title ?? pin.path}
                </span>
                {pin.status !== "active" && (
                  <span className="shrink-0 rounded-full bg-surface-tint px-2 py-0.5 text-xs text-muted-foreground">
                    {pin.status === "archived" ? "Archived" : "Missing"}
                  </span>
                )}
                {spaceDetail?.space.permissions?.edit !== false && <Button
                  size="xs"
                  variant="ghost"
                  className="relative -my-1 -mr-2 shrink-0 text-muted-foreground opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                  onClick={() => void unpin(pin.path)}
                >
                  Unpin
                </Button>}
              </div>
              {pin.note && (
                <p className="mt-1.5 text-[0.8rem] leading-5 text-muted-foreground">
                  {pin.note}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Top-level folders and record collections, as quick ways into the Space. */
function ContentChips({
  spaceId,
  folders,
  collections,
  folder,
  onFolder,
}: {
  spaceId: string
  folders: { name: string; count: number }[]
  collections: RecordCollectionSummary[]
  folder: string | null
  onFolder: (folder: string | null) => void
}) {
  if (folders.length === 0 && collections.length === 0) return null
  const chip =
    "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[0.8rem] transition-colors"
  return (
    <div className="flex flex-wrap gap-2">
      {folders.map((entry) => {
        const active = folder === entry.name
        return (
          <button
            key={entry.name}
            type="button"
            aria-pressed={active}
            onClick={() => onFolder(active ? null : entry.name)}
            className={cn(
              chip,
              active
                ? "border-foreground/20 bg-surface-selected text-foreground"
                : "border-border text-muted-foreground hover:border-foreground/15 hover:text-foreground"
            )}
          >
            <Folder className="size-3.5" />
            {humanizeSegment(entry.name)}
          </button>
        )
      })}
      {collections.map((collection) => (
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
          <span className="text-muted-foreground/60">{collection.count}</span>
        </Link>
      ))}
    </div>
  )
}

const RECENT_ROWS = 8

function SpaceOverview({
  spaceId,
  spaceName,
  spaceDescription,
  pins,
  onRetryPins,
}: {
  spaceId: string
  /** Undefined only until the Space list or details arrive. */
  spaceName: string | undefined
  spaceDescription?: string
  pins: ResolvedStartHerePin[] | undefined
  onRetryPins?: () => void
}) {
  const [folder, setFolder] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const { data: documentItems, isPending: documentsPending } = useDocuments(spaceId)
  const { data: collections } = useRecordCollections(spaceId)

  const documents = (documentItems ?? []).filter(
    (item): item is DocumentSummary => item.kind === "document" && !item.archived
  )
  const folders = useMemo(() => {
    const counts = new Map<string, number>()
    for (const document of documents) {
      const [top, ...rest] = document.path.split("/")
      if (top && rest.length > 0) counts.set(top, (counts.get(top) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [documents])

  const byUpdated = (a: DocumentSummary, b: DocumentSummary) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  // Built from the Space's own listing, so an archived Space still shows its docs.
  const listed: RecentItem[] = documents
    .filter(
      (document) =>
        document.lifetime !== "temporary" &&
        (!folder || document.path.startsWith(`${folder}/`))
    )
    .sort(byUpdated)
    .map((document) => ({ spaceId, document }))
  const temporary: RecentItem[] = documents
    .filter(
      (document) =>
        document.lifetime === "temporary" &&
        (!folder || document.path.startsWith(`${folder}/`))
    )
    .map((document) => ({ spaceId, document }))
  const visible = showAll ? listed : listed.slice(0, RECENT_ROWS)
  const loading = documentsPending

  return (
    <PageWithActivity spaceId={spaceId} className="xl:h-auto xl:min-h-0 xl:flex-1">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {spaceName === undefined ? (
              <div className="h-[2.1rem] w-56 animate-pulse rounded-lg bg-muted sm:h-10" />
            ) : (
              <h1 className="font-display text-[1.65rem] leading-tight font-semibold tracking-tight text-foreground sm:text-[2rem]">
                {spaceName}
              </h1>
            )}
            {spaceDescription && (
              <p className="mt-2 max-w-2xl text-[0.95rem] leading-6 text-muted-foreground">
                {spaceDescription}
              </p>
            )}
          </div>
          <SpaceNewMenu
            spaceId={spaceId}
            trigger={
              <Button variant="outline" size="sm" className="shrink-0">
                <Plus className="size-4" />
                New
              </Button>
            }
          />
        </header>

        <PendingSection spaceId={spaceId} />

        <PinnedSection spaceId={spaceId} pins={pins} onRetry={onRetryPins} />

        <section aria-labelledby="recent-heading">
          <div className="mb-2 flex items-center gap-2">
            <h2 id="recent-heading" className="text-sm font-semibold text-foreground">
              {folder ? humanizeSegment(folder) : "Recent"}
            </h2>
            {folder && (
              <button
                type="button"
                onClick={() => setFolder(null)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
          {loading ? (
            <div className="space-y-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : listed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {folder ? "No docs here." : "No docs yet."}
            </p>
          ) : (
            <>
              <RecentRows items={visible} />
              {!showAll && listed.length > RECENT_ROWS && (
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
        <TemporaryGroup items={temporary} />

        <ContentChips
          spaceId={spaceId}
          folders={folders}
          collections={collections ?? []}
          folder={folder}
          onFolder={(next) => {
            setFolder(next)
            setShowAll(false)
          }}
        />
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
      <SpaceOverview
        // A folder filter belongs to one Space; start each Space unfiltered.
        key={spaceId}
        spaceId={spaceId}
        spaceName={space?.name}
        spaceDescription={space?.description}
        pins={data ? (data.pins ?? []) : undefined}
        onRetryPins={isError ? () => void refetch() : undefined}
      />
    </div>
  )
}

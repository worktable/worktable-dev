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
import { Archive, ArrowLeft, Folder, Plus, RotateCcw } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { browserTeamMemberId } from "@/lib/team-context"
import type { ResolvedStartHerePin } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import {
  ArchivingSoonSection,
  FolderSection,
  LatestWorkSection,
  YourTurnSection,
} from "@/components/home/home-sections"
import { SpaceNewMenu } from "@/components/spaces/space-new-menu"
import { activityQueryKeys } from "@/lib/activity"
import { restoreSpace } from "@/lib/api"
import { useDocuments } from "@/lib/documents-queries"
import { setPins } from "@/lib/lifetime"
import { spaceQueryOptions, useSpace, useSpaces } from "@/lib/queries"
import { RelativeTime } from "@/lib/time"
import { shortWhen } from "@/lib/activity-format"
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
  // ?folder=F lists every doc in that top-level folder.
  validateSearch: (search: Record<string, unknown>): { folder?: string } =>
    typeof search["folder"] === "string" && search["folder"]
      ? { folder: search["folder"] }
      : {},
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

  // Pins are kept by the people who manage the Space, from a doc's menu.
  const canPin = spaceDetail?.space.permissions?.manage !== false
  if (pins?.length === 0) return null

  return (
    <section aria-labelledby="pinned-heading">
      <h2 id="pinned-heading" className="mb-2 px-0.5 text-sm font-semibold text-foreground">
        Pinned
      </h2>
      {!pins && onRetry ? (
        <p className="px-0.5 text-sm text-muted-foreground">
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
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="h-[2.625rem] animate-pulse rounded-xl bg-muted" />
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          {pins.map((pin) => (
            <div
              key={pin.path}
              className="card-surface card-surface-interactive group relative min-w-0 rounded-xl px-3 py-2.5"
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
                  name={pin.path}
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
                {canPin && <Button
                  size="xs"
                  variant="ghost"
                  className="absolute top-1/2 right-2 -translate-y-1/2 bg-card text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-sm:hidden"
                  onClick={() => void unpin(pin.path)}
                >
                  Unpin
                </Button>}
              </div>
              {pin.note && (
                <p className="mt-0.5 truncate pl-6 text-[0.8rem] text-muted-foreground">
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

interface FolderSummary {
  name: string
  /** Its docs, temporary ones included, as its own list shows them. */
  count: number
  /** Its most recently changed doc. */
  latest?: { title: string; at: string }
}

// Where work is happening at a glance; the rest are a click away.
const FOLDERS_SHOWN = 6

/** Top-level folders, busiest first, each opening its own list. */
function FoldersSection({
  spaceId,
  folders,
  status,
  onRetry,
}: {
  spaceId: string
  folders: FolderSummary[]
  status: "pending" | "error" | "success"
  onRetry: () => void
}) {
  const [all, setAll] = useState(false)
  if (status === "error") {
    return (
      <section aria-labelledby="folders-heading">
        <h2 id="folders-heading" className="mb-2 px-0.5 text-sm font-semibold text-foreground">
          Folders
        </h2>
        <p className="px-0.5 text-sm text-muted-foreground">
          Couldn’t load folders.{" "}
          <button type="button" className="text-primary-text hover:underline" onClick={onRetry}>
            Try again
          </button>
        </p>
      </section>
    )
  }
  // Folders come last, so loading them shifts nothing; until then, nothing.
  if (folders.length === 0) return null
  const shown = all ? folders : folders.slice(0, FOLDERS_SHOWN)
  return (
    <section aria-labelledby="folders-heading">
      <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
        <h2 id="folders-heading" className="text-sm font-semibold text-foreground">
          Folders
        </h2>
        {folders.length > FOLDERS_SHOWN && (
          <button
            type="button"
            className="text-[0.8rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setAll(!all)}
          >
            {all ? "Show Less" : `All ${folders.length}`}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map((entry) => (
          <Link
            key={entry.name}
            to="/spaces/$spaceId"
            params={{ spaceId }}
            search={{ folder: entry.name }}
            className="card-surface card-surface-interactive min-w-0 rounded-xl px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{humanizeSegment(entry.name)}</span>
              {entry.latest && (
                <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                  {shortWhen(entry.latest.at)}
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate pl-6 text-[0.8rem] text-muted-foreground">
              {entry.count} {entry.count === 1 ? "doc" : "docs"}
              {entry.latest && ` · ${entry.latest.title}`}
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}

/** One folder's docs, under the Space they belong to. */
function FolderView({
  spaceId,
  spaceName,
  folder,
}: {
  spaceId: string
  spaceName: string | undefined
  folder: string
}) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-8 lg:py-10">
      <header className="px-0.5">
        <Link
          to="/spaces/$spaceId"
          params={{ spaceId }}
          search={{}}
          className="inline-flex items-center gap-1 text-[0.8rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {spaceName ?? "Space Home"}
        </Link>
        <h1 className="mt-2 flex min-w-0 items-center gap-3 font-display text-[1.65rem] leading-tight font-semibold tracking-tight text-foreground sm:text-[2rem]">
          <Folder className="size-6 shrink-0 text-muted-foreground" />
          <span className="truncate">{humanizeSegment(folder)}</span>
        </h1>
      </header>
      <FolderSection spaceId={spaceId} folder={folder} />
    </div>
  )
}

function SpaceOverview({
  spaceId,
  space,
  spaceName,
  spaceDescription,
  pins,
  onRetryPins,
  canEdit,
}: {
  spaceId: string
  space: SpaceView | undefined
  /** Undefined only until the Space list or details arrive. */
  spaceName: string | undefined
  spaceDescription?: string
  pins: ResolvedStartHerePin[] | undefined
  onRetryPins?: () => void
  canEdit: boolean
}) {
  const {
    data: documentItems,
    status: documentsStatus,
    refetch: refetchDocuments,
  } = useDocuments(spaceId)

  const folders = useMemo(() => {
    const byName = new Map<string, FolderSummary>()
    for (const item of documentItems ?? []) {
      if (item.kind !== "document" || item.archived) continue
      const [top, ...rest] = item.path.split("/")
      if (!top || rest.length === 0) continue
      const entry = byName.get(top) ?? { name: top, count: 0 }
      entry.count += 1
      if (item.updatedAt && (!entry.latest || item.updatedAt > entry.latest.at)) {
        entry.latest = { title: item.title, at: item.updatedAt }
      }
      byName.set(top, entry)
    }
    return [...byName.values()].sort(
      (a, b) =>
        (b.latest?.at ?? "").localeCompare(a.latest?.at ?? "") ||
        a.name.localeCompare(b.name)
    )
  }, [documentItems])

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-8 lg:py-10">
      <header className="flex items-start justify-between gap-4 px-0.5">
        <div className="min-w-0">
          {spaceName === undefined ? (
            <div className="h-[2.1rem] w-56 animate-pulse rounded-lg bg-muted sm:h-10" />
          ) : (
            <div className="flex items-center gap-3">
              {space && <SpaceIcon space={space} size="lg" />}
              <h1 className="min-w-0 font-display text-[1.65rem] leading-tight font-semibold tracking-tight text-foreground sm:text-[2rem]">
                {spaceName}
              </h1>
            </div>
          )}
          {spaceDescription && (
            <p className="mt-2 line-clamp-2 max-w-2xl text-[0.95rem] leading-6 text-muted-foreground">
              {spaceDescription}
            </p>
          )}
        </div>
        {canEdit && (
          <SpaceNewMenu
            spaceId={spaceId}
            trigger={
              <Button variant="outline" size="sm" className="shrink-0">
                <Plus className="size-4" />
                New
              </Button>
            }
          />
        )}
      </header>

      <MemberWelcome spaceId={spaceId} />

      <YourTurnSection spaceId={spaceId} />

      <PinnedSection spaceId={spaceId} pins={pins} onRetry={onRetryPins} />

      <LatestWorkSection spaceId={spaceId} />

      <ArchivingSoonSection spaceId={spaceId} />

      <FoldersSection
        spaceId={spaceId}
        folders={folders}
        status={documentsStatus}
        onRetry={() => void refetchDocuments()}
      />
    </div>
  )
}

function SpaceDetailPage() {
  const { spaceId } = Route.useParams()
  const { folder } = Route.useSearch()
  const { data, isLoading, isError, refetch } = useSpace(spaceId)
  // The sidebar's Space list already holds the name, description and
  // settings, so the overview renders in place while the details (pins)
  // load, instead of swapping in a differently shaped placeholder.
  const {
    data: spaces,
    isLoading: spacesLoading,
    isError: spacesFailed,
    refetch: refetchSpaces,
  } = useSpaces()
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

  if (!space && !isLoading && !spacesLoading) {
    // A Space that couldn't be read is not a Space that doesn't exist.
    const unreadable = isError || spacesFailed
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-muted-foreground sm:px-8">
        {unreadable ? "Couldn’t load this Space." : "This Space isn’t here."}{" "}
        {unreadable ? (
          <button
            type="button"
            className="text-primary-text hover:underline"
            onClick={() => {
              void refetch()
              void refetchSpaces()
            }}
          >
            Try again
          </button>
        ) : (
          <Link to="/" className="text-primary-text hover:underline">
            Home
          </Link>
        )}
      </div>
    )
  }

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
      ) : folder ? (
        <FolderView spaceId={spaceId} spaceName={space?.name} folder={folder} />
      ) : (
      <SpaceOverview
        key={spaceId}
        spaceId={spaceId}
        space={space}
        spaceName={space?.name}
        spaceDescription={space?.description}
        pins={data ? (data.pins ?? []) : undefined}
        onRetryPins={isError ? () => void refetch() : undefined}
        canEdit={space?.permissions?.edit !== false}
      />
      )}
    </div>
  )
}

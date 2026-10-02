import {
  createFileRoute,
  Link,
  Outlet,
  useMatchRoute,
  useRouter,
} from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import type { ReactNode } from "react"
import {
  AppWindow,
  Archive,
  Database,
  FileText,
  Layers,
  MessageCircle,
  RotateCcw,
} from "lucide-react"
import { useRecordCollections, useRecords, useSpace, spaceQueryOptions } from "@/lib/queries"
import { useDocuments } from "@/lib/documents-queries"
import { formatArchiveDate, setStartHere } from "@/lib/lifetime"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { useQueryClient } from "@tanstack/react-query"
import { useSpaceAttention } from "@/lib/annotations-queries"
import type { AttentionSignal } from "@/lib/annotations-queries"
import { useSpaceSubscription } from "@/lib/ws"
import { recordTitle } from "@/lib/records"
import { RelativeTime } from "@/lib/time"
import { resolveIcon } from "@/lib/icons"
import { Button } from "@worktable/ui/components/button"
import { restoreSpace } from "@/lib/api"
import { toast } from "@worktable/ui/components/sonner"
import type {
  DocumentSummary,
  RecordCollectionSummary,
  ResolvedStartHerePin,
} from "@worktable/types"
import { useThreads } from "@/lib/threads-queries"

/** Wraps an attention chip in a deep link to its newest target. Widget-target
 *  signals link to the HTML doc route; doc/block targets to the doc route.
 *  Widget wins when both are set (the newest annotation carries one target). */
function attentionLink(
  spaceId: string,
  signal: AttentionSignal,
  key: string,
  chip: ReactNode
): ReactNode {
  if (signal.newestWidgetId) {
    return (
      <Link key={key} to="/spaces/$spaceId/documents/$" params={{ spaceId, _splat: signal.newestWidgetId }} className="transition-opacity hover:opacity-80">
        {chip}
      </Link>
    )
  }
  if (signal.newestDocPath) {
    return (
      <Link key={key} to="/spaces/$spaceId/documents/$" params={{ spaceId, _splat: signal.newestDocPath }} className="transition-opacity hover:opacity-80">
        {chip}
      </Link>
    )
  }
  return chip
}

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
  onRestore: () => void
  restoring: boolean
}) {
  return (
    <div className="mx-auto mb-6 max-w-4xl px-4 pt-6 sm:px-6">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200/70 bg-amber-50/80 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
        <div className="flex items-center gap-2">
          <Archive className="size-4 shrink-0" />
          <span>
            This space is archived and hidden from the main spaces list by
            default. Archived <RelativeTime iso={archivedAt} />.
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onRestore}
          disabled={restoring}
        >
          <RotateCcw className="mr-2 size-4" />
          {restoring ? "Restoring..." : "Restore"}
        </Button>
      </div>
    </div>
  )
}

function SpaceOverview({
  spaceId,
  spaceName,
  spaceDescription,
  spaceIcon,
  documents,
  startHere,
  recordCollections,
}: {
  spaceId: string
  spaceName: string
  spaceDescription?: string
  spaceIcon?: string
  documents: DocumentSummary[]
  startHere: ResolvedStartHerePin[]
  recordCollections: RecordCollectionSummary[]
}) {
  const active = documents.filter((document) => !document.archived)
  const docsCount = active.filter((document) => document.format.id !== "worktable.html").length
  const widgetsCount = active.length - docsCount
  const recordCount = recordCollections.reduce((sum, collection) => sum + collection.count, 0)
  const { data: threadsData } = useThreads({ kind: "space", spaceId })
  const threads = threadsData?.threads ?? []
  const threadCount = threads.length
  const byUpdated = (a: DocumentSummary, b: DocumentSummary) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  const recent = active
    .filter((document) => document.lifetime !== "temporary")
    .sort(byUpdated)
    .slice(0, 8)
  const temporary = active
    .filter((document) => document.lifetime === "temporary")
    .sort((a, b) => (a.archiveOn ?? "").localeCompare(b.archiveOn ?? ""))

  // Open instructions are real requests, counted server-side (an exact
  // filtered total, immune to pagination).
  const { data: attention } = useSpaceAttention(spaceId)
  const instructions = attention?.instructions ?? { count: 0, newestDocPath: null, newestWidgetId: null }

  return (
    <main className="mx-auto flex min-h-full max-w-5xl flex-col px-4 py-8 sm:px-6 lg:py-10">
      <header className="mb-10 grid gap-6 border-b border-border/70 pb-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
            {resolveIcon(spaceIcon, "size-4")}
            <span>Space</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {spaceName}
          </h1>
          {spaceDescription && (
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              {spaceDescription}
            </p>
          )}
        </div>

        <dl className="grid w-full grid-cols-2 overflow-hidden rounded-2xl border border-border/70 bg-muted/20 sm:grid-cols-4 lg:w-[27rem]">
          <div className="border-r border-border/70 p-4">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileText className="size-3.5" />
              Docs
            </dt>
            <dd className="mt-1 text-2xl font-semibold text-foreground">{docsCount}</dd>
          </div>
          <div className="border-r border-border/70 p-4">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <AppWindow className="size-3.5" />
              HTML docs
            </dt>
            <dd className="mt-1 text-2xl font-semibold text-foreground">{widgetsCount}</dd>
          </div>
          <div className="border-r border-border/70 p-4">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database className="size-3.5" />
              Records
            </dt>
            <dd className="mt-1 text-2xl font-semibold text-foreground">{recordCount}</dd>
          </div>
          <Link
            to="/spaces/$spaceId/threads/$"
            params={{ spaceId, _splat: "" }}
            className="p-4 transition-colors hover:bg-muted/50"
          >
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MessageCircle className="size-3.5" />
              Threads
            </dt>
            <dd className="mt-1 text-2xl font-semibold text-foreground">{threadCount}</dd>
          </Link>
        </dl>
      </header>

      {instructions.count > 0 && (
        <div className="-mt-4 mb-8 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground/70">Needs attention</span>
          {attentionLink(
            spaceId,
            instructions,
            "instructions",
            <span className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-[color:var(--accent-bronze-ink)]">
              {instructions.count} {instructions.count === 1 ? "instruction" : "instructions"}
            </span>
          )}
        </div>
      )}

      {docsCount === 0 && widgetsCount === 0 && recordCount === 0 && threadCount === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-24 text-center">
          <div className="mb-5 flex size-14 items-center justify-center rounded-3xl bg-muted/40">
            <Layers className="size-7 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium text-foreground">Empty space</h2>
          <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
            Start with a doc for durable context, then add HTML docs when an agent has something visual or interactive to show.
          </p>
        </div>
      ) : (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <section className="min-w-0 space-y-10">
            <StartHereSection spaceId={spaceId} pins={startHere} />
            <OverviewDocuments
              spaceId={spaceId}
              title="Recent"
              documents={recent}
              empty="No documents yet."
            />
            {temporary.length > 0 && (
              <OverviewDocuments
                spaceId={spaceId}
                title="Temporary"
                description="Supporting work that archives on its date unless kept."
                documents={temporary}
                showArchiveDate
              />
            )}
          </section>

          <aside className="min-w-0 lg:sticky lg:top-6">
            <div className="mb-8">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Threads
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground/75">
                    Durable conversations with connected agents.
                  </p>
                </div>
                <Link
                  to="/spaces/$spaceId/threads/$"
                  params={{ spaceId, _splat: "" }}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Open
                </Link>
              </div>
              {threads.length > 0 ? (
                <div className="mt-4 divide-y divide-border/70 border-y border-border/70">
                  {threads.slice(0, 3).map((thread) => (
                    <Link
                      key={thread.id}
                      to="/spaces/$spaceId/threads/$"
                      params={{ spaceId, _splat: thread.id }}
                      className="group flex min-w-0 items-center gap-2 py-2.5 text-sm transition-colors hover:bg-muted/30"
                    >
                      <MessageCircle className="size-4 shrink-0 text-muted-foreground/70 group-hover:text-foreground" />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {thread.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <RelativeTime iso={thread.updatedAt} />
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="mt-4 rounded-3xl border border-dashed border-border/80 px-5 py-6 text-sm leading-6 text-muted-foreground">
                  No threads yet. Connect an agent, then begin a conversation here.
                </div>
              )}
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Records
              </h2>
              <p className="mt-1 text-sm text-muted-foreground/75">
                File-backed state shared by agents and HTML docs.
              </p>
              {recordCollections.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {recordCollections.slice(0, 6).map((collection) => (
                    <RecordCollectionPreview key={collection.id} spaceId={spaceId} collection={collection} />
                  ))}
                </div>
              ) : (
                <div className="mt-4 rounded-3xl border border-dashed border-border/80 px-5 py-8 text-sm leading-6 text-muted-foreground">
                  No records yet. Create a collection when independently changing items need shared fields or queries across the set.
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </main>
  )
}

function RecordCollectionPreview({ spaceId, collection }: { spaceId: string; collection: RecordCollectionSummary }) {
  const { data } = useRecords(spaceId, collection.id, collection.count > 0)
  const records = data?.records?.slice(0, 3) ?? []

  return (
    <Link
      to="/spaces/$spaceId/records/$"
      params={{ spaceId, _splat: collection.id }}
      className="block rounded-2xl border border-border/70 bg-muted/20 p-4 transition-colors hover:border-primary/30 hover:bg-muted/30"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Database className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-foreground">{collection.name}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{collection.count} records · {collection.id}</div>
        </div>
      </div>
      {records.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {records.map((record) => (
            <div key={record.id} className="truncate rounded-lg bg-background/70 px-2.5 py-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{recordTitle(record, data?.schema)}</span>
            </div>
          ))}
        </div>
      )}
    </Link>
  )
}

function StartHereSection({
  spaceId,
  pins,
}: {
  spaceId: string
  pins: ResolvedStartHerePin[]
}) {
  const queryClient = useQueryClient()
  const unpin = async (path: string) => {
    try {
      await setStartHere(
        spaceId,
        pins
          .filter((pin) => pin.path !== path)
          .map((pin) => ({ path: pin.path, ...(pin.note ? { note: pin.note } : {}) }))
      )
      await queryClient.invalidateQueries({ queryKey: spaceQueryOptions(spaceId).queryKey })
    } catch (error) {
      console.error("Failed to unpin:", error)
      toast.error("Couldn’t unpin. Try again.")
    }
  }

  return (
    <section aria-labelledby="start-here-heading">
      <h2
        id="start-here-heading"
        className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground"
      >
        Start here
      </h2>
      {pins.length > 0 ? (
        <div className="mt-4 divide-y divide-border/70 border-y border-border/70">
          {pins.map((pin) => (
            <div key={pin.path} className="group flex min-w-0 items-start gap-3 px-1 py-3">
              <div className="min-w-0 flex-1">
                {pin.status === "missing" ? (
                  <span className="text-sm font-medium text-muted-foreground">{pin.path}</span>
                ) : (
                  <Link
                    to="/spaces/$spaceId/documents/$"
                    params={{ spaceId, _splat: pin.path }}
                    className="text-sm font-medium text-foreground hover:text-primary"
                  >
                    {pin.title ?? pin.path}
                  </Link>
                )}
                {pin.note && <p className="mt-0.5 text-sm text-muted-foreground">{pin.note}</p>}
              </div>
              {pin.status !== "active" && (
                <span className="shrink-0 rounded-full bg-surface-tint px-2 py-0.5 text-xs text-muted-foreground">
                  {pin.status === "archived" ? "Archived" : "Missing"}
                </span>
              )}
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0 text-muted-foreground opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => void unpin(pin.path)}
              >
                Unpin
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          Pin the documents to read first from their menu.
        </p>
      )}
    </section>
  )
}

function OverviewDocuments({
  spaceId,
  title,
  description,
  documents,
  empty,
  showArchiveDate = false,
}: {
  spaceId: string
  title: string
  description?: string
  documents: DocumentSummary[]
  empty?: string
  showArchiveDate?: boolean
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </h2>
      {description && <p className="mt-1 text-sm text-muted-foreground/75">{description}</p>}
      {documents.length > 0 ? (
        <div className="mt-4 divide-y divide-border/70 border-y border-border/70">
          {documents.map((document) => (
            <Link
              key={document.path}
              to="/spaces/$spaceId/documents/$"
              params={{ spaceId, _splat: document.path }}
              className="group grid min-w-0 gap-1 px-1 py-3 transition-colors hover:bg-muted/30 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <DocumentFormatIcon
                    formatId={document.format.id}
                    className="size-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground"
                  />
                  <span className="truncate text-sm font-medium text-foreground">{document.title}</span>
                </div>
                <div className="mt-1 truncate pl-6 text-xs text-muted-foreground">{document.path}</div>
              </div>
              <div className="pl-6 text-xs text-muted-foreground sm:pl-0">
                {showArchiveDate && document.archiveOn ? (
                  `Archives ${formatArchiveDate(document.archiveOn)}`
                ) : document.updatedAt ? (
                  <RelativeTime iso={document.updatedAt} />
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      ) : empty ? (
        <div className="mt-4 border-y border-border/70 py-8 text-sm text-muted-foreground">{empty}</div>
      ) : null}
    </div>
  )
}

function SpaceDetailPage() {
  const { spaceId } = Route.useParams()
  const { data, isLoading } = useSpace(spaceId)
  const matchRoute = useMatchRoute()
  const router = useRouter()
  const [restoring, setRestoring] = useState(false)
  const [mounted, setMounted] = useState(false)
  const reconcileRouteAfterReconnect = useCallback(
    () => router.invalidate(),
    [router]
  )

  useEffect(() => setMounted(true), [])
  useSpaceSubscription(spaceId, undefined, undefined, {
    reconcileRoute: reconcileRouteAfterReconnect,
  })

  const hasDocRoute = matchRoute({
    to: "/spaces/$spaceId/docs/$",
    fuzzy: true,
  })

  const hasWidgetRoute = matchRoute({
    to: "/spaces/$spaceId/widgets/$",
    fuzzy: true,
  })

  const hasDocumentRoute = matchRoute({
    to: "/spaces/$spaceId/documents/$",
    fuzzy: true,
  })

  const hasRecordsRoute = matchRoute({
    to: "/spaces/$spaceId/records/$",
    fuzzy: true,
  })

  const hasThreadsRoute = matchRoute({
    to: "/spaces/$spaceId/threads/$",
    fuzzy: true,
  })

  const hasChildRoute =
    hasDocumentRoute ||
    hasDocRoute ||
    hasWidgetRoute ||
    hasRecordsRoute ||
    hasThreadsRoute

  const archiveInfo = data
    ? getSpaceArchiveInfo(data.space.settings)
    : undefined

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
            onRestore={() => void handleRestore()}
            restoring={restoring}
          />
        )}
        <Outlet />
      </>
    )
  }

  if (!mounted || isLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="mb-6 space-y-2">
          <div className="h-7 w-48 animate-pulse rounded-lg bg-muted/30" />
          <div className="h-4 w-72 animate-pulse rounded bg-muted/20" />
        </div>
      </div>
    )
  }

  if (!data) return null

  const { space } = data

  return (
    <>
      {archiveInfo && (
        <ArchivedSpaceBanner
          archivedAt={archiveInfo.archivedAt}
          onRestore={() => void handleRestore()}
          restoring={restoring}
        />
      )}
      <SpaceOverviewWithData
        spaceId={spaceId}
        spaceName={space.name}
        spaceDescription={space.description}
        spaceIcon={space.icon}
        startHere={data.startHere ?? []}
      />
    </>
  )
}

function SpaceOverviewWithData(
  props: Omit<Parameters<typeof SpaceOverview>[0], "documents" | "recordCollections">
) {
  const { data: documents } = useDocuments(props.spaceId)
  const { data: recordCollections } = useRecordCollections(props.spaceId)
  return (
    <SpaceOverview
      {...props}
      documents={(documents ?? []).filter(
        (item): item is DocumentSummary => item.kind === "document"
      )}
      recordCollections={recordCollections ?? []}
    />
  )
}

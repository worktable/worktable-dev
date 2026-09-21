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
  Bot,
  Database,
  FileText,
  Layers,
  MessageCircle,
  RotateCcw,
} from "lucide-react"
import { useRecordCollections, useRecords, useSpace, spaceQueryOptions } from "@/lib/queries"
import { useSpaceDocs, spaceDocsQueryOptions } from "@/lib/docs-queries"
import { useSpaceAttention } from "@/lib/annotations-queries"
import type { AttentionSignal } from "@/lib/annotations-queries"
import { useSpaceSubscription } from "@/lib/ws"
import { staleTitle } from "@/lib/doc-freshness"
import { recordTitle } from "@/lib/records"
import { RelativeTime } from "@/lib/time"
import { resolveIcon } from "@/lib/icons"
import { Button } from "@worktable/ui/components/button"
import { restoreSpace } from "@/lib/api"
import { toast } from "@worktable/ui/components/sonner"
import type { DocListEntry, RecordCollectionSummary } from "@worktable/types"
import type { WidgetListEntry } from "@/lib/widgets-api"
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
  // Warm the detail and document caches without delaying SPA-shell hydration.
  // Awaiting here makes the first client tree contain live data while the static
  // shell still contains its pending UI, which React correctly rejects.
  beforeLoad: ({ context, params }) => {
    void context.queryClient.prefetchQuery(spaceQueryOptions(params.spaceId))
    void context.queryClient.prefetchQuery(spaceDocsQueryOptions(params.spaceId))
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
  spaceCreatedBy,
  docs,
  widgets,
  recordCollections,
}: {
  spaceId: string
  spaceName: string
  spaceDescription?: string
  spaceIcon?: string
  spaceCreatedBy?: string
  docs: DocListEntry[]
  widgets: WidgetListEntry[]
  recordCollections: RecordCollectionSummary[]
}) {
  const activeDocs = docs.filter((doc) => !doc.archived)
  const docsCount = activeDocs.length
  const activeWidgets = widgets.filter((widget) => !widget.archive)
  const widgetsCount = activeWidgets.length
  const recordCount = recordCollections.reduce((sum, collection) => sum + collection.count, 0)
  const { data: threadsData } = useThreads({ kind: "space", spaceId })
  const threads = threadsData?.threads ?? []
  const threadCount = threads.length
  const recentDocs = [...activeDocs]
    .sort((a, b) => getDocUpdatedAt(b) - getDocUpdatedAt(a))
    .slice(0, 7)
  const recentWidgets = [...activeWidgets]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 7)

  // Needs-attention signals: ambient counts, never a task queue. Counts are
  // computed server-side (exact filtered totals, immune to pagination);
  // staleness rides on the docs we already have.
  const { data: attention } = useSpaceAttention(spaceId)
  const instructions = attention?.instructions ?? { count: 0, newestDocPath: null, newestWidgetId: null }
  const lintFindings = attention?.lint ?? { count: 0, newestDocPath: null, newestWidgetId: null }
  // Staleness spans both content kinds: docs and HTML docs (widgets) carry the
  // same DocFreshness shape, so the "N stale" count aggregates both.
  const staleDocs = activeDocs.filter((doc) => doc.freshness?.stale)
  const staleWidgets = activeWidgets.filter((widget) => widget.freshness?.stale)
  const staleCount = staleDocs.length + staleWidgets.length

  const docGroups = buildDocGroups(activeDocs)

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
          {spaceCreatedBy && (
            <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground/70">
              <Bot className="size-3.5" />
              <span>Created by {spaceCreatedBy}</span>
            </div>
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

      {(instructions.count > 0 || lintFindings.count > 0 || staleCount > 0) && (
        <div className="-mt-4 mb-8 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground/70">Needs attention</span>
          {instructions.count > 0 && (() => {
            const chip = (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[color:var(--accent-bronze-ink)]">
                <span className="bronze-knob size-1.5 rounded-full" />
                {instructions.count} {instructions.count === 1 ? "instruction" : "instructions"}
              </span>
            )
            return attentionLink(spaceId, instructions, "instructions", chip)
          })()}
          {lintFindings.count > 0 && (() => {
            const chip = (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-muted-foreground">
                {lintFindings.count} lint
              </span>
            )
            return attentionLink(spaceId, lintFindings, "lint", chip)
          })()}
          {staleCount > 0 && (
            <span className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-muted-foreground">
              {staleCount} stale
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
          <section className="min-w-0">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Recent docs
                </h2>
                <p className="mt-1 text-sm text-muted-foreground/75">
                  Working notes and durable context for this space.
                </p>
              </div>
            </div>

            {recentDocs.length > 0 ? (
              <div className="divide-y divide-border/70 border-y border-border/70">
                {recentDocs.map((doc) => (
                  <Link
                    key={doc.path}
                    to="/spaces/$spaceId/documents/$"
                    params={{ spaceId, _splat: doc.path }}
                    className="group grid min-w-0 gap-1 px-1 py-3.5 transition-colors hover:bg-muted/30 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <FileText className="size-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground" />
                        <span className="truncate text-sm font-medium text-foreground">{docTitle(doc)}</span>
                        <StaleMark doc={doc} />
                      </div>
                      <div className="mt-1 truncate pl-6 text-xs text-muted-foreground">{doc.path}</div>
                    </div>
                    <div className="pl-6 text-xs text-muted-foreground sm:pl-0">
                      {getDocUpdatedAt(doc) ? (
                        <RelativeTime
                          iso={new Date(getDocUpdatedAt(doc)).toISOString()}
                        />
                      ) : (
                        doc.format
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="border-y border-border/70 py-10 text-sm text-muted-foreground">
                No docs yet.
              </div>
            )}

            {(docsCount > recentDocs.length || docGroups.length > 1) && (
              <div className="mt-10">
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  All docs
                </h2>
                <p className="mt-1 text-sm text-muted-foreground/75">
                  Generated from the space's files — always current.
                </p>
                <div className="mt-4 space-y-6">
                  {docGroups.map((group) => (
                    <div key={group.folder}>
                      <h3 className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                        {group.label}
                      </h3>
                      <div className="divide-y divide-border/50">
                        {group.docs.map((doc) => (
                          <Link
                            key={doc.path}
                            to="/spaces/$spaceId/documents/$"
                            params={{ spaceId, _splat: doc.path }}
                            className="group flex min-w-0 items-center gap-2 px-1 py-2 text-sm transition-colors hover:bg-muted/30"
                          >
                            <FileText className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
                            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                              {docTitle(doc)}
                            </span>
                            <StaleMark doc={doc} />
                            {(doc.backlinkCount ?? 0) > 0 && (
                              <span
                                className="shrink-0 text-xs text-muted-foreground/60"
                                title={`${doc.backlinkCount} ${doc.backlinkCount === 1 ? "doc links" : "docs link"} here`}
                              >
                                {doc.backlinkCount}&thinsp;↩
                              </span>
                            )}
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
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

            <div className="mb-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                HTML docs
              </h2>
              <p className="mt-1 text-sm text-muted-foreground/75">
                Agent-built working surfaces.
              </p>
            </div>

            {recentWidgets.length > 0 ? (
              <div className="divide-y divide-border/70 border-y border-border/70">
                {recentWidgets.map((widget) => (
                  <Link
                    key={widget.id}
                    to="/spaces/$spaceId/documents/$"
                    params={{ spaceId, _splat: widget.id }}
                    className="group flex min-h-10 min-w-0 items-center gap-2 px-1 py-2.5 text-sm transition-colors hover:bg-muted/30"
                  >
                    <AppWindow className="size-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{widget.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <RelativeTime iso={widget.updatedAt} />
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-border/80 px-5 py-8 text-sm leading-6 text-muted-foreground">
                No HTML docs yet. When an agent creates an interactive surface, it will show up here as the main launch point.
              </div>
            )}

            <div className="mt-8">
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

function getDocUpdatedAt(doc: DocListEntry): number {
  return doc.provenance?.updatedAt ? new Date(doc.provenance.updatedAt).getTime() : 0
}

function humanize(segment: string): string {
  const cleaned = segment.replace(/[-_]+/g, " ").trim()
  return cleaned.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase())
}

function docTitle(doc: DocListEntry): string {
  const heading = doc.headings?.[0]?.trim()
  if (heading) return heading
  return humanize(doc.path.split("/").at(-1) ?? doc.path)
}

/** Mirror of the server's space index grouping: top-level folder, root first. */
function buildDocGroups(docs: DocListEntry[]): Array<{ folder: string; label: string; docs: DocListEntry[] }> {
  const byFolder = new Map<string, DocListEntry[]>()
  for (const doc of docs) {
    const slash = doc.path.indexOf("/")
    const folder = slash === -1 ? "" : doc.path.slice(0, slash)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), doc])
  }
  return [...byFolder.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, groupDocs]) => ({
      folder,
      label: folder === "" ? "Overview" : humanize(folder),
      docs: [...groupDocs].sort((a, b) => a.path.localeCompare(b.path)),
    }))
}

/** Single-word staleness marker; tooltip carries the detail (no hover on mobile, so the word itself is the signal). */
function StaleMark({ doc }: { doc: DocListEntry }) {
  if (!doc.freshness?.stale) return null
  return (
    <span className="shrink-0 text-xs text-muted-foreground/70" title={staleTitle(doc.freshness)}>
      Stale
    </span>
  )
}

function SpaceDetailPage() {
  const { spaceId } = Route.useParams()
  const { data, isLoading } = useSpace(spaceId)
  const { data: docs } = useSpaceDocs(spaceId)
  const { data: recordCollections } = useRecordCollections(spaceId)
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
  const archiveInfo = getSpaceArchiveInfo(space.settings)

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

  return (
    <>
      {archiveInfo && (
        <ArchivedSpaceBanner
          archivedAt={archiveInfo.archivedAt}
          onRestore={() => void handleRestore()}
          restoring={restoring}
        />
      )}
      <SpaceOverview
        spaceId={spaceId}
        spaceName={space.name}
        spaceDescription={space.description}
        spaceIcon={space.icon}
        spaceCreatedBy={space.createdBy}
        docs={docs ?? []}
        widgets={data.widgets ?? []}
        recordCollections={recordCollections ?? []}
      />
    </>
  )
}

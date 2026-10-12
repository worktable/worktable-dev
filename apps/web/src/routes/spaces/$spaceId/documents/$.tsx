import { Suspense, useCallback, useEffect, useState } from "react"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { AlertTriangle, Download, FileQuestion } from "lucide-react"
import type {
  DocumentListItem,
  DocumentPage,
  DocumentPageResult,
} from "@worktable/types"
import { EditorSkeleton } from "@/components/editor/editor-skeleton"
import { useSetPageMeta } from "@/hooks/use-page-meta"
import {
  docQueryOptions,
  docReadCurrent,
  documentOpenStartedAt,
  noteDocumentOpen,
} from "@/lib/docs-queries"
import {
  documentPageQueryOptions,
  documentPageValidatedLive,
  documentQueryKeys,
  documentsQueryOptions,
  useDocumentPage,
} from "@/lib/documents-queries"
import { downloadDocumentSource } from "@/lib/documents-api"
import { browserDocumentRenderer } from "@/lib/document-renderers"
import { toast } from "@worktable/ui/components/sonner"
import { HttpError } from "@/lib/http"

/** Formats the Markdown and rich-text renderer opens. */
const DOC_RENDERED_FORMATS = new Set(["worktable.rich-text", "worktable.markdown"])

/** Whether cached state already says this path opens in the doc renderer. */
function cachedAsDoc(
  queryClient: QueryClient,
  spaceId: string,
  path: string
): boolean {
  const page = queryClient.getQueryData<DocumentPageResult>(
    documentQueryKeys.page(spaceId, path)
  )
  if (page) return page.kind !== "conflict" && page.renderer?.key === "doc"
  const listed = queryClient
    .getQueryData<DocumentListItem[]>(documentQueryKeys.list(spaceId))
    ?.find((item) => item.kind === "document" && item.path === path)
  return listed?.kind === "document" && DOC_RENDERED_FORMATS.has(listed.format.id)
}

/**
 * Start reading the document itself for the renderer, unless the copy this
 * tab holds is still proven current. The renderer validates whatever it uses.
 */
function startDocumentRead(
  queryClient: QueryClient,
  spaceId: string,
  path: string
): void {
  const openedAt = documentOpenStartedAt(spaceId, path) ?? performance.now()
  if (docReadCurrent(spaceId, path, openedAt)) return
  void queryClient.prefetchQuery({
    ...docQueryOptions(spaceId, path),
    staleTime: 0,
    retry: false,
  })
}

export const Route = createFileRoute("/spaces/$spaceId/documents/$")({
  ssr: false,
  beforeLoad: async ({ context, params, preload, cause }) => {
    const path = params._splat ?? ""
    if (path) {
      const queryClient = context.queryClient
      const options = documentPageQueryOptions(params.spaceId, path)
      const opening = !preload && cause === "enter"
      let readStarted = false
      if (opening) {
        noteDocumentOpen(params.spaceId, path)
        // Read the document beside the page check when the cached catalog
        // already says which renderer it needs.
        if (cachedAsDoc(queryClient, params.spaceId, path)) {
          startDocumentRead(queryClient, params.spaceId, path)
          readStarted = true
        }
      }
      try {
        // A cached handle must never authorize mounting an editor after a
        // concurrent move. Reuse the cached page check (a hover preload, say)
        // only while the Space's live socket proves nothing has changed since
        // it was read; otherwise check the exact path before the route renders.
        const page = await queryClient.fetchQuery({
          ...options,
          staleTime: documentPageValidatedLive(params.spaceId, path)
            ? Infinity
            : 0,
          retry: false,
        })
        if (
          opening &&
          !readStarted &&
          page.kind !== "conflict" &&
          page.renderer?.key === "doc" &&
          page.document.path === path
        ) {
          startDocumentRead(queryClient, params.spaceId, path)
        }
        // Fetch renderer code while the app shell is still starting up.
        // This does not mount it or bypass the renderer's fresh path checks.
        if (
          typeof window !== "undefined" &&
          page.kind !== "conflict" &&
          page.renderer
        ) {
          void browserDocumentRenderer(page.renderer)
            ?.preload(page.document.format.id)
            .catch(() => {})
        }
      } catch {
        // fetchQuery preserves prior data on a failed refresh. Remove it so a
        // missing or unreachable path cannot fall through to a stale renderer.
        context.queryClient.removeQueries({
          queryKey: options.queryKey,
          exact: true,
        })
      }
    }
  },
  pendingComponent: EditorSkeleton,
  // Keep the current page and the shell's progress bar while validating the
  // next path. Committing a pending match here also exposes a TanStack 1.167
  // race: concurrent renders can see it after its load promise was cleared.
  // Initial hydration and renderer Suspense still use the shared skeleton.
  pendingMs: Infinity,
  pendingMinMs: 0,
  component: DocumentPageRoute,
})

function DocumentPageRoute() {
  const { spaceId, _splat } = Route.useParams()
  const path = _splat ?? ""
  const pageQuery = useDocumentPage(spaceId, path)
  useRecheckPageAgainstCatalog(spaceId, path, pageQuery.data, pageQuery.dataUpdatedAt)

  if (!path) {
    return <Navigate to="/spaces/$spaceId" params={{ spaceId }} replace />
  }
  if (pageQuery.isLoading) return <EditorSkeleton />
  if (pageQuery.error) {
    const status =
      pageQuery.error instanceof HttpError ? pageQuery.error.status : null
    const serverDetail =
      pageQuery.error instanceof HttpError &&
      typeof pageQuery.error.body === "object" &&
      pageQuery.error.body !== null &&
      typeof (pageQuery.error.body as { error?: unknown }).error === "string"
        ? (pageQuery.error.body as { error: string }).error
        : null
    const notFound = status === 404
    const conflict = status === 409
    return (
      <DocumentState
        icon={conflict ? AlertTriangle : FileQuestion}
        title={
          notFound
            ? "Document not found"
            : conflict
              ? "Document path conflict"
              : "Couldn’t open document"
        }
        detail={
          notFound
            ? "It may have been moved or deleted."
            : conflict
              ? (serverDetail ?? "This document path can’t be resolved.")
              : "Check your connection and try again."
        }
      />
    )
  }
  if (!pageQuery.data) return <EditorSkeleton />

  const page = pageQuery.data
  if (page.kind === "conflict") {
    return (
      <ConflictDocumentPage claimCount={page.conflict.claims.length} />
    )
  }
  if (page.document.path !== path) {
    return (
      <Navigate
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId, _splat: page.document.path }}
        search={(previous) => previous}
        hash={(previous) => previous ?? ""}
        replace
      />
    )
  }

  const renderer = page.renderer ? browserDocumentRenderer(page.renderer) : null
  if (!renderer) {
    return <UnavailableDocumentPage spaceId={spaceId} page={page} />
  }
  const Renderer = renderer.component
  return (
    <Suspense fallback={<EditorSkeleton />}>
      <Renderer
        spaceId={spaceId}
        documentPath={page.document.path}
        formatId={page.document.format.id}
        page={page}
      />
    </Suspense>
  )
}

/**
 * A change the server reports without a path (a move, archive or deletion in
 * the format-neutral store) reaches this page as a newer Space catalog. When
 * the catalog no longer agrees with this page's check, check the path again;
 * otherwise the open document needs nothing.
 */
function useRecheckPageAgainstCatalog(
  spaceId: string,
  path: string,
  page: DocumentPageResult | undefined,
  pageUpdatedAt: number
) {
  const queryClient = useQueryClient()
  // Watch the catalog the breadcrumb already keeps loaded, without reading it.
  const { data: documents, dataUpdatedAt: documentsUpdatedAt } = useQuery({
    ...documentsQueryOptions(spaceId),
    enabled: false,
  })
  useEffect(() => {
    if (!documents || !page || page.kind === "conflict") return
    if (page.document.path !== path || documentsUpdatedAt <= pageUpdatedAt) return
    const listed = documents.find(
      (item) => item.kind === "document" && item.path === path
    )
    const agrees =
      listed?.kind === "document" &&
      !!listed.archived === !!page.document.archived &&
      listed.format.id === page.document.format.id
    if (agrees) return
    void queryClient.invalidateQueries(
      { queryKey: documentQueryKeys.page(spaceId, path), exact: true },
      { cancelRefetch: false }
    )
  }, [documents, documentsUpdatedAt, page, pageUpdatedAt, path, queryClient, spaceId])
}

/** The breadcrumb names the conflicted path from the catalog, like the sidebar. */
function ConflictDocumentPage({ claimCount }: { claimCount: number }) {
  return (
    <DocumentState
      icon={AlertTriangle}
      title="Document conflict"
      detail={`${claimCount} documents use this path. Move or rename one of the source files to open it.`}
    />
  )
}

function unavailableDetail(page: DocumentPage): string {
  if (page.document.health === "unsupported-version") {
    return "This document was created by a newer version of Worktable."
  }
  if (page.document.health === "unsupported-format") {
    return "This document format isn’t supported in this version of Worktable."
  }
  if (
    page.document.health === "invalid" ||
    page.document.health === "temporarily-unavailable"
  ) {
    return "Worktable couldn’t open this document safely."
  }
  return "This document doesn’t have a viewer in this version of Worktable."
}

function UnavailableDocumentPage({
  spaceId,
  page,
}: {
  spaceId: string
  page: DocumentPage
}) {
  const setPageMeta = useSetPageMeta()
  const [downloading, setDownloading] = useState(false)
  const download = useCallback(async () => {
    if (downloading) return
    setDownloading(true)
    try {
      await downloadDocumentSource(spaceId, page.document.path)
    } catch (error) {
      console.error("Document source download failed:", error)
      toast.error("Couldn’t download the source file. Try again.")
    } finally {
      setDownloading(false)
    }
  }, [downloading, page.document.path, spaceId])

  useEffect(() => {
    setPageMeta({
      titleOverride: page.document.title,
      primaryAction: page.capabilities.rawSource
        ? {
            label: "Download source",
            pendingLabel: "Downloading...",
            pending: downloading,
            icon: Download,
            onClick: () => void download(),
          }
        : undefined,
      shareTarget:
        page.capabilities.sharing && page.capabilities.legacyShareKind
          ? {
              kind: page.capabilities.legacyShareKind,
              spaceId,
              artifactKey: page.document.path,
            }
          : undefined,
    })
    return () => setPageMeta(null)
  }, [download, downloading, page, setPageMeta, spaceId])

  return (
    <DocumentState
      icon={FileQuestion}
      title="Preview unavailable"
      detail={
        page.capabilities.rawSource
          ? `${unavailableDetail(page)} Download the source file to open it elsewhere.`
          : unavailableDetail(page)
      }
    />
  )
}

function DocumentState({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof FileQuestion
  title: string
  detail: string
}) {
  return (
    <div data-document-state className="flex h-full items-center justify-center px-6 py-12">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
          <Icon className="size-5" />
        </div>
        <h1 className="text-lg font-medium text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

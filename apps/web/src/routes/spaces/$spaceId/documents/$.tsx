import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { AlertTriangle, Download, FileQuestion } from "lucide-react"
import type { DocumentPage, DocumentPageResult } from "@worktable/types"
import { EditorSkeleton } from "@/components/editor/editor-skeleton"
import { pageShareTarget, useSetPageMeta } from "@/hooks/use-page-meta"
import {
  documentPageQueryOptions,
  documentPageValidated,
  documentPageValidatedLive,
  ensureDocumentOpen,
  forgetDocumentOpen,
  documentQueryKeys,
  documentsQueryOptions,
  noteDocumentOpen,
  prefetchDocumentContent,
  useDocumentPage,
} from "@/lib/documents-queries"
import { downloadDocumentSource } from "@/lib/documents-api"
import {
  browserDocumentRenderer,
  previewDocumentRenderer,
} from "@/lib/document-renderers"
import { documentOpenHint, type DocumentOpenHint } from "@/lib/document-rows"
import { toast } from "@worktable/ui/components/sonner"
import { HttpError } from "@/lib/http"

// A file's page loads only when one opens, so Docs don't carry it.
const FilePage = lazy(() =>
  import("@/components/file-page").then((module) => ({ default: module.FilePage }))
)

/**
 * Start what opening this document reads: its content at the revision the
 * tab knows and its renderer's code. Hints only start reads; what may be
 * edited is decided by the page check.
 */
function startDocumentReads(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  hint: DocumentOpenHint
): void {
  if (hint.renderer === "doc") {
    void prefetchDocumentContent(
      queryClient,
      spaceId,
      path,
      hint.revision
    ).catch(() => {})
  }
  if (typeof window === "undefined") return
  void previewDocumentRenderer(hint.renderer)
    .preload(hint.formatId)
    .catch(() => {})
}

function startDocumentReadsForPage(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  page: DocumentPageResult
): void {
  if (
    page.kind === "conflict" ||
    !page.renderer ||
    page.document.path !== path
  ) {
    return
  }
  if (typeof window !== "undefined") {
    void browserDocumentRenderer(page.renderer)
      ?.preload(page.document.format.id)
      .catch(() => {})
  }
  if (page.renderer.key === "doc" && page.revision) {
    void prefetchDocumentContent(
      queryClient,
      spaceId,
      path,
      page.revision,
      true
    ).catch(() => {})
  }
}

export const Route = createFileRoute("/spaces/$spaceId/documents/$")({
  ssr: false,
  beforeLoad: async ({ context, params, preload, cause }) => {
    const path = params._splat ?? ""
    if (path) {
      const queryClient = context.queryClient
      const spaceId = params.spaceId
      const options = documentPageQueryOptions(spaceId, path)
      const opening = !preload && cause === "enter"
      if (opening) noteDocumentOpen(spaceId, path)
      // A hover, a tap and a click all start reading the content at the
      // revision the tab knows, beside the page check.
      const hint = documentOpenHint(queryClient, spaceId, path)
      if (hint) startDocumentReads(queryClient, spaceId, path, hint)
      // A cached check is reused (a hover preload's, say) only while the
      // Space's live socket proves nothing about this document changed since.
      const checkNow = (proven: boolean) =>
        queryClient.fetchQuery({
          ...options,
          staleTime: proven ? Infinity : 0,
          retry: false,
        })
      let check = checkNow(documentPageValidatedLive(spaceId, path))
      if (opening) {
        // A check already running when the open began (a tap's preload, say)
        // validates it only if the live socket proves it; otherwise check
        // once more after it.
        check = check.then((page) =>
          documentPageValidated(spaceId, path) ? page : checkNow(false)
        )
      }
      if (hint) {
        // Known content opens read-only at once; the check validates it.
        void check
          .then((page) =>
            startDocumentReadsForPage(queryClient, spaceId, path, page)
          )
          .catch(() => {})
        return
      }
      try {
        startDocumentReadsForPage(queryClient, spaceId, path, await check)
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
  const queryClient = useQueryClient()
  const pageQuery = useDocumentPage(spaceId, path)
  useRecheckPageAgainstCatalog(spaceId, path, pageQuery.data, pageQuery.dataUpdatedAt)
  // A check validates this open once its answer arrived after the open
  // began, or the live socket still proves an earlier one. The open began at
  // the navigation, or at the latest when this path first rendered (a
  // navigation can reuse a preload's route work). It then stays validated
  // while the path is open: later changes refresh the check, and the
  // editing room's own admission stays the final word.
  const openKey = `${spaceId}\0${path}`
  // Each open of a path is validated on its own: going A → B → A starts a
  // new open of A, which an earlier visit's check does not validate.
  const [open, setOpen] = useState<{ key: string; validated: boolean }>({
    key: "",
    validated: false,
  })
  if (open.key !== openKey) {
    ensureDocumentOpen(spaceId, path)
    setOpen({ key: openKey, validated: false })
  }
  useEffect(() => {
    // A remount for the same path can follow the previous cleanup.
    ensureDocumentOpen(spaceId, path)
    return () => forgetDocumentOpen(spaceId, path)
  }, [spaceId, path])
  const validatedNow =
    pageQuery.data !== undefined &&
    pageQuery.dataUpdatedAt > 0 &&
    !pageQuery.isError &&
    documentPageValidated(spaceId, path)
  const currentOpen = open.key === openKey
  if (validatedNow && currentOpen && !open.validated) {
    setOpen({ key: openKey, validated: true })
  }
  const validated = validatedNow || (currentOpen && open.validated)
  // No check validates this open yet and none is on its way (a preload's
  // answered before the open began): ask for one.
  const { isFetching: checking, isError: checkFailed, refetch } = pageQuery
  useEffect(() => {
    if (!path || validated || checking || checkFailed) return
    void refetch()
  }, [checkFailed, checking, path, refetch, validated])

  if (!path) {
    return <Navigate to="/spaces/$spaceId" params={{ spaceId }} replace />
  }
  if (pageQuery.error && !pageQuery.isFetching) {
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
  const page = validated ? pageQuery.data : undefined
  if (!page) {
    // Until the check, show what the tab already knows, read-only.
    const hint = documentOpenHint(queryClient, spaceId, path)
    if (!hint) return <EditorSkeleton />
    const Preview = previewDocumentRenderer(hint.renderer).component
    return (
      <Suspense fallback={<EditorSkeleton />}>
        <Preview
          spaceId={spaceId}
          documentPath={path}
          formatId={hint.formatId}
          page={null}
          preview={hint}
        />
      </Suspense>
    )
  }

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

  if (page.document.format.id === "worktable.file") {
    return (
      <Suspense fallback={<EditorSkeleton />}>
        <FilePage spaceId={spaceId} page={page} />
      </Suspense>
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
 * A change the server reports without a path (a move, archive, deletion or
 * write in the format-neutral store) reaches this page as a newer Space
 * catalog. When the catalog no longer agrees with this page's check,
 * including on the content's revision, check the path again; otherwise the
 * open document needs nothing.
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
      listed.format.id === page.document.format.id &&
      (listed.revision === undefined || listed.revision === page.revision)
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
      shareTarget: page.capabilities.legacyShareKind
        ? pageShareTarget(
            {
              kind: page.capabilities.legacyShareKind,
              spaceId,
              artifactKey: page.document.path,
            },
            page.sharing?.activeLinks,
            page.sharing?.canCreate
          )
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
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-surface-tint text-muted-foreground">
          <Icon className="size-5" />
        </div>
        <h1 className="text-lg font-medium text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

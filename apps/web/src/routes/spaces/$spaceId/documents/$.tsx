import { Suspense, useCallback, useEffect, useState } from "react"
import { createFileRoute, Navigate } from "@tanstack/react-router"
import { AlertTriangle, Download, FileQuestion } from "lucide-react"
import type { DocumentPage } from "@worktable/types"
import { EditorSkeleton } from "@/components/editor/editor-skeleton"
import { usePageMeta } from "@/hooks/use-page-meta"
import {
  documentPageQueryOptions,
  useDocumentPage,
} from "@/lib/documents-queries"
import { downloadDocumentSource } from "@/lib/documents-api"
import { browserDocumentRenderer } from "@/lib/document-renderers"
import { toast } from "@worktable/ui/components/sonner"
import { HttpError } from "@/lib/http"

export const Route = createFileRoute("/spaces/$spaceId/documents/$")({
  ssr: false,
  beforeLoad: async ({ context, params }) => {
    const path = params._splat ?? ""
    if (path) {
      const options = documentPageQueryOptions(params.spaceId, path)
      try {
        // A cached handle must never authorize mounting an editor after a
        // concurrent move. Refresh the exact path before the route renders;
        // the normal observer may then reuse this just-established result.
        const page = await context.queryClient.fetchQuery({
          ...options,
          staleTime: 0,
          retry: false,
        })
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
  pendingMs: 0,
  pendingMinMs: 0,
  component: DocumentPageRoute,
})

function DocumentPageRoute() {
  const { spaceId, _splat } = Route.useParams()
  const path = _splat ?? ""
  const pageQuery = useDocumentPage(spaceId, path)

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
      <ConflictDocumentPage
        path={path}
        claimCount={page.conflict.claims.length}
      />
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
      />
    </Suspense>
  )
}

function ConflictDocumentPage({
  path,
  claimCount,
}: {
  path: string
  claimCount: number
}) {
  const { setPageMeta } = usePageMeta()
  useEffect(() => {
    setPageMeta({ titleOverride: path.split("/").at(-1) || path })
    return () => setPageMeta(null)
  }, [path, setPageMeta])
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
  const { setPageMeta } = usePageMeta()
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
    <div className="flex h-full items-center justify-center px-6 py-12">
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

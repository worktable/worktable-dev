import { useVersionSnapshot } from "@/lib/version-history"
import {
  VersionHistoryPanel,
  VersionPreview,
} from "@/components/document/version-history"
import { spaceAccessKey } from "@/lib/team-access"
import {
  AlertTriangle,
  Archive,
  Code,
  ExternalLink,
  History,
  Info,
  Loader2,
  Maximize,
  Minimize,
  Pencil,
  RotateCcw,
  Trash,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { queryKeys, useSpace } from "@/lib/queries"
import { documentQueryKeys } from "@/lib/documents-queries"
import { isSpaceLive } from "@/lib/space-observation"
import type { DocumentRendererProps } from "@/lib/document-renderers"
import type { DocumentOpenHint } from "@/lib/document-rows"
import {
  archiveWidget,
  deleteWidget,
  exportWidgetHtml,
  getWidget,
  patchWidget,
  restoreWidget,
  widgetContentUrl,
  widgetVersionContentUrl,
} from "@/lib/widgets-api"
import { useSpaceEvents } from "@/hooks/use-space-events"
import { copyText } from "@/lib/clipboard"
import {
  pageShareTarget,
  useSetPageMeta,
  type PageAnnotationsAction,
  type PageOverflowAction,
} from "@/hooks/use-page-meta"
import { resolveWidgetApiTarget } from "@/lib/widget-broker"
import { resolveDocumentNavigation } from "@/lib/documents-api"
import { documentHref, documentRoute } from "@/lib/document-views"
import { authenticatedFetch, HttpError, redirectToLogin } from "@/lib/http"
import { EditorSkeleton } from "@/components/editor/editor-skeleton"
import { useTheme } from "@/components/theme-provider"
import { useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "@worktable/ui/components/sonner"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@worktable/ui/components/drawer"
import { Input } from "@worktable/ui/components/input"
import { Textarea } from "@worktable/ui/components/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { AnnotationPanel } from "@/components/annotations/annotation-panel"
import { DesktopContextPanel } from "@/components/desktop-context-panel"
import {
  useWidgetAnnotations,
  useWidgetAnnotationMutations,
} from "@/lib/annotations-queries"
import type {
  Annotation,
  AnnotationCategory,
  DocumentPage,
  DocumentSharingSummary,
  WidgetFile,
} from "@worktable/types"

type WidgetDiagnostic = {
  id: string
  level: "hint" | "info" | "warning" | "error"
  code: string
  message: string
  hint?: string
  timestamp?: string
}

export function HtmlDocumentRenderer({
  spaceId,
  documentPath,
  page,
  preview,
}: DocumentRendererProps) {
  return (
    <WidgetDetailPage
      key={`${spaceId}/${documentPath}`}
      spaceId={spaceId}
      widgetId={documentPath}
      page={page}
      preview={preview ?? null}
    />
  )
}

/** Settles once the route has checked this path, for requests that need it. */
function useValidation(validated: boolean): Promise<void> {
  const [validation] = useState(() => {
    let resolve = () => {}
    const promise = new Promise<void>((settle) => {
      resolve = settle
    })
    return { promise, resolve }
  })
  useEffect(() => {
    if (validated) validation.resolve()
  }, [validated, validation])
  return validation.promise
}

function WidgetDetailPage({
  spaceId,
  widgetId,
  page,
  preview,
}: {
  spaceId: string
  widgetId: string
  /** The route's check; null while the frame opens from a known revision. */
  page: DocumentPage | null
  preview: DocumentOpenHint | null
}) {
  const navigate = useNavigate()
  const readOnly = !page || page.capabilities.edit === false
  const spaceEvents = useSpaceEvents(spaceId)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  // The frame may load from a row's revision before the route's check. Its
  // records, state and navigation requests wait for the check.
  const validated = page !== null
  const validation = useValidation(validated)
  // Collections the widget has subscribed to (via brokered worktable.records.subscribe).
  const subscribedCollections = useRef<Set<string>>(new Set())
  // The Space page already keeps the query cache current from this Space's
  // socket. Listen on the same socket only for what this page does itself:
  // relay record changes to the widget iframe, which can't hold its own socket
  // under exposed CORS, and follow a move or deletion of this document.
  useEffect(() => {
    return spaceEvents.subscribe((message) => {
      if (message.type === "widget_deleted" && message.widgetId === widgetId) {
        void navigate({
          to: "/spaces/$spaceId",
          params: { spaceId },
          replace: true,
        })
      }
      if (
        message.type === "widget_moved" &&
        message.previousWidgetId === widgetId &&
        message.widgetId
      ) {
        void navigate({
          to: "/spaces/$spaceId/documents/$",
          params: { spaceId, _splat: message.widgetId },
          replace: true,
        })
      }
      if (
        message.type === "record_update" ||
        message.type === "record_deleted" ||
        message.type === "record_collection_update"
      ) {
        const win = iframeRef.current?.contentWindow
        if (!win) return
        for (const collection of subscribedCollections.current) {
          if (
            message.collectionId === undefined ||
            message.collectionId === collection
          ) {
            win.postMessage(
              { type: "worktable.records.changed", collection },
              "*"
            )
          }
        }
      }
    })
  }, [navigate, spaceEvents, spaceId, widgetId])
  const { resolvedTheme } = useTheme()
  const queryClient = useQueryClient()
  // Context rails need enough room to preserve the artifact beside them.
  // Below xl, drawers take over for records, annotations, and history alike.
  const [belowXl, setBelowXl] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1279px)")
    const update = () => setBelowXl(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])
  // The route's page check describes this document as it opens, and the
  // Space's socket refreshes it when the document changes (lib/ws.ts).
  const title = page ? page.document.title : (preview?.title ?? "")
  const archived = page
    ? Boolean(page.document.archived)
    : Boolean(preview?.archived)
  const versionsRevision =
    page?.provenance?.versionId ?? page?.document.updatedAt ?? ""
  // Check this path again after a change made here, or when the frame shows
  // the check no longer holds. The route follows a move or a deletion.
  const recheckPage = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: documentQueryKeys.page(spaceId, widgetId),
        exact: true,
      }),
    [queryClient, spaceId, widgetId]
  )
  const contentUrl = `${widgetContentUrl(spaceId, widgetId)}?theme=${resolvedTheme}`
  const newTabUrl = documentHref(spaceId, widgetId)
  // The frame is addressed by its content revision: a new revision (an edit
  // here or outside, a permission change, a new build) loads it again.
  // Snapshot compare frames are immutable and need no revision.
  // Before the check, the frame loads from the row's revision only while the
  // Space's socket is live and would report a move. Without the socket, the
  // frame's own announcement of the document it was served for, after the
  // check, is what catches a move during the open, so it waits for the check.
  const [frameBeforeCheck] = useState(() => isSpaceLive(spaceId))
  const frameRevision = page ? page.revision : preview?.revision
  const frameSrc =
    !page && !frameBeforeCheck
      ? null
      : frameRevision
        ? `${contentUrl}&rev=${encodeURIComponent(frameRevision)}${
            spaceAccessKey(spaceId)
              ? `&a=${encodeURIComponent(spaceAccessKey(spaceId)!)}`
              : ""
          }`
        : `${contentUrl}&v=${encodeURIComponent(
            page?.provenance?.contentHash ?? page?.document.updatedAt ?? ""
          )}`
  const [loadedFrameSrc, setLoadedFrameSrc] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<WidgetDiagnostic[]>([])

  // Version history rail state (mirrors the doc route).
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null)
  const versionQuery = useVersionSnapshot(
    "html",
    spaceId,
    widgetId,
    previewVersionId
  )
  const previewVersion = versionQuery.data

  // Annotations (HTML docs are DOC-LEVEL only — no block anchoring). The query
  // stays enabled so the floating button's open-count badge is always live;
  // live updates arrive via the space subscription above, which invalidates
  // the ["annotations", spaceId] prefix on annotation_update events.
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null
  )
  const [composerOpen, setComposerOpen] = useState(false)
  const annotationsQuery = useWidgetAnnotations(spaceId, widgetId)
  const annotationMutations = useWidgetAnnotationMutations(spaceId, widgetId)
  const annotations = annotationsQuery.data?.annotations ?? []
  const openAnnotationCount = annotations.filter(
    (annotation) => annotation.status !== "resolved"
  ).length

  // Annotations and the version rail compete for the same right-hand space, so
  // opening one closes the other (simplest coexistence — see the task brief).
  const openVersions = useCallback(() => {
    setVersionsOpen(true)
    setAnnotationsOpen(false)
  }, [])

  const toggleAnnotations = useCallback(() => {
    setAnnotationsOpen((open) => {
      if (!open) {
        setVersionsOpen(false)
        setPreviewVersionId(null)
      }
      return !open
    })
  }, [])
  const annotationsAction = useMemo<PageAnnotationsAction>(
    () => ({
      count: openAnnotationCount,
      open: annotationsOpen,
      onToggle: toggleAnnotations,
    }),
    [annotationsOpen, openAnnotationCount, toggleAnnotations]
  )

  const selectAnnotation = useCallback((annotation: Annotation) => {
    setActiveAnnotationId(annotation.id)
    setAnnotationsOpen(true)
    setVersionsOpen(false)
    setPreviewVersionId(null)
  }, [])

  useEffect(() => {
    setDiagnostics([])
  }, [spaceId, widgetId, frameSrc])

  // Reset the version rail and annotations when navigating to a different widget.
  useEffect(() => {
    setVersionsOpen(false)
    setPreviewVersionId(null)
    setAnnotationsOpen(false)
    setActiveAnnotationId(null)
    setComposerOpen(false)
  }, [spaceId, widgetId])

  // Load the selected snapshot for the compare pane header label.

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data as {
        type?: string
        widgetId?: string
        diagnostic?: WidgetDiagnostic
      }
      if (
        data?.type !== "worktable.widget.diagnostic" ||
        data.widgetId !== widgetId ||
        !data.diagnostic
      )
        return
      setDiagnostics((current) => {
        const next = [
          ...current.filter((item) => item.id !== data.diagnostic!.id),
          data.diagnostic!,
        ]
        return next.slice(-20)
      })
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [widgetId])

  // Broker the sandboxed widget's Worktable API calls. The widget posts
  // {type:"worktable.api.request", id, path, method, body}; we fetch same-origin
  // (so the httpOnly session cookie attaches and there's no CORS), restricted to
  // the widget's own /records and /state endpoints, and post the result back.
  useLayoutEffect(() => {
    const iframeElement = iframeRef.current
    // The injected runtime announces a closure-held token, with the document
    // it was served for, before authored code runs. Only that first
    // announcement counts: raw authored postMessages never receive navigation
    // authority.
    let navigationToken: string | null = null
    let navigationGeneration = 0
    let acceptingNavigationHandshake = true
    let observedInitialLoad = false
    let disposed = false
    const handleIframeLoad = () => {
      navigationGeneration += 1
      acceptingNavigationHandshake = false
      // The runtime announces itself before its frame finishes loading. A
      // first load without this document's announcement was served for
      // another path, after a move, or not at all: check this one again.
      if (!observedInitialLoad && navigationToken === null) void recheckPage()
      if (observedInitialLoad) navigationToken = null
      observedInitialLoad = true
    }
    const handleApiRequest = async (event: MessageEvent) => {
      const iframeWindow = iframeRef.current?.contentWindow
      if (event.source !== iframeWindow) return
      const data = event.data as {
        type?: string
        id?: string
        widgetId?: string
        spaceId?: string
        path?: string
        method?: string
        body?: string | null
        collection?: string
        navigationToken?: string
      }
      if (data?.type === "worktable.navigation.handshake") {
        if (!acceptingNavigationHandshake) return
        acceptingNavigationHandshake = false
        if (
          data.spaceId === spaceId &&
          data.widgetId === widgetId &&
          typeof data.navigationToken === "string" &&
          data.navigationToken.length >= 16
        ) {
          navigationToken = data.navigationToken
        }
        return
      }
      if (data?.type === "worktable.document.ready") {
        if (
          navigationToken !== null &&
          data.navigationToken === navigationToken &&
          data.spaceId === spaceId &&
          data.widgetId === widgetId
        ) {
          setLoadedFrameSrc(frameSrc)
        }
        return
      }
      if (data?.type === "worktable.navigation.frame-leaving") {
        if (
          navigationToken !== null &&
          data.navigationToken === navigationToken &&
          data.spaceId === spaceId &&
          data.widgetId === widgetId
        ) {
          navigationToken = null
          acceptingNavigationHandshake = false
          navigationGeneration += 1
        }
        return
      }
      // Track the widget's record subscriptions so the parent's space socket can
      // relay change events back to it (see the space events above).
      if (
        data?.type === "worktable.subscribe" &&
        typeof data.collection === "string"
      ) {
        subscribedCollections.current.add(data.collection)
        return
      }
      if (
        data?.type === "worktable.unsubscribe" &&
        typeof data.collection === "string"
      ) {
        subscribedCollections.current.delete(data.collection)
        return
      }
      if (
        data?.type === "worktable.navigation.open-document" ||
        data?.type === "worktable.api.request"
      ) {
        // Brokered for this path only once the route has checked it.
        await validation
        if (disposed || event.source !== iframeRef.current?.contentWindow) {
          return
        }
      }
      if (data?.type === "worktable.navigation.open-document") {
        if (typeof data.id !== "string") return
        const reply = (payload: {
          ok: boolean
          status: number
          body: unknown
        }) =>
          iframeWindow?.postMessage(
            { type: "worktable.navigation.response", id: data.id, ...payload },
            "*"
          )
        if (
          typeof data.path !== "string" ||
          data.spaceId !== spaceId ||
          data.widgetId !== widgetId ||
          navigationToken === null ||
          data.navigationToken !== navigationToken
        ) {
          reply({
            ok: false,
            status: 400,
            body: {
              error: "Could not open document.",
              code: "INVALID_NAVIGATION_REQUEST",
            },
          })
          return
        }
        const requestGeneration = navigationGeneration
        try {
          const target = await resolveDocumentNavigation(spaceId, data.path)
          if (
            disposed ||
            requestGeneration !== navigationGeneration ||
            event.source !== iframeRef.current?.contentWindow
          )
            return
          reply({ ok: true, status: 200, body: { target } })
          // A self-link is already satisfied. Keeping it in place also prevents
          // an authored on-load request from creating a reload loop.
          if (target.path === widgetId) return
          void navigate(documentRoute(spaceId, target.path))
        } catch (error) {
          if (
            disposed ||
            requestGeneration !== navigationGeneration ||
            event.source !== iframeRef.current?.contentWindow
          )
            return
          const body =
            error instanceof HttpError &&
            error.body &&
            typeof error.body === "object"
              ? (error.body as { error?: unknown; code?: unknown })
              : null
          reply({
            ok: false,
            status: error instanceof HttpError ? error.status : 0,
            body: {
              error:
                typeof body?.error === "string"
                  ? body.error
                  : "Could not open document.",
              code:
                typeof body?.code === "string" ? body.code : "NAVIGATION_ERROR",
            },
          })
        }
        return
      }
      if (
        data?.type !== "worktable.api.request" ||
        typeof data.id !== "string" ||
        typeof data.path !== "string"
      )
        return
      const reply = (payload: { ok: boolean; status: number; body: unknown }) =>
        iframeWindow?.postMessage(
          { type: "worktable.api.response", id: data.id, ...payload },
          "*"
        )
      const target = resolveWidgetApiTarget(
        data.path,
        spaceId,
        widgetId,
        window.location.origin
      )
      if (!target) {
        reply({
          ok: false,
          status: 403,
          body: {
            error: "Widget may only call its own records/state endpoints.",
            code: "FORBIDDEN",
          },
        })
        return
      }
      try {
        const res = await authenticatedFetch(target, {
          method: data.method || "GET",
          headers: { "Content-Type": "application/json" },
          body: data.body ?? undefined,
        })
        const body = await res.json().catch(() => ({}))
        reply({ ok: res.ok, status: res.status, body })
        // A 401 on a brokered call means the session expired — bounce the whole
        // app to /login like the shared REST client does, instead of leaving the
        // widget failing in place.
        if (res.status === 401) redirectToLogin()
      } catch (err) {
        reply({
          ok: false,
          status: 0,
          body: { error: String(err), code: "NETWORK_ERROR" },
        })
      }
    }
    window.addEventListener("message", handleApiRequest)
    iframeElement?.addEventListener("load", handleIframeLoad)
    return () => {
      disposed = true
      window.removeEventListener("message", handleApiRequest)
      iframeElement?.removeEventListener("load", handleIframeLoad)
    }
  }, [frameSrc, navigate, recheckPage, spaceId, validation, widgetId])

  const importantDiagnostics = useMemo(
    () =>
      diagnostics.filter(
        (diagnostic) =>
          diagnostic.level === "warning" || diagnostic.level === "error"
      ),
    [diagnostics]
  )

  const [restoring, setRestoring] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // Native fullscreen (desktop) vs. a CSS overlay fallback where
  // requestFullscreen is unavailable (iOS Safari on iframes).
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  const [overlayFullscreen, setOverlayFullscreen] = useState(false)
  const fullscreenActive = nativeFullscreen || overlayFullscreen

  useEffect(() => {
    const handleFullscreenChange = () =>
      setNativeFullscreen(!!document.fullscreenElement)
    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [])

  // Escape leaves the CSS-overlay fallback (native fullscreen handles its own).
  useEffect(() => {
    if (!overlayFullscreen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlayFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [overlayFullscreen])

  const toggleFullscreen = useCallback(() => {
    const el = wrapperRef.current
    if (!el) return
    if (typeof el.requestFullscreen !== "function") {
      setOverlayFullscreen((value) => !value)
      return
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    if (overlayFullscreen) {
      setOverlayFullscreen(false)
      return
    }
    // requestFullscreen can exist but still reject (permissions policy,
    // headless/webview environments) — fall back to the CSS overlay.
    el.requestFullscreen().catch(() => setOverlayFullscreen(true))
  }, [overlayFullscreen])

  const handleCopyHtml = useCallback(() => {
    exportWidgetHtml(spaceId, widgetId)
      .then(copyText)
      .then(() => toast.success("Copied HTML"))
      .catch((err) => {
        console.error("Failed to copy HTML doc source:", err)
        toast.error("Failed to copy HTML")
      })
  }, [spaceId, widgetId])

  const handleRestore = useCallback(async () => {
    setRestoring(true)
    try {
      await restoreWidget(spaceId, widgetId)
      await recheckPage()
      toast.success("HTML doc restored")
    } catch (err) {
      console.error("Failed to restore HTML doc:", err)
      toast.error("Failed to restore HTML doc")
    } finally {
      setRestoring(false)
    }
  }, [recheckPage, spaceId, widgetId])

  // The space-detail embed tells whether the Space is archived (sharing).
  const { data: spaceDetail } = useSpace(spaceId)

  const handleRename = useCallback(
    async (name: string, description?: string | null) => {
      try {
        await patchWidget(spaceId, widgetId, { name, description })
        await recheckPage()
        toast.success("HTML doc details updated")
      } catch (err) {
        console.error("Failed to update HTML doc details:", err)
        toast.error("Failed to update HTML doc details")
      }
    },
    [recheckPage, spaceId, widgetId]
  )

  const handleArchive = useCallback(async () => {
    try {
      await archiveWidget(spaceId, widgetId)
      await recheckPage()
      toast.success("HTML doc archived")
    } catch (err) {
      console.error("Failed to archive HTML doc:", err)
      toast.error("Failed to archive HTML doc")
    }
  }, [recheckPage, spaceId, widgetId])

  const handleDelete = useCallback(async () => {
    try {
      await deleteWidget(spaceId, widgetId)
      await navigate({ to: "/spaces/$spaceId", params: { spaceId } })
      toast.success("HTML doc deleted")
    } catch (err) {
      console.error("Failed to delete HTML doc:", err)
      toast.error("Failed to delete HTML doc")
    }
  }, [navigate, spaceId, widgetId])

  const overflowActions = useMemo<PageOverflowAction[]>(() => {
    const actions: PageOverflowAction[] = [
      {
        id: "version-history",
        label: "Version History",
        icon: History,
        onSelect: openVersions,
      },
    ]
    actions.push(
      {
        id: "open-new-tab",
        label: "Open in New Tab",
        icon: ExternalLink,
        onSelect: () => window.open(newTabUrl, "_blank", "noopener,noreferrer"),
        separatorBefore: true,
      },
      {
        id: "copy-html",
        label: "Copy HTML",
        icon: Code,
        onSelect: handleCopyHtml,
      }
    )
    // Changes wait for the route's check of this path.
    if (!validated) return actions
    actions.push(
      {
        id: "edit-details",
        label: "Edit Details",
        icon: Pencil,
        onSelect: () => setRenameOpen(true),
        separatorBefore: true,
      },
      {
        id: archived ? "restore" : "archive",
        label: archived ? "Restore" : "Archive",
        icon: archived ? RotateCcw : Archive,
        onSelect: archived
          ? () => void handleRestore()
          : () => void handleArchive(),
      },
      {
        id: "delete",
        label: "Delete",
        icon: Trash,
        onSelect: () => setDeleteOpen(true),
        tone: "destructive",
        separatorBefore: true,
      }
    )

    return readOnly
      ? actions.filter(
          (action) =>
            !["edit-details", "restore", "archive", "delete"].includes(
              action.id
            )
        )
      : actions
  }, [
    readOnly,
    archived,
    handleArchive,
    handleCopyHtml,
    handleRestore,
    newTabUrl,
    openVersions,
    validated,
  ])

  return (
    <div
      data-document-ready={
        frameSrc !== null && loadedFrameSrc === frameSrc ? "true" : undefined
      }
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <WidgetPageMeta
        spaceId={spaceId}
        widgetId={widgetId}
        spaceShareable={Boolean(
          validated &&
          spaceDetail &&
          !spaceDetail.space.settings["archive"] &&
          spaceDetail.space.permissions?.manage !== false
        )}
        title={title}
        archived={archived}
        annotations={validated ? annotationsAction : undefined}
        overflowActions={overflowActions}
        sharing={page?.sharing}
      />
      {archived && !readOnly ? (
        <ArchivedWidgetBanner
          onRestore={handleRestore}
          restoring={restoring}
          disabled={!validated}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={wrapperRef}
          className={`relative min-h-0 min-w-0 flex-col bg-background ${
            overlayFullscreen ? "fixed inset-0 z-50" : ""
          } ${previewVersionId ? "hidden xl:flex xl:flex-[1_1_50%] xl:border-r xl:border-border print:block print:flex-1 print:border-r-0" : "flex flex-1"}`}
        >
          <WidgetDiagnostics diagnostics={importantDiagnostics} />
          <div className="overlay-floating absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg bg-popover p-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={toggleFullscreen}
              aria-label={fullscreenActive ? "Exit fullscreen" : "Fullscreen"}
              title={fullscreenActive ? "Exit fullscreen" : "Fullscreen"}
            >
              {fullscreenActive ? (
                <Minimize className="size-4" />
              ) : (
                <Maximize className="size-4" />
              )}
            </Button>
          </div>
          {(frameSrc === null || loadedFrameSrc !== frameSrc) && (
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden bg-background">
              <EditorSkeleton />
            </div>
          )}
          {frameSrc !== null && (
            <iframe
              ref={iframeRef}
              onLoad={() => setLoadedFrameSrc(frameSrc)}
              title={title}
              src={frameSrc}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              data-worktable-widget-frame="true"
              className="h-full w-full flex-1 border-0 bg-background"
            />
          )}
        </div>

        {previewVersionId && (
          <VersionPreview
            canEdit={validated && !readOnly}
            key={previewVersionId}
            kind="html"
            spaceId={spaceId}
            path={widgetId}
            revision={versionsRevision}
            version={previewVersion}
            error={versionQuery.isError}
            onRetry={() => void versionQuery.refetch()}
            onBack={() => setPreviewVersionId(null)}
            onHistory={openVersions}
            onRestored={() => {
              void recheckPage()
              setPreviewVersionId(null)
            }}
          >
            {/* Fully static: the server serves snapshots with script-src 'none'
                and this sandbox omits allow-scripts as defense in depth —
                historical authored JS must not run (it could exfiltrate
                snapshot data by navigating the frame; connect-src can't stop
                navigation). */}
            <iframe
              key={previewVersionId}
              title={`${title} · Saved version`}
              src={`${widgetVersionContentUrl(spaceId, widgetId, previewVersionId)}?theme=${resolvedTheme}`}
              sandbox=""
              referrerPolicy="no-referrer"
              className="h-full w-full flex-1 border-0 bg-background"
            />
          </VersionPreview>
        )}

        <DesktopContextPanel
          open={!previewVersionId && annotationsOpen && !belowXl}
          width={384}
        >
          <AnnotationPanel
            visitorComments={page?.sharing?.visitorComments ? {spaceId, path: page.document.path, ...page.sharing.visitorComments} : undefined}
            readOnly={readOnly}
            annotations={annotations}
            activeAnnotationId={activeAnnotationId}
            onSelectAnnotation={selectAnnotation}
            onResolve={(annotationId) =>
              annotationMutations.resolve.mutate({ annotationId })
            }
            onReopen={(annotationId) =>
              annotationMutations.reopen.mutate(annotationId)
            }
            onReply={(annotationId, body) =>
              annotationMutations.reply.mutate({ annotationId, body })
            }
            onClose={() => setAnnotationsOpen(false)}
            onCompose={() => setComposerOpen(true)}
            composeLabel="Comment on this HTML doc"
            emptyHint="Leave a comment or instruction for this HTML doc."
            className="bg-transparent"
          />
        </DesktopContextPanel>

        <VersionHistoryPanel
          canEdit={validated && !readOnly}
          kind="html"
          spaceId={spaceId}
          path={widgetId}
          revision={versionsRevision}
          currentActor={page?.contributors?.lastEditor}
          provenance={page?.provenance}
          open={(versionsOpen || Boolean(previewVersionId)) && !belowXl}
          drawerMode={false}
          selectedVersionId={previewVersionId}
          onSelect={(id) => {
            setPreviewVersionId(id)
            setVersionsOpen(true)
            setAnnotationsOpen(false)
          }}
          onClose={() => {
            setVersionsOpen(false)
            setPreviewVersionId(null)
          }}
        />
      </div>

      {/* Both drawers cover the whole below-xl range: the desktop rail/panel
          are display:none until xl, so gating on the 768px mobile breakpoint
          would leave tablets with neither surface. */}
      {belowXl && (
        <>
          <VersionHistoryPanel
            canEdit={validated && !readOnly}
            kind="html"
            spaceId={spaceId}
            path={widgetId}
            revision={versionsRevision}
            currentActor={page?.contributors?.lastEditor}
            provenance={page?.provenance}
            open={versionsOpen}
            drawerMode
            selectedVersionId={previewVersionId}
            onSelect={(id) => {
              setPreviewVersionId(id)
              setVersionsOpen(false)
            }}
            onClose={() => setVersionsOpen(false)}
          />
          <Drawer
            open={annotationsOpen}
            onOpenChange={setAnnotationsOpen}
            repositionInputs={false}
          >
            <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[86dvh]">
              <DrawerTitle className="sr-only">Annotations</DrawerTitle>
              <DrawerDescription className="sr-only">
                Annotations for this HTML doc.
              </DrawerDescription>
              <AnnotationPanel
            visitorComments={page?.sharing?.visitorComments ? {spaceId, path: page.document.path, ...page.sharing.visitorComments} : undefined}
                readOnly={readOnly}
                annotations={annotations}
                activeAnnotationId={activeAnnotationId}
                onSelectAnnotation={selectAnnotation}
                onResolve={(annotationId) =>
                  annotationMutations.resolve.mutate({ annotationId })
                }
                onReopen={(annotationId) =>
                  annotationMutations.reopen.mutate(annotationId)
                }
                onReply={(annotationId, body) =>
                  annotationMutations.reply.mutate({ annotationId, body })
                }
                onClose={() => setAnnotationsOpen(false)}
                onCompose={() => setComposerOpen(true)}
                composeLabel="Comment on this HTML doc"
                emptyHint="Leave a comment or instruction for this HTML doc."
                className="max-h-[calc(86dvh-1.5rem)]"
              />
            </DrawerContent>
          </Drawer>
        </>
      )}

      <WidgetAnnotationComposer
        open={composerOpen && !readOnly}
        onOpenChange={setComposerOpen}
        onSubmit={(category, body) => {
          annotationMutations.create.mutate({
            target: { type: "widget", widgetId },
            category,
            body,
          })
          setAnnotationsOpen(true)
          setVersionsOpen(false)
          setPreviewVersionId(null)
        }}
      />
      <WidgetRenameDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        spaceId={spaceId}
        widgetId={widgetId}
        onRename={handleRename}
      />
      <WidgetDeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        widgetName={title}
        onConfirm={handleDelete}
      />
    </div>
  )
}

function WidgetAnnotationComposer({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (category: AnnotationCategory, body: string) => void
}) {
  const [category, setCategory] = useState<AnnotationCategory>("comment")
  const [body, setBody] = useState("")

  // Reset each time the composer opens so a prior draft never lingers.
  useEffect(() => {
    if (open) {
      setCategory("comment")
      setBody("")
    }
  }, [open])

  const categoryLabel: Record<AnnotationCategory, string> = {
    comment: "Comment",
    instruction: "Instruction",
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            Comment on this HTML doc
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Attach a comment or instruction to the whole HTML doc.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Type</label>
            <Select
              value={category}
              onValueChange={(value) =>
                setCategory(value as AnnotationCategory)
              }
            >
              <SelectTrigger>
                <SelectValue>{categoryLabel[category]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="comment">Comment</SelectItem>
                <SelectItem value="instruction">Instruction</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Note</label>
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={
                category === "instruction"
                  ? "Write an instruction..."
                  : "Write a comment..."
              }
              className="min-h-32"
            />
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!body.trim()) return
              onSubmit(category, body.trim())
              onOpenChange(false)
            }}
            disabled={!body.trim()}
          >
            Add
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function WidgetPageMeta({
  spaceId,
  widgetId,
  spaceShareable,
  title,
  archived,
  annotations,
  overflowActions,
  sharing,
}: {
  spaceId: string
  widgetId: string
  spaceShareable: boolean
  title: string
  archived: boolean
  annotations?: PageAnnotationsAction
  overflowActions?: PageOverflowAction[]
  /** The page's links while links v2 is on. */
  sharing?: DocumentSharingSummary
}) {
  const setPageMeta = useSetPageMeta()
  const activeLinks = sharing?.activeLinks
  const canCreateLinks = sharing?.canCreate

  useEffect(() => {
    setPageMeta({
      document: { spaceId, path: widgetId },
      titleOverride: title,
      annotations,
      overflowActions,
      shareTarget: pageShareTarget(
        { kind: "html", spaceId, artifactKey: widgetId },
        spaceShareable && !archived,
        activeLinks,
        canCreateLinks
      ),
    })
    return () => setPageMeta(null)
  }, [
    title,
    archived,
    annotations,
    overflowActions,
    spaceShareable,
    activeLinks,
    canCreateLinks,
    spaceId,
    widgetId,
    setPageMeta,
  ])

  return null
}

function ArchivedWidgetBanner({
  onRestore,
  restoring,
  disabled = false,
}: {
  onRestore: () => void
  restoring: boolean
  /** Restoring waits for the route's check of this path. */
  disabled?: boolean
}) {
  return (
    <div className="shrink-0 border-b border-border bg-amber-50/80 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 shrink-0" />
          <span>
            This HTML doc is archived and hidden from the main HTML doc list by
            default.
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void onRestore()}
          disabled={restoring || disabled}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          {restoring ? "Restoring..." : "Restore"}
        </Button>
      </div>
    </div>
  )
}

function WidgetDiagnostics({
  diagnostics,
}: {
  diagnostics: WidgetDiagnostic[]
}) {
  const [expanded, setExpanded] = useState(false)
  if (diagnostics.length === 0) return null

  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.level === "error"
  ).length
  const warningCount = diagnostics.length - errorCount
  const latest = diagnostics[diagnostics.length - 1]
  const tone =
    errorCount > 0
      ? "text-destructive border-destructive/30 bg-destructive/10"
      : "text-amber-700 border-amber-500/30 bg-amber-500/10 dark:text-amber-200"
  const Icon = errorCount > 0 ? AlertTriangle : Info

  return (
    <div
      className={`m-2 shrink-0 rounded-xl border px-3 py-2 text-sm sm:m-3 ${tone}`}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            HTML doc runtime noticed{" "}
            {errorCount > 0
              ? `${errorCount} error${errorCount === 1 ? "" : "s"}`
              : `${warningCount} warning${warningCount === 1 ? "" : "s"}`}
          </span>
          <span className="block truncate opacity-90">{latest.message}</span>
        </span>
        <span className="shrink-0 text-xs font-medium opacity-80">
          {expanded ? "Hide" : "Details"}
        </span>
      </button>
      {expanded ? (
        <div className="mt-3 space-y-2 border-t border-current/20 pt-3">
          {diagnostics.map((diagnostic) => (
            <div
              key={diagnostic.id}
              className="rounded-lg bg-background/50 p-2"
            >
              <div className="flex items-center gap-2 text-xs font-semibold tracking-wide uppercase opacity-80">
                <span>{diagnostic.level}</span>
                <span>{diagnostic.code}</span>
              </div>
              <div className="mt-1 font-medium">{diagnostic.message}</div>
              {diagnostic.hint ? (
                <div className="mt-1 opacity-85">{diagnostic.hint}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function WidgetRenameDialog({
  open,
  onClose,
  spaceId,
  widgetId,
  onRename,
}: {
  open: boolean
  onClose: () => void
  spaceId: string
  widgetId: string
  onRename: (name: string, description?: string | null) => Promise<void>
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Edit HTML doc details</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Change its name and description.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <WidgetDetailsEditor
          spaceId={spaceId}
          widgetId={widgetId}
          onRename={onRename}
          onClose={onClose}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** The page carries only the name, so the details are read when edited. */
function WidgetDetailsEditor({
  spaceId,
  widgetId,
  onRename,
  onClose,
}: {
  spaceId: string
  widgetId: string
  onRename: (name: string, description?: string | null) => Promise<void>
  onClose: () => void
}) {
  // Read afresh each time the dialog opens and forget it when it closes, so a
  // form never starts from details someone has since changed.
  const details = useQuery({
    queryKey: [...queryKeys.widget(spaceId, widgetId), "details"],
    queryFn: () => getWidget(spaceId, widgetId),
    gcTime: 0,
    retry: false,
  })
  if (details.data) {
    return (
      <WidgetRenameDialogForm
        widget={details.data}
        onRename={onRename}
        onClose={onClose}
      />
    )
  }
  return (
    <>
      <ResponsiveDialogBody>
        <div className="flex min-h-28 flex-col items-center justify-center gap-3 text-center">
          {details.isError ? (
            <>
              <p className="text-sm text-muted-foreground" role="status">
                Couldn’t load the details.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={details.isFetching}
                onClick={() => void details.refetch()}
              >
                Retry
              </Button>
            </>
          ) : (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          )}
        </div>
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled>Save</Button>
      </ResponsiveDialogFooter>
    </>
  )
}

function WidgetRenameDialogForm({
  widget,
  onRename,
  onClose,
}: {
  widget: WidgetFile
  onRename: (name: string, description?: string | null) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(widget.name)
  const [description, setDescription] = useState(widget.description ?? "")
  const [pending, setPending] = useState(false)

  const changed =
    name.trim() !== widget.name ||
    description.trim() !== (widget.description ?? "")
  const canRename = name.trim().length > 0 && changed && !pending
  const handleRename = async () => {
    if (!canRename) return
    setPending(true)
    try {
      await onRename(name.trim(), description.trim() || null)
      onClose()
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <ResponsiveDialogBody>
        <div className="space-y-2">
          <label htmlFor="widget-detail-name" className="text-sm font-medium">
            HTML doc name
          </label>
          <Input
            id="widget-detail-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label
            htmlFor="widget-detail-description"
            className="text-sm font-medium"
          >
            Description{" "}
            <span className="font-normal text-muted-foreground">optional</span>
          </label>
          <Input
            id="widget-detail-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleRename} disabled={!canRename}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </ResponsiveDialogFooter>
    </>
  )
}

function WidgetDeleteDialog({
  open,
  onClose,
  widgetName,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  widgetName: string
  onConfirm: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const handleConfirm = async () => {
    setPending(true)
    try {
      await onConfirm()
      onClose()
    } finally {
      setPending(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Delete HTML doc</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Delete{" "}
            <span className="font-medium text-foreground">{widgetName}</span>{" "}
            from this space?
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <p className="text-sm text-muted-foreground">
            This removes the HTML doc files and cannot be undone. Archive it
            instead if you may need it later.
          </p>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

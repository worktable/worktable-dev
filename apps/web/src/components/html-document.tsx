import {
  AlertTriangle,
  Archive,
  BadgeCheck,
  Code,
  ExternalLink,
  History,
  Info,
  Loader2,
  Maximize,
  Minimize,
  Pencil,
  RotateCcw,
  RotateCw,
  Save,
  ChevronsLeft,
  ChevronsRight,
  Trash,
  X,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { useSpace, queryKeys, widgetQueryOptions } from "@/lib/queries"
import {
  archiveWidget,
  createWidgetCheckpoint,
  deleteWidget,
  exportWidgetHtml,
  listWidgetVersions,
  patchWidget,
  readWidgetVersion,
  restoreWidget,
  restoreWidgetVersion,
  reviewWidget,
  widgetContentUrl,
  widgetVersionContentUrl,
} from "@/lib/widgets-api"
import type {
  WidgetVersionEntry,
  WidgetVersionSnapshot,
} from "@/lib/widgets-api"
import { useSpaceSubscription } from "@/lib/ws"
import { useSpaceEvents } from "@/hooks/use-space-events"
import { copyText } from "@/lib/clipboard"
import {
  CATEGORY_LABELS,
  docAttribution,
  staleTitle,
} from "@/lib/doc-freshness"
import {
  usePageMeta,
  type PageAnnotationsAction,
  type PageMetaChip,
  type PageOverflowAction,
} from "@/hooks/use-page-meta"
import { RelativeTime } from "@/lib/time"
import { resolveWidgetApiTarget } from "@/lib/widget-broker"
import { resolveDocumentNavigation } from "@/lib/documents-api"
import { documentHref, documentRoute } from "@/lib/document-views"
import {
  authenticatedFetch,
  canonicalConflictPath,
  HttpError,
  redirectToLogin,
} from "@/lib/http"
import { EditorSkeleton } from "@/components/editor/editor-skeleton"
import { useTheme } from "@/components/theme-provider"
import { useNavigate, useRouter } from "@tanstack/react-router"
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
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
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
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { AnnotationPanel } from "@/components/annotations/annotation-panel"
import { DesktopContextPanel } from "@/components/desktop-context-panel"
import {
  useWidgetAnnotations,
  useWidgetAnnotationMutations,
} from "@/lib/annotations-queries"
import type {
  Annotation,
  AnnotationCategory,
  DocFreshness,
  SpaceFile,
  WidgetFile,
} from "@worktable/types"
import type { WidgetListEntry, WidgetRead } from "@/lib/widgets-api"

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
}: {
  spaceId: string
  documentPath: string
}) {
  return (
    <WidgetDetailPage
      key={`${spaceId}/${documentPath}`}
      spaceId={spaceId}
      widgetId={documentPath}
    />
  )
}

function WidgetDetailPage({
  spaceId,
  widgetId,
}: {
  spaceId: string
  widgetId: string
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const spaceEvents = useSpaceEvents(spaceId)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const validatedMountedRouteRef = useRef<string | null>(null)
  // Collections the widget has subscribed to (via brokered worktable.records.subscribe).
  const subscribedCollections = useRef<Set<string>>(new Set())
  // Relay the parent's (same-origin, working-when-exposed) space subscription to
  // the widget iframe, which can't hold its own socket under exposed CORS.
  const { status: spaceSubscriptionStatus } = useSpaceSubscription(
    spaceId,
    (collectionId) => {
      const win = iframeRef.current?.contentWindow
      if (!win) return
      for (const collection of subscribedCollections.current) {
        if (collectionId === undefined || collectionId === collection) {
          win.postMessage(
            { type: "worktable.records.changed", collection },
            "*"
          )
        }
      }
    },
    (previousWidgetId, nextWidgetId) => {
      if (previousWidgetId !== widgetId) return
      void navigate({
        to: "/spaces/$spaceId/documents/$",
        params: { spaceId, _splat: nextWidgetId },
        replace: true,
      })
    }
  )
  useEffect(() => {
    return spaceEvents.subscribe((message) => {
      if (message.type === "widget_deleted" && message.widgetId === widgetId) {
        void navigate({
          to: "/spaces/$spaceId",
          params: { spaceId },
          replace: true,
        })
      }
    })
  }, [navigate, spaceEvents, spaceId, widgetId])
  useEffect(() => {
    if (spaceSubscriptionStatus !== "connected") return
    const routeKey = `${spaceId}\0${widgetId}`
    if (validatedMountedRouteRef.current === routeKey) return
    validatedMountedRouteRef.current = routeKey
    void router.invalidate()
  }, [router, spaceId, spaceSubscriptionStatus, widgetId])
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
  const widgetOptions = widgetQueryOptions(spaceId, widgetId)
  // A move can land after the common page resolves but before this legacy
  // renderer mounts. Do not let a fresh-looking cache entry authorize the
  // iframe: require success or error evidence produced after this mount.
  const initialWidgetEvidence = useRef({
    dataUpdatedAt:
      queryClient.getQueryState(widgetOptions.queryKey)?.dataUpdatedAt ?? 0,
    errorUpdatedAt:
      queryClient.getQueryState(widgetOptions.queryKey)?.errorUpdatedAt ?? 0,
  })
  const {
    data: widget,
    dataUpdatedAt,
    error,
    errorUpdatedAt,
    isLoading,
  } = useQuery({
    ...widgetOptions,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  })
  const routeValidated =
    dataUpdatedAt > initialWidgetEvidence.current.dataUpdatedAt ||
    errorUpdatedAt > initialWidgetEvidence.current.errorUpdatedAt
  const canonicalPath = canonicalConflictPath(error, widgetId)
  useEffect(() => {
    if (!canonicalPath) return
    void navigate({
      to: "/spaces/$spaceId/documents/$",
      params: { spaceId, _splat: canonicalPath },
      replace: true,
    })
  }, [canonicalPath, navigate, spaceId])
  const contentUrl = `${widgetContentUrl(spaceId, widgetId)}?theme=${resolvedTheme}`
  const newTabUrl = documentHref(spaceId, widgetId)
  // Cache-bust the iframe on content changes. Keyed on the provenance
  // contentHash when available: an external edit touching only index.html
  // never bumps widget.yaml's updatedAt, but it does mint a new contentHash.
  // updatedAt stays as the fallback for pre-provenance widgets. Snapshot
  // compare frames are immutable and need no buster.
  const frameKey = widget?.provenance?.contentHash ?? widget?.updatedAt
  const frameSrc = widget
    ? `${contentUrl}&v=${encodeURIComponent(frameKey ?? "")}`
    : contentUrl
  const [loadedFrameSrc, setLoadedFrameSrc] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<WidgetDiagnostic[]>([])

  // Version history rail state (mirrors the doc route).
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versionsRailExpanded, setVersionsRailExpanded] = useState(false)
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null)
  const [compareVersion, setCompareVersion] =
    useState<WidgetVersionSnapshot | null>(null)

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
        setVersionsRailExpanded(false)
        setCompareVersionId(null)
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
    setCompareVersionId(null)
  }, [])

  useEffect(() => {
    setDiagnostics([])
  }, [spaceId, widgetId, frameSrc])

  // Reset the version rail and annotations when navigating to a different widget.
  useEffect(() => {
    setVersionsOpen(false)
    setVersionsRailExpanded(false)
    setCompareVersionId(null)
    setAnnotationsOpen(false)
    setActiveAnnotationId(null)
    setComposerOpen(false)
  }, [spaceId, widgetId])

  // Load the selected snapshot for the compare pane header label.
  useEffect(() => {
    let cancelled = false
    if (!compareVersionId) {
      setCompareVersion(null)
      return
    }
    readWidgetVersion(spaceId, widgetId, compareVersionId)
      .then((version) => {
        if (!cancelled) setCompareVersion(version)
      })
      .catch((err) => {
        console.error("Failed to load version", err)
        if (!cancelled) {
          setCompareVersionId(null)
          setCompareVersion(null)
          toast.error("Failed to load checkpoint")
        }
      })
    return () => {
      cancelled = true
    }
  }, [spaceId, widgetId, compareVersionId])

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
    // The injected runtime announces a closure-held token before authored code
    // runs. Raw authored postMessages never receive navigation authority.
    let navigationToken: string | null = null
    let navigationGeneration = 0
    let acceptingNavigationHandshake = true
    let observedInitialLoad = false
    let disposed = false
    const handleIframeLoad = () => {
      navigationGeneration += 1
      acceptingNavigationHandshake = false
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
        if (
          acceptingNavigationHandshake &&
          navigationToken === null &&
          data.spaceId === spaceId &&
          data.widgetId === widgetId &&
          typeof data.navigationToken === "string" &&
          data.navigationToken.length >= 16
        ) {
          navigationToken = data.navigationToken
          acceptingNavigationHandshake = false
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
      // relay change events back to it (see useSpaceSubscription above).
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
  }, [frameSrc, navigate, spaceId, widgetId])

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
      await router.invalidate()
      toast.success("HTML doc restored")
    } catch (err) {
      console.error("Failed to restore HTML doc:", err)
      toast.error("Failed to restore HTML doc")
    } finally {
      setRestoring(false)
    }
  }, [spaceId, widgetId, router])

  // Hooks must precede the loading/error returns — a hook after a conditional
  // return renders in some passes but not others and React throws.
  const invalidateWidget = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.widget(spaceId, widgetId),
    })
  }, [queryClient, spaceId, widgetId])

  // Freshness lives on the LIST surfaces, not the single-widget read: source it
  // from the space-detail embed ({space, widgets}), which the parent
  // SpaceDetailPage already loads — so the cache is warm and there's no extra
  // fetch. (useWidget's GET /:widgetId does not carry freshness.)
  const { data: spaceDetail } = useSpace(spaceId)
  const freshness = useMemo(
    () => spaceDetail?.widgets?.find((w) => w.id === widgetId)?.freshness,
    [spaceDetail, widgetId]
  )

  // Manual click and inferred dwell can race; dedupe by sharing one in-flight
  // request and latching on the version already reviewed. Latch on the
  // provenance versionId — the identity of the recorded version — NOT the
  // contentHash: an agent that reverts a doc to a byte-identical earlier state
  // (A→B→A) mints a new, unreviewed version whose contentHash repeats, so a
  // hash latch would refuse to POST and strand the visible unreviewed state.
  // Each recorded version has a distinct id, so the latch clears per version.
  // updatedAt remains the pre-provenance fallback.
  const reviewedKeyRef = useRef<string | null>(null)
  const reviewInFlightRef = useRef<Promise<void> | null>(null)
  const currentKey = widget?.provenance?.versionId ?? widget?.updatedAt ?? null

  useEffect(() => {
    reviewInFlightRef.current = null
    reviewedKeyRef.current = null
  }, [spaceId, widgetId])

  /** Resolves true only for the call that initiated a POST — no-op joins and
   *  latched calls resolve false so callers don't report work they didn't do. */
  const markReviewed = useCallback((): Promise<boolean> => {
    const latchKey = currentKey ?? "none"
    if (reviewedKeyRef.current === latchKey) return Promise.resolve(false)
    if (reviewInFlightRef.current)
      return reviewInFlightRef.current.then(() => false)
    const request = (async () => {
      try {
        const result = await reviewWidget(spaceId, widgetId)
        reviewedKeyRef.current = latchKey
        // Write the post-review freshness into the space-detail cache so the
        // chip flips and the Mark-reviewed button hides immediately, without a
        // refetch round-trip. The sidebar reads the same query, so its stale
        // dot clears too.
        if (result.freshness) {
          queryClient.setQueryData(
            queryKeys.space(spaceId),
            (
              old: { space: SpaceFile; widgets: WidgetListEntry[] } | undefined
            ) =>
              old
                ? {
                    ...old,
                    widgets: old.widgets.map((w) =>
                      w.id === widgetId
                        ? { ...w, freshness: result.freshness }
                        : w
                    ),
                  }
                : old
          )
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      } finally {
        reviewInFlightRef.current = null
      }
    })()
    reviewInFlightRef.current = request
    return request.then(() => true)
  }, [spaceId, widgetId, queryClient, currentKey])

  const handleMarkReviewed = useCallback(() => {
    markReviewed()
      .then((performed) => {
        if (performed) toast.success("Marked reviewed")
      })
      .catch((err) => {
        console.error("Review failed:", err)
        toast.error("Failed to mark reviewed")
      })
  }, [markReviewed])

  const handleRename = useCallback(
    async (name: string, description?: string | null) => {
      try {
        await patchWidget(spaceId, widgetId, { name, description })
        await router.invalidate()
        toast.success("HTML doc details updated")
      } catch (err) {
        console.error("Failed to update HTML doc details:", err)
        toast.error("Failed to update HTML doc details")
      }
    },
    [router, spaceId, widgetId]
  )

  const handleArchive = useCallback(async () => {
    try {
      await archiveWidget(spaceId, widgetId)
      await router.invalidate()
      toast.success("HTML doc archived")
    } catch (err) {
      console.error("Failed to archive HTML doc:", err)
      toast.error("Failed to archive HTML doc")
    }
  }, [router, spaceId, widgetId])

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
    if (!widget) return []

    const actions: PageOverflowAction[] = [
      {
        id: "version-history",
        label: "Version History",
        icon: History,
        onSelect: openVersions,
      },
    ]
    if (freshness && !freshness.humanReviewed && !widget.archive) {
      actions.push({
        id: "mark-reviewed",
        label: "Mark Reviewed",
        icon: BadgeCheck,
        onSelect: handleMarkReviewed,
      })
    }
    actions.push(
      {
        id: "open-new-tab",
        label: "Open in new tab",
        icon: ExternalLink,
        onSelect: () => window.open(newTabUrl, "_blank", "noopener,noreferrer"),
        separatorBefore: true,
      },
      {
        id: "copy-html",
        label: "Copy HTML",
        icon: Code,
        onSelect: handleCopyHtml,
      },
      {
        id: "edit-details",
        label: "Edit details",
        icon: Pencil,
        onSelect: () => setRenameOpen(true),
        separatorBefore: true,
      },
      {
        id: widget.archive ? "restore" : "archive",
        label: widget.archive ? "Restore" : "Archive",
        icon: widget.archive ? RotateCcw : Archive,
        onSelect: widget.archive
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

    return actions
  }, [
    freshness,
    handleArchive,
    handleCopyHtml,
    handleMarkReviewed,
    handleRestore,
    newTabUrl,
    openVersions,
    widget,
  ])

  // Reading an HTML doc counts as a review, same as the doc route: 30s of
  // visible dwell plus at least one interaction. ONLY trusted parent-window
  // gestures count — a postMessage "interaction" signal from the sandboxed
  // frame would let agent-authored script forge the interaction and launder
  // its own content into human-reviewed after mere dwell. Users who only
  // interact inside the frame use Mark Reviewed explicitly.
  const inferredEligible = Boolean(
    freshness && !freshness.humanReviewed && !widget?.archive
  )
  useWidgetInferredReview(
    inferredEligible,
    widgetId,
    widget?.provenance?.versionId ?? widget?.updatedAt ?? "",
    markReviewed
  )

  if (!routeValidated || isLoading || canonicalPath) {
    return <EditorSkeleton />
  }

  if (error || !widget) {
    return (
      <div data-document-state className="flex h-full items-center justify-center text-sm text-destructive">
        HTML doc not found.
      </div>
    )
  }

  return (
    <div
      data-document-ready={loadedFrameSrc === frameSrc ? "true" : undefined}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <WidgetPageMeta
        spaceId={spaceId}
        widgetId={widgetId}
        spaceShareable={Boolean(
          spaceDetail && !spaceDetail.space.settings["archive"]
        )}
        widget={widget}
        freshness={freshness}
        annotations={annotationsAction}
        overflowActions={overflowActions}
      />
      {widget.archive ? (
        <ArchivedWidgetBanner onRestore={handleRestore} restoring={restoring} />
      ) : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={wrapperRef}
          className={`relative flex min-h-0 flex-col bg-background ${
            overlayFullscreen ? "fixed inset-0 z-50" : ""
          } ${compareVersionId && !belowXl ? "flex-[1_1_50%] border-r border-border print:flex-1 print:border-r-0" : "flex-1"}`}
        >
          <WidgetDiagnostics diagnostics={importantDiagnostics} />
          <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-border/70 bg-background/90 p-0.5 shadow-sm">
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
          {loadedFrameSrc !== frameSrc && (
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden bg-background">
              <EditorSkeleton />
            </div>
          )}
          <iframe
            ref={iframeRef}
            onLoad={() => setLoadedFrameSrc(frameSrc)}
            title={widget.name}
            src={frameSrc}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            data-worktable-widget-frame="true"
            className="h-full w-full flex-1 border-0 bg-background"
          />
        </div>

        {compareVersionId && (
          <div className="hidden min-w-0 flex-[1_1_50%] flex-col overflow-hidden bg-muted/10 xl:flex print:hidden">
            <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3 pb-2 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">
                  {compareVersionLabel(compareVersion)}
                </div>
                <div className="truncate text-muted-foreground">
                  {compareVersionDetail(compareVersion)}
                </div>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setCompareVersionId(null)}
                aria-label="Exit compare"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            {/* Fully static: the server serves snapshots with script-src 'none'
                and this sandbox omits allow-scripts as defense in depth —
                historical authored JS must not run (it could exfiltrate
                snapshot data by navigating the frame; connect-src can't stop
                navigation). */}
            <iframe
              key={compareVersionId}
              title={`${widget.name} — ${compareVersionLabel(compareVersion)}`}
              src={`${widgetVersionContentUrl(spaceId, widgetId, compareVersionId)}?theme=${resolvedTheme}`}
              sandbox=""
              referrerPolicy="no-referrer"
              className="h-full w-full flex-1 border-0 bg-background"
            />
          </div>
        )}

        <DesktopContextPanel
          open={!compareVersionId && annotationsOpen && !belowXl}
          width={384}
        >
          <AnnotationPanel
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

        <WidgetVersionHistoryPanel
          spaceId={spaceId}
          widgetId={widgetId}
          revision={widget?.provenance?.versionId ?? widget?.updatedAt ?? ""}
          open={(versionsOpen || Boolean(compareVersionId)) && !belowXl}
          compact={Boolean(compareVersionId) && !versionsRailExpanded}
          selectedVersionId={compareVersionId}
          onSelect={(versionId) => {
            setCompareVersionId(versionId)
            setVersionsOpen(true)
            setVersionsRailExpanded(false)
            setAnnotationsOpen(false)
          }}
          onClose={() => {
            setVersionsOpen(false)
            setVersionsRailExpanded(false)
          }}
          onToggleCompact={() => setVersionsRailExpanded((value) => !value)}
          onExitCompare={() => setCompareVersionId(null)}
          onRestored={() => {
            invalidateWidget()
            setCompareVersionId(null)
          }}
        />
      </div>

      {/* Both drawers cover the whole below-xl range: the desktop rail/panel
          are display:none until xl, so gating on the 768px mobile breakpoint
          would leave tablets with neither surface. */}
      {belowXl && (
        <>
          <WidgetVersionHistoryDrawer
            open={versionsOpen}
            onOpenChange={(open) => {
              setVersionsOpen(open)
              if (!open) setVersionsRailExpanded(false)
            }}
            spaceId={spaceId}
            widgetId={widgetId}
            revision={widget?.provenance?.versionId ?? widget?.updatedAt ?? ""}
            onRestored={invalidateWidget}
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
        open={composerOpen}
        onOpenChange={setComposerOpen}
        onSubmit={(category, body) => {
          annotationMutations.create.mutate({
            target: { type: "widget", widgetId },
            category,
            body,
          })
          setAnnotationsOpen(true)
          setVersionsOpen(false)
          setCompareVersionId(null)
        }}
      />
      <WidgetRenameDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        widget={widget}
        onRename={handleRename}
      />
      <WidgetDeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        widgetName={widget.name}
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

// Reading an HTML doc for a sustained period counts as a review (same contract
// as the doc route's useInferredReview): after 30s of visible dwell plus at
// least one interaction, record the review the reader would otherwise click.
// Fires at most once per widget view, only while eligible.
const INFERRED_REVIEW_DWELL_MS = 30_000

function useWidgetInferredReview(
  eligible: boolean,
  widgetId: string,
  revision: string,
  markReviewed: () => Promise<unknown>
) {
  const eligibleRef = useRef(eligible)
  eligibleRef.current = eligible
  const firedRef = useRef(false)

  // Reset on the version too, not just the widget id: after a passive review
  // fires, an agent/MCP update mints a new version (humanReviewed flips back to
  // false) while the user stays on the same doc — without resetting here the hook
  // stays latched and never re-reviews that new version.
  useEffect(() => {
    firedRef.current = false
  }, [widgetId, revision])

  useEffect(() => {
    if (!eligible || firedRef.current) return
    let visibleMs = 0
    let last = Date.now()
    let interacted = false
    const markInteracted = () => {
      interacted = true
    }
    const interval = setInterval(() => {
      const now = Date.now()
      if (document.visibilityState === "visible") visibleMs += now - last
      last = now
      if (
        visibleMs >= INFERRED_REVIEW_DWELL_MS &&
        interacted &&
        eligibleRef.current &&
        !firedRef.current
      ) {
        firedRef.current = true
        markReviewed().catch((err) => {
          console.error("Inferred review failed:", err)
          // Let a later tick retry rather than giving up for the visit.
          firedRef.current = false
        })
      }
    }, 5_000)
    window.addEventListener("pointerdown", markInteracted)
    window.addEventListener("keydown", markInteracted)
    window.addEventListener("wheel", markInteracted, { passive: true })
    return () => {
      clearInterval(interval)
      window.removeEventListener("pointerdown", markInteracted)
      window.removeEventListener("keydown", markInteracted)
      window.removeEventListener("wheel", markInteracted)
    }
  }, [eligible, widgetId, revision, markReviewed])
}

/**
 * Provenance chip for an HTML doc, mirroring the doc route's `docChip`.
 * Attribution prefers the version-history provenance (real source + actor —
 * filesystem edits and MCP writes attribute correctly even when widget.yaml
 * lags); widget.yaml fields are the pre-provenance fallback.
 */
function widgetChip(
  widget: WidgetRead,
  freshness: DocFreshness | undefined
): PageMetaChip {
  const category = docAttribution(
    {
      ...(widget.provenance?.source !== undefined
        ? { source: widget.provenance.source }
        : {}),
      ...((widget.provenance?.updatedBy ?? widget.updatedBy) !== undefined
        ? { updatedBy: widget.provenance?.updatedBy ?? widget.updatedBy }
        : {}),
    },
    freshness
  )
  return {
    label: CATEGORY_LABELS[category],
    agent: category === "agent",
    updatedAtIso: widget.provenance?.updatedAt ?? widget.updatedAt ?? null,
    stale: freshness?.stale ?? false,
    reviewed: freshness?.humanReviewed ?? false,
    staleDetail: freshness?.stale ? staleTitle(freshness) : undefined,
  }
}

function WidgetPageMeta({
  spaceId,
  widgetId,
  spaceShareable,
  widget,
  freshness,
  annotations,
  overflowActions,
}: {
  spaceId: string
  widgetId: string
  spaceShareable: boolean
  widget: WidgetRead
  freshness: DocFreshness | undefined
  annotations?: PageAnnotationsAction
  overflowActions?: PageOverflowAction[]
}) {
  const { setPageMeta } = usePageMeta()

  useEffect(() => {
    const chip = widgetChip(widget, freshness)
    setPageMeta({
      updatedAtLabel: formatWidgetUpdatedAt(
        widget.provenance?.updatedAt ?? widget.updatedAt
      ),
      provenanceLabel: widgetProvenanceLabel(widget),
      titleOverride: widget.name,
      chip,
      annotations,
      overflowActions,
      shareTarget:
        spaceShareable && !widget.archive
          ? { kind: "html", spaceId, artifactKey: widgetId }
          : undefined,
    })
    return () => setPageMeta(null)
  }, [
    widget,
    freshness,
    annotations,
    overflowActions,
    spaceShareable,
    spaceId,
    widgetId,
    setPageMeta,
  ])

  return null
}

function formatWidgetUpdatedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "Updated recently"
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function widgetProvenanceLabel(widget: WidgetRead): string {
  // Provenance carries the real actor for content changes that never touch
  // widget.yaml (external index.html edits, review checkpoints) — same
  // preference order as the chip.
  const by =
    widget.provenance?.updatedBy ||
    widget.updatedBy ||
    widget.createdBy ||
    "unknown"
  return `HTML doc · ${by}`
}

function ArchivedWidgetBanner({
  onRestore,
  restoring,
}: {
  onRestore: () => void
  restoring: boolean
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
          disabled={restoring}
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
      className={`m-2 shrink-0 rounded-xl border px-3 py-2 text-sm shadow-sm sm:m-3 ${tone}`}
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
  widget,
  onRename,
}: {
  open: boolean
  onClose: () => void
  widget: WidgetFile
  onRename: (name: string, description?: string | null) => Promise<void>
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <WidgetRenameDialogForm
          widget={widget}
          onRename={onRename}
          onClose={onClose}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
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
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Edit HTML doc details</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          Change its name and description.
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
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

// ── Version history ─────────────────────────────────────────
// Mirrors the doc route's VersionHistoryPanel UX: a right-hand rail beside the
// full-bleed iframe on desktop (with a compact mode when a compare is open) and
// a Drawer on mobile. Compare renders a second sandboxed iframe of the RENDERED
// snapshot — never a text diff.

function sourceDisplay(source: string): string {
  if (source === "browser-yjs") return "You via Browser"
  if (source === "mcp") return "Agent via MCP"
  if (source === "filesystem") return "Filesystem Update"
  if (source === "rest-api") return "API Update"
  if (source === "version-restore") return "Version Restore"
  if (source === "manual-checkpoint") return "Manual Checkpoint"
  return source || "Unknown Source"
}

function compareVersionLabel(version: WidgetVersionSnapshot | null): string {
  if (!version) return "Loading Version"
  return version.checkpoint?.label ?? sourceDisplay(version.source)
}

function compareVersionDetail(version: WidgetVersionSnapshot | null): string {
  if (!version) return "Loading comparison..."
  const created = new Date(version.createdAt)
  const time = Number.isNaN(created.getTime())
    ? "Unknown Time"
    : created.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
  return version.checkpoint?.label
    ? `${time} · ${sourceDisplay(version.source)}`
    : time
}

function SaveCheckpointDialog({
  open,
  saving,
  onOpenChange,
  onSave,
}: {
  open: boolean
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (label: string) => void | Promise<void>
}) {
  const [label, setLabel] = useState("")

  useEffect(() => {
    if (!open) setLabel("")
  }, [open])

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Save className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>Save checkpoint</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Capture the current HTML doc so you can compare or restore it later.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <label className="space-y-2 text-sm font-medium text-foreground">
            <span>Label</span>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Optional, e.g. Before layout rework"
              disabled={saving}
              autoFocus
            />
          </label>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={() => void onSave(label)} disabled={saving}>
            {saving ? "Saving..." : "Save Checkpoint"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** Shared fetch + toggle state for the version list, used by rail and drawer.
 * `revision` changes whenever a new version is recorded (the widget's provenance
 * versionId) — including it in the refresh deps keeps an already-open history
 * list live when a widget_update arrives from another client or a disk edit,
 * instead of showing a stale list until the panel is reopened. */
function useWidgetVersionList(
  spaceId: string,
  widgetId: string,
  active: boolean,
  revision: string
) {
  const [versions, setVersions] = useState<WidgetVersionEntry[]>([])
  const [showAll, setShowAll] = useState(false)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    if (!active) return
    setLoading(true)
    listWidgetVersions(spaceId, widgetId, showAll)
      .then(setVersions)
      .catch((err) => {
        console.error("Failed to load versions", err)
        toast.error("Failed to load version history")
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revision is an intentional refetch trigger
  }, [spaceId, widgetId, showAll, active, revision])

  useEffect(() => refresh(), [refresh])

  return { versions, showAll, setShowAll, loading, refresh }
}

function WidgetVersionRow({
  version,
  showAll,
  active,
  onSelect,
  onRestore,
  onExitCompare,
}: {
  version: WidgetVersionEntry
  showAll: boolean
  active: boolean
  onSelect: () => void
  onRestore: () => void
  onExitCompare?: () => void
}) {
  const label =
    version.checkpoint?.label ?? (showAll ? "Raw Version" : "Checkpoint")
  const exact = new Date(version.createdAt).toLocaleString()
  return (
    <article
      className={`border-l-2 px-3 py-4 transition-colors ${active ? "border-l-primary bg-muted/25" : "border-l-transparent hover:bg-muted/20"}`}
    >
      <button
        type="button"
        className="block w-full text-left"
        onClick={onSelect}
      >
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {version.checkpoint?.sourceCategory ?? "version"}
          </span>
          <span
            title={exact}
            className="ml-auto text-[11px] text-muted-foreground"
          >
            <RelativeTime iso={version.createdAt} />
          </span>
        </div>
        <h3 className="mb-1 truncate text-sm font-medium text-foreground">
          {label}
        </h3>
        <p className="truncate text-xs text-muted-foreground">
          {sourceDisplay(version.source)}
        </p>
        {version.reason && (
          <p className="mt-2 line-clamp-2 text-xs text-foreground/80">
            {version.reason}
          </p>
        )}
      </button>
      {active && (
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
          <Button size="sm" variant="outline" onClick={onRestore}>
            Restore
          </Button>
          {onExitCompare && (
            <Button size="sm" variant="ghost" onClick={onExitCompare}>
              Exit Compare
            </Button>
          )}
        </div>
      )}
    </article>
  )
}

function WidgetVersionList({
  versions,
  showAll,
  setShowAll,
  loading,
  selectedVersionId,
  onSelect,
  onSaveCheckpoint,
  onRestore,
  onExitCompare,
}: {
  versions: WidgetVersionEntry[]
  showAll: boolean
  setShowAll: (updater: (value: boolean) => boolean) => void
  loading: boolean
  selectedVersionId: string | null
  onSelect: (versionId: string) => void
  onSaveCheckpoint: () => void
  onRestore: (version: WidgetVersionEntry) => void
  onExitCompare?: () => void
}) {
  const scrollRef = useScrollFade<HTMLDivElement>()
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-2"
          onClick={onSaveCheckpoint}
        >
          <Save className="h-3.5 w-3.5" />
          Save Checkpoint
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show Checkpoints" : "Show All Versions"}
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="scroll-fade min-h-0 flex-1 overflow-auto p-3"
      >
        {loading ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border p-6 text-center">
            <Loader2 className="mb-3 h-8 w-8 animate-spin text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">
              Loading version history
            </p>
          </div>
        ) : versions.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border p-6 text-center">
            <History className="mb-3 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">
              No checkpoints yet
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Save a checkpoint or edit the HTML doc to create meaningful
              history.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {versions.map((version) => (
              <WidgetVersionRow
                key={version.id}
                version={version}
                showAll={showAll}
                active={version.id === selectedVersionId}
                onSelect={() => onSelect(version.id)}
                onRestore={() => onRestore(version)}
                onExitCompare={onExitCompare}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function WidgetVersionHistoryPanel({
  spaceId,
  widgetId,
  revision,
  open,
  compact,
  selectedVersionId,
  onSelect,
  onClose,
  onToggleCompact,
  onExitCompare,
  onRestored,
}: {
  spaceId: string
  widgetId: string
  revision: string
  open: boolean
  compact: boolean
  selectedVersionId: string | null
  onSelect: (versionId: string) => void
  onClose: () => void
  onToggleCompact: () => void
  onExitCompare: () => void
  onRestored: () => void
}) {
  const { versions, showAll, setShowAll, loading, refresh } =
    useWidgetVersionList(spaceId, widgetId, open, revision)
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const [restoreVersion, setRestoreVersion] =
    useState<WidgetVersionEntry | null>(null)
  const [savingCheckpoint, setSavingCheckpoint] = useState(false)
  const [restoringVersion, setRestoringVersion] = useState(false)

  const selectedIndex = versions.findIndex(
    (version) => version.id === selectedVersionId
  )
  const selected = selectedVersionId
    ? versions.find((version) => version.id === selectedVersionId)
    : null

  return (
    <>
      <DesktopContextPanel open={open} width={compact ? 64 : 384}>
        <div className="relative h-full w-full">
          {/* `invisible` (not just opacity-0) keeps the inactive pane out of
              the keyboard focus order as well as pointer interaction. */}
          <aside
            className={`absolute inset-0 flex flex-col items-center gap-2 bg-transparent py-4 transition-opacity duration-200 ${compact ? "opacity-100" : "pointer-events-none invisible opacity-0"}`}
          >
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onToggleCompact}
              aria-label="Expand version history"
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <div className="flex flex-1 items-center justify-center [writing-mode:vertical-rl]">
              <span className="truncate text-xs font-medium text-muted-foreground">
                {selected?.checkpoint?.label ?? "Compare"}
              </span>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={
                selectedIndex >= versions.length - 1 || selectedIndex < 0
              }
              onClick={() => onSelect(versions[selectedIndex + 1].id)}
              aria-label="Previous checkpoint"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={selectedIndex <= 0}
              onClick={() => onSelect(versions[selectedIndex - 1].id)}
              aria-label="Next checkpoint"
            >
              <RotateCw className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onExitCompare}
              aria-label="Exit compare"
            >
              <X className="h-4 w-4" />
            </Button>
          </aside>
          <div
            className={`absolute inset-0 transition-opacity duration-200 ${compact || !open ? "pointer-events-none invisible opacity-0" : "opacity-100"}`}
          >
            <aside className="flex h-full min-h-0 w-full flex-col bg-transparent">
              <div className="flex items-center justify-between gap-3 p-4 pb-2">
                <div className="flex min-w-0 items-center gap-2">
                  <History className="h-4 w-4 shrink-0 text-primary" />
                  <h2 className="text-sm font-medium text-foreground">
                    Version History
                  </h2>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {selectedVersionId && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={onToggleCompact}
                      aria-label="Collapse version history"
                    >
                      <ChevronsRight className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={onClose}
                    aria-label="Close version history"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <WidgetVersionList
                versions={versions}
                showAll={showAll}
                setShowAll={setShowAll}
                loading={loading}
                selectedVersionId={selectedVersionId}
                onSelect={onSelect}
                onSaveCheckpoint={() => setCheckpointOpen(true)}
                onRestore={setRestoreVersion}
                onExitCompare={onExitCompare}
              />
            </aside>
          </div>
        </div>
      </DesktopContextPanel>
      <SaveCheckpointDialog
        open={checkpointOpen}
        saving={savingCheckpoint}
        onOpenChange={setCheckpointOpen}
        onSave={async (label) => {
          setSavingCheckpoint(true)
          try {
            await createWidgetCheckpoint(
              spaceId,
              widgetId,
              label.trim() || undefined
            )
            toast.success("Checkpoint saved")
            setCheckpointOpen(false)
            refresh()
          } catch (err) {
            console.error("Failed to save checkpoint", err)
            toast.error("Failed to save checkpoint")
          } finally {
            setSavingCheckpoint(false)
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(restoreVersion)}
        onOpenChange={(open) => {
          if (!open) setRestoreVersion(null)
        }}
        title="Restore checkpoint?"
        description="This checkpoint will become the current HTML doc."
        confirmLabel="Restore"
        loading={restoringVersion}
        icon={<RotateCcw className="h-5 w-5 text-primary" />}
        onConfirm={async () => {
          if (!restoreVersion) return
          setRestoringVersion(true)
          try {
            await restoreWidgetVersion(spaceId, widgetId, restoreVersion.id)
            toast.success("Checkpoint restored")
            setRestoreVersion(null)
            onRestored()
            refresh()
          } catch (err) {
            console.error("Failed to restore checkpoint", err)
            toast.error("Failed to restore checkpoint")
          } finally {
            setRestoringVersion(false)
          }
        }}
      >
        <p className="text-sm text-muted-foreground">
          Your current version will be saved first, so you can switch back if
          needed.
        </p>
      </ConfirmDialog>
    </>
  )
}

function WidgetVersionHistoryDrawer({
  open,
  onOpenChange,
  spaceId,
  widgetId,
  revision,
  onRestored,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceId: string
  widgetId: string
  revision: string
  onRestored: () => void
}) {
  const { versions, showAll, setShowAll, loading, refresh } =
    useWidgetVersionList(spaceId, widgetId, open, revision)
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const [restoreVersion, setRestoreVersion] =
    useState<WidgetVersionEntry | null>(null)
  const [savingCheckpoint, setSavingCheckpoint] = useState(false)
  const [restoringVersion, setRestoringVersion] = useState(false)
  // Mobile has no compare pane, but a row must still be selectable — the row's
  // Restore action only renders on the active row.
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    null
  )

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
        <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[86dvh]">
          <DrawerTitle className="sr-only">Version History</DrawerTitle>
          <DrawerDescription className="sr-only">
            Version history for this HTML doc.
          </DrawerDescription>
          <div className="flex max-h-[calc(86dvh-1.5rem)] flex-col">
            <div className="flex items-center gap-2 p-4 pb-2">
              <History className="h-4 w-4 shrink-0 text-primary" />
              <h2 className="text-sm font-medium text-foreground">
                Version History
              </h2>
            </div>
            <WidgetVersionList
              versions={versions}
              showAll={showAll}
              setShowAll={setShowAll}
              loading={loading}
              selectedVersionId={selectedVersionId}
              onSelect={(versionId) =>
                setSelectedVersionId((current) =>
                  current === versionId ? null : versionId
                )
              }
              onSaveCheckpoint={() => setCheckpointOpen(true)}
              onRestore={setRestoreVersion}
            />
          </div>
        </DrawerContent>
      </Drawer>
      <SaveCheckpointDialog
        open={checkpointOpen}
        saving={savingCheckpoint}
        onOpenChange={setCheckpointOpen}
        onSave={async (label) => {
          setSavingCheckpoint(true)
          try {
            await createWidgetCheckpoint(
              spaceId,
              widgetId,
              label.trim() || undefined
            )
            toast.success("Checkpoint saved")
            setCheckpointOpen(false)
            refresh()
          } catch (err) {
            console.error("Failed to save checkpoint", err)
            toast.error("Failed to save checkpoint")
          } finally {
            setSavingCheckpoint(false)
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(restoreVersion)}
        onOpenChange={(o) => {
          if (!o) setRestoreVersion(null)
        }}
        title="Restore checkpoint?"
        description="This checkpoint will become the current HTML doc."
        confirmLabel="Restore"
        loading={restoringVersion}
        icon={<RotateCcw className="h-5 w-5 text-primary" />}
        onConfirm={async () => {
          if (!restoreVersion) return
          setRestoringVersion(true)
          try {
            await restoreWidgetVersion(spaceId, widgetId, restoreVersion.id)
            toast.success("Checkpoint restored")
            setRestoreVersion(null)
            onRestored()
            refresh()
          } catch (err) {
            console.error("Failed to restore checkpoint", err)
            toast.error("Failed to restore checkpoint")
          } finally {
            setRestoringVersion(false)
          }
        }}
      >
        <p className="text-sm text-muted-foreground">
          Your current version will be saved first, so you can switch back if
          needed.
        </p>
      </ConfirmDialog>
    </>
  )
}

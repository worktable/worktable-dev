import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Navigate, useNavigate, useRouter } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Wifi,
  WifiOff,
  Loader2,
  Archive,
  BadgeCheck,
  Copy,
  Download,
  RotateCcw,
  History,
  Printer,
  ArrowRightLeft,
  Pencil,
  X,
  Save,
  RotateCw,
  ChevronsRight,
  ChevronsLeft,
} from "lucide-react"
import { docQueryKeys, docQueryOptions } from "@/lib/docs-queries"
import { useSpace } from "@/lib/queries"
import {
  useAnnotationMutations,
  useDocAnnotations,
  annotationQueryKeys,
} from "@/lib/annotations-queries"
import type { Annotation } from "@worktable/types"
import type {
  DocMeta,
  DocVersionEntry,
  DocVersionSnapshot,
} from "@/lib/docs-api"
import {
  convertDoc,
  convertDocToMarkdown,
  restoreDoc,
  exportDocMarkdown,
  downloadDocMarkdown,
  listDocVersions,
  readDocVersion,
  createDocCheckpoint,
  createDoc,
  restoreDocVersion,
  reviewDoc,
} from "@/lib/docs-api"
import { workspaceCollaborationCacheKey } from "@/lib/collaboration-cache"
import { HttpError } from "@/lib/http"
import { copyText } from "@/lib/clipboard"
import {
  CATEGORY_LABELS,
  docAttribution,
  staleTitle,
} from "@/lib/doc-freshness"
import { RelativeTime } from "@/lib/time"
import { useSpaceEvents } from "@/hooks/use-space-events"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import {
  usePageMeta,
  type PageAnnotationsAction,
  type PageMetaChip,
  type PageOverflowAction,
  type PageSecondaryAction,
} from "@/hooks/use-page-meta"
import { DocumentPreview } from "@/components/editor/document-preview"
import { EditorSkeleton } from "@/components/editor/editor-skeleton"
import { MarkdownViewer } from "@/components/editor/markdown-viewer"
import { AnnotationPanel } from "@/components/annotations/annotation-panel"
import { DesktopContextPanel } from "@/components/desktop-context-panel"
import {
  AnnotationComposer,
  type AnnotationDraft,
} from "@/components/annotations/annotation-composer"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
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
import { toast } from "@worktable/ui/components/sonner"
import * as Y from "yjs"
import { WebsocketProvider } from "y-websocket"
import { IndexeddbPersistence } from "y-indexeddb"

// Lazy-load the editor (pulls in BlockNote, Mermaid, Shiki)
const loadEditor = () => import("@/components/editor/editor")
const Editor = lazy(() => loadEditor().then((m) => ({ default: m.Editor })))

export function preloadDocEditor(formatId?: string): Promise<unknown> {
  return formatId === "worktable.rich-text" ? loadEditor() : Promise.resolve()
}

export function DocDocumentRenderer({
  spaceId,
  documentPath,
  formatId,
}: {
  spaceId: string
  documentPath: string
  formatId?: string
}) {
  // This is a download hint only. DocEditorPage still validates the actual
  // path/format after mounting before it creates any collaborative state.
  useEffect(() => {
    void preloadDocEditor(formatId).catch(() => {})
  }, [formatId])
  return (
    <DocEditorPage
      key={`${spaceId}/${documentPath}`}
      spaceId={spaceId}
      docPath={documentPath}
    />
  )
}

// ── Sync Status Pill ─────────────────────────────────────────

type SyncState = "connecting" | "synced" | "disconnected"

function SyncStatusPill({ provider }: { provider: WebsocketProvider }) {
  const [state, setState] = useState<SyncState>("connecting")

  useEffect(() => {
    const onSync = (isSynced: boolean) => {
      if (isSynced) setState("synced")
    }
    const onStatus = ({ status }: { status: string }) => {
      if (status === "connected") {
        // Will flip to synced once sync event fires
      } else if (status === "connecting") {
        setState("connecting")
      } else if (status === "disconnected") {
        setState("disconnected")
      }
    }

    provider.on("sync", onSync)
    provider.on("status", onStatus)

    // Set initial state
    if (provider.synced) {
      setState("synced")
    } else if (provider.wsconnected) {
      setState("connecting")
    }

    return () => {
      provider.off("sync", onSync)
      provider.off("status", onStatus)
    }
  }, [provider])

  const config = {
    connecting: {
      icon: Loader2,
      text: "Syncing",
      className: "text-muted-foreground",
      iconClassName: "animate-spin",
    },
    synced: {
      icon: Wifi,
      text: "Synced",
      className: "text-emerald-600 dark:text-emerald-400",
      iconClassName: "",
    },
    disconnected: {
      icon: WifiOff,
      text: "Offline",
      className: "text-amber-600 dark:text-amber-400",
      iconClassName: "",
    },
  }[state]

  const Icon = config.icon

  // Hide the pill after being synced for a while
  const [visible, setVisible] = useState(true)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)

    if (state === "synced") {
      hideTimerRef.current = setTimeout(() => setVisible(false), 1800)
    } else {
      setVisible(true)
    }

    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [state])

  if (!visible) return null

  return (
    <div
      // --app-sidebar-width (set by the root layout) tracks the live sidebar
      // width — 0 when collapsed or on mobile — so the pill clears the
      // sidebar at any drag-resized width.
      className="fixed bottom-4 left-[calc(var(--app-sidebar-width,0px)+1rem)] z-40 rounded-full bg-popover/95 px-3 py-1.5 shadow-lg ring-1 ring-border/60 backdrop-blur-sm transition-all duration-200"
    >
      <div
        className={`flex items-center gap-1.5 text-xs font-medium transition-colors duration-200 ${config.className}`}
      >
        <Icon className={`h-3.5 w-3.5 ${config.iconClassName}`} />
        <span>{config.text}</span>
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────

function formatUpdatedAt(
  provenance: DocMeta["provenance"],
  fallbackUpdatedAt?: number
): string {
  const raw =
    provenance?.updatedAt ??
    (fallbackUpdatedAt ? new Date(fallbackUpdatedAt).toISOString() : null)
  if (!raw) return "Not versioned yet"
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return "Updated recently"
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function provenanceLabel(provenance: DocMeta["provenance"]): string {
  if (!provenance) return "No provenance yet"
  const by = provenance.updatedBy || "unknown"
  const source = provenance.source || "unknown"
  return `${by} via ${source}`
}

function docChip(doc: DocMeta): PageMetaChip | undefined {
  if (!doc.provenance && !doc.freshness) return undefined
  const category = docAttribution(doc.provenance, doc.freshness)
  return {
    label: CATEGORY_LABELS[category],
    agent: category === "agent",
    updatedAtIso: doc.provenance?.updatedAt ?? null,
    stale: doc.freshness?.stale ?? false,
    reviewed: doc.freshness?.humanReviewed ?? false,
    staleDetail: doc.freshness?.stale ? staleTitle(doc.freshness) : undefined,
  }
}

function DocPageMeta({
  spaceId,
  doc,
  onVersionHistory,
  onMarkReviewed,
  onConvertToMarkdown,
  onCopyMarkdown,
  onDownload,
  onRecoverOfflineEdits,
  secondaryAction,
  annotations,
}: {
  spaceId: string
  doc: DocMeta
  onVersionHistory?: () => void
  onMarkReviewed?: () => void
  onConvertToMarkdown?: () => void
  onCopyMarkdown?: () => void
  onDownload?: () => void
  onRecoverOfflineEdits?: () => void
  secondaryAction?: PageSecondaryAction
  annotations?: PageAnnotationsAction
}) {
  const { setPageMeta } = usePageMeta()
  const { data: spaceDetail } = useSpace(spaceId)
  const shareable = Boolean(
    spaceDetail && !spaceDetail.space.settings["archive"] && !doc.archived
  )
  const chip = useMemo(() => docChip(doc), [doc])
  const overflowActions = useMemo<PageOverflowAction[]>(() => {
    const actions: PageOverflowAction[] = []

    if (onRecoverOfflineEdits) {
      actions.push({
        id: "recover-offline-edits",
        label: "Recover Offline Edits",
        icon: RotateCcw,
        onSelect: onRecoverOfflineEdits,
      })
    }

    if (onVersionHistory) {
      actions.push({
        id: "version-history",
        label: "Version History",
        icon: History,
        onSelect: onVersionHistory,
      })
    }
    if (chip && !chip.reviewed && !doc.archived && onMarkReviewed) {
      actions.push({
        id: "mark-reviewed",
        label: "Mark Reviewed",
        icon: BadgeCheck,
        onSelect: onMarkReviewed,
      })
    }
    if (onConvertToMarkdown) {
      actions.push({
        id: "convert-to-markdown",
        label: "Save Markdown",
        icon: ArrowRightLeft,
        onSelect: onConvertToMarkdown,
        separatorBefore: actions.length > 0,
      })
    }
    if (onCopyMarkdown) {
      actions.push({
        id: "copy-markdown",
        label: "Copy Markdown",
        icon: Copy,
        onSelect: onCopyMarkdown,
        separatorBefore: actions.length > 0 && !onConvertToMarkdown,
      })
    }
    if (onDownload) {
      actions.push(
        {
          id: "download-markdown",
          label: "Download Markdown",
          icon: Download,
          onSelect: onDownload,
        },
        {
          id: "print-pdf",
          label: "Print PDF",
          icon: Printer,
          onSelect: () => window.print(),
        }
      )
    }

    return actions
  }, [
    chip,
    doc.archived,
    onConvertToMarkdown,
    onCopyMarkdown,
    onDownload,
    onMarkReviewed,
    onRecoverOfflineEdits,
    onVersionHistory,
  ])

  useEffect(() => {
    setPageMeta({
      updatedAtLabel: formatUpdatedAt(doc.provenance, doc.updatedAt),
      provenanceLabel: provenanceLabel(doc.provenance),
      chip,
      overflowActions,
      secondaryAction,
      annotations,
      shareTarget: shareable
        ? { kind: "doc", spaceId, artifactKey: doc.path }
        : undefined,
    })

    return () => setPageMeta(null)
  }, [
    doc,
    chip,
    overflowActions,
    secondaryAction,
    annotations,
    shareable,
    spaceId,
    setPageMeta,
  ])

  return null
}

// Reading a doc for a sustained period counts as a review: after 30s of
// visible dwell plus at least one interaction, record the checkpoint the
// reader would otherwise have to click for. Fires at most once per doc view
// and only while the newest version is not already a human touch. `ready`
// gates the timer on the content actually being on screen — a slow editor
// sync must not count as reading.
const INFERRED_REVIEW_DWELL_MS = 30_000

function useInferredReview(
  doc: DocMeta | undefined,
  ready: boolean,
  markReviewed: () => Promise<unknown>
) {
  const eligible = Boolean(
    ready && doc?.freshness && !doc.freshness.humanReviewed && !doc.archived
  )
  const eligibleRef = useRef(eligible)
  eligibleRef.current = eligible
  const firedRef = useRef(false)
  const docPath = doc?.path

  useEffect(() => {
    firedRef.current = false
  }, [docPath])

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
          // Let a later tick retry rather than silently giving up for the visit.
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
  }, [eligible, docPath, markReviewed])
}

function DocEditorPage({
  spaceId,
  docPath,
}: {
  spaceId: string
  docPath: string
}) {
  const router = useRouter()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const spaceEvents = useSpaceEvents(spaceId)

  const docOptions = docQueryOptions(spaceId, docPath)
  // A move can land after the common page resolves but before this legacy
  // renderer mounts. Do not let a fresh-looking cache entry authorize the
  // editor or its Yjs room: require evidence produced after this mount.
  const {
    isLoading,
    isFetchedAfterMount,
    error,
    data: docData,
  } = useQuery({
    ...docOptions,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  })

  const [converting, setConverting] = useState(false)
  const [convertingToMarkdown, setConvertingToMarkdown] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [offlineRecoveryCacheKey, setOfflineRecoveryCacheKey] = useState<
    string | null
  >(null)
  const [recoveringOfflineEdits, setRecoveringOfflineEdits] = useState(false)
  const [recoveryScanVersion, setRecoveryScanVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    const epochs = docData?.collaborationCacheEpochHistory ?? []
    const findRecovery = async () => {
      for (const epoch of epochs) {
        const cacheKey = workspaceCollaborationCacheKey(
          spaceId,
          docPath,
          docData!.collaborationEpoch,
          epoch
        )
        if (
          localStorage.getItem(offlineRecoveryMarker(cacheKey)) === "handled"
        ) {
          continue
        }
        if (await indexedDbExists(cacheKey)) {
          if (!cancelled) setOfflineRecoveryCacheKey(cacheKey)
          return
        }
      }
      if (!cancelled) setOfflineRecoveryCacheKey(null)
    }
    void findRecovery()
    return () => {
      cancelled = true
    }
  }, [docData, docPath, recoveryScanVersion, spaceId])

  const recoverOfflineEdits = useCallback(async () => {
    if (!offlineRecoveryCacheKey || recoveringOfflineEdits) return
    setRecoveringOfflineEdits(true)
    const recoveryDoc = new Y.Doc()
    const recoveryStore = new IndexeddbPersistence(
      offlineRecoveryCacheKey,
      recoveryDoc
    )
    try {
      await recoveryStore.whenSynced
      const { blocksFromCollaborationDoc } =
        await import("@/components/editor/editor")
      const blocks = await blocksFromCollaborationDoc(recoveryDoc)
      if (blocks.length === 0) {
        localStorage.setItem(
          offlineRecoveryMarker(offlineRecoveryCacheKey),
          "handled"
        )
        toast.info("No offline edits found")
      } else {
        const title = `${docPath.split("/").filter(Boolean).at(-1) || "Doc"} offline edits`
        const recovered = await createDoc(spaceId, title, blocks)
        localStorage.setItem(
          offlineRecoveryMarker(offlineRecoveryCacheKey),
          "handled"
        )
        await queryClient.invalidateQueries({
          queryKey: docQueryKeys.docs(spaceId),
        })
        toast.success("Offline edits recovered")
        await navigate({
          to: "/spaces/$spaceId/documents/$",
          params: { spaceId, _splat: recovered.path },
        })
      }
      setOfflineRecoveryCacheKey(null)
      setRecoveryScanVersion((value) => value + 1)
    } catch (error) {
      console.error("Offline edit recovery failed:", error)
      toast.error("Couldn’t recover offline edits. Try again.")
    } finally {
      recoveryStore.destroy()
      recoveryDoc.destroy()
      setRecoveringOfflineEdits(false)
    }
  }, [
    docPath,
    navigate,
    offlineRecoveryCacheKey,
    queryClient,
    recoveringOfflineEdits,
    spaceId,
  ])

  useEffect(() => {
    if (!offlineRecoveryCacheKey) return
    toast.info("Offline edits are available", {
      id: `offline-recovery-${spaceId}-${docPath}`,
      duration: 15_000,
      action: {
        label: "Recover",
        onClick: () => void recoverOfflineEdits(),
      },
    })
  }, [docPath, offlineRecoveryCacheKey, recoverOfflineEdits, spaceId])

  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        void queryClient.invalidateQueries({
          queryKey: docQueryKeys.doc(spaceId, docPath),
        })
      }
    }
    document.addEventListener("visibilitychange", handleVisibility)
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility)
  }, [queryClient, spaceId, docPath])

  useEffect(() => {
    return spaceEvents.subscribe((msg) => {
      if (
        (msg.type === "doc_update" &&
          (!msg.docPath || msg.docPath === docPath)) ||
        (msg.type === "doc_deleted" && msg.docPath === docPath)
      ) {
        void queryClient.invalidateQueries({
          queryKey: docQueryKeys.doc(spaceId, docPath),
        })
      }
      if (
        msg.type === "annotation_update" ||
        msg.type === "annotation_deleted"
      ) {
        void queryClient.invalidateQueries({
          queryKey: annotationQueryKeys.doc(spaceId, docPath, true),
        })
      }
    })
  }, [spaceEvents, queryClient, spaceId, docPath])

  const handleConvert = useCallback(async () => {
    setConverting(true)
    try {
      await convertDoc(spaceId, docPath)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: docQueryKeys.doc(spaceId, docPath),
        }),
        queryClient.invalidateQueries({
          queryKey: docQueryKeys.docs(spaceId),
        }),
      ])
      await router.invalidate()
    } catch (err) {
      console.error("Conversion failed:", err)
      toast.error("Couldn’t edit this doc. Try again.")
    } finally {
      setConverting(false)
    }
  }, [spaceId, docPath, queryClient, router])

  const handleConvertToMarkdown = useCallback(async () => {
    setConvertingToMarkdown(true)
    try {
      await convertDocToMarkdown(spaceId, docPath)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: docQueryKeys.doc(spaceId, docPath),
        }),
        queryClient.invalidateQueries({
          queryKey: docQueryKeys.docs(spaceId),
        }),
      ])
      await router.invalidate()
      toast.success("Markdown saved")
    } catch (err) {
      console.error("Saving as Markdown failed:", err)
      toast.error(
        err instanceof HttpError && (err.status === 409 || err.status === 422)
          ? err.message
          : "Couldn’t save Markdown. Try again."
      )
    } finally {
      setConvertingToMarkdown(false)
    }
  }, [spaceId, docPath, queryClient, router])

  const handleRestore = useCallback(async () => {
    setRestoring(true)
    try {
      await restoreDoc(spaceId, docPath)
      await router.invalidate()
      toast.success("Doc restored")
    } catch (err) {
      console.error("Restore failed:", err)
      toast.error("Couldn’t restore this doc. Try again.")
    } finally {
      setRestoring(false)
    }
  }, [spaceId, docPath, router])

  // Manual click and inferred dwell can race; dedupe by sharing one in-flight
  // request and latching on the versionId already reviewed (a review changes
  // the versionId, so the latch clears itself when the doc changes again).
  const reviewedVersionRef = useRef<string | null>(null)
  const reviewInFlightRef = useRef<Promise<void> | null>(null)
  const currentVersionId = docData?.provenance?.versionId ?? null

  useEffect(() => {
    // Both refs are per-doc state: the latch must not leak across navigation,
    // or the "none" sentinel would mark every unversioned doc as reviewed.
    reviewInFlightRef.current = null
    reviewedVersionRef.current = null
  }, [spaceId, docPath])

  /** Resolves true only for the call that initiated a POST — no-op joins and
   *  latched calls resolve false so callers don't report work they didn't do. */
  const markReviewed = useCallback((): Promise<boolean> => {
    // "none" stands in for docs without provenance (pre-versioning), so the
    // latch still blocks repeat POSTs while cached data has no versionId.
    const latchKey = currentVersionId ?? "none"
    if (reviewedVersionRef.current === latchKey) return Promise.resolve(false)
    if (reviewInFlightRef.current)
      return reviewInFlightRef.current.then(() => false)
    const request = (async () => {
      try {
        const result = await reviewDoc(spaceId, docPath)
        reviewedVersionRef.current = latchKey
        // The route returns the post-review state; write it into the cache so
        // the chip flips and the button hides immediately instead of after
        // the refetch round-trip.
        if (result.provenance || result.freshness) {
          queryClient.setQueryData(
            docQueryKeys.doc(spaceId, docPath),
            (old: DocMeta | undefined) =>
              old
                ? {
                    ...old,
                    provenance: result.provenance ?? old.provenance,
                    freshness: result.freshness ?? old.freshness,
                  }
                : old
          )
        }
        void queryClient.invalidateQueries({
          queryKey: docQueryKeys.docs(spaceId),
        })
      } finally {
        reviewInFlightRef.current = null
      }
    })()
    reviewInFlightRef.current = request
    return request.then(() => true)
  }, [spaceId, docPath, queryClient, currentVersionId])

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

  const handleCopyMarkdown = useCallback(() => {
    exportDocMarkdown(spaceId, docPath)
      .then(copyText)
      .then(() => toast.success("Copied as Markdown"))
      .catch((err) => {
        console.error("Copy failed:", err)
        toast.error("Couldn’t copy this doc. Try again.")
      })
  }, [spaceId, docPath])

  // No success toast: the browser's own download UI is the confirmation.
  const handleDownload = useCallback(() => {
    downloadDocMarkdown(spaceId, docPath).catch((err) => {
      console.error("Download failed:", err)
      toast.error("Couldn’t download this doc. Try again.")
    })
  }, [spaceId, docPath])

  if (!isFetchedAfterMount || isLoading) {
    return <EditorSkeleton />
  }

  if (error || !docData) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-lg font-medium text-muted-foreground">
            Doc not found
          </p>
          <p className="mt-1 text-sm text-muted-foreground/60">
            The doc &ldquo;{docPath}&rdquo; does not exist in this space.
          </p>
        </div>
      </div>
    )
  }

  if (docData.path !== docPath) {
    // Alias reads return the canonical path. Redirect before mounting a
    // BlockNote editor so an old URL never opens an obsolete Yjs room.
    return (
      <Navigate
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId, _splat: docData.path }}
        search={(previous) => previous}
        hash={(previous) => previous ?? ""}
        replace
      />
    )
  }

  if (docData.format === "markdown" && typeof docData.content === "string") {
    return (
      <MarkdownDocPage
        spaceId={spaceId}
        docPath={docPath}
        archived={Boolean(docData.archived)}
        doc={docData}
        onRestore={handleRestore}
        restoring={restoring}
        content={docData.content}
        onConvert={handleConvert}
        converting={converting}
        onMarkReviewed={handleMarkReviewed}
        onCopyMarkdown={handleCopyMarkdown}
        onDownload={handleDownload}
        onRecoverOfflineEdits={
          offlineRecoveryCacheKey && !recoveringOfflineEdits
            ? () => void recoverOfflineEdits()
            : undefined
        }
        onInferredReview={markReviewed}
      />
    )
  }

  return (
    <BlockNoteDocPage
      spaceId={spaceId}
      docPath={docPath}
      archived={Boolean(docData.archived)}
      doc={docData}
      onRestore={handleRestore}
      restoring={restoring}
      onMarkReviewed={handleMarkReviewed}
      onConvertToMarkdown={
        !docData.archived && docData.markdownCompatible !== false
          ? handleConvertToMarkdown
          : undefined
      }
      convertingToMarkdown={convertingToMarkdown}
      onCopyMarkdown={handleCopyMarkdown}
      onDownload={handleDownload}
      onRecoverOfflineEdits={
        offlineRecoveryCacheKey && !recoveringOfflineEdits
          ? () => void recoverOfflineEdits()
          : undefined
      }
      onInferredReview={markReviewed}
    />
  )
}

function ArchivedDocBanner({
  archived,
  onRestore,
  restoring,
}: {
  archived: boolean
  onRestore: () => void
  restoring: boolean
}) {
  if (!archived) return null

  return (
    <div className="border-b border-border bg-amber-50/80 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100 print:hidden">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 shrink-0" />
          <span>
            This doc is archived and hidden from the main doc list by default.
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

function MarkdownDocPage({
  spaceId,
  docPath,
  archived,
  doc,
  onRestore,
  restoring,
  content,
  onConvert,
  converting,
  onMarkReviewed,
  onCopyMarkdown,
  onDownload,
  onRecoverOfflineEdits,
  onInferredReview,
}: {
  spaceId: string
  docPath: string
  archived: boolean
  doc: DocMeta
  onRestore: () => void
  restoring: boolean
  content: string
  onConvert: () => void
  converting: boolean
  onMarkReviewed?: () => void
  onCopyMarkdown?: () => void
  onDownload?: () => void
  onRecoverOfflineEdits?: () => void
  onInferredReview: () => Promise<unknown>
}) {
  const secondaryAction = useMemo<PageSecondaryAction>(
    () => ({
      label: "Edit",
      displayLabel: "Edit",
      icon: Pencil,
      pending: converting,
      onClick: onConvert,
    }),
    [converting, onConvert]
  )
  const queryClient = useQueryClient()
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versionsRailExpanded, setVersionsRailExpanded] = useState(false)
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null)
  const [compareVersion, setCompareVersion] =
    useState<DocVersionSnapshot | null>(null)
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null
  )
  const [belowXl, setBelowXl] = useState(false)
  const annotationsQuery = useDocAnnotations(spaceId, docPath, true)
  const annotationMutations = useAnnotationMutations(spaceId, docPath)
  const annotations = annotationsQuery.data?.annotations ?? []
  const openAnnotationCount = annotations.filter(
    (annotation) => annotation.status !== "resolved"
  ).length
  const annotationsAction = useMemo<PageAnnotationsAction>(
    () => ({
      count: openAnnotationCount,
      open: annotationsOpen,
      onToggle: () => {
        if (!annotationsOpen) {
          setCompareVersionId(null)
          setVersionsOpen(false)
        }
        setAnnotationsOpen(!annotationsOpen)
      },
    }),
    [annotationsOpen, openAnnotationCount]
  )
  const openVersions = useCallback(() => {
    setVersionsOpen(true)
    setAnnotationsOpen(false)
  }, [])
  const selectAnnotation = useCallback((annotation: Annotation) => {
    setActiveAnnotationId(annotation.id)
    setAnnotationsOpen(true)
    setVersionsOpen(false)
    setVersionsRailExpanded(false)
    setCompareVersionId(null)
  }, [])

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1279px)")
    const update = () => setBelowXl(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!compareVersionId) {
      setCompareVersion(null)
      return
    }
    readDocVersion(spaceId, docPath, compareVersionId)
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
  }, [spaceId, docPath, compareVersionId])

  // The markdown viewer renders synchronously, so the content is on screen
  // as soon as this component is.
  useInferredReview(doc, true, onInferredReview)
  return (
    <div className="flex h-full flex-col">
      <DocPageMeta
        spaceId={spaceId}
        doc={doc}
        onMarkReviewed={onMarkReviewed}
        onCopyMarkdown={onCopyMarkdown}
        onDownload={onDownload}
        onRecoverOfflineEdits={onRecoverOfflineEdits}
        secondaryAction={secondaryAction}
        onVersionHistory={openVersions}
        annotations={annotationsAction}
      />
      <ArchivedDocBanner
        archived={archived}
        onRestore={onRestore}
        restoring={restoring}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`min-w-0 overflow-hidden ${compareVersionId && !belowXl ? "flex-[1_1_50%] border-r border-border print:flex-1 print:border-r-0" : "flex-1"}`}
        >
          <MarkdownViewer
            content={content}
            spaceId={spaceId}
            docPath={docPath}
          />
        </div>

        {compareVersionId && (
          <div className="hidden min-w-0 flex-[1_1_50%] flex-col overflow-hidden bg-muted/10 xl:flex print:hidden">
            <div className="flex shrink-0 items-center justify-between gap-3 px-6 pt-4 pb-2 text-xs">
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
            <Suspense fallback={<EditorSkeleton />}>
              {compareVersion && Array.isArray(compareVersion.after.content) ? (
                <Editor
                  initialContent={compareVersion.after.content as never[]}
                  editable={false}
                />
              ) : compareVersion &&
                typeof compareVersion.after.content === "string" ? (
                <MarkdownViewer
                  content={compareVersion.after.content}
                  spaceId={spaceId}
                  docPath={docPath}
                />
              ) : (
                <EditorSkeleton />
              )}
            </Suspense>
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
            className="bg-transparent"
          />
        </DesktopContextPanel>

        <VersionHistoryPanel
          spaceId={spaceId}
          docPath={docPath}
          open={(versionsOpen || Boolean(compareVersionId)) && !belowXl}
          compact={Boolean(compareVersionId) && !versionsRailExpanded}
          drawerMode={false}
          selectedVersionId={compareVersionId}
          onSelect={(versionId) => {
            setCompareVersionId(versionId)
            setVersionsOpen(true)
            setVersionsRailExpanded(false)
          }}
          onClose={() => {
            setVersionsOpen(false)
            setVersionsRailExpanded(false)
          }}
          onToggleCompact={() => setVersionsRailExpanded((value) => !value)}
          onExitCompare={() => setCompareVersionId(null)}
          onRestored={() => {
            void queryClient.invalidateQueries({
              queryKey: docQueryKeys.doc(spaceId, docPath),
            })
            setCompareVersionId(null)
          }}
        />
      </div>

      {belowXl && (
        <>
          <VersionHistoryPanel
            spaceId={spaceId}
            docPath={docPath}
            open={versionsOpen}
            compact={false}
            drawerMode
            onClose={() => {
              setVersionsOpen(false)
              setVersionsRailExpanded(false)
            }}
            onRestored={() => {
              void queryClient.invalidateQueries({
                queryKey: docQueryKeys.doc(spaceId, docPath),
              })
            }}
          />
          <Drawer
            open={annotationsOpen}
            onOpenChange={setAnnotationsOpen}
            repositionInputs={false}
          >
            <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[86dvh]">
              <DrawerTitle className="sr-only">Annotations</DrawerTitle>
              <DrawerDescription className="sr-only">
                Annotations for this doc.
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
                className="max-h-[calc(86dvh-1.5rem)]"
              />
            </DrawerContent>
          </Drawer>
        </>
      )}
    </div>
  )
}

// Custom Yjs message (mirrors the server's MESSAGE_INTENT = 43): tells the
// server this session has a genuine local (human) edit, so the resulting
// persist is attributed to a human rather than treated as machine drift.
const YJS_MESSAGE_PING = 42
const YJS_MESSAGE_INTENT = 43
const INTENT_FRAME = new Uint8Array([YJS_MESSAGE_INTENT])

function offlineRecoveryMarker(cacheKey: string): string {
  return `worktable-offline-recovery:${cacheKey}`
}

async function indexedDbExists(name: string): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") return true
  const databases = await indexedDB.databases()
  return databases.some((database) => database.name === name)
}

/** Returns whether the frame was actually delivered to an open socket. */
function sendIntentFrame(provider: WebsocketProvider | null): boolean {
  const ws = provider?.ws
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(INTENT_FRAME)
    return true
  }
  return false
}

function BlockNoteDocPage({
  spaceId,
  docPath,
  archived,
  doc,
  onRestore,
  restoring,
  onMarkReviewed,
  onConvertToMarkdown,
  convertingToMarkdown,
  onCopyMarkdown,
  onDownload,
  onRecoverOfflineEdits,
  onInferredReview,
}: {
  spaceId: string
  docPath: string
  archived: boolean
  doc: DocMeta
  onRestore: () => void
  restoring: boolean
  onMarkReviewed?: () => void
  onConvertToMarkdown?: () => void
  convertingToMarkdown: boolean
  onCopyMarkdown?: () => void
  onDownload?: () => void
  onRecoverOfflineEdits?: () => void
  onInferredReview: () => Promise<unknown>
}) {
  const ydocRef = useRef<Y.Doc | null>(null)
  const idbRef = useRef<IndexeddbPersistence | null>(null)
  const wsProviderRef = useRef<WebsocketProvider | null>(null)
  // A genuine local edit happened whose intent the server has NOT consumed
  // yet (the server sends MESSAGE_INTENT back only when a persist attributes
  // or spends the signal — a mere delivery receipt would be lost with the
  // server process if it crashed before the debounced persist). Only this —
  // never "edited at some point this session" — may be replayed on reconnect:
  // a consumed edit is durably attributed, and replaying it would defeat the
  // server's stale-cache protection over fresh agent versions.
  const pendingIntentRef = useRef(false)
  // Current known provenance, read at connect time to send the freshness base.
  const provenanceRef = useRef(doc.provenance)
  provenanceRef.current = doc.provenance
  const collaborationEpoch = doc.collaborationEpoch
  const collaborationCacheEpoch = doc.collaborationCacheEpoch
  const [provider, setProvider] = useState<WebsocketProvider | null>(null)
  const editorPaneRef = useRef<HTMLDivElement>(null)
  const previewScrollTop = useRef(0)
  const [readyEditor, setReadyEditor] = useState<WebsocketProvider | null>(null)
  const [readyContent, setReadyContent] = useState<WebsocketProvider | null>(
    null
  )
  const handleEditorReady = useCallback(
    () => setReadyEditor(provider),
    [provider]
  )
  const editorReadable = Boolean(
    provider && readyEditor === provider && readyContent === provider
  )
  useEffect(() => {
    if (!editorReadable) return
    const scrollRoot = editorPaneRef.current?.querySelector(
      ".worktable-editor-scroll-root"
    )
    if (scrollRoot) scrollRoot.scrollTop = previewScrollTop.current
  }, [editorReadable])
  const [collabDoc, setCollabDoc] = useState<Y.Doc | null>(null)
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [versionsRailExpanded, setVersionsRailExpanded] = useState(false)
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null)
  const [compareVersion, setCompareVersion] =
    useState<DocVersionSnapshot | null>(null)
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null
  )
  const [composerDraft, setComposerDraft] = useState<AnnotationDraft | null>(
    null
  )
  const [composerOpen, setComposerOpen] = useState(false)
  const [belowXl, setBelowXl] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1279px)")
    const update = () => setBelowXl(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])
  const queryClient = useQueryClient()
  const annotationsQuery = useDocAnnotations(spaceId, docPath, true)
  const annotationMutations = useAnnotationMutations(spaceId, docPath)
  const annotations = annotationsQuery.data?.annotations ?? []
  const openAnnotationCount = annotations.filter(
    (annotation) => annotation.status !== "resolved"
  ).length
  const annotationsAction = useMemo<PageAnnotationsAction>(
    () => ({
      count: openAnnotationCount,
      open: annotationsOpen,
      onToggle: () => {
        if (!annotationsOpen) {
          setCompareVersionId(null)
          setVersionsOpen(false)
        }
        setAnnotationsOpen(!annotationsOpen)
      },
    }),
    [annotationsOpen, openAnnotationCount]
  )
  const openVersions = useCallback(() => {
    setVersionsOpen(true)
    setAnnotationsOpen(false)
  }, [])

  useEffect(() => {
    const wsUrl =
      import.meta.env.VITE_WS_URL ??
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`

    // Fresh session for this doc: nothing to replay.
    pendingIntentRef.current = false

    const ydoc = new Y.Doc()
    ydocRef.current = ydoc

    const roomName = `${spaceId}/${docPath}`
    const cacheKey = workspaceCollaborationCacheKey(
      spaceId,
      docPath,
      collaborationEpoch,
      collaborationCacheEpoch
    )

    const idbProvider = new IndexeddbPersistence(cacheKey, ydoc)
    idbRef.current = idbProvider

    idbProvider.on("synced", () => {
      // Send the version/hash we currently show so the server can flag this
      // connection as stale if the doc changed underneath us.
      const base = provenanceRef.current
      const params: Record<string, string> = {
        collaborationEpoch,
        collaborationCacheEpoch,
      }
      if (base?.versionId) params.baseVersionId = base.versionId
      if (base?.contentHash) params.baseContentHash = base.contentHash

      const p = new WebsocketProvider(`${wsUrl}/yjs`, roomName, ydoc, {
        connect: false,
        params,
      })

      // The server sends MESSAGE_INTENT back when a persist CONSUMES the edit
      // signal (attributes a write, or spends it on a semantic no-op); only
      // that clears the pending flag. Intent whose edit was never durably
      // attributed — frame lost to a dropping socket, or the server crashing
      // before its debounced persist — therefore replays on reconnect, while
      // consumed intent never does: replaying it would let a stale reconnect
      // bypass the server's stale-cache guard over a fresh agent version.
      // (The ping handler just silences y-websocket's unknown-message error
      // for the server's keepalive frames.)
      p.messageHandlers[YJS_MESSAGE_PING] = () => {}
      p.messageHandlers[YJS_MESSAGE_INTENT] = () => {
        pendingIntentRef.current = false
      }

      // On (re)connect, deliver only an UNCONSUMED edit signal (its Yjs
      // update replays from local state now too).
      p.on("status", ({ status }: { status: string }) => {
        if (status === "connected" && pendingIntentRef.current) {
          sendIntentFrame(p)
        }
      })

      // Cached offline content can be used immediately. Otherwise keep the
      // saved preview until the first server sync, including for empty docs.
      if (ydoc.getXmlFragment("document-store").length > 0) setReadyContent(p)
      p.on("sync", (synced: boolean) => {
        if (synced) setReadyContent(p)
      })
      p.connect()
      wsProviderRef.current = p

      setProvider(p)
      setCollabDoc(ydoc)
    })

    const handleVisibility = () => {
      const ws = wsProviderRef.current
      if (!ws) return

      if (document.hidden) {
        ws.disconnect()
      } else {
        ws.connect()
      }
    }

    document.addEventListener("visibilitychange", handleVisibility)

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility)

      if (wsProviderRef.current) {
        wsProviderRef.current.destroy()
        wsProviderRef.current = null
      }
      idbProvider.destroy()
      ydoc.destroy()
      ydocRef.current = null
      idbRef.current = null
      setProvider(null)
      setCollabDoc(null)
    }
  }, [spaceId, docPath, collaborationEpoch, collaborationCacheEpoch])

  useEffect(() => {
    let cancelled = false
    if (!compareVersionId) {
      setCompareVersion(null)
      return
    }
    readDocVersion(spaceId, docPath, compareVersionId)
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
  }, [spaceId, docPath, compareVersionId])

  const selectAnnotation = useCallback((annotation: Annotation) => {
    setActiveAnnotationId(annotation.id)
    setAnnotationsOpen(true)
    setVersionsOpen(false)
    setVersionsRailExpanded(false)
    setCompareVersionId(null)
    if ("blockId" in annotation.target && annotation.target.blockId) {
      const node = document.querySelector(
        `[data-id="${CSS.escape(annotation.target.blockId)}"]`
      )
      node?.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }, [])

  // A genuine local edit: tell the server so its next persist is attributed to
  // a human. Idempotent — safe to fire on every keystroke; the server just
  // re-marks the same flag. Pending until a persist consumes the signal (see
  // the message handler above), so intent that never became durable replays
  // on reconnect along with the edit it describes.
  const handleLocalEdit = useCallback(() => {
    pendingIntentRef.current = true
    sendIntentFrame(wsProviderRef.current)
  }, [])

  // Dwell only counts once the editor is actually showing content — while
  // the Yjs/IndexedDB sync is still on the skeleton, nobody is reading.
  useInferredReview(doc, editorReadable, onInferredReview)

  return (
    <div className="flex h-full flex-col">
      <DocPageMeta
        spaceId={spaceId}
        doc={doc}
        onVersionHistory={openVersions}
        onMarkReviewed={onMarkReviewed}
        onConvertToMarkdown={
          convertingToMarkdown ? undefined : onConvertToMarkdown
        }
        onCopyMarkdown={onCopyMarkdown}
        onDownload={onDownload}
        onRecoverOfflineEdits={onRecoverOfflineEdits}
        annotations={annotationsAction}
      />
      <ArchivedDocBanner
        archived={archived}
        onRestore={onRestore}
        restoring={restoring}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`relative min-w-0 overflow-hidden ${compareVersionId && !belowXl ? "flex-[1_1_50%] border-r border-border print:flex-1 print:border-r-0" : "flex-1"}`}
        >
          {!editorReadable && (
            <div className="absolute inset-0 z-10">
              <DocumentPreview
                content={doc.content}
                onScroll={(top) => {
                  previewScrollTop.current = top
                }}
              />
            </div>
          )}
          <div
            ref={editorPaneRef}
            className={`h-full ${editorReadable ? "" : "invisible"}`}
            inert={!editorReadable}
            aria-hidden={!editorReadable}
          >
            {provider && collabDoc && (
              <Suspense fallback={<EditorSkeleton />}>
                <Editor
                  onReady={handleEditorReady}
                  collaboration={{
                    ydoc: collabDoc,
                    provider,
                    fragmentName: "document-store",
                    onLocalEdit: handleLocalEdit,
                  }}
                  editable={!convertingToMarkdown}
                  annotations={annotations}
                  activeAnnotationId={activeAnnotationId}
                  onSelectAnnotation={selectAnnotation}
                  onCreateAnnotation={(draft) => {
                    setComposerDraft(draft)
                    setComposerOpen(true)
                  }}
                />
              </Suspense>
            )}
          </div>
        </div>

        {compareVersionId && (
          <div className="hidden min-w-0 flex-[1_1_50%] flex-col overflow-hidden bg-muted/10 xl:flex print:hidden">
            <div className="flex shrink-0 items-center justify-between gap-3 px-6 pt-4 pb-2 text-xs">
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
            <Suspense fallback={<EditorSkeleton />}>
              {compareVersion && Array.isArray(compareVersion.after.content) ? (
                <Editor
                  initialContent={compareVersion.after.content as never[]}
                  editable={false}
                />
              ) : compareVersion &&
                typeof compareVersion.after.content === "string" ? (
                <MarkdownViewer
                  content={compareVersion.after.content}
                  spaceId={spaceId}
                  docPath={docPath}
                />
              ) : (
                <EditorSkeleton />
              )}
            </Suspense>
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
            className="bg-transparent"
          />
        </DesktopContextPanel>

        <VersionHistoryPanel
          spaceId={spaceId}
          docPath={docPath}
          open={(versionsOpen || Boolean(compareVersionId)) && !belowXl}
          compact={Boolean(compareVersionId) && !versionsRailExpanded}
          drawerMode={false}
          selectedVersionId={compareVersionId}
          onSelect={(versionId) => {
            setCompareVersionId(versionId)
            setVersionsOpen(true)
            setVersionsRailExpanded(false)
          }}
          onClose={() => {
            setVersionsOpen(false)
            setVersionsRailExpanded(false)
          }}
          onToggleCompact={() => setVersionsRailExpanded((value) => !value)}
          onExitCompare={() => setCompareVersionId(null)}
          onRestored={() => {
            void queryClient.invalidateQueries({
              queryKey: docQueryKeys.doc(spaceId, docPath),
            })
            setCompareVersionId(null)
          }}
        />
      </div>

      {belowXl && (
        <>
          <VersionHistoryPanel
            spaceId={spaceId}
            docPath={docPath}
            open={versionsOpen}
            compact={false}
            drawerMode
            onClose={() => {
              setVersionsOpen(false)
              setVersionsRailExpanded(false)
            }}
            onRestored={() => {
              void queryClient.invalidateQueries({
                queryKey: docQueryKeys.doc(spaceId, docPath),
              })
            }}
          />
          <Drawer
            open={annotationsOpen}
            onOpenChange={setAnnotationsOpen}
            repositionInputs={false}
          >
            <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[86dvh]">
              <DrawerTitle className="sr-only">Annotations</DrawerTitle>
              <DrawerDescription className="sr-only">
                Annotations for this doc.
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
                className="max-h-[calc(86dvh-1.5rem)]"
              />
            </DrawerContent>
          </Drawer>
        </>
      )}

      <AnnotationComposer
        key={`${composerDraft?.blockId ?? "none"}-${composerDraft?.category ?? "comment"}`}
        draft={composerDraft}
        open={composerOpen}
        onOpenChange={setComposerOpen}
        onSubmit={(draft, body) => {
          annotationMutations.create.mutate({
            target: {
              type: "block",
              docPath,
              blockId: draft.blockId,
              blockType: draft.blockType,
              quote: draft.quote,
            },
            category: draft.category,
            body,
          })
          setAnnotationsOpen(true)
        }}
      />

      {provider && <SyncStatusPill provider={provider} />}
    </div>
  )
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
            Capture the current doc so you can compare or restore it later.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <label className="space-y-2 text-sm font-medium text-foreground">
            <span>Label</span>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Optional, e.g. Before desktop edits"
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

function sourceDisplay(source: string): string {
  if (source === "browser-yjs") return "You via Browser"
  if (source === "mcp") return "Agent via MCP"
  if (source === "filesystem") return "Filesystem Update"
  if (source === "rest-api") return "API Update"
  if (source === "version-restore") return "Version Restore"
  if (source === "manual-checkpoint") return "Manual Checkpoint"
  return source || "Unknown Source"
}

function compareVersionLabel(version: DocVersionSnapshot | null): string {
  if (!version) return "Loading Version"
  return version.checkpoint?.label ?? sourceDisplay(version.source)
}

function compareVersionDetail(version: DocVersionSnapshot | null): string {
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

function VersionHistoryPanel({
  spaceId,
  docPath,
  open,
  compact,
  drawerMode,
  selectedVersionId = null,
  onSelect,
  onClose,
  onToggleCompact,
  onExitCompare,
  onRestored,
}: {
  spaceId: string
  docPath: string
  open: boolean
  compact: boolean
  drawerMode: boolean
  selectedVersionId?: string | null
  onSelect?: (versionId: string) => void
  onClose: () => void
  onToggleCompact?: () => void
  onExitCompare?: () => void
  onRestored: () => void
}) {
  const [versions, setVersions] = useState<DocVersionEntry[]>([])
  const [showAll, setShowAll] = useState(false)
  const [drawerSelectedVersionId, setDrawerSelectedVersionId] = useState<
    string | null
  >(null)
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  const [restoreVersion, setRestoreVersion] = useState<DocVersionEntry | null>(
    null
  )
  const [savingCheckpoint, setSavingCheckpoint] = useState(false)
  const [restoringVersion, setRestoringVersion] = useState(false)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    if (!open) return
    setLoading(true)
    listDocVersions(spaceId, docPath, showAll)
      .then(setVersions)
      .catch((err) => {
        console.error("Failed to load versions", err)
        toast.error("Failed to load version history")
      })
      .finally(() => setLoading(false))
  }, [spaceId, docPath, showAll, open])

  useEffect(() => refresh(), [refresh])

  if (!drawerMode && (!onSelect || !onToggleCompact || !onExitCompare)) {
    throw new Error("Desktop version history requires compare actions")
  }
  const desktopOnSelect = onSelect as (versionId: string) => void
  const desktopOnToggleCompact = onToggleCompact as () => void
  const desktopOnExitCompare = onExitCompare as () => void

  const activeVersionId = drawerMode
    ? drawerSelectedVersionId
    : selectedVersionId
  const selectedIndex = versions.findIndex(
    (version) => version.id === activeVersionId
  )
  const selected = activeVersionId
    ? versions.find((version) => version.id === activeVersionId)
    : null

  const content = (
    <DocVersionHistoryContent
      versions={versions}
      showAll={showAll}
      setShowAll={setShowAll}
      loading={loading}
      selectedVersionId={activeVersionId}
      onSelect={
        drawerMode
          ? (versionId) =>
              setDrawerSelectedVersionId((current) =>
                current === versionId ? null : versionId
              )
          : desktopOnSelect
      }
      onClose={onClose}
      onToggleCompact={drawerMode ? undefined : desktopOnToggleCompact}
      onSaveCheckpoint={() => setCheckpointOpen(true)}
      onRestore={setRestoreVersion}
      onExitCompare={drawerMode ? undefined : desktopOnExitCompare}
    />
  )

  const dialogs = (
    <>
      <SaveCheckpointDialog
        open={checkpointOpen}
        saving={savingCheckpoint}
        onOpenChange={setCheckpointOpen}
        onSave={async (label) => {
          setSavingCheckpoint(true)
          try {
            await createDocCheckpoint(
              spaceId,
              docPath,
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
        description="This checkpoint will become the current doc."
        confirmLabel="Restore"
        loading={restoringVersion}
        icon={<RotateCcw className="h-5 w-5 text-primary" />}
        onConfirm={async () => {
          if (!restoreVersion) return
          setRestoringVersion(true)
          try {
            await restoreDocVersion(spaceId, docPath, restoreVersion.id)
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

  if (drawerMode) {
    return (
      <>
        <Drawer
          open={open}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) onClose()
          }}
          repositionInputs={false}
        >
          <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[86dvh]">
            <DrawerTitle className="sr-only">Version History</DrawerTitle>
            <DrawerDescription className="sr-only">
              Version history for this doc.
            </DrawerDescription>
            <div className="flex max-h-[calc(86dvh-1.5rem)] min-h-0 flex-col">
              {content}
            </div>
          </DrawerContent>
        </Drawer>
        {dialogs}
      </>
    )
  }

  return (
    <>
      <DesktopContextPanel open={open} width={compact ? 64 : 384}>
        <div className="relative h-full w-full">
          <aside
            className={`absolute inset-0 flex flex-col items-center gap-2 bg-transparent py-4 transition-opacity duration-200 ${compact ? "opacity-100" : "pointer-events-none invisible opacity-0"}`}
          >
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={desktopOnToggleCompact}
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
              onClick={() => desktopOnSelect(versions[selectedIndex + 1].id)}
              aria-label="Previous checkpoint"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={selectedIndex <= 0}
              onClick={() => desktopOnSelect(versions[selectedIndex - 1].id)}
              aria-label="Next checkpoint"
            >
              <RotateCw className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={desktopOnExitCompare}
              aria-label="Exit compare"
            >
              <X className="h-4 w-4" />
            </Button>
          </aside>
          <div
            className={`absolute inset-0 transition-opacity duration-200 ${compact ? "pointer-events-none invisible opacity-0" : "opacity-100"}`}
          >
            {content}
          </div>
        </div>
      </DesktopContextPanel>
      {dialogs}
    </>
  )
}

function DocVersionHistoryContent({
  versions,
  showAll,
  setShowAll,
  loading,
  selectedVersionId,
  onSelect,
  onClose,
  onToggleCompact,
  onSaveCheckpoint,
  onRestore,
  onExitCompare,
}: {
  versions: DocVersionEntry[]
  showAll: boolean
  setShowAll: (updater: (value: boolean) => boolean) => void
  loading: boolean
  selectedVersionId: string | null
  onSelect: (versionId: string) => void
  onClose: () => void
  onToggleCompact?: () => void
  onSaveCheckpoint: () => void
  onRestore: (version: DocVersionEntry) => void
  onExitCompare?: () => void
}) {
  const scrollRef = useScrollFade<HTMLDivElement>()

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-transparent">
      <div className="flex items-center justify-between gap-3 p-4 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <History className="h-4 w-4 shrink-0 text-primary" />
          <h2 className="text-sm font-medium text-foreground">
            Version History
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {selectedVersionId && onToggleCompact ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onToggleCompact}
              aria-label="Collapse version history"
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          ) : null}
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
              Save a checkpoint or edit the doc to create meaningful history.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {versions.map((version) => {
              const active = version.id === selectedVersionId
              const label =
                version.checkpoint?.label ??
                (showAll ? "Raw Version" : "Checkpoint")
              const exact = new Date(version.createdAt).toLocaleString()
              return (
                <article
                  key={version.id}
                  className={`border-l-2 px-3 py-4 transition-colors ${active ? "border-l-primary bg-muted/25" : "border-l-transparent hover:bg-muted/20"}`}
                >
                  <button
                    type="button"
                    className="block w-full text-left"
                    onClick={() => onSelect(version.id)}
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
                    {version.reason ? (
                      <p className="mt-2 line-clamp-2 text-xs text-foreground/80">
                        {version.reason}
                      </p>
                    ) : null}
                  </button>
                  {active ? (
                    <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onRestore(version)}
                      >
                        Restore
                      </Button>
                      {onExitCompare ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={onExitCompare}
                        >
                          Exit Compare
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}

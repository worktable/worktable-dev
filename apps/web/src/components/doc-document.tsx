import { RUNTIME_BASE_PATH } from "@/lib/runtime-path"
import { browserTeamMemberId } from "@/lib/team-context"
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  Loader2,
  Archive,
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
import { docQueryKeys } from "@/lib/docs-queries"
import {
  documentQueryKeys,
  useDocumentContent,
} from "@/lib/documents-queries"
import type { DocumentRendererProps } from "@/lib/document-renderers"
import type { DocumentOpenHint } from "@/lib/document-rows"
import {
  firstHeadingText,
  isCollaborativeSave,
  isLiveDocumentSynced,
  registerLiveDocument,
} from "@/lib/live-documents"
import { useSpace } from "@/lib/queries"
import {
  useAnnotationMutations,
  useDocAnnotations,
} from "@/lib/annotations-queries"
import type {
  Annotation,
  DocumentPage,
  DocumentPageResult,
} from "@worktable/types"
import type { DocVersionEntry, DocVersionSnapshot } from "@/lib/docs-api"
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
} from "@/lib/docs-api"
import { workspaceCollaborationCacheKey } from "@/lib/collaboration-cache"
import { HttpError } from "@/lib/http"
import { copyText } from "@/lib/clipboard"
import { RelativeTime } from "@/lib/time"
import { useSpaceEvents } from "@/hooks/use-space-events"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import {
  useSetPageMeta,
  type PageAnnotationsAction,
  type PageOverflowAction,
  type PageSecondaryAction,
} from "@/hooks/use-page-meta"
import { DocumentPreview } from "@/components/editor/document-preview"
import { useDocName, useNameFromTitleOnLeave } from "@/hooks/use-doc-name"
import { takeJustCreated } from "@/hooks/use-new-doc"
import { DocumentByline } from "@/components/document/document-byline"
import { useBylineState } from "@/hooks/use-byline-state"
import { EditorSkeleton } from "@/components/editor/editor-skeleton"
import { MarkdownViewer } from "@/components/editor/markdown-viewer"
import { AnnotationPanel } from "@/components/annotations/annotation-panel"
import { DesktopContextPanel } from "@/components/desktop-context-panel"
import {
  AnnotationComposer,
  type AnnotationDraft,
} from "@/components/annotations/annotation-composer"
import { Button } from "@worktable/ui/components/button"
import {
  DocumentStatus,
  type DocumentStatusState,
} from "@worktable/ui/components/document-status"
import { preloadableComponent } from "@worktable/ui/lib/preloadable-component"
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
type LoadedEditorProps = ComponentProps<typeof import("@/components/editor/editor").Editor>
const editor = preloadableComponent<LoadedEditorProps>(() =>
  import("@/components/editor/editor").then((module) => ({
    default: module.Editor,
  }))
)
const Editor = editor.Component

export function preloadDocEditor(formatId?: string): Promise<unknown> {
  return formatId === "worktable.rich-text" ? editor.preload() : Promise.resolve()
}

export function DocDocumentRenderer({
  spaceId,
  documentPath,
  formatId,
  page,
  preview,
}: DocumentRendererProps) {
  // This is a download hint only. The editor and its room wait for the
  // route's check of this path.
  useEffect(() => {
    void preloadDocEditor(formatId).catch(() => {})
  }, [formatId])
  return (
    <DocEditorPage
      key={`${spaceId}/${documentPath}`}
      spaceId={spaceId}
      docPath={documentPath}
      page={page}
      preview={preview ?? null}
    />
  )
}

// ── Sync Status Pill ─────────────────────────────────────────

type SyncState = "connecting" | "synced" | "disconnected"

function SyncStatusPill({
  provider,
  ready,
}: {
  provider: WebsocketProvider | null
  ready: boolean
}) {
  const [state, setState] = useState<SyncState>("connecting")

  useEffect(() => {
    if (!provider) {
      setState("connecting")
      return
    }
    const onSync = (isSynced: boolean) => {
      setState(isSynced ? "synced" : "connecting")
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
    } else {
      setState("connecting")
    }

    return () => {
      provider.off("sync", onSync)
      provider.off("status", onStatus)
    }
  }, [provider])

  // A synced socket is not proof that the editor is visible yet.
  const displayState: DocumentStatusState =
    state === "disconnected"
      ? "offline"
      : !ready
        ? "opening"
        : state === "synced"
          ? "synced"
          : "syncing"

  const [visible, setVisible] = useState(true)
  useEffect(() => {
    setVisible(true)
    if (displayState !== "synced") return
    const timer = setTimeout(() => setVisible(false), 1800)
    return () => clearTimeout(timer)
  }, [displayState])

  if (!visible && displayState === "synced") return null
  return <DocumentStatus state={displayState} />
}

// ── Main Page ────────────────────────────────────────────────

/**
 * Publishes the document's header meta. Takes primitives so a re-read of the
 * same document, or a save that only moves its metadata, does not set it again.
 * Actions that change the document or its sharing appear once the route's
 * check has validated the path (`validated`); callers leave them out before.
 */
function DocPageMeta({
  spaceId,
  docPath,
  archived,
  validated,
  onVersionHistory,
  onConvertToMarkdown,
  onCopyMarkdown,
  onDownload,
  onRecoverOfflineEdits,
  secondaryAction,
  annotations,
}: {
  spaceId: string
  docPath: string
  archived: boolean
  validated: boolean
  onVersionHistory?: () => void
  onConvertToMarkdown?: () => void
  onCopyMarkdown?: () => void
  onDownload?: () => void
  onRecoverOfflineEdits?: () => void
  secondaryAction?: PageSecondaryAction
  annotations?: PageAnnotationsAction
}) {
  const setPageMeta = useSetPageMeta()
  const { data: spaceDetail } = useSpace(spaceId)
  const shareable = Boolean(
    validated &&
      spaceDetail &&
      spaceDetail.space.permissions?.manage !== false &&
      !spaceDetail.space.settings["archive"] &&
      !archived
  )
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
    onConvertToMarkdown,
    onCopyMarkdown,
    onDownload,
    onRecoverOfflineEdits,
    onVersionHistory,
  ])

  useEffect(() => {
    setPageMeta({
      // The byline under the title carries the lifetime chip.
      document: { spaceId, path: docPath, lifetimeInPage: true },
      overflowActions,
      secondaryAction,
      annotations,
      shareTarget: shareable
        ? { kind: "doc", spaceId, artifactKey: docPath }
        : undefined,
    })

    return () => setPageMeta(null)
  }, [
    docPath,
    overflowActions,
    secondaryAction,
    annotations,
    shareable,
    spaceId,
    setPageMeta,
  ])

  return null
}

function DocEditorPage({
  spaceId,
  docPath,
  page,
  preview,
}: {
  spaceId: string
  docPath: string
  /** The route's check of this path; null while it opens as a preview. */
  page: DocumentPage | null
  preview: DocumentOpenHint | null
}) {
  const router = useRouter()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const spaceEvents = useSpaceEvents(spaceId)
  const validated = page !== null
  const formatId = page ? page.document.format.id : preview?.formatId
  const revision = page ? page.revision : preview?.revision
  const archived = page
    ? Boolean(page.document.archived)
    : Boolean(preview?.archived)

  const [converting, setConverting] = useState(false)
  const [convertingToMarkdown, setConvertingToMarkdown] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [offlineRecoveryCacheKey, setOfflineRecoveryCacheKey] = useState<
    string | null
  >(null)
  const [recoveringOfflineEdits, setRecoveringOfflineEdits] = useState(false)
  const [recoveryScanVersion, setRecoveryScanVersion] = useState(0)

  // Keyed on the epochs alone: a save that moves only metadata rescans nothing.
  const collaborationEpoch = page?.collaboration?.epoch
  const epochHistory = page?.collaboration?.cacheEpochHistory
  useEffect(() => {
    if (!collaborationEpoch) return
    let cancelled = false
    const epochs = epochHistory ?? []
    const findRecovery = async () => {
      for (const epoch of epochs) {
        const cacheKey = workspaceCollaborationCacheKey(
          spaceId,
          docPath,
          collaborationEpoch,
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
  }, [collaborationEpoch, epochHistory, docPath, recoveryScanVersion, spaceId])

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

  const recoverOfflineEditsAction = useMemo(
    () =>
      offlineRecoveryCacheKey && !recoveringOfflineEdits
        ? () => void recoverOfflineEdits()
        : undefined,
    [offlineRecoveryCacheKey, recoveringOfflineEdits, recoverOfflineEdits]
  )

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

  // A synced editing session already holds every collaborative save,
  // including its own, so their echoes only move the check's save marker
  // (the base a reconnect sends) and revision forward. Any other change to
  // this document refreshes the check (lib/ws.ts); new content follows its
  // revision.
  useEffect(() => {
    return spaceEvents.subscribe((msg) => {
      if (
        msg.type !== "doc_update" ||
        msg.docPath !== docPath ||
        !isLiveDocumentSynced(spaceId, docPath) ||
        !isCollaborativeSave(msg)
      ) {
        return
      }
      const saved = (msg.data ?? {}) as {
        provenance?: DocumentPage["provenance"]
        revision?: string
      }
      queryClient.setQueryData<DocumentPageResult>(
        documentQueryKeys.page(spaceId, docPath),
        (current) =>
          current?.kind === "document"
            ? {
                ...current,
                ...(saved.provenance ? { provenance: saved.provenance } : {}),
                ...(saved.revision ? { revision: saved.revision } : {}),
              }
            : current
      )
    })
  }, [spaceEvents, queryClient, spaceId, docPath])

  // Converting changes the format and the revision: check the path again.
  const recheck = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: documentQueryKeys.page(spaceId, docPath),
        exact: true,
      }),
      queryClient.invalidateQueries({
        queryKey: docQueryKeys.docs(spaceId),
      }),
    ])
    await router.invalidate()
  }, [docPath, queryClient, router, spaceId])

  const handleConvert = useCallback(async () => {
    setConverting(true)
    try {
      await convertDoc(spaceId, docPath)
      await recheck()
    } catch (err) {
      console.error("Conversion failed:", err)
      toast.error("Couldn’t edit this doc. Try again.")
    } finally {
      setConverting(false)
    }
  }, [spaceId, docPath, recheck])

  const handleConvertToMarkdown = useCallback(async () => {
    setConvertingToMarkdown(true)
    try {
      await convertDocToMarkdown(spaceId, docPath)
      await recheck()
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
  }, [spaceId, docPath, recheck])

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

  if (!formatId) return <EditorSkeleton />

  if (formatId === "worktable.markdown") {
    return (
      <MarkdownDocPage
        readOnly={!page || page.capabilities.edit === false}
        spaceId={spaceId}
        docPath={docPath}
        page={page}
        archived={archived}
        validated={validated}
        revision={revision}
        onRestore={handleRestore}
        restoring={restoring}
        onConvert={page?.capabilities.edit === false ? undefined : handleConvert}
        converting={converting}
        onCopyMarkdown={handleCopyMarkdown}
        onDownload={handleDownload}
        onRecoverOfflineEdits={recoverOfflineEditsAction}
      />
    )
  }

  return (
    <BlockNoteDocPage
      spaceId={spaceId}
      docPath={docPath}
      archived={archived}
      readOnly={!page || page.capabilities.edit === false}
      page={page}
      revision={revision}
      onRestore={handleRestore}
      restoring={restoring}
      onConvertToMarkdown={!archived && page?.capabilities.edit !== false ? handleConvertToMarkdown : undefined}
      convertingToMarkdown={convertingToMarkdown}
      onCopyMarkdown={handleCopyMarkdown}
      onDownload={handleDownload}
      onRecoverOfflineEdits={recoverOfflineEditsAction}
    />
  )
}

/** Content the server could not serve for a Doc it listed. */
function DocUnavailable({ docPath }: { docPath: string }) {
  return (
    <div data-document-state className="flex h-full items-center justify-center">
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

function ArchivedDocBanner({
  archived,
  onRestore,
  restoring,
  readOnly = false,
  disabled,
}: {
  archived: boolean
  readOnly?: boolean
  onRestore: () => void
  restoring: boolean
  /** Restoring waits for the route's check of this path. */
  disabled: boolean
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
        {!readOnly && <Button
          size="sm"
          variant="outline"
          onClick={() => void onRestore()}
          disabled={restoring || disabled}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          {restoring ? "Restoring..." : "Restore"}
        </Button>}
      </div>
    </div>
  )
}

function MarkdownDocPage({
  readOnly,
  spaceId,
  docPath,
  page,
  archived,
  validated,
  revision,
  onRestore,
  restoring,
  onConvert,
  converting,
  onCopyMarkdown,
  onDownload,
  onRecoverOfflineEdits,
}: {
  readOnly?: boolean
  spaceId: string
  docPath: string
  page: DocumentPage | null
  archived: boolean
  validated: boolean
  revision: string | undefined
  onRestore: () => void
  restoring: boolean
  onConvert?: () => void
  converting: boolean
  onCopyMarkdown?: () => void
  onDownload?: () => void
  onRecoverOfflineEdits?: () => void
}) {
  const secondaryAction = useMemo<PageSecondaryAction | undefined>(
    () =>
      validated && onConvert
        ? {
            label: "Edit",
            displayLabel: "Edit",
            icon: Pencil,
            pending: converting,
            onClick: onConvert,
          }
        : undefined,
    [converting, onConvert, validated]
  )
  const contentQuery = useDocumentContent(
    spaceId,
    docPath,
    revision,
    validated
  )
  const content = contentQuery.data?.content
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

  if (typeof content !== "string") {
    return contentQuery.isError ? (
      <DocUnavailable docPath={docPath} />
    ) : (
      <EditorSkeleton />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <DocPageMeta
        spaceId={spaceId}
        docPath={docPath}
        archived={archived}
        validated={validated}
        onCopyMarkdown={onCopyMarkdown}
        onDownload={onDownload}
        onRecoverOfflineEdits={validated ? onRecoverOfflineEdits : undefined}
        secondaryAction={secondaryAction}
        onVersionHistory={openVersions}
        annotations={validated ? annotationsAction : undefined}
      />
      <ArchivedDocBanner
        readOnly={readOnly}
        archived={archived}
        onRestore={onRestore}
        restoring={restoring}
        disabled={!validated}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`min-w-0 overflow-hidden ${compareVersionId && !belowXl ? "flex-[1_1_50%] border-r border-border print:flex-1 print:border-r-0" : "flex-1"}`}
        >
          <MarkdownViewer
            content={content}
            spaceId={spaceId}
            docPath={docPath}
            afterTitle={
              <DocumentByline
                spaceId={spaceId}
                docPath={docPath}
                provenance={page?.provenance}
                updatedAt={page?.document.updatedAt}
                contributors={page?.contributors}
                backlinks={page?.backlinks}
                onVersionHistory={openVersions}
              />
            }
          />
        </div>

        {compareVersionId && (
          <div className="hidden min-w-0 flex-[1_1_50%] flex-col overflow-hidden bg-surface-inset xl:flex print:hidden">
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
              queryKey: documentQueryKeys.page(spaceId, docPath),
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
                queryKey: documentQueryKeys.page(spaceId, docPath),
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
  readOnly = false,
  page,
  revision,
  onRestore,
  restoring,
  onConvertToMarkdown,
  convertingToMarkdown,
  onCopyMarkdown,
  onDownload,
  onRecoverOfflineEdits,
}: {
  spaceId: string
  docPath: string
  archived: boolean
  readOnly?: boolean
  /** The route's check; the editor and its room wait for it. */
  page: DocumentPage | null
  revision: string | undefined
  onRestore: () => void
  restoring: boolean
  onConvertToMarkdown?: () => void
  convertingToMarkdown: boolean
  onCopyMarkdown?: () => void
  onDownload?: () => void
  onRecoverOfflineEdits?: () => void
}) {
  const validated = page !== null
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
  const provenanceRef = useRef(page?.provenance)
  provenanceRef.current = page?.provenance
  // The room is joined with the epochs of the validated check only.
  const collaborationEpoch = page?.collaboration?.epoch
  const collaborationCacheEpoch = page?.collaboration?.cacheEpoch
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
  // The saved content shows until the editor is readable, following the
  // revision until then; after that, the room brings every change.
  const [previewRevision, setPreviewRevision] = useState(revision)
  if (!editorReadable && revision !== previewRevision) {
    setPreviewRevision(revision)
  }
  const previewQuery = useDocumentContent(
    spaceId,
    docPath,
    previewRevision,
    validated && previewRevision === revision
  )
  const previewContent = Array.isArray(previewQuery.data?.content)
    ? previewQuery.data.content
    : undefined
  useEffect(() => {
    if (!editorReadable || previewScrollTop.current === 0) return
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
    // A preview never opens the room or its browser cache: a path the tab
    // has not checked may now name another document.
    if (readOnly || !collaborationEpoch || !collaborationCacheEpoch) return
    const wsUrl =
      import.meta.env.VITE_WS_URL ??
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${RUNTIME_BASE_PATH}`

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
      const memberId = browserTeamMemberId()
      if (memberId) params.memberId = memberId
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
      // The room admits only the path's current document and epochs. Refused
      // before its first sync, the path may have moved or gone since the
      // check (a move can race it while no Space socket reports changes):
      // check it once more, and the route follows.
      let rechecked = false
      p.on("connection-close", () => {
        if (rechecked || p.synced) return
        rechecked = true
        void queryClient.invalidateQueries({
          queryKey: documentQueryKeys.page(spaceId, docPath),
          exact: true,
        })
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
  }, [spaceId, docPath, collaborationEpoch, collaborationCacheEpoch, queryClient, readOnly])

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

  // While synced, this tab holds every save of this document; lists and the
  // page above use that to skip reading back their own echoes.
  useEffect(() => {
    if (!provider || !collabDoc) return
    return registerLiveDocument(spaceId, docPath, {
      synced: () => provider.synced,
      label: () => firstHeadingText(collabDoc.getXmlFragment("document-store")),
    })
  }, [collabDoc, docPath, provider, spaceId])


  const docName = useDocName(spaceId, docPath)
  const [focusTitle] = useState(() => takeJustCreated(spaceId, docPath))
  // The editor takes focus once it is shown; until then it is inert.
  const editorTitle = useMemo(
    () => ({ placeholder: docName, focus: focusTitle && editorReadable }),
    [docName, focusTitle, editorReadable]
  )
  useNameFromTitleOnLeave(spaceId, docPath, !readOnly && !archived)

  // The preview and the editor each show the byline; one state keeps what
  // is open when the editor takes over.
  const bylineState = useBylineState()
  const byline = (
    <DocumentByline
      state={bylineState}
      spaceId={spaceId}
      docPath={docPath}
      provenance={page?.provenance}
      updatedAt={page?.document.updatedAt}
      contributors={page?.contributors}
      backlinks={page?.backlinks}
      onVersionHistory={openVersions}
    />
  )

  return (
    <div className="flex h-full flex-col">
      <DocPageMeta
        spaceId={spaceId}
        docPath={docPath}
        archived={archived}
        validated={validated}
        onVersionHistory={openVersions}
        onConvertToMarkdown={
          convertingToMarkdown || !validated ? undefined : onConvertToMarkdown
        }
        onCopyMarkdown={onCopyMarkdown}
        onDownload={onDownload}
        onRecoverOfflineEdits={validated ? onRecoverOfflineEdits : undefined}
        annotations={validated ? annotationsAction : undefined}
      />
      <ArchivedDocBanner
        readOnly={readOnly}
        archived={archived}
        onRestore={onRestore}
        restoring={restoring}
        disabled={!validated}
      />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          className={`relative min-w-0 overflow-hidden ${compareVersionId && !belowXl ? "flex-[1_1_50%] border-r border-border print:flex-1 print:border-r-0" : "flex-1"}`}
        >
          {!editorReadable && (
            <div className="absolute inset-0 z-10">
              {previewContent ? (
                <DocumentPreview
                  showStatus={false}
                  content={previewContent}
                  titlePlaceholder={docName}
                  afterTitle={byline}
                  onScroll={(top) => {
                    previewScrollTop.current = top
                  }}
                />
              ) : (
                <EditorSkeleton />
              )}
            </div>
          )}
          <div
            ref={editorPaneRef}
            className={`h-full ${(previewContent?.length ?? 0) > 200 ? "worktable-large-document" : ""} ${editorReadable ? "" : "invisible"}`}
            inert={!editorReadable}
            aria-hidden={!editorReadable}
          >
            {/* Build the editor once its first usable Yjs state exists. Mounting an
                empty editor first runs its normalization/plugins again on sync. */}
            {provider && collabDoc && readyContent === provider && (
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
                  title={editorTitle}
                  afterTitle={byline}
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
          <div className="hidden min-w-0 flex-[1_1_50%] flex-col overflow-hidden bg-surface-inset xl:flex print:hidden">
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
              queryKey: documentQueryKeys.page(spaceId, docPath),
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
                queryKey: documentQueryKeys.page(spaceId, docPath),
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
                className="max-h-[calc(86dvh-1.5rem)]"
              />
            </DrawerContent>
          </Drawer>
        </>
      )}

      <AnnotationComposer
        draft={composerDraft}
        open={composerOpen && !readOnly}
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

      {!readOnly && (
        <SyncStatusPill provider={provider} ready={editorReadable} />
      )}
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
      spaceId={spaceId}
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
  spaceId,
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
  spaceId: string
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
  const { data: spaceDetail } = useSpace(spaceId)
  const canEdit = Boolean(spaceDetail && spaceDetail.space.permissions?.edit !== false)
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
          disabled={!canEdit}
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
                  className={`border-l-2 px-3 py-4 transition-colors ${active ? "border-l-primary bg-surface-selected" : "border-l-transparent hover:bg-surface-hover"}`}
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
                        disabled={!canEdit}
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

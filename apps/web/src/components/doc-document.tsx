import { useVisitorCommentsPanel } from "@/hooks/use-visitor-comments-panel"
import { useVersionSnapshot } from "@/lib/version-history"
import {
  VersionHistoryPanel,
  VersionPreview,
} from "@/components/document/version-history"
import { RUNTIME_BASE_PATH } from "@/lib/runtime-path"
import { browserTeamMemberId } from "@/lib/team-context"
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  Copy,
  Download,
  RotateCcw,
  History,
  Printer,
  ArrowRightLeft,
  Pencil,
} from "lucide-react"
import { docQueryKeys } from "@/lib/docs-queries"
import { documentQueryKeys, useDocumentContent } from "@/lib/documents-queries"
import type { DocumentRendererProps } from "@/lib/document-renderers"
import type { DocumentOpenHint } from "@/lib/document-rows"
import {
  firstHeadingText,
  isCollaborativeSave,
  isLiveDocumentSynced,
  registerLiveDocument,
} from "@/lib/live-documents"
import {
  useAnnotationMutations,
  useDocAnnotations,
} from "@/lib/annotations-queries"
import type {
  Annotation,
  DocumentPage,
  DocumentPageResult,
  DocumentSharingSummary,
} from "@worktable/types"
import {
  convertDoc,
  convertDocToMarkdown,
  restoreDoc,
  exportDocMarkdown,
  downloadDocMarkdown,
  createDoc,
} from "@/lib/docs-api"
import { workspaceCollaborationCacheKey } from "@/lib/collaboration-cache"
import { HttpError } from "@/lib/http"
import { copyText } from "@/lib/clipboard"
import { useSpaceEvents } from "@/hooks/use-space-events"
import {
  pageShareTarget,
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
import { useEditorFiles } from "@/hooks/use-editor-files"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { EditorSkeleton } from "@/components/editor/editor-skeleton"
import { MarkdownViewer } from "@/components/editor/markdown-viewer"
import {
  readingPlace,
  restoreReadingPlace,
  type ReadingPlace,
} from "@/components/editor/reading-place"
import { AnnotationPanel } from "@/components/annotations/annotation-panel"
import { DesktopContextPanel } from "@/components/desktop-context-panel"
import {
  AnnotationComposer,
  type AnnotationDraft,
} from "@/components/annotations/annotation-composer"
import { PassageCommenting } from "@/components/annotations/passage-commenting"
import { docContributors } from "@/lib/comment-recipients"
import { usePassageComments } from "@/components/annotations/use-passage-comments"
import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@worktable/ui/components/button"
import {
  DocumentStatus,
  type DocumentStatusState,
} from "@worktable/ui/components/document-status"
import { preloadableComponent } from "@worktable/ui/lib/preloadable-component"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@worktable/ui/components/drawer"
import { toast } from "@worktable/ui/components/sonner"
import { versionFilesAt } from "@/lib/file-embeds"
import * as Y from "yjs"
import { WebsocketProvider } from "y-websocket"
import { IndexeddbPersistence } from "y-indexeddb"

// Lazy-load the editor (pulls in BlockNote, Mermaid, Shiki)
type LoadedEditorProps = ComponentProps<
  typeof import("@/components/editor/editor").Editor
>
type EditorHandle = import("@/components/editor/editor").EditorHandle
const editor = preloadableComponent<LoadedEditorProps>(() =>
  import("@/components/editor/editor").then((module) => ({
    default: module.Editor,
  }))
)
const Editor = editor.Component

export function preloadDocEditor(formatId?: string): Promise<unknown> {
  return formatId === "worktable.rich-text"
    ? editor.preload()
    : Promise.resolve()
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
 * Actions that change the document appear once the route's check has
 * validated the path; callers leave them out before.
 */
function DocPageMeta({
  spaceId,
  docPath,
  onVersionHistory,
  onConvertToMarkdown,
  onCopyMarkdown,
  onDownload,
  onRecoverOfflineEdits,
  secondaryAction,
  annotations,
  sharing,
}: {
  spaceId: string
  docPath: string
  onVersionHistory?: () => void
  onConvertToMarkdown?: () => void
  onCopyMarkdown?: () => void
  onDownload?: () => void
  onRecoverOfflineEdits?: () => void
  secondaryAction?: PageSecondaryAction
  annotations?: PageAnnotationsAction
  /** The page's links. */
  sharing?: DocumentSharingSummary
}) {
  const setPageMeta = useSetPageMeta()
  const activeLinks = sharing?.activeLinks
  const canCreateLinks = sharing?.canCreate
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
      shareTarget: pageShareTarget(
        { kind: "doc", spaceId, artifactKey: docPath },
        activeLinks,
        canCreateLinks
      ),
    })

    return () => setPageMeta(null)
  }, [
    docPath,
    overflowActions,
    secondaryAction,
    annotations,
    activeLinks,
    canCreateLinks,
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
  // Until the check lands, the page the tab last read gives the files'
  // versions, so the stand-in loads them from the browser's cache too.
  const fileVersions = page ? page.embeds : preview?.embeds

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

  // What the Markdown page showed when Edit was pressed, for the rich page
  // to open on. Taken once, by the page that opens after converting.
  const opening = useRef<{ docPath: string; value: DocOpening } | null>(null)
  const takeOpening = useCallback(() => {
    const value =
      opening.current?.docPath === docPath ? opening.current.value : null
    opening.current = null
    return value
  }, [docPath])

  const handleConvert = useCallback(
    async (from: DocOpening) => {
      setConverting(true)
      // Set first: the change's event can bring the rich page before the
      // response does.
      opening.current = { docPath, value: from }
      try {
        await convertDoc(spaceId, docPath)
        await recheck()
      } catch (err) {
        opening.current = null
        console.error("Conversion failed:", err)
        toast.error("Couldn’t edit this doc. Try again.")
      } finally {
        setConverting(false)
      }
    },
    [spaceId, docPath, recheck]
  )

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
        fileVersions={fileVersions}
        archived={archived}
        validated={validated}
        revision={revision}
        onRestore={handleRestore}
        restoring={restoring}
        onConvert={
          page?.capabilities.edit === false ? undefined : handleConvert
        }
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
      takeOpening={takeOpening}
      archived={archived}
      readOnly={!page || page.capabilities.edit === false}
      page={page}
        fileVersions={fileVersions}
      revision={revision}
      onRestore={handleRestore}
      restoring={restoring}
      onConvertToMarkdown={
        !archived && page?.capabilities.edit !== false
          ? handleConvertToMarkdown
          : undefined
      }
      convertingToMarkdown={convertingToMarkdown}
      onCopyMarkdown={handleCopyMarkdown}
      onDownload={handleDownload}
      onRecoverOfflineEdits={recoverOfflineEditsAction}
    />
  )
}

/** The scrolling pane of what shows while a rich Doc opens. */
function standInRoot(standIn: HTMLElement | null) {
  return standIn?.querySelector(
    "[data-document-preview], [data-document-scroll-root]"
  )
}

/** A Markdown Doc as it was showing when Edit was pressed. */
interface DocOpening {
  markdown: string
  place: ReadingPlace | null
}

/** Content the server could not serve for a Doc it listed. */
function DocUnavailable({ docPath }: { docPath: string }) {
  return (
    <div
      data-document-state
      className="flex h-full items-center justify-center"
    >
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
        {!readOnly && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onRestore()}
            disabled={restoring || disabled}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            {restoring ? "Restoring..." : "Restore"}
          </Button>
        )}
      </div>
    </div>
  )
}

function MarkdownDocPage({
  readOnly,
  spaceId,
  docPath,
  page,
  fileVersions,
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
  /** The versions of the Doc's files, known before the page check lands. */
  fileVersions?: Readonly<Record<string, string>>
  archived: boolean
  validated: boolean
  revision: string | undefined
  onRestore: () => void
  restoring: boolean
  onConvert?: (from: DocOpening) => void
  converting: boolean
  onCopyMarkdown?: () => void
  onDownload?: () => void
  onRecoverOfflineEdits?: () => void
}) {
  const contentQuery = useDocumentContent(spaceId, docPath, revision, validated)
  const content = contentQuery.data?.content
  const readingRef = useRef<HTMLDivElement>(null)
  const secondaryAction = useMemo<PageSecondaryAction | undefined>(
    () =>
      validated && onConvert && typeof content === "string"
        ? {
            label: "Edit",
            displayLabel: "Edit",
            icon: Pencil,
            pending: converting,
            onClick: () => {
              const root = readingRef.current?.querySelector(
                "[data-document-scroll-root]"
              )
              onConvert({
                markdown: content,
                place: root ? readingPlace(root) : null,
              })
            },
          }
        : undefined,
    [content, converting, onConvert, validated]
  )
  const queryClient = useQueryClient()
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  useVisitorCommentsPanel(page?.sharing?.visitorComments, setAnnotationsOpen, setVersionsOpen, annotationsOpen)
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null)
  const versionQuery = useVersionSnapshot(
    "doc",
    spaceId,
    docPath,
    previewVersionId
  )
  const previewVersion = versionQuery.data
  // An old version shows its files as they were when it was saved.
  const readingFiles = useEditorFiles(spaceId, docPath, {
    upload: false,
    ...(previewVersion ? { at: versionFilesAt(previewVersion) } : {}),
  })
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null
  )
  const [belowXl, setBelowXl] = useState(false)
  const annotationsQuery = useDocAnnotations(spaceId, docPath, true)
  const annotationMutations = useAnnotationMutations(spaceId, docPath)
  const commentContext = useMemo(
    () => ({ spaceId, docPath, contributors: docContributors(page) }),
    [spaceId, docPath, page]
  )
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
          setPreviewVersionId(null)
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
    setPreviewVersionId(null)
  }, [])

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1279px)")
    const update = () => setBelowXl(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])

  // Comments on a passage: select text in the Doc as it reads, no Edit needed.
  const isMobile = useIsMobile()
  const canComment = validated && canCommentOn(page, readOnly)
  const passages = usePassageComments({
    rootRef: readingRef,
    ready: typeof content === "string",
    annotations,
    activeAnnotationId,
    onSelectAnnotation: selectAnnotation,
  })
  const focusAnnotation = (annotation: Annotation) => {
    selectAnnotation(annotation)
    passages.reveal(annotation.id)
  }
  const emptyHint = canComment ? "Select text to comment on it." : ""

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
        onCopyMarkdown={onCopyMarkdown}
        onDownload={onDownload}
        onRecoverOfflineEdits={validated ? onRecoverOfflineEdits : undefined}
        secondaryAction={secondaryAction}
        onVersionHistory={openVersions}
        annotations={validated ? annotationsAction : undefined}
        sharing={page?.sharing}
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
          ref={readingRef}
          className={`min-w-0 overflow-hidden ${previewVersionId ? "hidden xl:block xl:flex-[1_1_50%] xl:border-r xl:border-border print:block print:flex-1 print:border-r-0" : "flex-1"}`}
        >
          <MarkdownViewer
            content={content}
            spaceId={spaceId}
            docPath={docPath}
            fileVersions={fileVersions}
            // Before the page check lands, with no versions from a page read
            // earlier, an image would load once without its version and
            // again with it: it waits for the check instead.
            fileVersionsPending={!page && fileVersions === undefined}
            afterTitle={
              <DocumentByline
                spaceId={spaceId}
                docPath={docPath}
                provenance={page?.provenance}
                updatedAt={page?.document.updatedAt}
                contributors={page?.contributors}
                backlinks={page?.backlinks}
                referrers={page?.referrers}
                onVersionHistory={openVersions}
              />
            }
          />
        </div>

        {previewVersionId && (
          <VersionPreview
            canEdit={validated && !readOnly}
            key={previewVersionId}
            kind="doc"
            spaceId={spaceId}
            path={docPath}
            revision={
              page?.provenance?.versionId ?? page?.document.updatedAt ?? ""
            }
            version={previewVersion}
            error={versionQuery.isError}
            onRetry={() => void versionQuery.refetch()}
            onBack={() => setPreviewVersionId(null)}
            onHistory={openVersions}
            onRestored={() => {
              void queryClient.invalidateQueries({
                queryKey: documentQueryKeys.page(spaceId, docPath),
                exact: true,
              })
              setPreviewVersionId(null)
            }}
          >
            {(byline) => (
              <Suspense fallback={<EditorSkeleton />}>
                {previewVersion &&
                Array.isArray(previewVersion.after.content) ? (
                  <Editor
                    key={previewVersion.id}
                    initialContent={previewVersion.after.content as never[]}
                    editable={false}
                    afterTitle={byline}
                    files={readingFiles}
                  />
                ) : previewVersion &&
                  typeof previewVersion.after.content === "string" ? (
                  <MarkdownViewer
                    filesAt={versionFilesAt(previewVersion)}
                    content={previewVersion.after.content}
                    afterTitle={byline}
                    spaceId={spaceId}
                    docPath={docPath}
                  />
                ) : (
                  <EditorSkeleton />
                )}
              </Suspense>
            )}
          </VersionPreview>
        )}

        <DesktopContextPanel
          open={!previewVersionId && annotationsOpen && !belowXl}
          width={384}
        >
          <AnnotationPanel
            visitorComments={page?.sharing?.visitorComments && page.sharing.visitorComments.available !== false ? {spaceId, path: page.document.path, ...page.sharing.visitorComments} : undefined}
            readOnly={readOnly}
            canReply={canComment}
            annotations={annotations}
            activeAnnotationId={activeAnnotationId}
            onSelectAnnotation={focusAnnotation}
            detachedIds={passages.detached}
            emptyHint={emptyHint}
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
          canEdit={validated && !readOnly}
          kind="doc"
          spaceId={spaceId}
          path={docPath}
          revision={
            page?.provenance?.versionId ?? page?.document.updatedAt ?? ""
          }
          currentActor={page?.contributors?.lastEditor}
          provenance={page?.provenance}
          open={(versionsOpen || Boolean(previewVersionId)) && !belowXl}
          drawerMode={false}
          selectedVersionId={previewVersionId}
          onSelect={(id) => {
            setPreviewVersionId(id)
            setVersionsOpen(true)
          }}
          onClose={() => {
            setVersionsOpen(false)
            setPreviewVersionId(null)
          }}
        />
      </div>

      {belowXl && (
        <>
          <VersionHistoryPanel
            canEdit={validated && !readOnly}
            kind="doc"
            spaceId={spaceId}
            path={docPath}
            revision={
              page?.provenance?.versionId ?? page?.document.updatedAt ?? ""
            }
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
                Annotations for this doc.
              </DrawerDescription>
              <AnnotationPanel
            visitorComments={page?.sharing?.visitorComments && page.sharing.visitorComments.available !== false ? {spaceId, path: page.document.path, ...page.sharing.visitorComments} : undefined}
                readOnly={readOnly}
                canReply={canComment}
                annotations={annotations}
                activeAnnotationId={activeAnnotationId}
                onSelectAnnotation={focusAnnotation}
                detachedIds={passages.detached}
                emptyHint={emptyHint}
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

      {canComment && !previewVersionId && (
        <PassageCommenting
          rootRef={readingRef}
          docPath={docPath}
          context={commentContext}
          onCreate={(input) => {
            annotationMutations.create.mutate({ ...input, category: "comment" })
            // On a phone the highlight confirms it; the next passage is a tap away.
            if (!isMobile) {
              setAnnotationsOpen(true)
              setVersionsOpen(false)
            }
          }}
        />
      )}
    </div>
  )
}

/**
 * Whether this person may comment on the Doc. With Teams the page says, as
 * a viewer may comment; without, whoever may edit may comment.
 */
function canCommentOn(page: DocumentPage | null, readOnly = false): boolean {
  return page?.capabilities.comment ?? !readOnly
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
  takeOpening,
  archived,
  readOnly = false,
  page,
  fileVersions,
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
  /** The Markdown this Doc was just converted from, as it was showing. */
  takeOpening: () => DocOpening | null
  archived: boolean
  readOnly?: boolean
  /** The route's check; the editor and its room wait for it. */
  page: DocumentPage | null
  /** The versions of the Doc's files, known before the page check lands. */
  fileVersions?: Readonly<Record<string, string>>
  revision: string | undefined
  onRestore: () => void
  restoring: boolean
  onConvertToMarkdown?: () => void
  convertingToMarkdown: boolean
  onCopyMarkdown?: () => void
  onDownload?: () => void
  onRecoverOfflineEdits?: () => void
}) {
  // The editor learns once whether files can be added, so it waits to know.
  const deploymentKnown = useDeploymentInfo().data !== undefined
  const editingFiles = useEditorFiles(spaceId, docPath, {
    upload: !readOnly && !archived,
    versions: fileVersions,
  })
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
  // Until the editor shows, the Doc shows as it was: the Markdown it was
  // just converted from, or else its saved preview. The reader's place in
  // it carries over to the editor.
  const [opening, setOpening] = useState(takeOpening)
  const standInRef = useRef<HTMLDivElement>(null)
  const place = useRef(opening?.place ?? null)
  const placedTop = useRef(0)
  const caretPending = useRef(opening !== null)
  const editorHandle = useRef<EditorHandle | null>(null)
  const [readyEditor, setReadyEditor] = useState<WebsocketProvider | null>(null)
  const [readyContent, setReadyContent] = useState<WebsocketProvider | null>(
    null
  )
  const handleEditorReady = useCallback(
    (handle: EditorHandle) => {
      editorHandle.current = handle
      // A reader who scrolled the stand-in is reading somewhere new.
      const root = standInRoot(standInRef.current)
      if (root && Math.abs(root.scrollTop - placedTop.current) > 1) {
        place.current = readingPlace(root)
      }
      const at = place.current
      const editorRoot = editorPaneRef.current?.querySelector(
        ".worktable-editor-scroll-root"
      )
      if (!at || !editorRoot) return setReadyEditor(provider)
      // Put the place back while the editor is still hidden, and again a
      // frame later: blocks of a long Doc take their real height only once
      // they near the view.
      restoreReadingPlace(editorRoot, at)
      requestAnimationFrame(() => {
        restoreReadingPlace(editorRoot, at)
        setReadyEditor(provider)
      })
    },
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
  const showsStandIn = Boolean(opening || previewContent)
  useLayoutEffect(() => {
    const root = standInRoot(standInRef.current)
    if (!root || !place.current) return
    restoreReadingPlace(root, place.current)
    placedTop.current = root.scrollTop
  }, [showsStandIn])
  useEffect(() => {
    if (!editorReadable) return
    const scrollRoot = editorPaneRef.current?.querySelector(
      ".worktable-editor-scroll-root"
    )
    const at = place.current
    const caret = caretPending.current
    // Used once. If the room reconnects, the saved preview stands in and the
    // editor stays where it is unless the reader scrolls that preview.
    place.current = null
    placedTop.current = 0
    caretPending.current = false
    setOpening(null)
    if (!scrollRoot || !at) return
    const block = restoreReadingPlace(scrollRoot, at)
    const active = document.activeElement
    // Leave focus with a field or dialog the reader turned to meanwhile.
    const elsewhere =
      active instanceof HTMLElement &&
      !editorPaneRef.current?.contains(active) &&
      (active.matches("input, textarea, select, [contenteditable='true']") ||
        active.closest("[role='dialog']") !== null)
    if (block && caret && !elsewhere) editorHandle.current?.placeCaret(block)
  }, [editorReadable])
  const [collabDoc, setCollabDoc] = useState<Y.Doc | null>(null)
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  useVisitorCommentsPanel(page?.sharing?.visitorComments, setAnnotationsOpen, setVersionsOpen, annotationsOpen)
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null)
  const versionQuery = useVersionSnapshot(
    "doc",
    spaceId,
    docPath,
    previewVersionId
  )
  const previewVersion = versionQuery.data
  // An old version shows its files as they were when it was saved.
  const readingFiles = useEditorFiles(spaceId, docPath, {
    upload: false,
    ...(previewVersion ? { at: versionFilesAt(previewVersion) } : {}),
  })
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null
  )
  const [composerDraft, setComposerDraft] = useState<AnnotationDraft | null>(
    null
  )
  const [composerOpen, setComposerOpen] = useState(false)
  const isMobile = useIsMobile()
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
  const commentContext = useMemo(
    () => ({ spaceId, docPath, contributors: docContributors(page) }),
    [spaceId, docPath, page]
  )
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
          setPreviewVersionId(null)
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
  }, [
    spaceId,
    docPath,
    collaborationEpoch,
    collaborationCacheEpoch,
    queryClient,
    readOnly,
  ])

  const selectAnnotation = useCallback((annotation: Annotation) => {
    setActiveAnnotationId(annotation.id)
    setAnnotationsOpen(true)
    setVersionsOpen(false)
    setPreviewVersionId(null)
    if ("blockId" in annotation.target && annotation.target.blockId) {
      const node = document.querySelector(
        `[data-id="${CSS.escape(annotation.target.blockId)}"]`
      )
      node?.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }, [])

  // Without edit access the saved Doc stays on screen, and a viewer comments
  // on text selected there, as in a Markdown Doc.
  const canComment = validated && canCommentOn(page, readOnly)
  const passages = usePassageComments({
    rootRef: standInRef,
    ready: readOnly && Boolean(previewContent),
    annotations: readOnly ? annotations : [],
    activeAnnotationId,
    onSelectAnnotation: selectAnnotation,
  })
  const focusAnnotation = (annotation: Annotation) => {
    selectAnnotation(annotation)
    passages.reveal(annotation.id)
  }
  // An editor gets the panel's own hint about the editor's commands.
  const readerHint = !readOnly
    ? undefined
    : canComment
      ? "Select text to comment on it."
      : ""

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
      referrers={page?.referrers}
      onVersionHistory={openVersions}
    />
  )

  return (
    <div className="flex h-full flex-col">
      <DocPageMeta
        spaceId={spaceId}
        docPath={docPath}
        onVersionHistory={openVersions}
        onConvertToMarkdown={
          convertingToMarkdown || !validated ? undefined : onConvertToMarkdown
        }
        onCopyMarkdown={onCopyMarkdown}
        onDownload={onDownload}
        onRecoverOfflineEdits={validated ? onRecoverOfflineEdits : undefined}
        annotations={validated ? annotationsAction : undefined}
        sharing={page?.sharing}
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
          className={`relative min-w-0 overflow-hidden ${previewVersionId ? "hidden xl:block xl:flex-[1_1_50%] xl:border-r xl:border-border print:block print:flex-1 print:border-r-0" : "flex-1"}`}
        >
          {!editorReadable && (
            <div ref={standInRef} className="absolute inset-0 z-10">
              {opening ? (
                <MarkdownViewer
                  content={opening.markdown}
                  spaceId={spaceId}
                  docPath={docPath}
                  fileVersions={fileVersions}
                  afterTitle={byline}
                />
              ) : previewContent ? (
                <DocumentPreview
                  showStatus={false}
                  content={previewContent}
                  titlePlaceholder={docName}
                  afterTitle={byline}
                  resolveUrl={editingFiles?.resolve}
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
            {provider && collabDoc && readyContent === provider && deploymentKnown && (
              <Suspense fallback={<EditorSkeleton />}>
                <Editor
                  // The editor learns what it can do with files once; turning the files
                  // preview on or off makes a new one that knows.
                  key={editingFiles ? (editingFiles.upload ? "files" : "file-links") : "no-files"}
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
                  files={editingFiles}
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

        {previewVersionId && (
          <VersionPreview
            canEdit={validated && !readOnly}
            key={previewVersionId}
            kind="doc"
            spaceId={spaceId}
            path={docPath}
            revision={
              page?.provenance?.versionId ?? page?.document.updatedAt ?? ""
            }
            version={previewVersion}
            error={versionQuery.isError}
            onRetry={() => void versionQuery.refetch()}
            onBack={() => setPreviewVersionId(null)}
            onHistory={openVersions}
            onRestored={() => {
              void queryClient.invalidateQueries({
                queryKey: documentQueryKeys.page(spaceId, docPath),
                exact: true,
              })
              setPreviewVersionId(null)
            }}
          >
            {(byline) => (
              <Suspense fallback={<EditorSkeleton />}>
                {previewVersion &&
                Array.isArray(previewVersion.after.content) ? (
                  <Editor
                    key={previewVersion.id}
                    initialContent={previewVersion.after.content as never[]}
                    editable={false}
                    afterTitle={byline}
                    files={readingFiles}
                  />
                ) : previewVersion &&
                  typeof previewVersion.after.content === "string" ? (
                  <MarkdownViewer
                    filesAt={versionFilesAt(previewVersion)}
                    content={previewVersion.after.content}
                    afterTitle={byline}
                    spaceId={spaceId}
                    docPath={docPath}
                  />
                ) : (
                  <EditorSkeleton />
                )}
              </Suspense>
            )}
          </VersionPreview>
        )}

        <DesktopContextPanel
          open={!previewVersionId && annotationsOpen && !belowXl}
          width={384}
        >
          <AnnotationPanel
            visitorComments={page?.sharing?.visitorComments && page.sharing.visitorComments.available !== false ? {spaceId, path: page.document.path, ...page.sharing.visitorComments} : undefined}
            readOnly={readOnly}
            canReply={canComment}
            annotations={annotations}
            activeAnnotationId={activeAnnotationId}
            onSelectAnnotation={focusAnnotation}
            emptyHint={readerHint}
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
          canEdit={validated && !readOnly}
          kind="doc"
          spaceId={spaceId}
          path={docPath}
          revision={
            page?.provenance?.versionId ?? page?.document.updatedAt ?? ""
          }
          currentActor={page?.contributors?.lastEditor}
          provenance={page?.provenance}
          open={(versionsOpen || Boolean(previewVersionId)) && !belowXl}
          drawerMode={false}
          selectedVersionId={previewVersionId}
          onSelect={(id) => {
            setPreviewVersionId(id)
            setVersionsOpen(true)
          }}
          onClose={() => {
            setVersionsOpen(false)
            setPreviewVersionId(null)
          }}
        />
      </div>

      {belowXl && (
        <>
          <VersionHistoryPanel
            canEdit={validated && !readOnly}
            kind="doc"
            spaceId={spaceId}
            path={docPath}
            revision={
              page?.provenance?.versionId ?? page?.document.updatedAt ?? ""
            }
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
                Annotations for this doc.
              </DrawerDescription>
              <AnnotationPanel
            visitorComments={page?.sharing?.visitorComments && page.sharing.visitorComments.available !== false ? {spaceId, path: page.document.path, ...page.sharing.visitorComments} : undefined}
                readOnly={readOnly}
                canReply={canComment}
                annotations={annotations}
                activeAnnotationId={activeAnnotationId}
                onSelectAnnotation={focusAnnotation}
                emptyHint={readerHint}
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
        context={commentContext}
        onSubmit={(body, to) => {
          if (!composerDraft) return
          annotationMutations.create.mutate({
            target: {
              type: "block",
              docPath,
              blockId: composerDraft.blockId,
              blockType: composerDraft.blockType,
              quote: composerDraft.quote,
            },
            category: "comment",
            body,
            to,
          })
          if (!isMobile) setAnnotationsOpen(true)
        }}
      />

      {readOnly && canComment && !previewVersionId && (
        <PassageCommenting
          rootRef={standInRef}
          docPath={docPath}
          context={commentContext}
          onCreate={(input) => {
            annotationMutations.create.mutate({ ...input, category: "comment" })
            if (!isMobile) setAnnotationsOpen(true)
          }}
        />
      )}

      {!readOnly && !previewVersionId && (
        <SyncStatusPill provider={provider} ready={editorReadable} />
      )}
    </div>
  )
}

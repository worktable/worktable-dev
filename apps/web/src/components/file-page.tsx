import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  AppWindow,
  Database,
  Download,
  File as FileIcon,
  Upload,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { toast } from "@worktable/ui/components/sonner"
import {
  filePolicy,
  type DocumentPage,
  type FileSurfacePolicies,
} from "@worktable/types"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { DataTooltips } from "@/components/document/data-tooltip"
import { ImageViewControl } from "@/components/viewer/image-view-control"
import { useSetPageMeta } from "@/hooks/use-page-meta"
import { DocumentByline } from "@/components/document/document-byline"
import { TipCard } from "@/components/help/help"
import { documentQueryKeys } from "@/lib/documents-queries"
import { documentRoute } from "@/lib/document-views"
import { fetchJSON, refusalReason } from "@/lib/http"
import { filePreviewTextKey, readPreviewText } from "@/lib/file-preview-text"
import { FileChangedError, fileSourceUrl, replaceFile } from "@/lib/file-embeds"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import "@/styles/document-controls.css"

// Only a table file's import loads the dialog, when it opens.
const ImportRecordsDialog = lazy(() =>
  import("@/components/records/import-records-dialog").then((module) => ({
    default: module.ImportRecordsDialog,
  }))
)

// The grid loads only when a table file opens.
const TableFileView = lazy(() => import("@/components/viewer/table-file-view"))
// The viewer's tools load only when a PDF or Word file opens.
const PdfFileView = lazy(() => import("@/components/viewer/pdf-file-view"))

/** How a file shows on its page: the file type table's page policy. */
type FileView = FileSurfacePolicies["page"]

/** Open as HTML Doc: the file becomes an HTML Doc, its history kept. */
function openFileAsHtmlDoc(
  spaceId: string,
  path: string
): Promise<{ path: string }> {
  return fetchJSON(
    `/api/spaces/${encodeURIComponent(spaceId)}/documents/open-as-html`,
    { method: "POST", body: JSON.stringify({ path }) }
  )
}

/**
 * A file's page: the file itself where Worktable can show it, a card where
 * it can't, and the Docs that use it.
 */
export function FilePage({
  spaceId,
  page,
}: {
  spaceId: string
  page: DocumentPage
}) {
  const path = page.document.path
  const name = page.document.title
  const view = filePolicy(name, "page")
  const setPageMeta = useSetPageMeta()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const fade = useScrollFade<HTMLDivElement>(8, { top: false })
  const picker = useRef<HTMLInputElement>(null)
  const article = useRef<HTMLElement>(null)
  const [uploading, setUploading] = useState(false)
  // The file loads by what its bytes are, so an unchanged file comes from
  // the browser's cache and a changed one loads anew. Right after Upload New
  // Version, the new bytes' hash stands in until the page catches up, and
  // the next upload is based on the revision that one saved.
  const [uploaded, setUploaded] = useState<{
    hash: string
    revision: string
    replacedVersion: string | undefined
  } | null>(null)
  const caughtUp = !uploaded || uploaded.replacedVersion !== page.version
  const version = caughtUp ? (page.version ?? null) : uploaded.hash
  const basedOn = caughtUp ? page.version : uploaded.revision
  // A new version picked after the file changed, until the person decides.
  const [changed, setChanged] = useState<File | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const canEdit = page.capabilities.edit !== false && !page.document.archived
  // A file past what a version holds keeps no history, so a new version
  // couldn't keep this one.
  const canReplace = canEdit && !page.noHistory && basedOn !== undefined
  // A table people will keep working in belongs in Records.
  const importable = canEdit && filePolicy(name, "import")
  // An HTML file runs only once a person opens it as an HTML Doc, whose
  // source is a .html file.
  const openableAsHtml = canEdit && view === "frame" && path.endsWith(".html")
  const [openingAsHtml, setOpeningAsHtml] = useState(false)
  const url = fileSourceUrl(spaceId, path, version)
  // A table fills the pane as a grid. Past what a preview reads, or when
  // the read fails, it is a card like any other file.
  const tableView = view === "table" && page.noHistory === undefined
  const tableText = useQuery({
    queryKey: filePreviewTextKey(url),
    queryFn: () => readPreviewText(url),
    enabled: tableView,
    staleTime: Infinity,
  })
  const tableOn = tableView && !tableText.isError && tableText.data !== null
  // A PDF or Word file fills the pane, in its viewer. Where the viewer is
  // off, or the file is past what a preview reads, it is a card like any
  // other file.
  const deployment = useDeploymentInfo().data
  const framed =
    (view === "pdf" || view === "word") &&
    !page.noHistory &&
    page.byteLength !== undefined
  const framedOn =
    framed &&
    (view === "pdf"
      ? deployment?.capabilities.pdfViewer
      : deployment?.capabilities.wordViewer) === true
  // A Word file's viewer downloads several MB the first time, so with Data
  // Saver on it waits until the person asks for it.
  const [openAnyway, setOpenAnyway] = useState(false)
  const waiting = framedOn && view === "word" && !openAnyway && savingData()

  const uploadVersion = useCallback(
    async (file: File, over: string | undefined) => {
      if (over === undefined) return
      setUploading(true)
      const refreshPage = () =>
        void queryClient.invalidateQueries({
          queryKey: documentQueryKeys.page(spaceId, path),
          exact: true,
        })
      try {
        const saved = await replaceFile(spaceId, path, file, over)
        setUploaded({
          hash: saved.contentHash,
          revision: saved.sourceRevision,
          replacedVersion: page.version,
        })
        setChanged(null)
        refreshPage()
        toast.success("New version uploaded")
      } catch (error) {
        if (error instanceof FileChangedError) {
          // Show the newer version behind the question.
          setChanged(file)
          refreshPage()
          return
        }
        console.error("File upload failed:", error)
        setChanged(null)
        toast.error(
          refusalReason(error) ?? "Couldn’t upload the new version. Try again."
        )
      } finally {
        setUploading(false)
      }
    },
    [page.version, path, queryClient, spaceId]
  )

  const openAsHtml = useCallback(async () => {
    setOpeningAsHtml(true)
    try {
      const opened = await openFileAsHtmlDoc(spaceId, path)
      void queryClient.invalidateQueries({
        queryKey: documentQueryKeys.list(spaceId),
        exact: true,
      })
      await navigate({ ...documentRoute(spaceId, opened.path), replace: true })
    } catch (error) {
      console.error("Open as HTML Doc failed:", error)
      toast.error("Couldn’t open this file as an HTML Doc. Try again.")
      setOpeningAsHtml(false)
    }
  }, [navigate, path, queryClient, spaceId])

  useEffect(() => {
    setPageMeta({
      titleOverride: name,
      document: { spaceId, path },
      primaryAction: {
        label: "Download",
        icon: Download,
        onClick: () => {
          window.location.href = fileSourceUrl(spaceId, path, null, {
            download: true,
          })
        },
      },
      ...(importable || openableAsHtml
        ? {
            overflowActions: [
              ...(openableAsHtml
                ? [
                    {
                      id: "open-as-html",
                      label: "Open as HTML Doc",
                      icon: AppWindow,
                      disabled: openingAsHtml,
                      onSelect: () => void openAsHtml(),
                    },
                  ]
                : []),
              ...(importable
                ? [
                    {
                      id: "import-records",
                      label: "Import into Records",
                      icon: Database,
                      onSelect: () => setImportOpen(true),
                    },
                  ]
                : []),
            ],
          }
        : {}),
      ...(canReplace
        ? {
            secondaryAction: {
              label: "Upload New Version",
              description:
                "Replaces this file everywhere it's used. The current version stays in its history.",
              icon: Upload,
              pending: uploading,
              disabled: uploading,
              onClick: () => picker.current?.click(),
            },
          }
        : {}),
    })
    return () => setPageMeta(null)
  }, [
    canReplace,
    importable,
    name,
    openAsHtml,
    openableAsHtml,
    openingAsHtml,
    page,
    path,
    setPageMeta,
    spaceId,
    uploading,
  ])

  const dialogs = (
    <>
      <DeferredMount active={importOpen}>
        <ImportRecordsDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          spaceId={spaceId}
          path={path}
          fileName={name}
        />
      </DeferredMount>
      <ConfirmDialog
        open={changed !== null}
        onOpenChange={(open) => {
          if (!open) setChanged(null)
        }}
        title="This file changed"
        description="A newer version was saved after you opened it. Replacing it keeps that version in history."
        confirmLabel="Replace Anyway"
        loadingLabel="Replacing…"
        loading={uploading}
        onConfirm={() => {
          if (changed) void uploadVersion(changed, "current")
        }}
      />
      <input
        ref={picker}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) void uploadVersion(file, basedOn)
        }}
      />
    </>
  )

  if (framedOn && !waiting) {
    return (
      <div className="flex h-full flex-col">
        {dialogs}
        <Suspense fallback={null}>
          <PdfFileView
            key={url}
            viewer={view === "word" ? "word" : "pdf"}
            spaceId={spaceId}
            path={path}
            name={name}
            fileUrl={url}
            byteLength={page.byteLength!}
            refusal={(status) => <FileCard name={name} status={status} />}
            leading={
              <DocumentByline
                spaceId={spaceId}
                docPath={path}
                {...(page.document.updatedAt
                  ? { updatedAt: page.document.updatedAt }
                  : {})}
                {...(page.backlinks ? { backlinks: page.backlinks } : {})}
                {...(page.referrers ? { referrers: page.referrers } : {})}
              />
            }
          />
        </Suspense>
      </div>
    )
  }

  if (tableOn) {
    return (
      <div className="flex h-full flex-col">
        {dialogs}
        <Suspense fallback={null}>
          <TableFileView
            key={url}
            name={name}
            text={tableText.data ?? undefined}
            leading={
              <DocumentByline
                spaceId={spaceId}
                docPath={path}
                {...(page.document.updatedAt
                  ? { updatedAt: page.document.updatedAt }
                  : {})}
                {...(page.backlinks ? { backlinks: page.backlinks } : {})}
                {...(page.referrers ? { referrers: page.referrers } : {})}
              />
            }
          />
        </Suspense>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {dialogs}
      <div
        ref={fade}
        data-document-scroll-root
        className="scroll-fade h-full w-full flex-1 overflow-auto"
      >
        <article
          ref={article}
          className="worktable-markdown worktable-document-content"
        >
          <h1>{name}</h1>
          <DocumentByline
            spaceId={spaceId}
            docPath={path}
            {...(page.document.updatedAt
              ? { updatedAt: page.document.updatedAt }
              : {})}
            {...(page.backlinks ? { backlinks: page.backlinks } : {})}
            {...(page.referrers ? { referrers: page.referrers } : {})}
            tip={<TipCard tip="fileMeet" className="mt-3" />}
          />
          {waiting ? (
            <FileCard
              name={name}
              status="Data Saver is on"
              action={
                <Button size="sm" onClick={() => setOpenAnyway(true)}>
                  Open
                </Button>
              }
            />
          ) : (
            <FileContent
              key={url}
              // While the page learns whether the viewer is on, nothing shows.
              view={framed ? (deployment ? "card" : "pending") : view}
              url={url}
              name={name}
              // A table's text is read above, once; this only says why it
              // shows as a card, so the card never starts the read again.
              tooLarge={
                page.noHistory !== undefined ||
                (tableView && tableText.data === null)
              }
              readFailed={tableView && tableText.isError}
            />
          )}
          {page.noHistory ? (
            <p className="text-sm text-muted-foreground">
              No history while this file is larger than 64 MiB.
            </p>
          ) : null}
          {view === "image" ? (
            <>
              <DataTooltips rootRef={article} />
              <ImageViewControl
                frameRef={article}
                openOnClick
                linksToFile={false}
              />
            </>
          ) : null}
        </article>
      </div>
    </div>
  )
}

function FileContent({
  view,
  url,
  name,
  tooLarge,
  readFailed,
}: {
  view: FileView | "pending"
  url: string
  name: string
  /** Past what a version holds, or what a preview reads: no preview. */
  tooLarge: boolean
  /** The file's text couldn't be read for its page. */
  readFailed: boolean
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const text = useQuery({
    queryKey: filePreviewTextKey(url),
    queryFn: () => readPreviewText(url),
    enabled: !tooLarge && view === "text",
    staleTime: Infinity,
  })
  if (view === "pending") return null
  // A PDF or Word file reaches here only where its viewer is off or the
  // file is too large.
  if (view === "card" || ((view === "pdf" || view === "word") && !tooLarge)) {
    return <FileCard name={name} status="No preview for this file type" />
  }
  if (tooLarge || text.data === null) {
    return <FileCard name={name} status="Too large to preview" />
  }
  if (readFailed || text.isError || imageFailed) {
    return <FileCard name={name} status="Couldn’t load preview" />
  }
  if (view === "image") {
    return (
      <p>
        <img
          src={url}
          alt={name}
          data-viewable=""
          tabIndex={0}
          onError={() => setImageFailed(true)}
        />
      </p>
    )
  }
  if (view === "frame") {
    // The page as written, with its scripts off and nothing loaded from the
    // network: the server sandboxes the response, and so does the frame.
    return (
      <div className="not-prose my-6 overflow-hidden rounded-xl card-surface">
        <iframe
          title={name}
          src={url}
          sandbox=""
          referrerPolicy="no-referrer"
          className="block h-[70vh] w-full border-0 bg-background"
        />
      </div>
    )
  }
  if (text.data === undefined) return null
  // A table that loaded shows as a grid in the pane, never here.
  if (view === "text") {
    return (
      <pre>
        <code>{text.data}</code>
      </pre>
    )
  }
  return null
}

/** Whether the browser asks pages to save data, as Data Saver does. */
function savingData(): boolean {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection
  return connection?.saveData === true
}

function FileCard({
  name,
  status,
  action,
}: {
  name: string
  status: string
  action?: ReactNode
}) {
  const dot = name.lastIndexOf(".")
  const type = dot > 0 ? name.slice(dot + 1).toUpperCase() : "File"
  return (
    <div className="not-prose my-6 flex items-center gap-3 rounded-xl card-surface p-4">
      <div className="flex size-10 items-center justify-center rounded-lg bg-surface-tint text-muted-foreground">
        <FileIcon className="size-5" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {name}
        </div>
        <div className="text-sm text-muted-foreground">
          {type} · {status}
        </div>
      </div>
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
  )
}

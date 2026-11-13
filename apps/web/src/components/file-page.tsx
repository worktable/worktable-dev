import { lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  AppWindow,
  Database,
  Download,
  File as FileIcon,
  Upload,
} from "lucide-react"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { toast } from "@worktable/ui/components/sonner"
import {
  delimiterForFilename,
  filePolicy,
  parseDelimitedText,
  type DocumentPage,
  type FileSurfacePolicies,
} from "@worktable/types"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { DataTooltips } from "@/components/document/data-tooltip"
import { ImageViewControl } from "@/components/viewer/image-view-control"
import { mergeRefs, usePaneWidth } from "@/hooks/use-pane-width"
import { useSetPageMeta } from "@/hooks/use-page-meta"
import { DocTable } from "@/components/document/doc-table"
import { DocumentByline } from "@/components/document/document-byline"
import { documentQueryKeys } from "@/lib/documents-queries"
import { documentRoute } from "@/lib/document-views"
import { authenticatedFetch, fetchJSON } from "@/lib/http"
import {
  FileChangedError,
  fileSourceUrl,
  replaceFile,
} from "@/lib/file-embeds"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import "@/styles/document-controls.css"

// Only a table file's import loads the dialog, when it opens.
const ImportRecordsDialog = lazy(() =>
  import("@/components/records/import-records-dialog").then((module) => ({
    default: module.ImportRecordsDialog,
  }))
)

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

/** Text larger than this shows as a card with Download instead. */
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024
/** Rows a table shows; the rest stay in the file. */
const TABLE_MAX_ROWS = 1000
/** Cells a table shows at most, so one very wide row can't stall the tab. */
const TABLE_MAX_CELLS = 50_000
/** Columns a table shows at most. */
const TABLE_MAX_COLUMNS = 200

/** The file's text, or null once it passes the preview limit. */
async function readPreviewText(url: string): Promise<string | null> {
  const response = await authenticatedFetch(url)
  if (!response.ok) throw new Error(`File read failed: ${response.status}`)
  const length = Number(response.headers.get("content-length") ?? "0")
  if (length > PREVIEW_MAX_BYTES) return null
  // Without a length to trust, read only as far as the limit.
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    bytes += value.byteLength
    if (bytes > PREVIEW_MAX_BYTES) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
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
  // A table's Expand widens it to this pane, as it does in a Doc.
  const paneWidth = usePaneWidth<HTMLDivElement>()
  const scrollRef = useMemo(() => mergeRefs(fade, paneWidth), [fade, paneWidth])
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
        toast.error("Couldn’t upload the new version. Try again.")
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

  return (
    <div className="flex h-full flex-col">
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
      <div
        ref={scrollRef}
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
          />
          <FileContent
            key={url}
            view={view}
            url={url}
            name={name}
            tooLarge={page.noHistory !== undefined}
          />
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
}: {
  view: FileView
  url: string
  name: string
  /** Past what a version holds: no preview is read. */
  tooLarge: boolean
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const text = useQuery({
    queryKey: ["file-preview", url],
    queryFn: () => readPreviewText(url),
    enabled: !tooLarge && (view === "table" || view === "text"),
    staleTime: Infinity,
  })
  if (view === "card") {
    return <FileCard name={name} status="No preview for this file type" />
  }
  if (tooLarge || text.data === null) {
    return <FileCard name={name} status="Too large to preview" />
  }
  if (text.isError || imageFailed) {
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
  if (view === "text") {
    return (
      <pre>
        <code>{text.data}</code>
      </pre>
    )
  }
  // Only the rows a table can show are kept; the rest are counted.
  const table = parseDelimitedText(text.data, delimiterForFilename(name), {
    maxRows: TABLE_MAX_ROWS,
  })
  // A row longer than the header keeps its values, under unnamed columns,
  // up to what the table shows; the whole file stays one Download away.
  let widest = table.header.length
  for (const row of table.rows) {
    widest = Math.max(widest, row.length)
  }
  const columns = Math.min(widest, TABLE_MAX_COLUMNS)
  const rows = table.rows.slice(
    0,
    Math.min(TABLE_MAX_ROWS, Math.floor(TABLE_MAX_CELLS / Math.max(columns, 1)))
  )
  return (
    <>
      <DocTable>
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, index) => (
              <th key={index} className="whitespace-pre-wrap">
                {table.header[index] ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: columns }, (_, index) => (
                <td key={index} className="whitespace-pre-wrap">
                  {row[index] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </DocTable>
      <p className="text-sm text-muted-foreground">
        {table.rowCount > rows.length
          ? `First ${rows.length.toLocaleString()} of ${table.rowCount.toLocaleString()} rows`
          : `${table.rowCount.toLocaleString()} ${table.rowCount === 1 ? "row" : "rows"}`}
        {widest > columns
          ? `, first ${columns.toLocaleString()} of ${widest.toLocaleString()} columns`
          : ""}
      </p>
    </>
  )
}

function FileCard({ name, status }: { name: string; status: string }) {
  const dot = name.lastIndexOf(".")
  const type = dot > 0 ? name.slice(dot + 1).toUpperCase() : "File"
  return (
    <div className="not-prose my-6 flex items-center gap-3 rounded-xl card-surface p-4">
      <div className="flex size-10 items-center justify-center rounded-lg bg-surface-tint text-muted-foreground">
        <FileIcon className="size-5" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{name}</div>
        <div className="text-sm text-muted-foreground">
          {type} · {status}
        </div>
      </div>
    </div>
  )
}

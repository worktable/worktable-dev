import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, File as FileIcon, Upload } from "lucide-react"
import { toast } from "@worktable/ui/components/sonner"
import {
  delimiterForFilename,
  parseDelimitedText,
  type DocumentPage,
} from "@worktable/types"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useSetPageMeta } from "@/hooks/use-page-meta"
import { DocTable } from "@/components/document/doc-table"
import { DocumentByline } from "@/components/document/document-byline"
import { documentQueryKeys } from "@/lib/documents-queries"
import { authenticatedFetch } from "@/lib/http"
import { fileSourceUrl, replaceFile } from "@/lib/file-embeds"
import "@/styles/document-controls.css"

/** How a file shows on its page, decided by its name. */
type FileView = "image" | "table" | "text" | "card"

const IMAGE = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i
const TABLE = /\.(?:csv|tsv)$/i
const TEXT = /\.(?:txt|log|json|jsonl|ya?ml|xml|ini|toml)$/i

function fileView(name: string): FileView {
  if (IMAGE.test(name)) return "image"
  if (TABLE.test(name)) return "table"
  if (TEXT.test(name)) return "text"
  return "card"
}

/** Text larger than this shows as a card with Download instead. */
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024
/** Rows a table shows; the rest stay in the file. */
const TABLE_MAX_ROWS = 1000

async function readPreviewText(url: string): Promise<string | null> {
  const response = await authenticatedFetch(url)
  if (!response.ok) throw new Error(`File read failed: ${response.status}`)
  const length = Number(response.headers.get("content-length") ?? "0")
  if (length > PREVIEW_MAX_BYTES) return null
  return response.text()
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
  const view = fileView(name)
  const setPageMeta = useSetPageMeta()
  const queryClient = useQueryClient()
  const fade = useScrollFade<HTMLDivElement>(8, { top: false })
  const picker = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  // The file loads by what its bytes are, so an unchanged file comes from
  // the browser's cache and a changed one loads anew. Right after Upload New
  // Version, the new bytes' hash stands in until the page catches up.
  const [uploaded, setUploaded] = useState<{
    hash: string
    replacedVersion: string | undefined
  } | null>(null)
  const version =
    uploaded && uploaded.replacedVersion === page.version
      ? uploaded.hash
      : (page.version ?? null)
  const url = fileSourceUrl(spaceId, path, version)

  const uploadVersion = useCallback(
    async (file: File) => {
      setUploading(true)
      try {
        const { contentHash } = await replaceFile(spaceId, path, file)
        setUploaded({ hash: contentHash, replacedVersion: page.version })
        void queryClient.invalidateQueries({
          queryKey: documentQueryKeys.page(spaceId, path),
          exact: true,
        })
        toast.success("New version uploaded")
      } catch (error) {
        console.error("File upload failed:", error)
        toast.error("Couldn’t upload the new version. Try again.")
      } finally {
        setUploading(false)
      }
    },
    [page.version, path, queryClient, spaceId]
  )

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
      ...(page.capabilities.edit !== false && !page.document.archived
        ? {
            secondaryAction: {
              label: "Upload New Version",
              icon: Upload,
              pending: uploading,
              disabled: uploading,
              onClick: () => picker.current?.click(),
            },
          }
        : {}),
    })
    return () => setPageMeta(null)
  }, [name, page, path, setPageMeta, spaceId, uploading])

  return (
    <div className="flex h-full flex-col">
      <input
        ref={picker}
        type="file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ""
          if (file) void uploadVersion(file)
        }}
      />
      <div
        ref={fade}
        data-document-scroll-root
        className="scroll-fade h-full w-full flex-1 overflow-auto"
      >
        <article className="worktable-markdown worktable-document-content">
          <h1>{name}</h1>
          <DocumentByline
            spaceId={spaceId}
            docPath={path}
            {...(page.document.updatedAt
              ? { updatedAt: page.document.updatedAt }
              : {})}
            {...(page.backlinks ? { backlinks: page.backlinks } : {})}
          />
          <FileContent view={view} url={url} name={name} />
        </article>
      </div>
    </div>
  )
}

function FileContent({
  view,
  url,
  name,
}: {
  view: FileView
  url: string
  name: string
}) {
  const text = useQuery({
    queryKey: ["file-preview", url],
    queryFn: () => readPreviewText(url),
    enabled: view === "table" || view === "text",
    staleTime: Infinity,
  })
  if (view === "image") {
    return (
      <p>
        <img src={url} alt={name} />
      </p>
    )
  }
  if (view === "card" || text.data === null || text.isError) {
    return <FileCard name={name} />
  }
  if (text.data === undefined) return null
  if (view === "text") {
    return (
      <pre>
        <code>{text.data}</code>
      </pre>
    )
  }
  const table = parseDelimitedText(text.data, delimiterForFilename(name))
  const rows = table.rows.slice(0, TABLE_MAX_ROWS)
  // A row longer than the header keeps its values, under unnamed columns.
  const columns = Math.max(table.header.length, ...rows.map((row) => row.length))
  return (
    <>
      <DocTable>
        <thead>
          <tr>
            {Array.from({ length: columns }, (_, index) => (
              <th key={index}>{table.header[index] ?? ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: columns }, (_, index) => (
                <td key={index}>{row[index] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </DocTable>
      <p className="text-sm text-muted-foreground">
        {table.rows.length > rows.length
          ? `First ${rows.length.toLocaleString()} of ${table.rows.length.toLocaleString()} rows`
          : `${table.rows.length.toLocaleString()} ${table.rows.length === 1 ? "row" : "rows"}`}
      </p>
    </>
  )
}

function FileCard({ name }: { name: string }) {
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
          {type} · No preview
        </div>
      </div>
    </div>
  )
}

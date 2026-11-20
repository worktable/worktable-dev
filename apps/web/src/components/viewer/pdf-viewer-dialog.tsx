import { Download } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { Button } from "@worktable/ui/components/button"
import { documentRoute } from "@/lib/document-views"
import { fileSourceUrl } from "@/lib/file-embeds"
import type { SourceFile } from "@/lib/source-file"
import { ViewerDialog, ViewerHeader } from "./viewer-dialog"
import PdfFileView from "./pdf-file-view"

/** A PDF a Doc embeds, by the Space file it is. */
export type ViewerPdf = SourceFile

/**
 * A PDF full screen, over the Doc it is in: the same viewer as the file's
 * own page, with Download and Open.
 */
export default function PdfViewerDialog({
  open,
  onOpenChange,
  pdf,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pdf: ViewerPdf
}) {
  const name = pdf.path.slice(pdf.path.lastIndexOf("/") + 1)
  const at = pdf.at ? { at: pdf.at } : {}
  return (
    <ViewerDialog open={open} onOpenChange={onOpenChange}>
      <div className="flex h-full min-h-0 flex-col">
        <ViewerHeader title={name} fallbackTitle="PDF">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              window.location.href = fileSourceUrl(
                pdf.spaceId,
                pdf.path,
                pdf.version,
                {
                  download: true,
                  ...at,
                }
              )
            }}
            title="Download"
            aria-label="Download"
          >
            <Download />
          </Button>
          <Button
            nativeButton={false}
            variant="ghost"
            size="sm"
            render={
              <Link
                {...documentRoute(pdf.spaceId, pdf.path)}
                onClick={() => onOpenChange(false)}
              />
            }
            aria-label="Open file page"
          >
            Open
          </Button>
        </ViewerHeader>
        <div className="min-h-0 flex-1">
          <PdfFileView
            spaceId={pdf.spaceId}
            path={pdf.path}
            name={name}
            fileUrl={fileSourceUrl(pdf.spaceId, pdf.path, pdf.version, at)}
          />
        </div>
      </div>
    </ViewerDialog>
  )
}

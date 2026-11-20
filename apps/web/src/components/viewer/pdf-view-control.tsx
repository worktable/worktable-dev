import { lazy, useEffect, useState, type RefObject } from "react"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import { filePolicy } from "@worktable/types"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { sourceFileOf } from "@/lib/file-embeds"
import type { ViewerPdf } from "./pdf-viewer-dialog"

// The viewer loads when a PDF is first pointed at, so it opens at once.
const loadViewer = () => import("./pdf-viewer-dialog")
const PdfViewerDialog = lazy(loadViewer)

/** The PDF cards in a Doc: a Markdown embed's, or a rich-text file block's name. */
const PDF_TARGETS =
  '[data-pdf-card], [data-content-type="file"] .bn-file-name-with-icon'

/**
 * The Space file a PDF card in a Doc stands for, or null for anything else,
 * such as a file block holding a web address or another type of file.
 */
function pdfOf(
  element: Element | null,
  resolve: (ref: string) => string
): ViewerPdf | null {
  const target = element?.closest(PDF_TARGETS)
  if (!target) return null
  const ref =
    target.getAttribute("data-pdf-card") ??
    target.closest('[data-content-type="file"]')?.getAttribute("data-url")
  if (!ref) return null
  const file = sourceFileOf(resolve(ref))
  return file && filePolicy(file.path, "page") === "pdf" ? file : null
}

/**
 * Opens a PDF a Doc embeds full screen, in the PDF viewer. A Markdown embed
 * of a PDF is a card, and a rich-text file block of one shows its name;
 * pressing either opens the file over the Doc.
 */
export function PdfViewControl({
  frameRef,
  resolve,
}: {
  /** The element the Doc's content is in. */
  frameRef: RefObject<HTMLElement | null>
  /** Where a file the Doc names loads from, at the version its page gives. */
  resolve: (ref: string) => string
}) {
  // Where the viewer is off, a card stays a link to the file's page.
  const viewerOn = useDeploymentInfo().data?.capabilities.pdfViewer === true
  const [pdf, setPdf] = useState<ViewerPdf | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !viewerOn) return
    const show = (event: Event) => {
      const found = pdfOf(event.target as Element | null, resolve)
      if (!found) return
      event.preventDefault()
      event.stopPropagation()
      setPdf(found)
      setOpen(true)
    }
    const point = (event: Event) => {
      if (pdfOf(event.target as Element | null, resolve)) void loadViewer()
    }
    const click = (event: MouseEvent) => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey) show(event)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return
      if ((event.target as Element | null)?.matches?.("[data-pdf-card]"))
        show(event)
    }
    frame.addEventListener("pointerover", point)
    frame.addEventListener("click", click, true)
    frame.addEventListener("keydown", key)
    return () => {
      frame.removeEventListener("pointerover", point)
      frame.removeEventListener("click", click, true)
      frame.removeEventListener("keydown", key)
    }
  }, [frameRef, resolve, viewerOn])

  return (
    <DeferredMount active={open}>
      {pdf && <PdfViewerDialog open={open} onOpenChange={setOpen} pdf={pdf} />}
    </DeferredMount>
  )
}

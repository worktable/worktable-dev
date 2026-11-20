import { useEffect, useMemo, useRef, useState } from "react"
import { Copy, Download, Maximize, X } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import {
  shareLinkQr,
  shareLinkQrFileName,
  shareLinkQrPath,
  shareLinkQrPng,
  type ShareLinkQr as Code,
} from "@/lib/share-link-qr"

/**
 * A link's QR code, with ways to take it elsewhere: a file, the clipboard, or
 * the whole screen for a room to scan.
 */
export default function ShareLinkQr({
  url,
  title,
}: {
  url: string
  /** The document's name, for the file and the full screen view. */
  title?: string
}) {
  const qr = useMemo(() => shareLinkQr(url), [url])
  const screen = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  useEffect(() => {
    const changed = () => setFull(document.fullscreenElement === screen.current)
    document.addEventListener("fullscreenchange", changed)
    return () => document.removeEventListener("fullscreenchange", changed)
  }, [])
  // Copying a picture needs a secure page; an iPhone has no full screen.
  const canCopy =
    typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write)
  const canFill = document.fullscreenEnabled

  function download() {
    shareLinkQrPng(url).then(
      (blob) => {
        const href = URL.createObjectURL(blob)
        const anchor = document.createElement("a")
        anchor.href = href
        anchor.download = shareLinkQrFileName(title)
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(href), 10_000)
      },
      () => toast.error("Couldn’t make the image")
    )
  }

  function copy() {
    // Handed over as a promise, so Safari still counts it as this click.
    navigator.clipboard
      .write([new ClipboardItem({ "image/png": shareLinkQrPng(url) })])
      .then(
        () => toast.success("Image copied"),
        () => toast.error("Couldn’t copy the image")
      )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-1.5">
      <QrTile
        qr={qr}
        className="size-52 shrink-0 rounded-xl border border-border p-2"
      />
      <div className="flex min-w-36 flex-1 flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={download}
        >
          <Download className="size-4" />
          Download PNG
        </Button>
        {canCopy ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={copy}
          >
            <Copy className="size-4" />
            Copy Image
          </Button>
        ) : null}
        {canFill ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={() => void screen.current?.requestFullscreen()}
          >
            <Maximize className="size-4" />
            Full Screen
          </Button>
        ) : null}
      </div>
      {/* Shown only while it fills the screen: the code, and the link in
          words for anyone who can't scan. Always dark on white. */}
      <div
        ref={screen}
        className="hidden flex-col items-center justify-center gap-6 bg-white p-10 text-black [&:fullscreen]:flex"
      >
        {full ? (
          <>
            <button
              type="button"
              aria-label="Exit full screen"
              className="absolute top-5 right-5 rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 hover:text-black"
              onClick={() => void document.exitFullscreen()}
            >
              <X className="size-6" />
            </button>
            <QrTile qr={qr} className="size-[min(68vh,80vw)]" />
            {title ? (
              <p className="text-center text-3xl font-semibold">{title}</p>
            ) : null}
            <p className="max-w-[90vw] text-center font-mono text-2xl break-all">
              {url.replace(/^https?:\/\//, "")}
            </p>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** The code itself. Scanners need dark squares on white, in either theme. */
function QrTile({ qr, className }: { qr: Code; className?: string }) {
  const path = useMemo(() => shareLinkQrPath(qr), [qr])
  return (
    <div className={cn("bg-white", className)}>
      <svg
        role="img"
        aria-label="QR code for this link"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shapeRendering="crispEdges"
        className="size-full"
      >
        <path d={path} fill="#000" />
      </svg>
    </div>
  )
}

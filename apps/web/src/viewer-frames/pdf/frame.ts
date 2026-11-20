// The PDF viewer frame. It runs pdf.js on bytes the page hands it, inside a
// document with no origin and no network; see viewer-frame-protocol.ts.

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import "./pdfjs-global"
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs"
import type { ViewerHostMessage } from "../../lib/viewer-frame-protocol"
import { VIEWER_PIECE_BYTES } from "../../lib/viewer-frame-protocol"
import { asset, assetArrived, hear, say, startWorker } from "../frame-host"

const container = document.getElementById("viewer-container") as HTMLDivElement
const pages = document.getElementById("viewer-pages") as HTMLDivElement
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "light"
    ? "light"
    : "dark"

/** The viewer's own files come from the page, never the network. */
class HostBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const kinds: Record<string, string> = {
      cMapUrl: "cmaps",
      standardFontDataUrl: "standard_fonts",
      wasmUrl: "wasm",
    }
    return new Uint8Array(
      await asset({ kind: kinds[kind] ?? "unknown", name: filename })
    )
  }
}

/** The file's bytes, a piece at a time, from the page. */
class HostTransport extends pdfjs.PDFDataRangeTransport {
  override requestDataRange(begin: number, end: number): void {
    say({ type: "viewer.read", begin, end })
  }
}

let transport: HostTransport | null = null
let viewer: PDFViewer | null = null
let eventBus: EventBus | null = null
let query = ""

function state() {
  return {
    page: viewer?.currentPageNumber ?? 1,
    pages: viewer?.pagesCount ?? 0,
    scale: viewer?.currentScale ?? 1,
  }
}

async function open(
  message: Extract<ViewerHostMessage, { type: "viewer.open" }>
) {
  // Parsing runs in a worker, off this thread. Where a browser won't start
  // one here, the file isn't shown and its page offers the download.
  let worker: InstanceType<typeof pdfjs.PDFWorker>
  try {
    worker = new pdfjs.PDFWorker({ port: await startWorker("viewer-worker") })
  } catch {
    say({ type: "viewer.refused", reason: "failed" })
    return
  }
  const start = new Uint8Array(message.start)
  if (!message.whole) {
    transport = new HostTransport(message.byteLength, start)
  }
  const task = pdfjs.getDocument({
    ...(transport ? { range: transport } : { data: start }),
    worker,
    rangeChunkSize: VIEWER_PIECE_BYTES,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: "cmaps/",
    standardFontDataUrl: "standard_fonts/",
    wasmUrl: "wasm/",
    useWorkerFetch: false,
    BinaryDataFactory: HostBinaryData,
    // A font the file names but doesn't carry comes from the viewer's own
    // files, so a page looks the same on every device.
    useSystemFonts: false,
    enableXfa: false,
    maxImageSize: 64 * 1024 * 1024,
  })
  task.onPassword = () => {
    say({ type: "viewer.refused", reason: "password" })
    void task.destroy()
  }
  let pdf: Awaited<typeof task.promise>
  try {
    pdf = await task.promise
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== "PasswordException") {
      say({ type: "viewer.refused", reason: "damaged" })
    }
    return
  }
  eventBus = new EventBus()
  const linkService = new PDFLinkService({ eventBus })
  const findController = new PDFFindController({ eventBus, linkService })
  viewer = new PDFViewer({
    container,
    viewer: pages,
    eventBus,
    linkService,
    findController,
    textLayerMode: 1,
    // Forms and notes are drawn as the file shows them, never as fields a
    // reader could fill in: this viewer can't save a file back.
    annotationMode: pdfjs.AnnotationMode.ENABLE,
  })
  linkService.setViewer(viewer)
  let shown = false
  eventBus.on("pagesinit", () => {
    if (!viewer) return
    viewer.currentScaleValue = "page-width"
    if (message.page) viewer.currentPageNumber = message.page
  })
  eventBus.on("pagerendered", () => {
    if (shown) return
    shown = true
    say({ type: "viewer.shown", ...state() })
  })
  eventBus.on("pagechanging", () => say({ type: "viewer.state", ...state() }))
  eventBus.on("scalechanging", () => say({ type: "viewer.state", ...state() }))
  eventBus.on(
    "updatefindmatchescount",
    (event: { matchesCount: { current: number; total: number } }) =>
      say({ type: "viewer.find", ...event.matchesCount })
  )
  eventBus.on(
    "updatefindcontrolstate",
    (event: { matchesCount: { current: number; total: number } }) =>
      say({ type: "viewer.find", ...event.matchesCount })
  )
  viewer.setDocument(pdf)
  linkService.setDocument(pdf)
}

function command(
  message: Extract<ViewerHostMessage, { type: "viewer.command" }>
) {
  if (!viewer || !eventBus) return
  const asked = message.command
  if (asked.name === "page") {
    viewer.currentPageNumber = Math.min(
      Math.max(1, asked.page),
      viewer.pagesCount
    )
  } else if (asked.name === "zoom") {
    if (asked.to === "fit") viewer.currentScaleValue = "page-width"
    else if (asked.to === "in") viewer.increaseScale()
    else viewer.decreaseScale()
  } else {
    const again = asked.query === query && asked.direction !== undefined
    query = asked.query
    eventBus.dispatch("find", {
      source: null,
      type: again ? "again" : "",
      query,
      highlightAll: true,
      findPrevious: asked.direction === "previous",
    })
  }
}

hear((message) => {
  if (message.type === "viewer.open") void open(message)
  else if (message.type === "viewer.bytes") {
    if (message.data) {
      transport?.onDataRange(message.begin, new Uint8Array(message.data))
    }
  } else if (message.type === "viewer.asset")
    assetArrived(message.id, message.data)
  else command(message)
})

// Fit to width follows the pane as it is resized.
window.addEventListener("resize", () => {
  if (viewer?.currentScaleValue === "page-width") {
    viewer.currentScaleValue = "page-width"
  }
})

// A link out is the page's to open: the frame can't open a window, and
// following it here would replace the viewer.
document.addEventListener(
  "click",
  (event) => {
    const link = (event.target as Element | null)?.closest?.("a[href]")
    const href = link?.getAttribute("href") ?? ""
    if (!link || href.startsWith("#")) return
    event.preventDefault()
    say({ type: "viewer.link", url: (link as HTMLAnchorElement).href })
  },
  true
)

// Keys the app owns go back to it while the PDF has focus.
document.addEventListener("keydown", (event) => {
  const command = event.metaKey || event.ctrlKey
  if (event.key === "Escape") say({ type: "viewer.key", key: "Escape" })
  else if (command && event.key.toLowerCase() === "f") {
    event.preventDefault()
    say({ type: "viewer.key", key: "find" })
  }
})

say({ type: "viewer.handshake" })

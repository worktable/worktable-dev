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
import { createRail, type Rail } from "./rail"

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

/** The most fetched beyond what pdf.js asked for, when it reads in a row. */
const READ_AHEAD_MAX_BYTES = 4 * 1024 * 1024

/** The most fetched-ahead bytes kept for requests still to come. */
const KEPT_AHEAD_MAX_BYTES = 16 * 1024 * 1024

/**
 * The file's bytes, a piece at a time, from the page. pdf.js asks for one
 * piece after another when it walks a long table, forwards or, for some
 * files, backwards, each a round trip. When a request lies next to the last
 * one, more is fetched in that direction than was asked for, doubling each
 * time, and later requests inside what was fetched are answered at once.
 */
class HostTransport extends pdfjs.PDFDataRangeTransport {
  #length: number
  /** Reads sent to the page, by where they begin: what pdf.js asked for. */
  #asked = new Map<number, { begin: number; end: number }>()
  /** Fetched bytes pdf.js hasn't asked for yet, oldest first. */
  #kept: { begin: number; bytes: Uint8Array }[] = []
  #last: { begin: number; end: number } | null = null
  #extra = 0

  constructor(length: number, start: Uint8Array) {
    super(length, start)
    this.#length = length
  }

  override requestDataRange(begin: number, end: number): void {
    const last = this.#last
    this.#last = { begin, end }
    const kept = this.#kept.find(
      (each) => each.begin <= begin && each.begin + each.bytes.byteLength >= end
    )
    if (kept) {
      const now = kept.bytes.slice(begin - kept.begin, end - kept.begin)
      void Promise.resolve().then(() => this.onDataRange(begin, now))
      return
    }
    const forwards = last !== null && begin === last.end
    const backwards = last !== null && end === last.begin
    this.#extra =
      forwards || backwards
        ? Math.min(
            Math.max(this.#extra * 2, VIEWER_PIECE_BYTES),
            READ_AHEAD_MAX_BYTES
          )
        : 0
    const from = backwards ? Math.max(0, begin - this.#extra) : begin
    const to = forwards ? Math.min(this.#length, end + this.#extra) : end
    this.#asked.set(from, { begin, end })
    say({ type: "viewer.read", begin: from, end: to })
  }

  /** Bytes the page sent for a read that began at `from`. */
  arrived(from: number, data: Uint8Array): void {
    const asked = this.#asked.get(from) ?? {
      begin: from,
      end: from + data.byteLength,
    }
    this.#asked.delete(from)
    if (data.byteLength > asked.end - asked.begin) {
      this.#kept.push({ begin: from, bytes: data })
      let size = this.#kept.reduce(
        (sum, each) => sum + each.bytes.byteLength,
        0
      )
      while (size > KEPT_AHEAD_MAX_BYTES && this.#kept.length > 1) {
        size -= this.#kept.shift()!.bytes.byteLength
      }
    }
    this.onDataRange(
      asked.begin,
      data.slice(asked.begin - from, asked.end - from)
    )
  }
}

let transport: HostTransport | null = null
let viewer: PDFViewer | null = null
let eventBus: EventBus | null = null
let query = ""
// The page browser, made once the pages are laid out, and whether the page
// that holds this frame wants it open.
let rail: Rail | null = null
let railOpen = false
let givePassword: ((password: string | null) => void) | null = null

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
    // pdf.js types the port as null; it takes a started worker.
    const port = (await startWorker("viewer-worker")) as unknown as null
    worker = new pdfjs.PDFWorker({ port })
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
  // The reader is asked in the app's page; the password stays in this open.
  task.onPassword = (answer: (password: string) => void, reason: number) => {
    givePassword = (password) => {
      givePassword = null
      if (password === null) {
        say({ type: "viewer.refused", reason: "password" })
        void task.destroy()
      } else answer(password)
    }
    say({
      type: "viewer.password",
      retry: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD,
    })
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
    // The width of the pane, up to a size that still reads as a page.
    viewer.currentScaleValue = "auto"
    if (message.page) viewer.currentPageNumber = message.page
    void createRail({ pdf, viewer, linkService }).then((made) => {
      rail = made
      rail.setOpen(railOpen)
    })
  })
  eventBus.on("pagerendered", () => {
    if (shown) return
    shown = true
    say({ type: "viewer.shown", ...state() })
  })
  eventBus.on("pagechanging", () => {
    rail?.setPage(viewer?.currentPageNumber ?? 1)
    say({ type: "viewer.state", ...state() })
  })
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
  if (asked.name === "rail") {
    railOpen = asked.open
    rail?.setOpen(railOpen)
  } else if (asked.name === "page") {
    viewer.currentPageNumber = Math.min(
      Math.max(1, asked.page),
      viewer.pagesCount
    )
  } else if (asked.name === "zoom") {
    if (asked.to === "fit") viewer.currentScaleValue = "page-width"
    else if (asked.to === "in") viewer.increaseScale()
    else viewer.decreaseScale()
  } else if (asked.query === "") {
    query = ""
    eventBus.dispatch("findbarclose", { source: null })
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
    transport?.arrived(message.begin, new Uint8Array(message.data))
  } else if (message.type === "viewer.theme") {
    document.documentElement.dataset.theme =
      message.theme === "light" ? "light" : "dark"
  } else if (message.type === "viewer.asset")
    assetArrived(message.id, message.data)
  else if (message.type === "viewer.password") givePassword?.(message.password)
  else command(message)
})

// A zoom that fits the pane follows it as it is resized.
window.addEventListener("resize", () => {
  const fit = viewer?.currentScaleValue
  if (viewer && (fit === "auto" || fit === "page-width")) {
    viewer.currentScaleValue = fit
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

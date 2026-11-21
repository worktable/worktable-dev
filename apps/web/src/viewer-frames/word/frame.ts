// The Word viewer frame. It draws a Word file with Extend's renderer, on
// bytes the page hands it, inside a document with no origin and no network;
// see viewer-frame-protocol.ts.
//
// The server also opens this document in its preview browser to draw a
// Word file once as a PDF (word-renditions.ts). There it is loaded with
// `?print`, reads its file and its own files from the page's address, and
// lays out every page for printing instead of talking to a page around it.

import {
  createDocxViewer,
  setWasmSource,
  type DocxViewer,
  type DocxVanillaViewerController,
} from "@extend-ai/react-docx/vanilla"
import type { ViewerHostMessage } from "../../lib/viewer-frame-protocol"
import { asset, assetArrived, hear, say } from "../frame-host"

/** The largest Word file this frame draws. Past it, the page shows a card. */
const WORD_MAX_BYTES = 32 * 1024 * 1024

/**
 * How far one Zoom In or Zoom Out goes, and the range zoom stays in, as
 * Extend counts zoom: a percentage of the page's own size.
 */
const ZOOM_STEP = 1.25
const ZOOM_MIN = 25
const ZOOM_MAX = 200

/** Drawn by the server's preview browser for a PDF, not shown to a reader. */
const printing = new URLSearchParams(location.search).has("print")

const container = document.getElementById("viewer-container") as HTMLDivElement
const root = document.getElementById("viewer-document") as HTMLDivElement

function setTheme(theme: string | null): void {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark"
}
setTheme(new URLSearchParams(location.search).get("theme"))

/** The colour around the pages, which follows the app's theme. */
function gapColor(): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--viewer-background")
    .trim()
}

/** Each look-alike family's faces: regular, bold, italic, bold italic. */
const FACES_PER_FAMILY = 4

// The renderer's engine comes from the page, never the network; it is asked
// for as soon as the frame starts, so it downloads while the file does.
let engine: Promise<WebAssembly.Module> | null = null

declare global {
  // The build points the renderer's worker and font loads here: see
  // apps/web/viewer-frames.ts.
  var __wordViewerWorker: () => Worker
  var __wordViewerFont: (id: string) => Promise<{ faces: { source: string }[] }>
}

/**
 * The renderer's import worker. A frame with no origin can start one only
 * from a blob, and only as a classic script, from the code it carries.
 */
globalThis.__wordViewerWorker = () => {
  const code = document.getElementById("viewer-worker")?.textContent ?? ""
  return new Worker(
    URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
  )
}

const fonts = new Map<string, Promise<{ faces: { source: string }[] }>>()
/**
 * A look-alike font family, in the order the renderer asks for its faces:
 * regular, bold, italic, bold italic. Loaded only when a file names it and
 * the machine doesn't have the font it stands in for.
 */
globalThis.__wordViewerFont = (id) => {
  let family = fonts.get(id)
  // In print, the faces are read from this document's own address.
  if (!family && printing) {
    family = Promise.resolve({
      faces: Array.from({ length: FACES_PER_FAMILY }, (_, index) => ({
        source: `files/fonts/${id}-${index}.woff2`,
      })),
    })
    fonts.set(id, family)
  }
  if (!family) {
    family = Promise.all(
      Array.from({ length: FACES_PER_FAMILY }, (_, index) =>
        asset({ kind: "fonts", name: `${id}-${index}.woff2` }).then(
          (bytes) => ({
            source: URL.createObjectURL(
              new Blob([bytes], { type: "font/woff2" })
            ),
          })
        )
      )
    ).then((faces) => ({ faces }))
    // A family that failed to load can be asked for again.
    family.catch(() => fonts.delete(id))
    fonts.set(id, family)
  }
  return family
}

let viewer: DocxViewer | null = null
let controller: DocxVanillaViewerController | null = null
let shown = false

function state() {
  const pages = controller?.totalPages ?? 0
  return {
    page: Math.min(
      Math.max(1, controller?.currentPage ?? 1),
      Math.max(1, pages)
    ),
    pages,
    scale: (controller?.getResolvedZoom() ?? 100) / 100,
  }
}

let lastState = ""
function report(): void {
  if (!controller?.hasDocument || controller.isLoading) return
  const now = state()
  const key = `${now.page}/${now.pages}/${now.scale}`
  if (key === lastState) return
  lastState = key
  say({ type: shown ? "viewer.state" : "viewer.shown", ...now })
  shown = true
}

/** The file's bytes: what the page sent first, and the rest asked for. */
async function wholeFile(
  message: Extract<ViewerHostMessage, { type: "viewer.open" }>
): Promise<ArrayBuffer> {
  if (message.whole) return message.start
  const rest = await new Promise<ArrayBuffer>((resolve) => {
    restArrived = resolve
    say({
      type: "viewer.read",
      begin: message.start.byteLength,
      end: message.byteLength,
    })
  })
  const bytes = new Uint8Array(message.byteLength)
  bytes.set(new Uint8Array(message.start), 0)
  bytes.set(new Uint8Array(rest), message.start.byteLength)
  return bytes.buffer
}
let restArrived: ((data: ArrayBuffer) => void) | null = null

/**
 * Whether a file is an encrypted Word file, which is not a zip but a
 * compound file. It is never parsed.
 */
function encrypted(file: ArrayBuffer): boolean {
  const head = new Uint8Array(file, 0, Math.min(4, file.byteLength))
  return head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11
}

async function open(
  message: Extract<ViewerHostMessage, { type: "viewer.open" }>
) {
  if (message.byteLength > WORD_MAX_BYTES) {
    say({ type: "viewer.refused", reason: "too-large" })
    return
  }
  // The engine is compiled once and handed to the import worker as is.
  let file: ArrayBuffer
  try {
    const [module, bytes] = await Promise.all([
      engine ?? Promise.reject(new Error("No engine")),
      wholeFile(message),
    ])
    setWasmSource(module)
    file = bytes
  } catch {
    say({ type: "viewer.refused", reason: "failed" })
    return
  }
  if (encrypted(file)) {
    say({ type: "viewer.refused", reason: "password" })
    return
  }
  viewer = createDocxViewer(root, {
    file,
    fileName: "file.docx",
    mode: "read-only",
    // The width of the pane, up to the page's own size.
    defaultZoom: "automatic",
    height: "100%",
    pageGapBackgroundColor: gapColor(),
    pageVirtualization: { scrollElement: container },
    showComments: false,
    showTrackedChanges: false,
    onZoomChange: report,
  })
  let reviewed = false
  viewer.subscribe((next) => {
    controller = next
    if (next.error) {
      say({ type: "viewer.refused", reason: "damaged" })
      viewer?.destroy()
      viewer = null
      return
    }
    // Nothing in the file is hidden: its comments and tracked changes show
    // beside its pages. A file with neither keeps the pages alone.
    if (!reviewed && next.hasDocument && !next.isLoading) {
      reviewed = true
      const comments = next.comments.length > 0
      const changes = next.trackedChanges.length > 0
      if (comments || changes) {
        viewer?.setOptions({
          showComments: comments,
          showTrackedChanges: changes,
        })
      }
    }
    report()
  })
}

/** Bring a page into view, from 1. */
function showPage(page: number): void {
  const pages = controller?.totalPages ?? 0
  const index = Math.min(Math.max(1, page), Math.max(1, pages)) - 1
  const target = root.querySelector<HTMLElement>(
    `[data-docx-page-index="${index}"]`
  )
  target?.scrollIntoView({ block: "start" })
}

function command(
  message: Extract<ViewerHostMessage, { type: "viewer.command" }>
) {
  if (!controller) return
  const asked = message.command
  if (asked.name === "page") showPage(asked.page)
  else if (asked.name === "zoom") {
    if (asked.to === "fit") controller.setZoom("fit-width")
    else {
      const now = controller.getResolvedZoom()
      const next = asked.to === "in" ? now * ZOOM_STEP : now / ZOOM_STEP
      controller.setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)))
    }
  }
}

/**
 * Draws the file for the server's PDF: every page, at its own size, in the
 * light theme. Says how it ended in `data-print` on the document: `ready`
 * once each page is laid out for printing, else why there is nothing to
 * print. The preview browser has no workers, so Extend reads the file on
 * this thread: an engine given as a response, not a module, keeps it here.
 */
async function print(): Promise<void> {
  const end = (state: string) => {
    document.documentElement.dataset.print = state
  }
  let file: ArrayBuffer
  try {
    const [engineResponse, response] = await Promise.all([
      fetch("files/wasm/docx_wasm_bg.wasm"),
      fetch("file"),
    ])
    if (!engineResponse.ok || !engineResponse.body) return end("failed")
    // The server's preview browser is handed the engine compressed.
    setWasmSource(
      engineResponse.headers.get("x-worktable-packed") === "gzip"
        ? new Response(
            engineResponse.body.pipeThrough(new DecompressionStream("gzip")),
            { headers: { "Content-Type": "application/wasm" } }
          )
        : engineResponse
    )
    if (!response.ok) return end("failed")
    file = await response.arrayBuffer()
  } catch {
    return end("failed")
  }
  if (file.byteLength > WORD_MAX_BYTES) return end("too-large")
  if (encrypted(file)) return end("password")
  document.documentElement.classList.add("printing")
  let reviewed = false
  const drawn = createDocxViewer(root, {
    file,
    fileName: "file.docx",
    mode: "read-only",
    zoom: 100,
    pageVirtualization: { enabled: false },
    showComments: false,
    showTrackedChanges: false,
  })
  drawn.subscribe((next) => {
    if (next.error) return end("damaged")
    if (!next.hasDocument || next.isLoading) return
    if (!reviewed) {
      // As in the viewer: comments and tracked changes print beside the
      // pages of a file that has them.
      reviewed = true
      const comments = next.comments.length > 0
      const changes = next.trackedChanges.length > 0
      if (comments || changes) {
        drawn.setOptions({
          showComments: comments,
          showTrackedChanges: changes,
        })
        return
      }
    }
    void settle().then(layOutPages, () => end("failed"))
  })
}

/** Waits for the layout to stop changing, then for fonts and pictures. */
let settling: Promise<void> | null = null
function settle(): Promise<void> {
  settling ??= (async () => {
    let last = ""
    for (let round = 0; round < 50; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const now = [...root.querySelectorAll("[data-docx-page-wrapper]")]
        .map((page) => {
          const box = page.getBoundingClientRect()
          return `${Math.round(box.width)}x${Math.round(box.height)}`
        })
        .join(",")
      if (now && now === last) break
      last = now
    }
    await document.fonts.ready
    await Promise.all(
      [...root.querySelectorAll("img")].map((image) =>
        image.decode().catch(() => undefined)
      )
    )
  })()
  return settling
}

/**
 * Gives each page its own sheet at its own size: a section can be
 * landscape, and a page with comments beside it is wider.
 */
function layOutPages(): void {
  const sizes = new Map<string, string>()
  const pages = root.querySelectorAll<HTMLElement>("[data-docx-page-wrapper]")
  for (const page of pages) {
    const box = page.getBoundingClientRect()
    const width = Math.ceil(box.width)
    const height = Math.ceil(box.height)
    const name = `sheet-${width}x${height}`
    sizes.set(name, `${width}px ${height}px`)
    page.style.setProperty("page", name)
  }
  if (sizes.size === 0) {
    document.documentElement.dataset.print = "damaged"
    return
  }
  const sheets = document.createElement("style")
  sheets.textContent = [...sizes]
    .map(([name, size]) => `@page ${name} { size: ${size}; margin: 0 }`)
    .join("\n")
  document.head.append(sheets)
  document.documentElement.dataset.pages = String(pages.length)
  document.documentElement.dataset.print = "ready"
}

if (printing) void print()

hear((message) => {
  if (message.type === "viewer.open") void open(message)
  else if (message.type === "viewer.bytes") {
    restArrived?.(message.data)
    restArrived = null
  } else if (message.type === "viewer.theme") {
    setTheme(message.theme)
    viewer?.setOptions({ pageGapBackgroundColor: gapColor() })
  } else if (message.type === "viewer.asset")
    assetArrived(message.id, message.data)
  else if (message.type === "viewer.command") command(message)
})

// The page in view changes as the reader scrolls.
container.addEventListener("scroll", () => requestAnimationFrame(report), {
  passive: true,
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

// Keys the app owns go back to it while the file has focus.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") say({ type: "viewer.key", key: "Escape" })
})

if (!printing) {
  say({ type: "viewer.handshake" })
  engine = asset({ kind: "wasm", name: "docx_wasm_bg.wasm" }).then((bytes) =>
    WebAssembly.compile(bytes)
  )
}

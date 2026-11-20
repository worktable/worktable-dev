// The page browser beside a PDF: a picture of each page, and the file's own
// outline when it has one. Pictures are drawn here from the open file as
// they scroll into view, kept as small images, and never stored anywhere.

import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs"
import type {
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs"
import { say } from "../frame-host"

/** How wide a page's picture is drawn, in CSS pixels. */
const PICTURE_WIDTH = 120

type OutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number]

export interface Rail {
  /** Show or hide it; on a narrow pane it covers the pages while open. */
  setOpen: (open: boolean) => void
  /** The page in view changed. */
  setPage: (page: number) => void
}

export async function createRail({
  pdf,
  viewer,
  linkService,
}: {
  pdf: PDFDocumentProxy
  viewer: PDFViewer
  linkService: PDFLinkService
}): Promise<Rail> {
  const root = document.getElementById("viewer-rail") as HTMLElement
  const tabs = document.createElement("div")
  tabs.className = "rail-tabs"
  tabs.setAttribute("role", "tablist")
  const pagesPanel = document.createElement("div")
  pagesPanel.className = "rail-pages"
  pagesPanel.setAttribute("role", "tabpanel")
  pagesPanel.setAttribute("aria-label", "Pages")
  root.append(tabs, pagesPanel)

  const narrow = () => window.innerWidth < 640
  const goTo = (page: number) => {
    viewer.currentPageNumber = page
    // On a narrow pane the rail covers the pages; get out of the way.
    if (narrow()) {
      setOpen(false)
      say({ type: "viewer.rail", open: false })
    }
  }

  // A button per page, sized like the page before its picture is drawn.
  const first = await pdf.getPage(1)
  const firstSize = first.getViewport({ scale: 1 })
  const labels = await pdf.getPageLabels().catch(() => null)
  const buttons: HTMLButtonElement[] = []
  for (let page = 1; page <= pdf.numPages; page++) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "rail-page"
    button.dataset.page = String(page)
    const label = labels?.[page - 1] || String(page)
    button.setAttribute("aria-label", `Page ${label}`)
    const frame = document.createElement("span")
    frame.className = "rail-picture"
    frame.style.aspectRatio = `${firstSize.width} / ${firstSize.height}`
    const number = document.createElement("span")
    number.className = "rail-number"
    number.textContent = label
    button.append(frame, number)
    button.addEventListener("click", () => goTo(page))
    buttons.push(button)
  }
  pagesPanel.append(...buttons)

  // Pictures are drawn one at a time, nearest first, only once the rail is
  // open and the page's own view has drawn what the reader is looking at.
  const wanted = new Set<number>()
  const drawn = new Set<number>()
  let drawing = false
  const drawNext = async () => {
    if (drawing || root.hidden) return
    const next = [...wanted].sort(
      (a, b) =>
        Math.abs(a - viewer.currentPageNumber) -
        Math.abs(b - viewer.currentPageNumber)
    )[0]
    if (next === undefined) return
    wanted.delete(next)
    drawing = true
    try {
      const page = await pdf.getPage(next)
      const unscaled = page.getViewport({ scale: 1 })
      const ratio = window.devicePixelRatio || 1
      const viewport = page.getViewport({
        scale: (PICTURE_WIDTH * ratio) / unscaled.width,
      })
      const canvas = document.createElement("canvas")
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await page.render({ canvas, viewport }).promise
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve)
      )
      canvas.width = canvas.height = 0
      if (blob) {
        const image = document.createElement("img")
        image.alt = ""
        image.src = URL.createObjectURL(blob)
        const frame = buttons[next - 1]!.firstElementChild as HTMLElement
        frame.style.aspectRatio = `${unscaled.width} / ${unscaled.height}`
        frame.replaceChildren(image)
        drawn.add(next)
      }
    } catch {
      // A page that can't be drawn keeps its blank frame and its number.
    } finally {
      drawing = false
      void drawNext()
    }
  }
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.page)
        if (drawn.has(page)) continue
        if (entry.isIntersecting) wanted.add(page)
        else wanted.delete(page)
      }
      void drawNext()
    },
    { root: pagesPanel, rootMargin: "400px 0px" }
  )
  for (const button of buttons) seen.observe(button)

  // The file's own outline, when it has one.
  const outline = await pdf.getOutline().catch(() => null)
  let outlinePanel: HTMLElement | null = null
  if (outline?.length) {
    outlinePanel = document.createElement("div")
    outlinePanel.className = "rail-outline"
    outlinePanel.setAttribute("role", "tabpanel")
    outlinePanel.setAttribute("aria-label", "Outline")
    outlinePanel.hidden = true
    outlinePanel.append(
      outlineList(outline, (item) => {
        if (item.dest) {
          void linkService.goToDestination(item.dest)
          if (narrow()) {
            setOpen(false)
            say({ type: "viewer.rail", open: false })
          }
        } else if (item.url) say({ type: "viewer.link", url: item.url })
      })
    )
    root.append(outlinePanel)
    const tab = (label: string, panel: HTMLElement) => {
      const button = document.createElement("button")
      button.type = "button"
      button.setAttribute("role", "tab")
      button.textContent = label
      button.addEventListener("click", () => {
        for (const each of tabs.children)
          each.setAttribute("aria-selected", "false")
        button.setAttribute("aria-selected", "true")
        pagesPanel.hidden = panel !== pagesPanel
        outlinePanel!.hidden = panel !== outlinePanel
        if (panel === pagesPanel) void drawNext()
      })
      return button
    }
    const pagesTab = tab("Pages", pagesPanel)
    pagesTab.setAttribute("aria-selected", "true")
    tabs.append(pagesTab, tab("Outline", outlinePanel))
  } else {
    tabs.hidden = true
  }

  let current = 0
  const setPage = (page: number) => {
    buttons[current - 1]?.removeAttribute("aria-current")
    current = page
    const button = buttons[page - 1]
    if (!button) return
    button.setAttribute("aria-current", "page")
    // Keep the current page's picture in sight, without moving otherwise.
    const top = button.offsetTop - pagesPanel.offsetTop
    if (
      top < pagesPanel.scrollTop ||
      top + button.offsetHeight > pagesPanel.scrollTop + pagesPanel.clientHeight
    ) {
      pagesPanel.scrollTop = top - pagesPanel.clientHeight / 3
    }
  }
  const setOpen = (open: boolean) => {
    root.hidden = !open
    document.body.dataset.rail = open ? "open" : "closed"
    if (open) {
      setPage(viewer.currentPageNumber)
      void drawNext()
    }
    // The pages' own width changed: fit them again if they were fitted.
    const fit = viewer.currentScaleValue
    if (fit === "auto" || fit === "page-width") viewer.currentScaleValue = fit
  }
  setPage(viewer.currentPageNumber)
  return { setOpen, setPage }
}

function outlineList(
  items: OutlineItem[],
  follow: (item: OutlineItem) => void
): HTMLElement {
  const list = document.createElement("ul")
  for (const item of items) {
    const entry = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = item.title || "Untitled"
    if (item.bold) button.style.fontWeight = "600"
    if (item.italic) button.style.fontStyle = "italic"
    button.addEventListener("click", () => follow(item))
    entry.append(button)
    if (item.items?.length) entry.append(outlineList(item.items, follow))
    list.append(entry)
  }
  return list
}

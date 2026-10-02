/**
 * Mermaid touch handling for the rich editor.
 *
 * Tapping a Mermaid block would otherwise focus ProseMirror's contenteditable
 * and raise the mobile keyboard. Taps inside a block (outside its source
 * editor) are taken over: ProseMirror is blurred, the browser's own click is
 * suppressed, and the tapped control receives a synthetic click instead.
 * Diagrams themselves are passive; panning and zooming happen in the
 * full-screen viewer, so page scrolling is never trapped.
 *
 * Only active on touch devices (pointer: coarse).
 */

const MERMAID_BLOCK = '[data-content-type="mermaid"]'
const TAP_MAX_DISTANCE = 15
const TAP_MAX_DURATION = 300

function isTouchDevice(): boolean {
  return window.matchMedia("(pointer: coarse)").matches
}

/**
 * Find the nearest clickable element (button, link, diagram opener) from a
 * touch target, stopping at the mermaid block boundary.
 */
function findClickableAncestor(
  element: HTMLElement,
  boundary: Element
): HTMLElement | null {
  let current: HTMLElement | null = element
  while (current && current !== boundary) {
    const tag = current.tagName?.toLowerCase()
    if (tag === "button" || tag === "a") return current
    if (current.getAttribute("role") === "button") return current
    if (current.hasAttribute("data-mermaid-open")) return current
    if (current.getAttribute("data-content-type") === "mermaid") break
    current = current.parentElement
  }
  return null
}

/** The code editor needs normal touch behavior (focus, cursor, keyboard). */
function isInsideCodeEditor(element: HTMLElement): boolean {
  return !!element.closest(".cm-editor")
}

export function initMermaidTouchHandler(editorRoot: HTMLElement): () => void {
  if (!isTouchDevice()) return () => {}

  let startX = 0
  let startY = 0
  let startTime = 0
  let syntheticClickTarget: HTMLElement | null = null

  const blurEditor = () => {
    const editor = editorRoot.querySelector<HTMLElement>(
      ".ProseMirror[contenteditable]"
    )
    if (editor && editor.contains(document.activeElement)) {
      editor.blur()
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    }
  }

  const handleTouchStart = (event: TouchEvent) => {
    const target = event.target as HTMLElement
    if (event.touches.length === 1) {
      startX = event.touches[0].clientX
      startY = event.touches[0].clientY
      startTime = Date.now()
    }
    if (target.closest(MERMAID_BLOCK) && !isInsideCodeEditor(target)) {
      blurEditor()
    }
  }

  const handleTouchEnd = (event: TouchEvent) => {
    const target = event.target as HTMLElement
    const block = target.closest(MERMAID_BLOCK)
    if (!block || isInsideCodeEditor(target)) return

    const touch = event.changedTouches[0]
    if (!touch) return
    const isTap =
      Math.abs(touch.clientX - startX) < TAP_MAX_DISTANCE &&
      Math.abs(touch.clientY - startY) < TAP_MAX_DISTANCE &&
      Date.now() - startTime < TAP_MAX_DURATION
    if (!isTap) return

    event.preventDefault()
    const clickTarget = findClickableAncestor(target, block)
    if (!clickTarget) return
    syntheticClickTarget = clickTarget
    clickTarget.click()
    syntheticClickTarget = null
  }

  // Block any browser-generated click that would re-focus the editor.
  const handleClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    if (!target.closest(MERMAID_BLOCK)) return
    if (target === syntheticClickTarget || isInsideCodeEditor(target)) return
    const active = document.activeElement as HTMLElement | null
    if (active?.closest?.(".ProseMirror")) active.blur()
  }

  editorRoot.addEventListener("touchstart", handleTouchStart, {
    passive: true,
    capture: true,
  })
  editorRoot.addEventListener("touchend", handleTouchEnd, {
    passive: false,
    capture: true,
  })
  editorRoot.addEventListener("click", handleClick, { capture: true })

  return () => {
    editorRoot.removeEventListener("touchstart", handleTouchStart, {
      capture: true,
    })
    editorRoot.removeEventListener("touchend", handleTouchEnd, {
      capture: true,
    })
    editorRoot.removeEventListener("click", handleClick, { capture: true })
  }
}

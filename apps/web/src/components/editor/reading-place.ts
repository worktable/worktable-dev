/**
 * Where someone is reading a Doc, kept across the renderings it passes
 * through as it opens: Markdown, the saved preview and the editor. Lines
 * mostly sit in the same place in each, but not always (tables lay out
 * differently), so the place is a block and its distance from the top of the
 * pane rather than a scroll offset.
 */
export interface ReadingPlace {
  /**
   * The block's text, which every rendering shows the same. Empty when no
   * text is in view, such as among images at the end of a Doc.
   */
  text: string
  /** Which block with that text, counting from the top. */
  occurrence: number
  /** The block's distance from the top of the scrolling pane. */
  offset: number
  /** How far the pane was scrolled, for when there is no text to go by. */
  scrollTop: number
}

const BLOCKS = "h1, h2, h3, h4, h5, h6, p, li, pre, th, td, summary, blockquote"
// A line pressed against the top edge isn't the one being read, and on a
// phone the editor scrolls a caret there down by this much.
const EDGE = 16

/** A block's own text: without nested blocks, lists and editor controls. */
function ownText(element: Element): string {
  let text = ""
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent
      else if (
        child instanceof Element &&
        !child.matches(`${BLOCKS}, ul, ol, select, [contenteditable="false"]`)
      ) {
        walk(child)
      }
    }
  }
  walk(element)
  return text.replace(/\s+/g, " ").trim().slice(0, 200)
}

/**
 * Where a block's first line of text starts. Renderings wrap text in
 * differently padded boxes (a table cell's paragraph), but its lines match.
 */
function lineTop(element: Element): number {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const text = walker.currentNode as Text
    const start = text.data.search(/\S/)
    if (start < 0) continue
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + 1)
    const rect = range.getBoundingClientRect()
    if (rect.height > 0) return rect.top
  }
  return element.getBoundingClientRect().top
}

function blocks(root: Element): { element: Element; text: string }[] {
  // Diagram labels are drawn, and only where the diagram has rendered.
  return Array.from(root.querySelectorAll(BLOCKS))
    .filter((element) => !element.closest("svg"))
    .map((element) => ({ element, text: ownText(element) }))
    .filter((block) => block.text !== "")
}

/** The first block that starts clear of the top, or the one the pane starts inside. */
export function readingPlace(root: Element): ReadingPlace {
  const top = root.getBoundingClientRect().top
  const all = blocks(root)
  const starts = all.findIndex(({ element }) => lineTop(element) >= top + EDGE)
  const at =
    starts >= 0
      ? starts
      : all.findIndex(
          ({ element }) => element.getBoundingClientRect().bottom > top
        )
  const block = all[at]
  if (!block)
    return { text: "", occurrence: 0, offset: 0, scrollTop: root.scrollTop }
  return {
    text: block.text,
    occurrence: all.slice(0, at).filter((other) => other.text === block.text)
      .length,
    offset: lineTop(block.element) - top,
    scrollTop: root.scrollTop,
  }
}

/**
 * Scroll the pane so the place's block sits where it was, and return that
 * block. Null when this rendering doesn't show it.
 */
export function restoreReadingPlace(
  root: Element,
  place: ReadingPlace
): Element | null {
  if (!place.text) {
    root.scrollTop = place.scrollTop
    return null
  }
  const match = blocks(root).filter((block) => block.text === place.text)[
    place.occurrence
  ]
  if (!match) return null
  root.scrollTop +=
    lineTop(match.element) - root.getBoundingClientRect().top - place.offset
  return match.element
}

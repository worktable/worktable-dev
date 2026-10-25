import {
  findPassage,
  passageSelector,
  type PassageSelector,
} from "@worktable/types"

/**
 * The reading text of a Doc on screen, as findPassage sees it: the server
 * builds the same text from the Doc's Markdown (markdown-passage.ts), so a
 * passage selected here is found there, and back.
 */
export interface PassageText {
  text: string
  nodes: Text[]
  /** Where each node's text starts in `text`. */
  starts: number[]
}

/** What the page adds around the content: controls, captions, the byline. */
const SKIP =
  "button, svg, style, script, [aria-hidden='true'], [data-doc-byline], .worktable-code-header, .worktable-caption"

const BLOCKS = new Set([
  "ARTICLE",
  "BLOCKQUOTE",
  "DD",
  "DETAILS",
  "DIV",
  "DT",
  "FIGCAPTION",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
])

/** Blocks that hold only other blocks: text directly in them is layout. */
const CONTAINERS = new Set([
  "ARTICLE",
  "BLOCKQUOTE",
  "DETAILS",
  "DIV",
  "OL",
  "SECTION",
  "TABLE",
  "TBODY",
  "THEAD",
  "TR",
  "UL",
])

function blockOf(node: Node, root: Element): Element {
  let element = node.parentElement
  while (element && element !== root && !BLOCKS.has(element.tagName))
    element = element.parentElement
  return element ?? root
}

export function readPassageText(root: Element): PassageText {
  const parts: string[] = []
  const nodes: Text[] = []
  const starts: number[] = []
  let length = 0
  let lastBlock: Element | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const skipped = node.parentElement?.closest(SKIP)
      return skipped && root.contains(skipped)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data) continue
    if (
      CONTAINERS.has(text.parentElement?.tagName ?? "") &&
      !text.data.trim()
    )
      continue
    const block = blockOf(text, root)
    if (lastBlock && block !== lastBlock) {
      parts.push("\n")
      length += 1
    }
    lastBlock = block
    nodes.push(text)
    starts.push(length)
    parts.push(text.data)
    length += text.data.length
  }
  return { text: parts.join(""), nodes, starts }
}

/** Offset in the reading text of a point in the page, or null outside it. */
function offsetOf(
  model: PassageText,
  container: Node,
  offset: number,
  edge: "start" | "end"
): number | null {
  const index = model.nodes.indexOf(container as Text)
  if (index >= 0) return model.starts[index]! + offset
  // A point between elements, as a triple-click or a drag past a block
  // makes: take the nearest text inside the selection.
  const point = document.createRange()
  point.setStart(container, offset)
  if (edge === "start") {
    for (let i = 0; i < model.nodes.length; i++) {
      if (point.comparePoint(model.nodes[i]!, 0) >= 0) return model.starts[i]!
    }
    return null
  }
  for (let i = model.nodes.length - 1; i >= 0; i--) {
    const node = model.nodes[i]!
    if (point.comparePoint(node, node.data.length) <= 0)
      return model.starts[i]! + node.data.length
  }
  return null
}

/** The selector for a selected range, or null when it holds no reading text. */
export function selectorForRange(
  model: PassageText,
  range: Range
): PassageSelector | null {
  const start = offsetOf(model, range.startContainer, range.startOffset, "start")
  const end = offsetOf(model, range.endContainer, range.endOffset, "end")
  if (start === null || end === null || end <= start) return null
  const selector = passageSelector(model.text, start, end)
  return selector.quote.trim() ? selector : null
}

function pointAt(
  model: PassageText,
  offset: number,
  edge: "start" | "end"
): [Text, number] | null {
  let low = 0
  let high = model.starts.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (model.starts[middle]! <= offset) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  if (found < 0) return model.nodes[0] ? [model.nodes[0], 0] : null
  const node = model.nodes[found]!
  const within = offset - model.starts[found]!
  if (within <= node.data.length) {
    // An end exactly at a node's start belongs to the node before it.
    if (edge === "end" && within === 0 && found > 0) {
      const previous = model.nodes[found - 1]!
      return [previous, previous.data.length]
    }
    return [node, within]
  }
  // In a separator between blocks.
  return edge === "start" && model.nodes[found + 1]
    ? [model.nodes[found + 1]!, 0]
    : [node, node.data.length]
}

/** Where a passage is on screen now, if it is still there. */
export function rangeForPassage(
  model: PassageText,
  selector: PassageSelector
): Range | null {
  const found = findPassage(model.text, selector)
  if (!found) return null
  const start = pointAt(model, found.start, "start")
  const end = pointAt(model, found.end, "end")
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(...start)
  range.setEnd(...end)
  return range
}

/** Mark ranges with a named ::highlight(), where the browser supports it. */
export function setHighlight(name: string, ranges: Range[]) {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return
  if (ranges.length === 0) CSS.highlights.delete(name)
  else CSS.highlights.set(name, new Highlight(...ranges))
}

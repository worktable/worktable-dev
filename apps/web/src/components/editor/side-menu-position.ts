import type { FloatingUIOptions } from "@blocknote/react"

type Middleware = NonNullable<
  NonNullable<FloatingUIOptions["useFloatingOptions"]>["middleware"]
>[number]

// Blocks without text center the handle on their first compact control row;
// images, diagrams and video keep it beside their top edge.
const CONTROL_ROW = ".bn-add-file-button, .bn-file-name-with-icon, audio"

/** Distance from the block's top to the vertical center of its first line. */
export function firstLineCenter(block: Element): number | null {
  const content = block.querySelector(":scope > .bn-block-content")
  if (!content) return null
  const line =
    content.querySelector(".bn-inline-content") ??
    content.querySelector("th p, td p, th, td")
  if (line) {
    const style = getComputedStyle(line)
    const lineHeight = Number.parseFloat(style.lineHeight)
    const top =
      line.getBoundingClientRect().top +
      Number.parseFloat(style.paddingTop || "0") +
      Number.parseFloat(style.borderTopWidth || "0")
    const height = Number.isFinite(lineHeight)
      ? lineHeight
      : Number.parseFloat(style.fontSize) * 1.2
    return top + height / 2 - block.getBoundingClientRect().top
  }
  const row = content.querySelector(CONTROL_ROW)
  if (!row) return null
  const rect = row.getBoundingClientRect()
  return rect.top + rect.height / 2 - block.getBoundingClientRect().top
}

/**
 * BlockNote centers the side menu with offsets tuned to its default heading
 * metrics, which our type scale replaces. Measure the line the handle sits
 * beside instead, so it stays centered for any font, size or line height.
 */
export const sideMenuFirstLine: Middleware = {
  name: "worktableSideMenuFirstLine",
  fn: ({ y, elements, rects }) => {
    const reference = elements.reference
    const block =
      reference instanceof Element ? reference : reference.contextElement
    const center = block ? firstLineCenter(block) : null
    if (center === null) return {}
    return { y: y + center - rects.floating.height / 2 }
  },
}

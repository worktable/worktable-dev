// ============================================================
// Code in Markdown
// ============================================================
//
// Code shows its text and never holds links: fenced blocks with backticks or
// tildes, indented blocks and inline spans alike. Readers that look for links
// blank it out, keeping every other character where it was.

import { fromMarkdown } from "mdast-util-from-markdown"

type Range = readonly [number, number]

/** Only Markdown with one of these can hold code. */
const MAY_HOLD_CODE = /`|~~~|^(?: {4}|\t)/m

/** Where a Markdown text's code blocks and inline code sit. */
export function markdownCodeRanges(markdown: string): {
  blocks: Range[]
  inline: Range[]
} {
  const blocks: Range[] = []
  const inline: Range[] = []
  if (!MAY_HOLD_CODE.test(markdown)) return { blocks, inline }
  const visit = (node: {
    type: string
    position?: { start: { offset?: number }; end: { offset?: number } }
    children?: unknown[]
  }) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined) {
      if (node.type === "code") blocks.push([start, end])
      else if (node.type === "inlineCode") inline.push([start, end])
    }
    for (const child of node.children ?? []) visit(child as typeof node)
  }
  visit(fromMarkdown(markdown))
  return { blocks, inline }
}

/** The text with the given ranges blanked, line breaks kept. */
export function blankRanges(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return text
  let result = ""
  let at = 0
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < at) continue
    result += text.slice(at, start) + text.slice(start, end).replace(/[^\n]/g, " ")
    at = end
  }
  return result + text.slice(at)
}

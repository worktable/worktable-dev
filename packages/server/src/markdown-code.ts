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

/**
 * Above this, a Doc's code is found by its fences and spans alone, as a full
 * parse of a very large text costs more than links in it are worth.
 */
const PARSE_MAX_CHARS = 256 * 1024

/** Fenced code with backticks or tildes, closed by the same or by the end. */
const FENCED_CODE =
  /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm
const INLINE_CODE = /`[^`\n]*`/g

function scannedCodeRanges(markdown: string): { blocks: Range[]; inline: Range[] } {
  const ranges = (pattern: RegExp, text: string) =>
    [...text.matchAll(pattern)].map(
      (match): Range => [match.index, match.index + match[0].length]
    )
  const blocks = ranges(FENCED_CODE, markdown)
  return { blocks, inline: ranges(INLINE_CODE, blankRanges(markdown, blocks)) }
}

/** Where a Markdown text's code blocks and inline code sit. */
export function markdownCodeRanges(markdown: string): {
  blocks: Range[]
  inline: Range[]
} {
  if (!MAY_HOLD_CODE.test(markdown)) return { blocks: [], inline: [] }
  if (markdown.length > PARSE_MAX_CHARS) return scannedCodeRanges(markdown)
  const blocks: Range[] = []
  const inline: Range[] = []
  type Node = {
    type: string
    position?: { start: { offset?: number }; end: { offset?: number } }
    children?: unknown[]
  }
  // Walked with a stack, so deep nesting can't exhaust the call stack.
  const stack: Node[] = [fromMarkdown(markdown) as Node]
  while (stack.length > 0) {
    const node = stack.pop()!
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined) {
      if (node.type === "code") blocks.push([start, end])
      else if (node.type === "inlineCode") inline.push([start, end])
    }
    for (const child of node.children ?? []) stack.push(child as Node)
  }
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

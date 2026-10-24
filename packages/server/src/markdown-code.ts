// ============================================================
// Code and links in Markdown
// ============================================================
//
// Code shows its text and never holds links: fenced blocks with backticks or
// tildes, indented blocks and inline spans alike. A link's destination runs
// as Markdown reads it, angle brackets and a level of parentheses included.
// Everything here reads a text in a single pass, so no text, however large
// or strange, can make reading it slow; a link this can't read with
// certainty is left for aliases to resolve.

type Range = readonly [number, number]

/** Only Markdown with one of these can hold code. */
const MAY_HOLD_CODE = /`|~~~|^(?: {4}|\t)/m

/**
 * Fenced code with backticks or tildes, closed by a run of the same
 * character at least as long, or by the end. A backtick fence's info string
 * holds no backticks, so ```a``` on one line is a code span, not a fence. The
 * fence is taken whole through a lookahead, which never gives characters
 * back, so a long run of backticks can't make matching slow.
 */
const FENCED_CODE =
  /^ {0,3}(?=(([`~])\2{2,}))\1(?:(?<=~)[^\n]*|[^`\n]*)\n[\s\S]*?(?:^ {0,3}\1\2*[ \t]*$|(?![\s\S]))/gm
const INLINE_CODE = /`[^`\n]*`/g
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const INDENTED = /^(?: {4}|\t)/

/**
 * An inline link or image, whole and not escaped: a label holds no brackets, and a
 * destination is in angle brackets or allows one level of parentheses,
 * followed by an optional title and the closing parenthesis.
 */
export const MARKDOWN_LINK_PATTERN =
  /(?<!\\)(!?)(?<!\\)\[([^[\]]*)\]\(\s*(<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"\n]*")?\s*\)/g

export interface MarkdownLayout {
  /** Code blocks, fenced or indented. */
  blocks: Range[]
  /** Inline code. */
  inline: Range[]
  /** Inline link and image destinations as written, outside code. */
  destinations: Range[]
  /** Which of the destinations are images' rather than links'. */
  images: boolean[]
}

function matchRanges(pattern: RegExp, text: string): Range[] {
  return [...text.matchAll(pattern)].map(
    (match): Range => [match.index, match.index + match[0].length]
  )
}

/**
 * Indented code blocks: indented lines after a blank line, outside a list,
 * where indenting continues a list item rather than starting code.
 */
function indentedCode(text: string): Range[] {
  const ranges: Range[] = []
  let at = 0
  let previousBlank = true
  let inCode = false
  let inList = false
  for (const line of text.split("\n")) {
    const blank = line.trim() === ""
    if (!blank && LIST_ITEM.test(line)) inList = true
    else if (!blank && !INDENTED.test(line)) inList = false
    const code: boolean = !blank && !inList && INDENTED.test(line) && (previousBlank || inCode)
    if (code) ranges.push([at, at + line.length])
    if (!blank) inCode = code
    previousBlank = blank
    at += line.length + 1
  }
  return ranges
}

/** Where a Markdown text's code and link destinations sit. */
export function markdownLayout(markdown: string): MarkdownLayout {
  const mayHoldCode = MAY_HOLD_CODE.test(markdown)
  const fenced = mayHoldCode ? matchRanges(FENCED_CODE, markdown) : []
  const blocks = mayHoldCode
    ? [...fenced, ...indentedCode(blankRanges(markdown, fenced))]
    : []
  const inline = mayHoldCode
    ? matchRanges(INLINE_CODE, blankRanges(markdown, blocks))
    : []
  const scanned = blankRanges(markdown, [...blocks, ...inline])
  const destinations: Range[] = []
  const images: boolean[] = []
  for (const match of scanned.matchAll(MARKDOWN_LINK_PATTERN)) {
    const start = match[0].indexOf(match[3]!, match[0].indexOf("](") + 2)
    destinations.push([match.index + start, match.index + start + match[3]!.length])
    images.push(match[1] === "!")
  }
  return { blocks, inline, destinations, images }
}

/** Where a Markdown text's code blocks and inline code sit. */
export function markdownCodeRanges(markdown: string): {
  blocks: Range[]
  inline: Range[]
} {
  const { blocks, inline } = markdownLayout(markdown)
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

import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { gfm } from "micromark-extension-gfm"
import { Parser } from "htmlparser2"
import {
  findPassage,
  isMermaidLanguage,
  type PassageSelector,
} from "@worktable/types"

interface MarkdownNode {
  type: string
  value?: string
  lang?: string | null
  children?: MarkdownNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/** Nodes that start a new line of reading text, as the page shows them. */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "code",
  "table",
  "tableRow",
  "tableCell",
  "thematicBreak",
  "footnoteDefinition",
])

/** HTML whose text the reader never shows; sanitizing drops it. */
const HIDDEN_TAGS = new Set(["script", "style", "template", "textarea"])
/** HTML elements that start a new line of reading text. */
const HTML_BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "dd",
  "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "ol", "p", "pre", "section", "summary", "table",
  "td", "th", "tr", "ul",
])

/**
 * The text a reader sees in a Markdown Doc, and the source offset each of
 * its characters came from. Markup, images and diagrams are left out and
 * raw HTML shows its text, as on the page, so a quote selected there can be
 * found here.
 */
export function markdownReadingText(source: string): {
  text: string
  from: number[]
} {
  const chars: string[] = []
  const from: number[] = []
  const separate = (at: number) => {
    if (chars.length > 0 && chars[chars.length - 1] !== "\n") {
      chars.push("\n")
      from.push(at)
    }
  }
  // Each character goes where it is written. Decoded text (an escape, an
  // entity) is matched character by character in its node's span.
  const pushText = (value: string, start: number, end: number) => {
    const exact = source.slice(start, end).indexOf(value)
    let cursor = start
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!
      let at: number
      if (exact >= 0) at = start + exact + index
      else {
        const found = source.indexOf(char, cursor)
        at = found >= 0 && found < end ? found : Math.min(cursor, end - 1)
        if (found >= 0 && found < end) cursor = found + 1
      }
      chars.push(char)
      from.push(Math.max(start, at))
    }
  }
  // Raw HTML shows its text, as the reader renders it.
  const pushHtml = (html: string, start: number, end: number) => {
    let hidden = 0
    const parser: Parser = new Parser(
      {
        onopentagname(name) {
          if (HIDDEN_TAGS.has(name)) hidden++
          else if (HTML_BLOCK_TAGS.has(name)) separate(start + parser.startIndex)
        },
        onclosetag(name) {
          if (HIDDEN_TAGS.has(name)) hidden = Math.max(0, hidden - 1)
        },
        ontext(text) {
          if (hidden === 0) pushText(text, start + parser.startIndex, end)
        },
      },
      { decodeEntities: true }
    )
    parser.write(html)
    parser.end()
  }
  const visit = (node: MarkdownNode) => {
    const start = node.position?.start.offset ?? 0
    const end = node.position?.end.offset ?? start
    if (BLOCK_TYPES.has(node.type)) separate(start)
    if (node.type === "break") separate(start)
    if (node.type === "image") return
    if (node.type === "code" && isMermaidLanguage(node.lang)) return
    if (node.type === "html" && typeof node.value === "string") {
      pushHtml(node.value, start, end)
      return
    }
    if (
      (node.type === "text" ||
        node.type === "inlineCode" ||
        node.type === "code") &&
      typeof node.value === "string"
    ) {
      pushText(node.value, start, end)
      return
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(
    fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as MarkdownNode
  )
  return { text: chars.join(""), from }
}

export interface MarkdownPassage {
  /** Source offsets, end exclusive. */
  start: number
  end: number
  match: "exact" | "fuzzy"
  /** Source lines the passage spans, from 1. */
  startLine: number
  endLine: number
}

function lineAt(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < source.length; index++) {
    if (source.charCodeAt(index) === 10) line++
  }
  return line
}

/** Where in a Markdown file's source a passage selected on the page is now. */
export function locateMarkdownPassage(
  source: string,
  selector: PassageSelector,
  /** The source's reading text, when the caller looks up several passages. */
  reading = markdownReadingText(source)
): MarkdownPassage | null {
  const found = findPassage(reading.text, selector)
  if (!found) return null
  let start = reading.from[found.start]!
  // A passage that opens with an escaped character starts at its backslash.
  if (source[start - 1] === "\\" && source[start] !== "\\") start--
  const end = reading.from[found.end - 1]! + 1
  return {
    start,
    end,
    match: found.match,
    startLine: lineAt(source, start),
    endLine: lineAt(source, end - 1),
  }
}

/** The whole source lines a passage spans. */
export function markdownPassageLines(
  source: string,
  passage: Pick<MarkdownPassage, "startLine" | "endLine">
): string {
  return source
    .split("\n")
    .slice(passage.startLine - 1, passage.endLine)
    .join("\n")
}

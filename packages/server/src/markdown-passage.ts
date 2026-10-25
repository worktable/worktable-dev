import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { gfm } from "micromark-extension-gfm"
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

/**
 * The text a reader sees in a Markdown Doc, and the source offset each of
 * its characters came from. Markup, images and diagrams are left out, as on
 * the page, so a quote selected there can be found here.
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
  const visit = (node: MarkdownNode) => {
    const start = node.position?.start.offset ?? 0
    const end = node.position?.end.offset ?? start
    if (BLOCK_TYPES.has(node.type)) separate(start)
    if (node.type === "break") separate(start)
    if (node.type === "image" || node.type === "html") return
    if (node.type === "code" && isMermaidLanguage(node.lang)) return
    if (
      (node.type === "text" ||
        node.type === "inlineCode" ||
        node.type === "code") &&
      typeof node.value === "string"
    ) {
      const value = node.value
      const written = source.slice(start, end)
      const at = written.indexOf(value)
      for (let index = 0; index < value.length; index++) {
        chars.push(value[index]!)
        // Escaped or decoded text doesn't line up character for character;
        // its characters keep to the node's own span.
        from.push(
          at >= 0
            ? start + at + index
            : Math.min(start + index, Math.max(start, end - 1))
        )
      }
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
  selector: PassageSelector
): MarkdownPassage | null {
  const reading = markdownReadingText(source)
  const found = findPassage(reading.text, selector)
  if (!found) return null
  const start = reading.from[found.start]!
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

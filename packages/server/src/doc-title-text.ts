// A Doc's title is the level-one heading it opens with. These read and set
// it in stored content; the catalog, renames and the editor all use this
// one rule, so every place agrees on a Doc's name.

type Block = Record<string, unknown> & { id?: unknown }

/** The opening block when it is the Doc's title, a level-one heading. */
export function titleBlock(blocks: readonly unknown[]): Block | null {
  const first = blocks[0] as Block | undefined
  if (!first || first.type !== "heading") return null
  const props = (first.props ?? {}) as Record<string, unknown>
  if ((Number(props.level) || 1) !== 1 || props.isToggleable) return null
  return first
}

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((inline) => {
      if (!inline || typeof inline !== "object") return ""
      const item = inline as { text?: unknown; content?: unknown }
      return typeof item.text === "string" ? item.text : inlineText(item.content)
    })
    .join("")
}

/** The title a rich Doc opens with, or "" without one. */
export function richDocTitle(blocks: readonly unknown[]): string {
  const block = titleBlock(blocks)
  return block ? inlineText(block.content).trim() : ""
}

const BOM = "﻿"

/**
 * The 0-based line range of the level-one heading a Markdown Doc opens with
 * (ATX `# Title`, or a setext title underlined with `=`), or null. A leading
 * byte order mark is not part of the first line.
 */
export function markdownTitleLines(
  lines: readonly string[]
): { start: number; end: number; text: string } | null {
  const start = lines.findIndex((line) => line.replace(BOM, "").trim() !== "")
  if (start === -1) return null
  const line = lines[start]!.replace(BOM, "")
  const atx = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
  if (atx) return { start, end: start, text: atx[1]!.trim() }
  if (/^ {0,3}=+[ \t]*$/.test(lines[start + 1] ?? "")) {
    return { start, end: start + 1, text: line.trim() }
  }
  return null
}

/** The title a Markdown Doc opens with, or "" without one. */
export function markdownDocTitle(markdown: string): string {
  return markdownTitleLines(markdown.split("\n"))?.text ?? ""
}

/** `markdown` with `title` as its opening level-one heading. */
export function withMarkdownTitle(markdown: string, title: string): string {
  const bom = markdown.startsWith(BOM) ? BOM : ""
  const text = markdown.slice(bom.length)
  const lines = text.split("\n")
  const current = markdownTitleLines(lines)
  if (current) {
    lines.splice(current.start, current.end - current.start + 1, `# ${title}`)
    return bom + lines.join("\n")
  }
  return bom + (text.trim() === "" ? `# ${title}\n` : `# ${title}\n\n${text}`)
}

/** The title in a stored Doc file's text: Markdown, or rich blocks as JSON. */
export function storedDocTitle(text: string, markdown: boolean): string {
  if (markdown) return markdownDocTitle(text)
  try {
    const parsed: unknown = JSON.parse(text)
    const blocks = Array.isArray(parsed)
      ? parsed
      : (parsed as { content?: unknown } | null)?.content
    return Array.isArray(blocks) ? richDocTitle(blocks) : ""
  } catch {
    return ""
  }
}

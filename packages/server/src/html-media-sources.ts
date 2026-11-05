// ============================================================
// Media tags' src attributes, where they sit in the text
// ============================================================
//
// Read as a browser reads them: whole attributes, outside other attributes'
// values, entities decoded, and never inside script, style or comments.
// Markdown Docs' HTML media tags and HTML Docs' images both use this, to
// find what they show and to rewrite it in place.

import { Parser } from "htmlparser2"

const HTML_MEDIA_TAGS = new Set(["img", "video", "audio", "source"])
const HTML_MEDIA_HINT = /<(?:img|video|audio|source)\b/i

export interface HtmlMediaSource {
  /** Where the value's text starts, and its length, as written. */
  at: number
  length: number
  /** The value, entities decoded. */
  value: string
  quote: string | null
  tag: string
}

/**
 * The src values of the text's HTML media tags, with where each sits in the
 * text and the quote around it. `accept` keeps only the ones it wants, and
 * `max` stops keeping them past that many, so a page with millions of tags
 * holds no more than that.
 */
export function htmlMediaSources(
  scanned: string,
  options: { accept?: (tag: string, value: string) => boolean; max?: number } = {}
): HtmlMediaSource[] {
  if (!HTML_MEDIA_HINT.test(scanned)) return []
  const sources: HtmlMediaSource[] = []
  let tag = ""
  const parser: Parser = new Parser({
    onopentagname(name) {
      tag = name
    },
    onattribute(name, value, quote) {
      if (!HTML_MEDIA_TAGS.has(tag) || name !== "src") return
      if (options.max !== undefined && sources.length >= options.max) return
      if (options.accept && !options.accept(tag, value)) return
      // The attribute's text runs from its name; its value follows the "=".
      const raw = scanned.slice(parser.startIndex, parser.endIndex + 1)
      const equals = raw.indexOf("=")
      if (equals === -1) return
      let start = equals + 1
      while (/\s/.test(raw[start] ?? "")) start += 1
      if (quote) start += 1
      let end = start
      while (
        end < raw.length &&
        (quote ? raw[end] !== quote : !/[\s>]/.test(raw[end]!))
      ) {
        end += 1
      }
      sources.push({
        at: parser.startIndex + start,
        length: end - start,
        value,
        quote: quote ?? null,
        tag,
      })
    },
  })
  parser.write(scanned)
  parser.end()
  return sources
}

/** A value as an HTML attribute with this quote holds it. */
export function htmlAttributeText(value: string, quote: string | null): string {
  const text = value.replace(/&/g, "&amp;")
  if (quote === "'") return text.replace(/'/g, "&#39;")
  if (quote === '"') return text.replace(/"/g, "&quot;")
  return text.replace(/[\s"'=<>`]/g, (char) => `&#${char.charCodeAt(0)};`)
}

/** Text with each edit's span replaced, in one pass; overlapping edits are dropped. */
export function applySpanEdits(
  text: string,
  edits: Array<{ at: number; length: number; text: string }>
): string {
  const parts: string[] = []
  let at = 0
  for (const edit of [...edits].sort((a, b) => a.at - b.at)) {
    if (edit.at < at) continue
    parts.push(text.slice(at, edit.at), edit.text)
    at = edit.at + edit.length
  }
  parts.push(text.slice(at))
  return parts.join("")
}

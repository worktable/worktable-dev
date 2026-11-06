// ============================================================
// Icons in HTML Docs
// ============================================================
//
// An HTML Doc names an icon from Worktable's library, the Lucide icons the
// app uses, with an empty svg element: <svg data-icon="circle-check"></svg>.
// Its frame can load nothing, so the server draws each named icon into the
// page wherever the page is served: the member frame, previews, old versions,
// share links and the scriptless share view. A page carries only the icons
// it names, about 330 bytes each.
//
// - The element keeps everything the page wrote on it; Worktable adds only
//   the attributes it lacks: a 24-unit viewBox, currentColor stroke, and
//   aria-hidden unless the page labels it. The theme makes it 1em square
//   unless the page sizes it (html-doc-theme.ts).
// - An svg that already has content is the page's own drawing and stays.
// - Names ignore case, dashes and underscores, and Lucide's former names
//   still answer, so check_circle and CheckCircle draw circle-check.
// - The output is plain path, circle, rect, line, polyline, polygon and
//   ellipse elements, which the scriptless share view's sanitizer keeps.
// - Fast enough to run on every serve: a page that doesn't say data-icon is
//   returned as it is, and one that does is scanned once with a regular
//   expression, which skips comments and the text of script, style, title and
//   textarea as the browser does. Only each icon's own tag is parsed.
//
// Held behind the MCP preview surface (htmlIconsEnabled).

import { Parser } from "htmlparser2"
import library from "./html-icons.generated.json" with { type: "json" }
import { htmlIconsEnabled } from "./mcp/surface.ts"
import { applySpanEdits } from "./html-media-sources.ts"
import type { WidgetValidationIssue } from "./widget-authoring.ts"

export { htmlIconsEnabled }

/** Names the library a frame's icons come from, for its revision. */
export const HTML_ICONS_SOURCE: string = library.source

const ICONS: Record<string, string> = library.icons
const TAGS: Record<string, string[]> = library.tags

/** Everyday icons, which suggestions for a wrong name offer first. */
const COMMON = new Set(
  "circle-check circle-x circle-alert triangle-alert info clock loader circle-dashed ban arrow-right arrow-up-right arrow-down-right trending-up trending-down chevron-right refresh-cw file-text folder image link database code mail calendar user users bot message-square settings lightbulb target flag rocket zap sparkles list-checks git-branch shield lock search".split(
    " "
  )
)

/** Names a warning suggests others for, and lists. */
const UNKNOWN_LISTED = 10

/** A page's icons past this many stay empty. */
export const HTML_ICONS_MAX = 2_000

const HINT = /data-icon/i

// One pass over the page, a tag at a time: a comment, an element whose text
// is never markup (skipped whole), an svg start tag, or any other start tag,
// read whole so an "<svg" inside its attribute values never counts. Quoted
// attribute values may hold ">". Names end where the browser ends them, so
// <svg-icon> and <title-bar> are other tags. Outside quotes a tag stops at
// the next "<", so a page of tags that never close is still read in one
// pass, not once from each of them.
const TAG = `(?:[^>"'<]|"[^"]*"|'[^']*')*>`
const SCAN = new RegExp(
  `<!--[\\s\\S]*?(?:-->|$)|<(script|style|title|textarea)(?=[\\s/>])${TAG}[\\s\\S]*?(?:<\\/\\1\\s*>|$)|(<svg(?=[\\s/>])${TAG})|<[a-z][^\\s/>]*${TAG}`,
  "gi"
)
const NAMED = /\sdata-icon\s*=/i
const CLOSE = /\s*<\/svg\s*>/iy

/** The key a name is looked up by: case, dashes and underscores ignored. */
function iconKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}

let byKey: Map<string, string> | null = null

/** The library's name for what a page wrote, or null when it has none. */
export function htmlIconName(written: string): string | null {
  if (Object.hasOwn(ICONS, written)) return written
  if (!byKey) {
    byKey = new Map(Object.keys(ICONS).map((name) => [iconKey(name), name]))
    for (const [key, name] of Object.entries(library.aliases)) {
      if (!byKey.has(key)) byKey.set(key, name)
    }
  }
  return byKey.get(iconKey(written)) ?? null
}

/** Attributes an icon gets unless the page set them. */
const DEFAULTS: Array<[string, string]> = [
  ["viewBox", "0 0 24 24"],
  ["fill", "none"],
  ["stroke", "currentColor"],
  ["stroke-width", "2"],
  ["stroke-linecap", "round"],
  ["stroke-linejoin", "round"],
]

interface IconElement {
  /** Where the empty element starts and ends in the text, its end exclusive. */
  at: number
  end: number
  openTag: string
  attributes: Record<string, string>
  name: string
}

/** A start tag's attributes, names lowercased, as the browser reads them. */
function tagAttributes(tag: string): Record<string, string> {
  let attributes: Record<string, string> = {}
  const parser = new Parser({
    onopentag(_name, parsed) {
      attributes = parsed
    },
  })
  parser.write(tag)
  parser.end()
  return attributes
}

/**
 * The page's empty svg elements that name an icon, up to `max` of them. An
 * svg with content is the page's own drawing, so it isn't one.
 */
function iconElements(html: string, max: number): IconElement[] {
  const found: IconElement[] = []
  // A page repeats the same few tags; each is parsed once.
  const parsed = new Map<string, Record<string, string>>()
  for (const match of html.matchAll(SCAN)) {
    const openTag = match[2]
    if (!openTag || !NAMED.test(openTag)) continue
    if (found.length >= max) break
    let attributes = parsed.get(openTag)
    if (!attributes) {
      attributes = tagAttributes(openTag)
      parsed.set(openTag, attributes)
    }
    const name = attributes["data-icon"]
    if (name === undefined) continue
    const at = match.index
    let end = at + openTag.length
    if (!/\/\s*>$/.test(openTag)) {
      CLOSE.lastIndex = end
      if (!CLOSE.test(html)) continue
      end = CLOSE.lastIndex
    }
    found.push({ at, end, openTag, attributes, name })
  }
  return found
}

function drawn(element: IconElement, paths: string): string {
  const has = (name: string) => name.toLowerCase() in element.attributes
  const added = DEFAULTS.filter(([name]) => !has(name)).map(
    ([name, value]) => ` ${name}="${value}"`
  )
  const labelled = has("aria-label") || has("aria-labelledby")
  if (!labelled && !has("aria-hidden")) added.push(` aria-hidden="true"`)
  if (labelled && !has("role")) added.push(` role="img"`)
  const open = element.openTag.replace(/\s*\/?\s*>$/, "")
  return `${open}${added.join("")}>${paths}</svg>`
}

/**
 * The page with each icon it names drawn in. With the feature off, or no
 * icon named, the page as it is.
 */
export function expandHtmlIcons(html: string): string {
  if (!htmlIconsEnabled() || !HINT.test(html)) return html
  const edits: Array<{ at: number; length: number; text: string }> = []
  for (const element of iconElements(html, HTML_ICONS_MAX)) {
    const name = htmlIconName(element.name)
    if (!name) continue
    edits.push({
      at: element.at,
      length: element.end - element.at,
      text: drawn(element, ICONS[name]!),
    })
  }
  return edits.length === 0 ? html : applySpanEdits(html, edits)
}

/** Up to three library names close to a name the library doesn't have. */
export function suggestHtmlIcons(written: string): string[] {
  const words = written
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (words.length === 0) return []
  const scored: Array<[string, number]> = []
  for (const name of Object.keys(ICONS)) {
    const parts = name.split("-")
    const tags = TAGS[name] ?? []
    let score = 0
    for (const word of words) {
      if (tags.includes(word)) score += 4
      if (parts.includes(word)) score += 3
      else if (parts.some((part) => part.startsWith(word))) score += 1
    }
    // Everyday icons, then plainer ones: circle-x before file-x-2.
    if (score > 0)
      scored.push([
        name,
        score + (COMMON.has(name) ? 2 : 0) - parts.length * 0.5,
      ])
  }
  return scored
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name]) => name)
}

/** What a write should know about the icons its page names. Empty while off. */
export function htmlIconWarnings(html: string): WidgetValidationIssue[] {
  if (!htmlIconsEnabled() || !HINT.test(html)) return []
  const elements = iconElements(html, HTML_ICONS_MAX + 1)
  const issues: WidgetValidationIssue[] = []
  if (elements.length > HTML_ICONS_MAX) {
    issues.push({
      severity: "warning",
      code: "html_icons_too_many",
      message: `The page names more than ${HTML_ICONS_MAX} icons; those past that stay empty.`,
    })
  }
  const unknown = new Set<string>()
  for (const element of elements.slice(0, HTML_ICONS_MAX)) {
    if (!htmlIconName(element.name)) unknown.add(element.name)
  }
  if (unknown.size > 0) {
    const listed = [...unknown].slice(0, UNKNOWN_LISTED)
    const more =
      unknown.size > listed.length
        ? `; and ${unknown.size - listed.length} more`
        : ""
    const list = listed
      .map((name): [string, string[]] => [name, suggestHtmlIcons(name)])
      .map(([name, close]) =>
        close.length > 0
          ? `${JSON.stringify(name.slice(0, 60))} (try ${close.join(", ")})`
          : JSON.stringify(name.slice(0, 60))
      )
      .join("; ")
      .concat(more)
    issues.push({
      severity: "warning",
      code: "html_icon_unknown",
      message: `Not an icon in Worktable's library, so it stays empty: ${list}.`,
      hint: "Icons are Lucide's, named as on lucide.dev, such as circle-check or arrow-right.",
    })
  }
  return issues
}

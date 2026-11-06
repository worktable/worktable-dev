// ============================================================
// Icons in HTML Docs
// ============================================================
//
// An HTML Doc names an icon from Worktable's library, the Lucide icons the
// app uses, with an empty svg element: <svg data-icon="circle-check"></svg>.
// Its frame can load nothing, so the server draws each named icon into the
// page wherever the page is served: the member frame, previews, old versions,
// share links and the scriptless share view. A page carries only the icons
// it names, about 350 bytes each.
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
// - Pure text work: no I/O, and a page that doesn't say data-icon is
//   returned untouched without being parsed.
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

/** The icons the guide names, by the job they do. Suggestions favor them. */
export const HTML_ICON_GROUPS: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  [
    "Status",
    [
      "circle-check",
      "circle-x",
      "circle-alert",
      "triangle-alert",
      "info",
      "clock",
      "loader",
      "circle-dashed",
      "ban",
    ],
  ],
  [
    "Direction and change",
    [
      "arrow-right",
      "arrow-up-right",
      "arrow-down-right",
      "trending-up",
      "trending-down",
      "chevron-right",
      "refresh-cw",
    ],
  ],
  [
    "Things",
    [
      "file-text",
      "folder",
      "image",
      "link",
      "database",
      "code",
      "mail",
      "calendar",
      "user",
      "users",
      "bot",
      "message-square",
      "settings",
    ],
  ],
  [
    "Ideas and steps",
    [
      "lightbulb",
      "target",
      "flag",
      "rocket",
      "zap",
      "sparkles",
      "list-checks",
      "git-branch",
      "shield",
      "lock",
      "search",
    ],
  ],
]
const CURATED = new Set(HTML_ICON_GROUPS.flatMap(([, names]) => names))

/** A page's icons past this many stay empty. */
export const HTML_ICONS_MAX = 2_000

const HINT = /data-icon/i

/** The key a name is looked up by: case, dashes and underscores ignored. */
function iconKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}

let byKey: Map<string, string> | null = null

/** The library's name for what a page wrote, or null when it has none. */
export function htmlIconName(written: string): string | null {
  if (ICONS[written]) return written
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
  /** Where the element starts and ends in the text, its end exclusive. */
  at: number
  end: number
  openTag: string
  selfClosing: boolean
  attributes: Record<string, string>
  name: string
  empty: boolean
}

/** The page's svg elements that name an icon, up to `max` of them. */
function iconElements(html: string, max: number): IconElement[] {
  const found: IconElement[] = []
  let current: IconElement | null = null
  // Elements open inside the current one.
  let depth = 0
  const parser: Parser = new Parser({
    onopentag(tag, attributes) {
      if (current) {
        current.empty = false
        depth += 1
        return
      }
      if (tag !== "svg" || !("data-icon" in attributes) || found.length >= max)
        return
      const openTag = html.slice(parser.startIndex, parser.endIndex + 1)
      current = {
        at: parser.startIndex,
        end: parser.endIndex + 1,
        openTag,
        selfClosing: /\/\s*>$/.test(openTag),
        attributes,
        name: attributes["data-icon"] ?? "",
        empty: true,
      }
    },
    ontext(text) {
      if (current && text.trim() !== "") current.empty = false
    },
    onclosetag() {
      if (!current) return
      if (depth > 0) {
        depth -= 1
        return
      }
      current.end = current.selfClosing ? current.end : parser.endIndex + 1
      found.push(current)
      current = null
    },
  })
  parser.write(html)
  parser.end()
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
    if (!element.empty) continue
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
    // The guide's icons, then plainer ones: circle-x before file-x-2.
    if (score > 0)
      scored.push([
        name,
        score + (CURATED.has(name) ? 2 : 0) - parts.length * 0.5,
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
  const unknown = new Map<string, string[]>()
  for (const element of elements.slice(0, HTML_ICONS_MAX)) {
    if (
      !element.empty ||
      htmlIconName(element.name) ||
      unknown.has(element.name)
    )
      continue
    unknown.set(element.name, suggestHtmlIcons(element.name))
  }
  if (unknown.size > 0) {
    const list = [...unknown]
      .map(([name, close]) =>
        close.length > 0
          ? `${JSON.stringify(name.slice(0, 60))} (try ${close.join(", ")})`
          : JSON.stringify(name.slice(0, 60))
      )
      .join("; ")
    issues.push({
      severity: "warning",
      code: "html_icon_unknown",
      message: `Not an icon in Worktable's library, so it stays empty: ${list}.`,
      hint: "Icons are Lucide's, named as on lucide.dev, such as circle-check or arrow-right.",
    })
  }
  return issues
}

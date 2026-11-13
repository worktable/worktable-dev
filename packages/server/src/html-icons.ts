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

import { Parser } from "htmlparser2"
import library from "./html-icons.generated.json" with { type: "json" }
import { htmlIconsEnabled } from "./mcp/surface.ts"
import { applySpanEdits } from "./html-media-sources.ts"
import type { WidgetValidationIssue } from "./widget-authoring.ts"

export { htmlIconsEnabled }

/** Names the library a frame's icons come from. */
export const HTML_ICONS_SOURCE: string = library.source

/** Changes whenever what drawing icons in page code does changes. */
const CODE_ICONS_VERSION = "code-1"

/**
 * What a frame's icons depend on, for its revision and the caches built from
 * it: the library, and whether and how icons page code adds are drawn.
 * Undefined while icons are off.
 */
export function htmlIconsRevision(): string | undefined {
  if (!htmlIconsEnabled()) return undefined
  return `${HTML_ICONS_SOURCE}\0${CODE_ICONS_VERSION}`
}

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
  `<!--[\\s\\S]*?(?:-->|$)|<(script|style|title|textarea)(?=[\\s/>])${TAG}([\\s\\S]*?)(?:<\\/\\1\\s*>|$)|(<svg(?=[\\s/>])${TAG})|<[a-z][^\\s/>]*${TAG}`,
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
    const openTag = match[3]
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
  for (const name of unknownCodeIcons(html)) unknown.add(name)
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

// ── Icons page code adds ─────────────────────────────────────
//
// A page's code can add icons after it is served, as when a Records tool
// renders rows: row.innerHTML = '<svg data-icon="circle-check"></svg>', or a
// status map { done: "circle-check" }. Those svgs are empty when served, so
// the page also gets the drawings its code may need, in a small script after
// the runtime that fills such icons as code adds them. Only names written out
// in the page's scripts count: in a data-icon attribute, or as a quoted
// string that names a Lucide icon as data-icon would. Nothing is evaluated,
// and a name
// built from pieces isn't found. The drawings live in the script's closure,
// so the page's own template and querySelector calls never see them.
//
// - Only pages whose scripts say data-icon, dataIcon or dataset.icon get it.
// - At most 64 names, those in data-icon attributes first.
// - Only the live frames run it: the member frame, current previews and live
//   share links. Old versions and the scriptless share view run no script.
// - The runtime draws an empty svg[data-icon] that code adds, draws again
//   when code changes data-icon (a write of the same name changes nothing)
//   or a framework empties a drawn icon, and
//   clears an icon whose name it doesn't have, reporting that once. Shapes
//   go into the page's own svg element, which keeps its attributes and
//   listeners. Icons inside shadow roots aren't drawn.

/** Names page code may draw past this many stay empty. */
export const HTML_CODE_ICONS_MAX = 64

const CODE_HINT = /data-icon|dataIcon|dataset\.icon/
// A whole attribute and a whole name: not metadata-icon, and not a name
// built from pieces, such as "arrow-${dir}".
const CODE_NAMED =
  /(?<![\w-])data-icon\s*=\s*\\?["'`]?([A-Za-z0-9_-]+)(?=\\?["'`]|[\s>\\]|$)/g
const LITERAL = /(["'`])([A-Za-z0-9][A-Za-z0-9_-]*)\1/g

/** The text of the page's own scripts, as written. */
function scriptTexts(html: string): string[] {
  const texts: string[] = []
  for (const match of html.matchAll(SCAN)) {
    if (match[1]?.toLowerCase() === "script" && match[2]) texts.push(match[2])
  }
  return texts
}

/**
 * The icons a page's scripts name, in data-icon attributes or as Lucide
 * names in quotes, those in attributes first; and the names in attributes
 * the library lacks. Null when no script says data-icon.
 */
function codeIcons(
  html: string
): { names: string[]; unknown: string[] } | null {
  if (!CODE_HINT.test(html)) return null
  // Scripts that place icons first, so a bundled library's strings can't
  // take the places of the names they use.
  const all = scriptTexts(html)
  const texts = [
    ...all.filter((text) => CODE_HINT.test(text)),
    ...all.filter((text) => !CODE_HINT.test(text)),
  ]
  if (!CODE_HINT.test(texts[0] ?? "")) return null
  const names = new Set<string>()
  const unknown = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(CODE_NAMED)) {
      const name = htmlIconName(match[1]!)
      if (name) names.add(name)
      else unknown.add(match[1]!)
    }
  }
  for (const text of texts) {
    for (const match of text.matchAll(LITERAL)) {
      // Spelled as a data-icon may spell it: case, dashes and underscores
      // aside, a current or former Lucide name.
      const name = htmlIconName(match[2]!)
      if (name) names.add(name)
    }
  }
  return { names: [...names], unknown: [...unknown] }
}

// Runs after the runtime and before the page's scripts. __DATA__ is the
// drawings by name, and each spelling's key to its name.
const CODE_ICONS_RUNTIME = `(function(){
const data=__DATA__;
const SVG='http://www.w3.org/2000/svg';
const defaults=__DEFAULTS__;
const diagnostics=window.worktable&&window.worktable.diagnostics;
const report=diagnostics&&typeof diagnostics.report==='function'?diagnostics.report.bind(diagnostics):function(){};
const owned=new WeakSet();
const reported=new Set();
function keyOf(name){return String(name).toLowerCase().replace(/[^a-z0-9]/g,'')}
function tell(code,name,message){const id=code+'\\0'+name;if(reported.has(id)||reported.size>=20)return;reported.add(id);try{report({level:'warning',code:code,message:message})}catch(e){}}
function clear(svg){if(owned.has(svg)){svg.replaceChildren();owned.delete(svg)}}
function draw(svg,changed,quiet){
const written=svg.getAttribute('data-icon');
if(written===null){clear(svg);return}
if(svg.namespaceURI!==SVG){tell('html_icon_not_svg',written,'Icon '+JSON.stringify(written)+' stays empty: createElement("svg") makes an HTML element. Use createElementNS("'+SVG+'", "svg") or innerHTML.');return}
const name=Object.prototype.hasOwnProperty.call(data.keys,keyOf(written))?data.keys[keyOf(written)]:null;
if(!name){if(changed)svg.replaceChildren();clear(svg);if(!quiet)tell('html_icon_not_on_page',written,'Icon '+JSON.stringify(written)+' stays empty: page code adds it, but the page never writes its name out.');return}
const holder=document.createElementNS(SVG,'svg');
holder.innerHTML=data.shapes[name];
svg.replaceChildren.apply(svg,Array.from(holder.childNodes));
for(const pair of defaults)if(!svg.hasAttribute(pair[0]))svg.setAttribute(pair[0],pair[1]);
const labelled=svg.hasAttribute('aria-label')||svg.hasAttribute('aria-labelledby');
if(!labelled&&!svg.hasAttribute('aria-hidden'))svg.setAttribute('aria-hidden','true');
if(labelled&&!svg.hasAttribute('role'))svg.setAttribute('role','img');
owned.add(svg);
}
function isIcon(node){return node.nodeType===1&&node.localName==='svg'&&node.hasAttribute('data-icon')}
function empty(node){return node.firstElementChild===null}
function fill(svg,seen,quiet){if(!seen.has(svg)&&empty(svg)){seen.add(svg);draw(svg,false,quiet)}}
const observer=new MutationObserver(function(records){
const seen=new Set();
for(const record of records){
const target=record.target;
if(record.type==='attributes'){if(record.oldValue!==target.getAttribute('data-icon')&&(isIcon(target)||owned.has(target))&&!seen.has(target)){seen.add(target);draw(target,true)}continue}
if(isIcon(target))fill(target,seen);
for(const node of record.addedNodes){
if(node.nodeType!==1)continue;
if(isIcon(node)){fill(node,seen);continue}
if(empty(node))continue;
for(const svg of node.querySelectorAll('svg[data-icon]'))fill(svg,seen);
}
}
});
function start(){
const seen=new Set();
// Markup icons still empty here were warned about when written.
for(const svg of document.querySelectorAll('svg[data-icon]'))fill(svg,seen,true);
observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['data-icon']});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();`

/**
 * The script that draws the icons a page's code adds, to go right after the
 * runtime in a live frame, or "" when the page needs none. `html` is the
 * page as written, before Worktable adds anything.
 */
export function htmlCodeIconsScript(html: string): string {
  if (!htmlIconsEnabled()) return ""
  const found = codeIcons(html)
  if (!found) return ""
  const shapes: Record<string, string> = {}
  const keys: Record<string, string> = {}
  for (const name of found.names.slice(0, HTML_CODE_ICONS_MAX)) {
    shapes[name] = ICONS[name]!
    keys[iconKey(name)] = name
  }
  for (const [key, name] of Object.entries(library.aliases)) {
    if (Object.hasOwn(shapes, name) && !Object.hasOwn(keys, key))
      keys[key] = name
  }
  // Library data only; "<" is escaped so nothing in it can end the script.
  const data = JSON.stringify({ shapes, keys }).replace(/</g, "\\u003c")
  const script = CODE_ICONS_RUNTIME.replace("__DATA__", () => data).replace(
    "__DEFAULTS__",
    () => JSON.stringify(DEFAULTS)
  )
  return `<script data-worktable-runtime="icons">${script}</script>`
}

/** The data-icon names a page's scripts write that the library lacks. */
function unknownCodeIcons(html: string): string[] {
  if (!htmlIconsEnabled()) return []
  return codeIcons(html)?.unknown ?? []
}

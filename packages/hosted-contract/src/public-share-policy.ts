// Shared presentation policy; each trust boundary runs its own parser and sanitizer.
export const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "svg",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
])

export const ALLOWED_SVG_TAGS = new Set([
  "a",
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "g",
  "line",
  "lineargradient",
  "path",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "svg",
  "text",
  "title",
  "tspan",
])

export const REMOVE_WITH_CONTENTS = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "fencedframe",
  "frame",
  "frameset",
  "iframe",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "portal",
  "script",
  "select",
  "source",
  "template",
  "textarea",
  "track",
  "video",
])

export const SVG_REMOVE_WITH_CONTENTS = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "discard",
  "feimage",
  "foreignobject",
  "image",
  "script",
  "set",
  "use",
])

export const SAFE_ATTRIBUTES = new Set([
  "abbr",
  "alt",
  "checked",
  "class",
  "colspan",
  "datetime",
  "dir",
  "disabled",
  "height",
  "id",
  "lang",
  "open",
  "role",
  "rowspan",
  "scope",
  "start",
  "style",
  "title",
  "type",
  "value",
  "width",
])

export const SAFE_SVG_ATTRIBUTES = new Set([
  ...SAFE_ATTRIBUTES,
  "clip-path",
  "cx",
  "cy",
  "d",
  "dominant-baseline",
  "dx",
  "dy",
  "fill",
  "fill-opacity",
  "focusable",
  "font-family",
  "font-size",
  "font-weight",
  "fx",
  "fy",
  "gradienttransform",
  "gradientunits",
  "offset",
  "opacity",
  "points",
  "preserveaspectratio",
  "r",
  "rx",
  "ry",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "transform",
  "viewbox",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
])

export const LOCAL_SVG_URL = /^url\(\s*#[A-Za-z_][\w:.-]*\s*\)$/i

export const DATA_RASTER_IMAGE =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i

type SafeHref =
  | { kind: "fragment"; href: string }
  | { kind: "external"; href: string }

function isPrivateWorktableAppUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
  return (
    hostname === "app.worktable.cloud" ||
    hostname.endsWith(".app.worktable.cloud")
  )
}

export function safePublicShareHref(value: string): SafeHref | null {
  const trimmed = value.trim()
  if (trimmed.startsWith("#")) {
    return { kind: "fragment", href: trimmed }
  }

  try {
    const url = new URL(trimmed)
    if (
      (url.protocol !== "http:" &&
        url.protocol !== "https:" &&
        url.protocol !== "mailto:") ||
      isPrivateWorktableAppUrl(url)
    ) {
      return null
    }
    return { kind: "external", href: url.href }
  } catch {
    return null
  }
}

import { JSDOM } from "jsdom"
import { getServerEditor } from "./blocknote.ts"
import { sanitizeBlocksForConversion } from "./markdown.ts"

const ALLOWED_TAGS = new Set([
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

const ALLOWED_SVG_TAGS = new Set([
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

const REMOVE_WITH_CONTENTS = new Set([
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

const SVG_REMOVE_WITH_CONTENTS = new Set([
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

const SAFE_ATTRIBUTES = new Set([
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

const SAFE_SVG_ATTRIBUTES = new Set([
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

const LOCAL_SVG_URL = /^url\(\s*#[A-Za-z_][\w:.-]*\s*\)$/i

const DATA_RASTER_IMAGE =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i
const DARK_THEME_SELECTOR_RE =
  /html\s*\[\s*data-theme\s*=\s*(?:"dark"|'dark'|dark)\s*\]/i
const DARK_THEME_SELECTOR_GLOBAL_RE =
  /html\s*\[\s*data-theme\s*=\s*(?:"dark"|'dark'|dark)\s*\]/gi

function sanitizeCss(css: string): string {
  return css
    .replace(/@import\s+[^;]+;?/gi, "")
    .replace(/url\(\s*(?!["']?data:)[^)]*\)/gi, "none")
    .replace(/expression\s*\(/gi, "blocked(")
    .replace(/(?:-moz-binding|behavior)\s*:[^;}]*/gi, "")
}

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

function safeHref(value: string): SafeHref | null {
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

function systemDarkThemeRule(rule: CSSRule): string | null {
  const candidate = rule as CSSRule & {
    cssRules?: CSSRuleList
    selectorText?: string
    style?: CSSStyleDeclaration
  }

  if (typeof candidate.selectorText === "string" && candidate.style) {
    if (!DARK_THEME_SELECTOR_RE.test(candidate.selectorText)) return null
    const selector = candidate.selectorText.replace(
      DARK_THEME_SELECTOR_GLOBAL_RE,
      ":root"
    )
    return `${selector} { ${candidate.style.cssText} }`
  }

  if (!candidate.cssRules) return null
  const children = Array.from(candidate.cssRules)
    .map(systemDarkThemeRule)
    .filter((child): child is string => child !== null)
  if (children.length === 0) return null

  const openingBrace = rule.cssText.indexOf("{")
  if (openingBrace === -1) return children.join("\n")
  const header = rule.cssText.slice(0, openingBrace).trim()
  return `${header} {\n${children.join("\n")}\n}`
}

function appendSystemThemeCompatibility(document: Document): void {
  const darkRules = Array.from(document.styleSheets).flatMap((sheet) =>
    Array.from(sheet.cssRules)
      .map(systemDarkThemeRule)
      .filter((rule): rule is string => rule !== null)
  )
  const style = document.createElement("style")
  style.setAttribute("data-worktable-shared-theme", "system")
  style.textContent = `:root { color-scheme: light dark; }${
    darkRules.length > 0
      ? `\n@media (prefers-color-scheme: dark) {\n${darkRules.join("\n")}\n}`
      : ""
  }`
  document.head.append(style)
}

function sanitizeTree(
  document: Document,
  options: { allowStyles: boolean }
): void {
  for (const element of [...document.querySelectorAll("*")]) {
    const tag = element.localName.toLowerCase()
    const structural = tag === "html" || tag === "head" || tag === "body"
    const svgElement = element.namespaceURI === "http://www.w3.org/2000/svg"

    if (
      !structural &&
      (REMOVE_WITH_CONTENTS.has(tag) ||
        (svgElement && SVG_REMOVE_WITH_CONTENTS.has(tag)))
    ) {
      element.remove()
      continue
    }
    if (svgElement && !ALLOWED_SVG_TAGS.has(tag)) {
      element.remove()
      continue
    }
    if (
      !structural &&
      (tag === "form" || (!svgElement && !ALLOWED_TAGS.has(tag)))
    ) {
      element.replaceWith(...element.childNodes)
      continue
    }
    if (tag === "style") {
      if (!options.allowStyles) {
        element.remove()
      } else {
        element.textContent = sanitizeCss(element.textContent ?? "")
      }
      continue
    }

    const href = tag === "a" ? element.getAttribute("href") : null
    const imageSource = tag === "img" ? element.getAttribute("src") : null
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const isAria = name.startsWith("aria-")
      const isData = name.startsWith("data-")
      const safeAttributes = svgElement ? SAFE_SVG_ATTRIBUTES : SAFE_ATTRIBUTES
      if (
        name.startsWith("on") ||
        name === "contenteditable" ||
        (!safeAttributes.has(name) && !isAria && !isData) ||
        (svgElement &&
          attribute.value.toLowerCase().includes("url(") &&
          !LOCAL_SVG_URL.test(attribute.value))
      ) {
        element.removeAttribute(attribute.name)
      }
    }

    if (element.hasAttribute("style")) {
      if (options.allowStyles) {
        element.setAttribute(
          "style",
          sanitizeCss(element.getAttribute("style") ?? "")
        )
      } else {
        element.removeAttribute("style")
      }
    }

    if (tag === "a" && href) {
      const target = safeHref(href)
      if (!target) {
        const replacement = document.createElement("span")
        for (const attribute of [...element.attributes]) {
          replacement.setAttribute(attribute.name, attribute.value)
        }
        replacement.replaceChildren(...element.childNodes)
        element.replaceWith(replacement)
        continue
      }
      element.setAttribute("href", target.href)
      if (target?.kind === "external") {
        element.setAttribute("target", "_blank")
        element.setAttribute("rel", "noopener noreferrer")
        element.setAttribute("referrerpolicy", "no-referrer")
      }
    }

    if (tag === "img") {
      if (imageSource && DATA_RASTER_IMAGE.test(imageSource)) {
        element.setAttribute("src", imageSource)
      } else {
        const replacement = document.createElement("span")
        replacement.className = "shared-image-placeholder"
        replacement.textContent = element.getAttribute("alt") || "Image"
        element.replaceWith(replacement)
      }
    }

    if (tag === "input") {
      if (element.getAttribute("type") !== "checkbox") {
        element.remove()
      } else {
        element.setAttribute("disabled", "")
      }
    }
  }
}

async function documentBlocks(
  content: unknown[] | string,
  format: "blocknote" | "markdown"
): Promise<unknown[]> {
  const editor = await getServerEditor()
  if (format === "markdown") {
    return (await editor.tryParseMarkdownToBlocks(
      content as string
    )) as unknown[]
  }
  return content as unknown[]
}

/** Convert one saved Doc to a navigation-safe HTML fragment. */
export async function renderPublicDocProjection(
  content: unknown[] | string,
  format: "blocknote" | "markdown"
): Promise<string> {
  const editor = await getServerEditor()
  const blocks = sanitizeBlocksForConversion(
    await documentBlocks(content, format),
    editor
  )
  const converted = await editor.blocksToHTMLLossy(blocks)
  const dom = new JSDOM(`<body>${converted}</body>`)
  sanitizeTree(dom.window.document, {
    allowStyles: true,
  })
  return dom.window.document.body.innerHTML
}

/**
 * Produce a complete scriptless HTML document. Safe CSS stays useful inside the
 * isolated frame; CSP remains the authoritative network backstop.
 */
export function renderPublicHtmlProjection(source: string): string {
  const dom = new JSDOM(source)
  const { document } = dom.window
  sanitizeTree(document, {
    allowStyles: true,
  })
  document.documentElement.removeAttribute("data-theme")

  document.head
    .querySelectorAll(":scope > :not(style)")
    .forEach((node) => node.remove())
  appendSystemThemeCompatibility(document)
  const charset = document.createElement("meta")
  charset.setAttribute("charset", "utf-8")
  const viewport = document.createElement("meta")
  viewport.setAttribute("name", "viewport")
  viewport.setAttribute("content", "width=device-width,initial-scale=1")
  const title = document.createElement("title")
  title.textContent = "Shared HTML document"
  document.head.prepend(charset, viewport, title)

  return `<!doctype html>\n${document.documentElement.outerHTML}`
}

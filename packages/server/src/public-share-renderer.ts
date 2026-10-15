import { JSDOM } from "jsdom"
import { renderToStaticMarkup } from "react-dom/server"
import { markdownDocument } from "@worktable/ui/markdown-document"
import { codeLanguageName } from "@worktable/ui/lib/code-language"
import { getServerEditor } from "./blocknote.ts"
import { sanitizeBlocksForConversion } from "./markdown.ts"

import {
  ALLOWED_TAGS,
  ALLOWED_SVG_TAGS,
  REMOVE_WITH_CONTENTS,
  SVG_REMOVE_WITH_CONTENTS,
  SAFE_ATTRIBUTES,
  SAFE_SVG_ATTRIBUTES,
  LOCAL_SVG_URL,
  DATA_RASTER_IMAGE,
  PUBLIC_SHARE_DIAGRAM_ATTRIBUTE,
  PUBLIC_SHARE_MERMAID_DIAGRAM,
  safePublicShareHref,
} from "@worktable/hosted-contract"

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
      const target = safePublicShareHref(href)
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

/** Rebuild Mermaid blocks as marked source text; authored attributes never carry the marker. */
function markMermaidDiagrams(document: Document): void {
  for (const element of document.querySelectorAll(
    `[${PUBLIC_SHARE_DIAGRAM_ATTRIBUTE}]`
  )) {
    element.removeAttribute(PUBLIC_SHARE_DIAGRAM_ATTRIBUTE)
  }
  for (const code of document.querySelectorAll("pre > code.language-mermaid")) {
    const diagram = document.createElement("pre")
    diagram.setAttribute(
      PUBLIC_SHARE_DIAGRAM_ATTRIBUTE,
      PUBLIC_SHARE_MERMAID_DIAGRAM
    )
    const source = document.createElement("code")
    // Markdown fences end with a newline that is not part of the source.
    source.textContent = (code.textContent ?? "").replace(/\n$/, "")
    diagram.append(source)
    code.parentElement?.replaceWith(diagram)
  }
}

/** Markdown renders as the app renders it; rich text through BlockNote. */
async function documentHtml(
  content: unknown[] | string,
  format: "blocknote" | "markdown"
): Promise<string> {
  if (format === "markdown") {
    return renderToStaticMarkup(markdownDocument(content as string))
  }
  const editor = await getServerEditor()
  return editor.blocksToHTMLLossy(
    sanitizeBlocksForConversion(content as unknown[], editor)
  )
}

/**
 * Shape sanitized HTML into the shared document markup
 * (@worktable/ui/document-content.css), as the app draws the same Doc:
 * checklists, toggles, code headers and contained tables.
 */
function shapeDocument(document: Document): void {
  for (const box of document.querySelectorAll("li > input[type=checkbox]")) {
    box.parentElement?.classList.add("task-list-item")
    box.parentElement?.parentElement?.classList.add("contains-task-list")
  }
  // Rich text toggles arrive as one-item lists; they start closed, as in the editor.
  for (const list of document.querySelectorAll("ul")) {
    const items = [...list.children]
    if (
      items.length > 0 &&
      items.every(
        (item) =>
          item.localName === "li" &&
          item.children.length === 1 &&
          item.firstElementChild?.localName === "details"
      )
    ) {
      list.replaceWith(...items.map((item) => item.firstElementChild!))
    }
  }
  for (const toggle of document.querySelectorAll(
    "details:has(> summary > .bn-inline-content)"
  )) {
    toggle.removeAttribute("open")
  }
  for (const pre of document.querySelectorAll(
    `pre:not([${PUBLIC_SHARE_DIAGRAM_ATTRIBUTE}])`
  )) {
    const language =
      pre.getAttribute("data-language") ??
      pre
        .querySelector("code")
        ?.className.match(/(?:^|\s)language-([\w+#.-]+)/)?.[1]
    const frame = document.createElement("div")
    frame.className = "worktable-code"
    const header = document.createElement("div")
    header.className = "worktable-code-header"
    const label = document.createElement("span")
    label.className = "worktable-code-language"
    label.textContent = codeLanguageName(language ?? undefined) ?? ""
    header.append(label)
    pre.replaceWith(frame)
    frame.append(header, pre)
  }
  for (const table of document.querySelectorAll("table")) {
    if (table.querySelector(":scope > colgroup > col[style*='width:']:not([style*='min-width'])"))
      table.setAttribute("style", "width: auto")
    const scroll = document.createElement("div")
    scroll.className = "worktable-table-scroll"
    table.replaceWith(scroll)
    scroll.append(table)
  }
}

/**
 * Markdown can carry authored HTML. Keep its column alignment but nothing
 * that could restyle or overlay the share page.
 */
function limitAuthoredStyles(document: Document): void {
  for (const style of document.querySelectorAll("style")) style.remove()
  for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
    const align = element.style.textAlign
    element.removeAttribute("style")
    if (/^(left|center|right|justify)$/.test(align))
      element.style.textAlign = align
  }
}

/** Convert one saved Doc to a navigation-safe HTML fragment. */
export async function renderPublicDocProjection(
  content: unknown[] | string,
  format: "blocknote" | "markdown"
): Promise<string> {
  const dom = new JSDOM(`<body>${await documentHtml(content, format)}</body>`)
  sanitizeTree(dom.window.document, {
    allowStyles: true,
  })
  if (format === "markdown") limitAuthoredStyles(dom.window.document)
  markMermaidDiagrams(dom.window.document)
  shapeDocument(dom.window.document)
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

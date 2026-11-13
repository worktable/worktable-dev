import { parseDocument } from "htmlparser2"
import {
  HTML_ELEMENT_QUOTE_LENGTH,
  matchHtmlElement,
  type HtmlElement,
  type HtmlElementCandidate,
} from "@worktable/types"

type ParsedNode = ReturnType<typeof parseDocument>["children"][number]
type ParsedElement = Extract<ParsedNode, { attribs: Record<string, string> }>

/** Where a comment's element is in an HTML Doc's page as written. */
export type HtmlElementPlace =
  | {
      kind: "element"
      match: "exact" | "fuzzy"
      startLine: number
      endLine: number
      excerpt: string
    }
  | {
      /**
       * The element is not in the page as written: it was removed, or a
       * script draws it. This is the nearest thing around it that is.
       */
      kind: "container"
      container: string
      startLine: number
      endLine: number
      excerpt: string
    }

const EXCERPT_LENGTH = 2000
const CANDIDATE_LIMIT = 3000
const UNREAD = new Set(["script", "style", "template", "noscript"])
const NAMING_ATTRIBUTE =
  /^(data-(?!worktable)[\w-]+|role|aria-label|name|href|src|alt|title|type|placeholder|for)$/

const isElement = (node: ParsedNode | null | undefined): node is ParsedElement =>
  Boolean(node && "attribs" in node)

function children(node: ParsedNode | ParsedElement): ParsedNode[] {
  return "children" in node ? (node.children as ParsedNode[]) : []
}

/** An element's words, as the page's runtime reads them: see textOf there. */
function textOf(element: ParsedElement, length: number): string {
  let text = ""
  const walk = (node: ParsedNode): boolean => {
    if (node.type === "text") text += `${node.data} `
    else if (isElement(node) && !UNREAD.has(node.name))
      for (const child of children(node)) if (!walk(child)) return false
    return text.length < length * 2
  }
  for (const child of children(element)) if (!walk(child)) break
  return text.replace(/\s+/g, " ").trim().slice(0, length)
}

function segment(element: ParsedElement): string {
  const id = element.attribs["id"]
  const siblings = element.parent
    ? children(element.parent as ParsedNode).filter(
        (node) => isElement(node) && node.name === element.name
      )
    : [element]
  return `${element.name}${id && id.length <= 40 ? `#${id}` : ""}${
    siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(element) + 1})` : ""
  }`
}

function describe(
  element: ParsedElement,
  body: ParsedElement | null,
  heading: string
): HtmlElementCandidate {
  const text = textOf(element, HTML_ELEMENT_QUOTE_LENGTH)
  const path: string[] = []
  let within = ""
  let depth = 0
  for (
    let node: ParsedNode | null = element;
    isElement(node) && node !== body && node.name !== "html";
    node = node.parent as ParsedNode | null
  ) {
    path.unshift(segment(node))
    if (node !== element && !within && depth++ < 4) {
      const around = textOf(node, 120)
      if (around && around !== text.slice(0, 120)) within = around
    }
  }
  const attrs: Record<string, string> = {}
  for (const [name, value] of Object.entries(element.attribs)) {
    if (Object.keys(attrs).length >= 8) break
    if (NAMING_ATTRIBUTE.test(name) && !value.startsWith("data:"))
      attrs[name] = value.slice(0, 160)
  }
  const id = element.attribs["id"]
  return {
    ...(id ? { id } : {}),
    classes: (element.attribs["class"] ?? "")
      .split(/\s+/)
      .filter((name) => name && name.length <= 80)
      .slice(0, 6),
    attrs,
    ...(text ? { text } : {}),
    ...(within ? { within } : {}),
    ...(heading ? { heading } : {}),
    path: path.slice(-12).join(" > "),
  }
}

function place(html: string, element: ParsedElement) {
  const start = element.startIndex ?? 0
  const end = (element.endIndex ?? start) + 1
  const source = html.slice(start, end)
  const lines = (to: number) => html.slice(0, to).split("\n").length
  return {
    startLine: lines(start),
    endLine: lines(end),
    excerpt:
      source.length > EXCERPT_LENGTH
        ? `${source.slice(0, EXCERPT_LENGTH)}…`
        : source,
  }
}

/**
 * Finds a comment's element in the page as the agent wrote it, so the agent
 * is told the lines to change. A script may draw the element, and then only
 * what surrounds it is in the page.
 */
export function locateHtmlElement(
  html: string,
  anchor: { element: HtmlElement; quote?: string }
): HtmlElementPlace | null {
  const document = parseDocument(html, {
    withStartIndices: true,
    withEndIndices: true,
  })
  const tagged: ParsedElement[] = []
  const candidates: HtmlElementCandidate[] = []
  const byId = new Map<string, ParsedElement>()
  let body: ParsedElement | null = null
  let heading = ""
  const find = (node: ParsedNode) => {
    if (isElement(node) && node.name === "body" && !body) body = node
    else for (const child of children(node)) find(child)
  }
  for (const node of document.children) find(node)
  const walk = (node: ParsedNode) => {
    if (!isElement(node) || UNREAD.has(node.name)) return
    const id = node.attribs["id"]
    if (id && !byId.has(id)) byId.set(id, node)
    if (node.name === anchor.element.tag && tagged.length < CANDIDATE_LIMIT) {
      tagged.push(node)
      candidates.push(describe(node, body, heading))
    }
    if (/^h[1-6]$/.test(node.name)) heading = textOf(node, 120)
    for (const child of children(node)) walk(child)
  }
  for (const node of body ? children(body) : document.children) walk(node)

  const { id, classes, attrs, within, heading: under, path } = anchor.element
  const match = matchHtmlElement(
    { id, classes, attrs, within, heading: under, path, text: anchor.quote },
    candidates
  )
  if (match) {
    return {
      kind: "element",
      match: match.match,
      ...place(html, tagged[match.index]!),
    }
  }
  // Nearest first: the last part of the path that names an id still there.
  for (const part of anchor.element.path.split(" > ").reverse().slice(1)) {
    const named = /^([a-z][\w-]*)#([^:]+)/.exec(part)
    const container = named && byId.get(named[2]!)
    if (container && container.name === named[1]) {
      return {
        kind: "container",
        container: `${named[1]}#${named[2]}`,
        ...place(html, container),
      }
    }
  }
  return null
}

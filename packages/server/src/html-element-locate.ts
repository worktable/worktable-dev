import { parseDocument } from "htmlparser2"
import {
  HTML_ELEMENT_ATTRIBUTES,
  HTML_ELEMENT_CONTEXT_LENGTH,
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
const IN_HEAD = new Set(["head", "title", "meta", "link", "base"])
const NAMING_ATTRIBUTE =
  /^(data-(?!worktable)[\w-]+|role|aria-label|name|href|src|alt|title|type|placeholder|for)$/

const isElement = (node: ParsedNode | null | undefined): node is ParsedElement =>
  Boolean(node && "attribs" in node)

function children(node: ParsedNode | ParsedElement): ParsedNode[] {
  return "children" in node ? (node.children as ParsedNode[]) : []
}

/** An element in the page, and where its words are in the page's text. */
interface Read {
  element: ParsedElement
  /** Its words run from here to `end` in the text. */
  start: number
  end: number
  /** The last heading before it. */
  heading: string
}

/**
 * Reads the page as its runtime does: the text is every piece of text in
 * order, each trimmed and with its spaces collapsed, joined by single
 * spaces; scripts and styles are not text. An element's words, and the text
 * before and after it, are parts of that.
 */
function readPage(roots: ParsedNode[]): { text: string; elements: Read[] } {
  let text = ""
  let heading = ""
  const elements: Read[] = []
  const walk = (node: ParsedNode) => {
    if (node.type === "text") {
      const piece = node.data.replace(/\s+/g, " ").trim()
      if (piece) text += text ? ` ${piece}` : piece
      return
    }
    if (!isElement(node) || UNREAD.has(node.name)) return
    const read: Read = { element: node, start: text.length, end: 0, heading }
    elements.push(read)
    for (const child of children(node)) walk(child)
    read.end = text.length
    // A heading is the one before whatever follows it, not what is in it.
    if (/^h[1-6]$/.test(node.name))
      heading = text.slice(read.start, read.end).trim().slice(0, 120)
  }
  for (const node of roots) walk(node)
  return { text, elements }
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

function pathOf(element: ParsedElement, body: ParsedElement | null): string {
  const path: string[] = []
  for (
    let node: ParsedNode | null = element;
    isElement(node) && node !== body && node.name !== "html";
    node = node.parent as ParsedNode | null
  )
    path.unshift(segment(node))
  return path.slice(-12).join(" > ")
}

/**
 * What a browser puts in the body of a page written without a body tag:
 * everything but the head and what belongs in it.
 */
function bodyOf(nodes: ParsedNode[]): ParsedNode[] {
  return nodes.flatMap((node) => {
    if (!isElement(node)) return [node]
    if (node.name === "html") return bodyOf(children(node))
    return IN_HEAD.has(node.name) ? [] : [node]
  })
}

function describe(
  { element, start, end, heading }: Read,
  page: string,
  body: ParsedElement | null
): HtmlElementCandidate {
  const text = page.slice(start, end).trim().slice(0, HTML_ELEMENT_QUOTE_LENGTH)
  const before = page.slice(0, start).slice(-HTML_ELEMENT_CONTEXT_LENGTH)
  const after = page.slice(end).trim().slice(0, HTML_ELEMENT_CONTEXT_LENGTH)
  const attrs: Record<string, string> = {}
  for (const [name, value] of Object.entries(element.attribs)) {
    if (Object.keys(attrs).length >= HTML_ELEMENT_ATTRIBUTES) break
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
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(heading ? { heading } : {}),
    path: pathOf(element, body),
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
  let body: ParsedElement | null = null
  const find = (node: ParsedNode) => {
    if (isElement(node) && node.name === "body" && !body) body = node
    else for (const child of children(node)) find(child)
  }
  for (const node of document.children) find(node)
  const page = readPage(body ? children(body) : bodyOf(document.children))
  // A page with more elements of one kind than are compared still keeps
  // the one where the comment's element was.
  const tagged = page.elements
    .filter((read) => read.element.name === anchor.element.tag)
    .filter(
      (read, at) =>
        at < CANDIDATE_LIMIT ||
        pathOf(read.element, body) === anchor.element.path
    )
  const byId = new Map<string, ParsedElement>()
  for (const { element } of page.elements) {
    const id = element.attribs["id"]
    if (id && !byId.has(id)) byId.set(id, element)
  }

  const { id, classes, attrs, before, after, heading, path } = anchor.element
  const match = matchHtmlElement(
    { id, classes, attrs, before, after, heading, path, text: anchor.quote },
    tagged.map((read) => describe(read, page.text, body))
  )
  if (match) {
    return {
      kind: "element",
      match: match.match,
      ...place(html, tagged[match.index]!.element),
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

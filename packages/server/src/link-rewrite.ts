// ============================================================
// Links after a move
// ============================================================
//
// Moving a Doc or a file through Worktable keeps the links to it true on
// disk, not only through aliases, so an agent reading the folder directly
// follows them. After a move, every Doc that moved or links to something
// that moved has those link and embed targets rewritten in place: relative
// targets stay relative, `/`-rooted ones stay rooted, and a target's query,
// fragment and `.md` style are kept. Aliases remain for anything missed.

import { posix } from "node:path"
import { Parser } from "htmlparser2"
import { resolveDocLink } from "@worktable/types"
import { logError } from "./debug-log.ts"
import { filesPreviewEnabled } from "./files-preview.ts"
import { getSpaceLinkGraph } from "./link-graph.ts"
import { blankRanges, markdownLayout } from "./markdown-code.ts"
import {
  agentChangeBase,
  commitAgentBlocks,
  syncDocAfterToolWrite,
} from "./mcp/dispatcher.ts"
import { docExists, writeDoc } from "./store.ts"

export interface PathMove {
  from: string
  to: string
}

type Rewrite = (target: string) => string | null

const SUFFIX = /[?#].*$/
const DOC_EXTENSION = /\.(?:md|json)$/i

/**
 * Encode only what would break a Markdown link or an HTML attribute, or read
 * as a query or fragment: a name may hold "#" or "?" itself.
 */
function encodeTargetPath(path: string): string {
  // encodeURIComponent leaves "(" and ")" as they are, which would end a
  // Markdown link early, so every one is encoded by its code.
  return path.replace(
    /[ ()<>"'#?%]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/**
 * The text a target should have once a Doc that was at `oldDoc` is at
 * `newDoc` and the paths in `moved` have moved, or null to leave it as it is.
 */
export function rewrittenTarget(
  target: string,
  oldDoc: string,
  newDoc: string,
  moved: ReadonlyMap<string, string>
): string | null {
  const lexical = resolveDocLink(oldDoc, target)
  if (lexical === null) return null
  const movedTo = moved.get(lexical)
  const rooted = target.startsWith("/")
  if (!movedTo && (oldDoc === newDoc || rooted)) return null
  const destination = movedTo ?? lexical
  const suffix = SUFFIX.exec(target)?.[0] ?? ""
  const body = target.slice(0, target.length - suffix.length)
  let decoded = body
  try {
    decoded = decodeURIComponent(body)
  } catch {
    // Kept as written.
  }
  const extension = DOC_EXTENSION.exec(decoded)?.[0] ?? ""
  let path: string
  if (rooted) {
    path = `/${destination}`
  } else {
    path = posix.relative(
      posix.dirname(`/${newDoc}`),
      `/${destination}`
    )
    // A Doc moved into the folder of the Doc it links to names it from above.
    if (path === "") path = `../${posix.basename(destination)}`
    if (body.startsWith("./") && !path.startsWith(".")) path = `./${path}`
  }
  const text = `${encodeTargetPath(`${path}${extension}`)}${suffix}`
  return text === target ? null : text
}

// ── Markdown ────────────────────────────────────────────────

const HTML_MEDIA_TAGS = new Set(["img", "video", "audio", "source"])
const HTML_MEDIA_HINT = /<(?:img|video|audio|source)\b/i


/**
 * The src values of a Doc's HTML media tags, read as a browser reads them,
 * with where each sits in the text and the quote around it.
 */
function htmlMediaSources(
  scanned: string
): Array<{
  at: number
  length: number
  value: string
  quote: string | null
  tag: string
}> {
  if (!HTML_MEDIA_HINT.test(scanned)) return []
  const sources: Array<{
    at: number
    length: number
    value: string
    quote: string | null
    tag: string
  }> = []
  let tag = ""
  const parser: Parser = new Parser({
    onopentagname(name) {
      tag = name
    },
    onattribute(name, value, quote) {
      if (!HTML_MEDIA_TAGS.has(tag) || name !== "src") return
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

/** A path as an HTML attribute value holds it. */
function htmlAttributeText(value: string, quote: string | null): string {
  const text = value.replace(/&/g, "&amp;")
  if (quote === "'") return text.replace(/'/g, "&#39;")
  if (quote === '"') return text.replace(/"/g, "&quot;")
  return text.replace(/[\s"'=<>`]/g, (char) => `&#${char.charCodeAt(0)};`)
}

/**
 * A Markdown Doc with its link, image and media targets rewritten, or with
 * `imagesOnly`, its images alone.
 */
export function rewriteMarkdownLinks(
  markdown: string,
  rewrite: Rewrite,
  options: { imagesOnly?: boolean } = {}
): string {
  // One read says where code and link destinations sit; code keeps its
  // offsets but can never match a link or a media tag.
  const layout = markdownLayout(markdown)
  const scanned = blankRanges(markdown, [...layout.blocks, ...layout.inline])
  const edits: Array<{ at: number; length: number; text: string }> = []
  for (const [index, [start, end]] of layout.destinations.entries()) {
    if (options.imagesOnly && !layout.images[index]) continue
    // A destination in angle brackets keeps them; its path sits inside.
    const angled = markdown[start] === "<" && markdown[end - 1] === ">"
    const at = angled ? start + 1 : start
    const target = markdown.slice(at, angled ? end - 1 : end)
    const text = rewrite(target)
    if (text !== null) edits.push({ at, length: target.length, text })
  }
  for (const source of htmlMediaSources(scanned)) {
    if (options.imagesOnly && source.tag !== "img") continue
    const text = rewrite(source.value)
    if (text !== null) {
      edits.push({
        at: source.at,
        length: source.length,
        text: htmlAttributeText(text, source.quote),
      })
    }
  }
  // Assembled in one pass, however many links change.
  const parts: string[] = []
  let at = 0
  for (const edit of edits.sort((a, b) => a.at - b.at)) {
    if (edit.at < at) continue
    parts.push(markdown.slice(at, edit.at), edit.text)
    at = edit.at + edit.length
  }
  parts.push(markdown.slice(at))
  return parts.join("")
}

// ── Rich text ───────────────────────────────────────────────

type Block = Record<string, unknown>

const MEDIA_BLOCKS = new Set(["image", "video", "audio", "file"])

function rewriteInline(content: unknown[], rewrite: Rewrite): unknown[] | null {
  let changed = false
  const next = content.map((inline) => {
    const node = inline as Block | null
    if (node?.type !== "link" || typeof node.href !== "string") return inline
    const href = rewrite(node.href)
    if (href === null) return inline
    changed = true
    return { ...node, href }
  })
  return changed ? next : null
}

function rewriteTable(content: Block, rewrite: Rewrite): Block | null {
  if (!Array.isArray(content.rows)) return null
  let changed = false
  const rows = content.rows.map((row) => {
    const cells = (row as Block | null)?.cells
    if (!Array.isArray(cells)) return row
    let rowChanged = false
    const nextCells = cells.map((cell) => {
      if (Array.isArray(cell)) {
        const next = rewriteInline(cell, rewrite)
        if (!next) return cell
        rowChanged = true
        return next
      }
      const inner = (cell as Block | null)?.content
      if (!Array.isArray(inner)) return cell
      const next = rewriteInline(inner, rewrite)
      if (!next) return cell
      rowChanged = true
      return { ...(cell as Block), content: next }
    })
    if (!rowChanged) return row
    changed = true
    return { ...(row as Block), cells: nextCells }
  })
  return changed ? { ...content, rows } : null
}

/** One block with its targets rewritten, or null when nothing changed. */
function rewriteBlock(
  block: Block,
  rewrite: Rewrite,
  imagesOnly = false
): Block | null {
  let next: Block | null = null
  const content = block.content
  if (imagesOnly) {
    // Only image blocks: their url.
  } else if (Array.isArray(content)) {
    const inline = rewriteInline(content, rewrite)
    if (inline) next = { ...block, content: inline }
  } else if (
    content &&
    typeof content === "object" &&
    (content as Block).type === "tableContent"
  ) {
    const table = rewriteTable(content as Block, rewrite)
    if (table) next = { ...block, content: table }
  }
  const props = block.props as Block | undefined
  if (
    typeof block.type === "string" &&
    (imagesOnly ? block.type === "image" : MEDIA_BLOCKS.has(block.type)) &&
    typeof props?.url === "string" &&
    props.url
  ) {
    const url = rewrite(props.url)
    if (url !== null) next = { ...(next ?? block), props: { ...props, url } }
  }
  if (Array.isArray(block.children)) {
    let childChanged = false
    const children = block.children.map((child) => {
      const rewritten = rewriteBlock(child as Block, rewrite, imagesOnly)
      if (!rewritten) return child
      childChanged = true
      return rewritten
    })
    if (childChanged) next = { ...(next ?? block), children }
  }
  return next
}

/** A rich Doc's blocks with targets rewritten, and the top-level blocks that changed. */
export function rewriteBlockLinks(
  blocks: unknown[],
  rewrite: Rewrite,
  options: { imagesOnly?: boolean } = {}
): { blocks: unknown[]; changed: Block[] } {
  const changed: Block[] = []
  const next = blocks.map((block) => {
    const rewritten = rewriteBlock(block as Block, rewrite, options.imagesOnly)
    if (!rewritten) return block
    changed.push(rewritten)
    return rewritten
  })
  return { blocks: next, changed }
}

// ── After a move ────────────────────────────────────────────

const writeOptions = {
  updatedBy: "system",
  source: "system",
  reason: "Updated links after a move",
  managedIdentity: true,
}

async function rewriteDoc(
  spaceId: string,
  docPath: string,
  oldPath: string,
  moved: ReadonlyMap<string, string>
): Promise<boolean> {
  const current = await agentChangeBase(spaceId, docPath, undefined, false)
  const rewrite: Rewrite = (target) =>
    rewrittenTarget(target, oldPath, docPath, moved)
  const base = current.base
  if (typeof base === "string") {
    const next = rewriteMarkdownLinks(base, rewrite)
    if (next === base) return false
    const written = await writeDoc(spaceId, docPath, next, {
      ...writeOptions,
      sourceRevision: current.sourceRevision,
    })
    if (!written.ok) throw new Error(written.error ?? "Links were not updated")
  } else if (Array.isArray(base)) {
    const { blocks, changed } = rewriteBlockLinks(base, rewrite)
    if (changed.length === 0) return false
    const written = await commitAgentBlocks({
      spaceId,
      docPath,
      base,
      baseIsSource: current.baseIsSource,
      blocks,
      regions: changed.map((block) => ({
        replacedBlockIds: [String(block.id)],
        blocks: [block],
      })),
      sourceRevision: current.sourceRevision,
      writeOptions,
    })
    if (!written.ok) throw new Error(written.error ?? "Links were not updated")
  } else {
    return false
  }
  await syncDocAfterToolWrite(spaceId, docPath)
  return true
}

/** Docs elsewhere one move rewrites; aliases cover links in any more. */
const REWRITES_PER_MOVE_MAX = 200

let track: (task: Promise<unknown>) => void = () => {}
const queues = new Map<string, Promise<void>>()

/** Where background rewrites go so the server's drains wait for them. */
export function setLinkRewriteTracker(
  tracker: (task: Promise<unknown>) => void
): void {
  track = tracker
}

/**
 * Rewrite the links a move affected. The Docs that moved are rewritten now,
 * from their own text: the move's request waits for them, and their callers
 * get them as written. Docs elsewhere that link to or embed what moved are
 * found through the Space's link graph, a read of the whole Space, so they
 * are rewritten after the request, a Space at a time. A Doc that can't be
 * updated keeps working through aliases; the move itself has already
 * happened and is never undone here.
 */
export async function rewriteLinksAfterMove(
  spaceId: string,
  moves: readonly PathMove[]
): Promise<{ rewritten: string[] }> {
  const rewritten: string[] = []
  if (!filesPreviewEnabled()) return { rewritten }
  const actual = moves.filter((move) => move.from !== move.to)
  if (actual.length === 0) return { rewritten }
  const moved = new Map(actual.map((move) => [move.from, move.to]))
  for (const move of actual) {
    try {
      if (!(await docExists(spaceId, move.to))) continue
      if (await rewriteDoc(spaceId, move.to, move.from, moved)) {
        rewritten.push(move.to)
      }
    } catch (error) {
      console.warn("[links] a moved Doc's links were not updated:", logError(error))
    }
  }
  const task = (queues.get(spaceId) ?? Promise.resolve())
    .then(() => rewriteLinksTo(spaceId, actual, moved))
    .catch((error) => {
      console.warn("[links] links were not updated after a move:", logError(error))
    })
  queues.set(spaceId, task)
  void task.finally(() => {
    if (queues.get(spaceId) === task) queues.delete(spaceId)
  })
  track(task)
  return { rewritten }
}

/** Rewrite the Docs, other than those that moved, that link to what moved. */
async function rewriteLinksTo(
  spaceId: string,
  actual: readonly PathMove[],
  moved: ReadonlyMap<string, string>
): Promise<void> {
  // Built after the move: its links resolve through the new aliases, so a
  // moved path's sources are listed under where it is now.
  const graph = await getSpaceLinkGraph(spaceId)
  const movedDocs = new Set(actual.map((move) => move.to))
  const docs = new Set<string>()
  for (const move of actual) {
    for (const source of graph.inbound.get(move.to) ?? []) {
      if (!movedDocs.has(source)) docs.add(source)
    }
  }
  // A move rewrites a bounded number of Docs; links in any more keep working
  // through aliases, so one move can't turn into unbounded writes.
  for (const docPath of [...docs].slice(0, REWRITES_PER_MOVE_MAX)) {
    try {
      if (await docExists(spaceId, docPath)) {
        await rewriteDoc(spaceId, docPath, docPath, moved)
      }
    } catch (error) {
      console.warn("[links] a Doc's links were not updated after a move:", logError(error))
    }
  }
}

/** Wait for the link rewrites under way; shutdown and tests use this. */
export async function settleLinkRewrites(): Promise<void> {
  while (queues.size > 0) await Promise.allSettled([...queues.values()])
}

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
import { resolveDocLink } from "@worktable/types"
import { logError } from "./debug-log.ts"
import { filesPreviewEnabled } from "./files-preview.ts"
import { getSpaceLinkGraph } from "./link-graph.ts"
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

/** Encode only what would break a Markdown link or an HTML attribute. */
function encodeTargetPath(path: string): string {
  return path.replace(/[ ()<>"']/g, (character) => encodeURIComponent(character))
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
    if (body.startsWith("./") && !path.startsWith(".")) path = `./${path}`
  }
  const text = `${encodeTargetPath(`${path}${extension}`)}${suffix}`
  return text === target ? null : text
}

// ── Markdown ────────────────────────────────────────────────

const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const HTML_MEDIA_SRC =
  /<(?:img|video|audio|source)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

/** Code keeps its offsets but can never match a link. */
function blankCode(markdown: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ")
  return markdown
    .replace(/^```[\s\S]*?^```/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
}

/** A Markdown Doc with its link, image and media targets rewritten. */
export function rewriteMarkdownLinks(markdown: string, rewrite: Rewrite): string {
  const scanned = blankCode(markdown)
  const edits: Array<{ at: number; length: number; text: string }> = []
  let match: RegExpExecArray | null
  MARKDOWN_LINK.lastIndex = 0
  while ((match = MARKDOWN_LINK.exec(scanned)) !== null) {
    const target = match[3]!
    const open = match[0].indexOf("](") + 2
    const at = match.index + match[0].indexOf(target, open)
    const text = rewrite(target)
    if (text !== null) edits.push({ at, length: target.length, text })
  }
  HTML_MEDIA_SRC.lastIndex = 0
  while ((match = HTML_MEDIA_SRC.exec(scanned)) !== null) {
    const target = match[1] ?? match[2] ?? ""
    const at = match.index + match[0].length - target.length - 1
    const text = rewrite(target)
    if (text !== null) edits.push({ at, length: target.length, text })
  }
  let result = markdown
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    result =
      result.slice(0, edit.at) + edit.text + result.slice(edit.at + edit.length)
  }
  return result
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
function rewriteBlock(block: Block, rewrite: Rewrite): Block | null {
  let next: Block | null = null
  const content = block.content
  if (Array.isArray(content)) {
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
    MEDIA_BLOCKS.has(block.type) &&
    typeof props?.url === "string" &&
    props.url
  ) {
    const url = rewrite(props.url)
    if (url !== null) next = { ...(next ?? block), props: { ...props, url } }
  }
  if (Array.isArray(block.children)) {
    let childChanged = false
    const children = block.children.map((child) => {
      const rewritten = rewriteBlock(child as Block, rewrite)
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
  rewrite: Rewrite
): { blocks: unknown[]; changed: Block[] } {
  const changed: Block[] = []
  const next = blocks.map((block) => {
    const rewritten = rewriteBlock(block as Block, rewrite)
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
): Promise<void> {
  const current = await agentChangeBase(spaceId, docPath, undefined, false)
  const rewrite: Rewrite = (target) =>
    rewrittenTarget(target, oldPath, docPath, moved)
  const base = current.base
  if (typeof base === "string") {
    const next = rewriteMarkdownLinks(base, rewrite)
    if (next === base) return
    const written = await writeDoc(spaceId, docPath, next, {
      ...writeOptions,
      sourceRevision: current.sourceRevision,
    })
    if (!written.ok) throw new Error(written.error ?? "Links were not updated")
  } else if (Array.isArray(base)) {
    const { blocks, changed } = rewriteBlockLinks(base, rewrite)
    if (changed.length === 0) return
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
    return
  }
  await syncDocAfterToolWrite(spaceId, docPath)
}

/**
 * Rewrite the links a move affected: in every Doc that moved, and in every
 * Doc that links to or embeds something that moved. A Doc that can't be
 * updated keeps working through aliases; the move itself has already
 * happened and is never undone here.
 */
export async function rewriteLinksAfterMove(
  spaceId: string,
  moves: readonly PathMove[]
): Promise<void> {
  if (!filesPreviewEnabled()) return
  const actual = moves.filter((move) => move.from !== move.to)
  if (actual.length === 0) return
  const moved = new Map(actual.map((move) => [move.from, move.to]))
  const formerPath = new Map(actual.map((move) => [move.to, move.from]))
  try {
    // Built after the move: its links resolve through the new aliases, so a
    // moved path's sources are listed under where it is now.
    const graph = await getSpaceLinkGraph(spaceId)
    const docs = new Set<string>()
    for (const move of actual) {
      docs.add(move.to)
      for (const source of graph.inbound.get(move.to) ?? []) docs.add(source)
    }
    for (const docPath of docs) {
      if (!(await docExists(spaceId, docPath))) continue
      try {
        await rewriteDoc(spaceId, docPath, formerPath.get(docPath) ?? docPath, moved)
      } catch (error) {
        console.warn("[links] a Doc's links were not updated after a move:", logError(error))
      }
    }
  } catch (error) {
    console.warn("[links] links were not updated after a move:", logError(error))
  }
}

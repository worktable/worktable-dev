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
// With Space images in HTML Docs on, an HTML Doc's img targets are kept
// true the same way, since its images resolve without aliases.

import { posix } from "node:path"
import { resolveDocLink } from "@worktable/types"
import { logError } from "./debug-log.ts"
import { filesEnabled } from "./files-enabled.ts"
import {
  applySpanEdits,
  htmlAttributeText,
  htmlMediaSources,
} from "./html-media-sources.ts"
import { getSpaceLinkGraph } from "./link-graph.ts"
import { blankRanges, markdownLayout } from "./markdown-code.ts"
import {
  agentChangeBase,
  commitAgentBlocks,
  syncDocAfterToolWrite,
} from "./mcp/dispatcher.ts"
import { docExists, writeDoc } from "./store.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { readDocumentCatalogSnapshot } from "./document-query.ts"
import { withCanonicalHtmlDocumentPath } from "./html-document-path.ts"
import {
  htmlSpaceImagesEnabled,
  rewriteHtmlImageTargets,
} from "./html-space-images.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { buildWidgetFile } from "./widget-authoring.ts"
import {
  readWidgetDocument,
  withWidgetWriteLock,
  writeWidget,
} from "./widget-store.ts"
import {
  captureWidgetVersionContent,
  recordWidgetVersion,
} from "./widget-version-store.ts"
import { wsManager } from "./ws.ts"
import { normalizeRecordFieldType } from "@worktable/types"
import {
  listRecordCollections,
  listRecords,
  RECORD_CHANGED,
  updateRecord,
} from "./record-store.ts"

export interface PathMove {
  from: string
  to: string
}

/**
 * A target's new text, or null to leave it. `imageUses` says how many images
 * show it: one for an inline image, every referring image for a definition.
 */
type Rewrite = (target: string, imageUses?: number) => string | null

const SUFFIX = /[?#].*$/
const DOC_EXTENSION = /\.(?:md|json)$/i

/**
 * Encode only what would break a Markdown link or an HTML attribute, or read
 * as a query or fragment: a name may hold "#" or "?" itself.
 */
export function encodeTargetPath(path: string): string {
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
    const text = rewrite(target, layout.imageUses[index])
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
  return applySpanEdits(markdown, edits)
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

/**
 * Rewrite targets in one Doc as it is now, open or not: a Markdown Doc by its
 * text, a rich Doc block by block, so people typing in it are not
 * interrupted. Saved as a version with `reason`.
 */
export async function rewriteDocTargets(
  spaceId: string,
  docPath: string,
  rewrite: Rewrite,
  options: { reason: string; imagesOnly?: boolean }
): Promise<boolean> {
  const writeOptions = {
    updatedBy: "system",
    source: "system",
    reason: options.reason,
    managedIdentity: true,
    // Keeps links in step with a move: counted, never refused.
    storage: "counted" as const,
  }
  const scan = { imagesOnly: options.imagesOnly ?? false }
  const current = await agentChangeBase(spaceId, docPath, undefined, false)
  const base = current.base
  if (typeof base === "string") {
    const next = rewriteMarkdownLinks(base, rewrite, scan)
    if (next === base) return false
    const written = await writeDoc(spaceId, docPath, next, {
      ...writeOptions,
      sourceRevision: current.sourceRevision,
    })
    if (!written.ok) throw new Error(written.error ?? "Links were not updated")
  } else if (Array.isArray(base)) {
    const { blocks, changed } = rewriteBlockLinks(base, rewrite, scan)
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

// ── HTML Docs ───────────────────────────────────────────────

/** The Space's HTML Docs, while their img targets are kept true. */
async function htmlDocPaths(spaceId: string): Promise<Set<string>> {
  if (!htmlSpaceImagesEnabled()) return new Set()
  const catalog = await readDocumentCatalogSnapshot(spaceId)
  return new Set(
    catalog.entries.flatMap((entry) =>
      entry.kind === "document" &&
      entry.descriptor.format.id === BUILTIN_DOCUMENT_FORMATS.html
        ? [entry.descriptor.path]
        : []
    )
  )
}

/**
 * Rewrite one HTML Doc's img targets as it is now, saved as a version with
 * `reason`. Its name and permissions stay as they are.
 */
async function rewriteHtmlDoc(
  spaceId: string,
  path: string,
  oldPath: string,
  moved: ReadonlyMap<string, string>
): Promise<boolean> {
  const widget = await withCanonicalHtmlDocumentPath(
    spaceId,
    path,
    () =>
      withWidgetWriteLock(spaceId, path, async () => {
        const { data } = await readWidgetDocument(spaceId, path)
        if (!data) return null
        const html = rewriteHtmlImageTargets(data.html, (target) =>
          rewrittenTarget(target, oldPath, path, moved)
        )
        if (html === data.html) return null
        const before = await captureWidgetVersionContent(spaceId, path)
        const result = await writeWidget(
          spaceId,
          buildWidgetFile({
            id: path,
            name: data.widget.name,
            description: data.widget.description,
            updatedBy: "system",
            existing: data.widget,
          }),
          html,
          // Keeps image paths in step with a move: counted, never refused.
          { storage: "counted" }
        )
        if (result.error || !result.data) {
          throw new Error(result.error ?? "Links were not updated")
        }
        await recordWidgetVersion(spaceId, path, before, {
          source: "system",
          updatedBy: "system",
          reason: "Updated links after a move",
        })
        result.release?.()
        return result.data
      }),
    { materialize: true }
  )
  if (!widget) return false
  invalidateSearchIndex({ spaceId, path })
  wsManager.broadcast(spaceId, {
    type: "widget_update",
    spaceId,
    widgetId: path,
    data: widget,
  })
  return true
}

/** Rewrite one Doc's links to what moved; `oldPath` is where it was. */
function rewriteDoc(
  spaceId: string,
  docPath: string,
  oldPath: string,
  moved: ReadonlyMap<string, string>
): Promise<boolean> {
  return rewriteDocTargets(
    spaceId,
    docPath,
    (target) => rewrittenTarget(target, oldPath, docPath, moved),
    { reason: "Updated links after a move" }
  )
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
 * Records naming something that moved, in file or document fields, name it
 * where it is now. Each record that changes is one update.
 */
async function rewriteRecordFields(
  spaceId: string,
  moved: ReadonlyMap<string, string>
): Promise<void> {
  for (const collection of await listRecordCollections(spaceId)) {
    const fields = Object.entries(collection.schema?.fields ?? {}).filter(
      ([, field]) => {
        const type = normalizeRecordFieldType(field.type)
        return type === "file" || type === "document"
      }
    )
    if (fields.length === 0) continue
    for (const record of await listRecords(spaceId, collection.id, {
      includeArchived: true,
    })) {
      const data = record.data as Record<string, unknown>
      const changes: Record<string, unknown> = {}
      const before: Record<string, unknown> = {}
      for (const [key] of fields) {
        const value = data[key]
        const next = Array.isArray(value)
          ? value.map((entry) =>
              typeof entry === "string" ? (moved.get(entry) ?? entry) : entry
            )
          : typeof value === "string"
            ? (moved.get(value) ?? value)
            : value
        if (JSON.stringify(next) !== JSON.stringify(value)) {
          changes[key] = next
          before[key] = value
        }
      }
      if (Object.keys(changes).length === 0) continue
      // Only while the fields still hold what was read: an edit made since
      // stands, and an old path in it still works through aliases.
      const updated = await updateRecord(spaceId, collection.id, record.id, {
        data: changes,
        ifData: before,
        updatedBy: "system",
      })
      if (updated.error && updated.error !== RECORD_CHANGED) {
        console.warn("[links] a record was not updated after a move:", updated.error)
      }
    }
  }
}

/**
 * Rewrite the links a move affected. The Docs that moved are rewritten now,
 * from their own text: the move's request waits for them, and their callers
 * get them as written. Docs elsewhere that link to or embed what moved are
 * found through the Space's link graph, a read of the whole Space, so they
 * are rewritten after the request, a Space at a time, along with Records
 * whose file and document fields name what moved. A Doc that can't be
 * updated keeps working through aliases; the move itself has already
 * happened and is never undone here.
 */
export async function rewriteLinksAfterMove(
  spaceId: string,
  moves: readonly PathMove[]
): Promise<{ rewritten: string[] }> {
  const rewritten: string[] = []
  if (!filesEnabled()) return { rewritten }
  const actual = moves.filter((move) => move.from !== move.to)
  if (actual.length === 0) return { rewritten }
  const moved = new Map(actual.map((move) => [move.from, move.to]))
  // Without the catalog, each moved Doc is tried as an HTML Doc first.
  const htmlDocs = await htmlDocPaths(spaceId).catch(() => null)
  for (const move of actual) {
    try {
      if (htmlDocs === null || htmlDocs.has(move.to)) {
        if (await rewriteHtmlDoc(spaceId, move.to, move.from, moved)) {
          rewritten.push(move.to)
          continue
        }
        if (htmlDocs !== null) continue
      }
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

/**
 * Rewrite the Docs, other than those that moved, that link to what moved,
 * and the Records that name it.
 */
async function rewriteLinksTo(
  spaceId: string,
  actual: readonly PathMove[],
  moved: ReadonlyMap<string, string>
): Promise<void> {
  try {
    await rewriteRecordFields(spaceId, moved)
  } catch (error) {
    console.warn("[links] records were not updated after a move:", logError(error))
  }
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
  const htmlDocs = await htmlDocPaths(spaceId)
  // HTML Docs first: their images don't follow aliases, so only a rewrite
  // keeps them showing.
  const ordered = [...docs].sort(
    (a, b) => Number(htmlDocs.has(b)) - Number(htmlDocs.has(a))
  )
  for (const docPath of ordered.slice(0, REWRITES_PER_MOVE_MAX)) {
    try {
      if (htmlDocs.has(docPath)) {
        await rewriteHtmlDoc(spaceId, docPath, docPath, moved)
      } else if (await docExists(spaceId, docPath)) {
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

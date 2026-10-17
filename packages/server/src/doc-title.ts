// ============================================================
// Doc titles
// ============================================================
//
// A Doc's name is its title: the level-one heading it opens with. Renaming
// a Doc sets that heading and moves the file to a path made from it, so the
// sidebar, lists, links and files all agree on one name.

import { randomUUID } from "node:crypto"
import { renameDocAndSync, type RenameOutcome } from "./doc-rename.ts"
import {
  agentChangeBase,
  commitAgentBlocks,
  syncDocAfterToolWrite,
} from "./mcp/dispatcher.ts"
import { listDocuments } from "./document-query.ts"
import { DocEditError } from "./markdown-edit.ts"
import {
  deduplicateSlug,
  sanitizeDocPath,
  slugify,
  writeDoc,
} from "./store.ts"

type Block = Record<string, unknown> & { id?: unknown }

/** The opening block when it is the Doc's title, a level-one heading. */
export function titleBlock(blocks: readonly unknown[]): Block | null {
  const first = blocks[0] as Block | undefined
  if (!first || first.type !== "heading") return null
  const props = (first.props ?? {}) as Record<string, unknown>
  if ((Number(props.level) || 1) !== 1 || props.isToggleable) return null
  return first
}

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((inline) => {
      if (!inline || typeof inline !== "object") return ""
      const item = inline as { text?: unknown; content?: unknown }
      return typeof item.text === "string" ? item.text : inlineText(item.content)
    })
    .join("")
}

/** The title a rich Doc opens with, or "" without one. */
export function richDocTitle(blocks: readonly unknown[]): string {
  const block = titleBlock(blocks)
  return block ? inlineText(block.content).trim() : ""
}

/**
 * The 0-based line range of the level-one heading a Markdown Doc opens with
 * (ATX `# Title`, or a setext title underlined with `=`), or null.
 */
function markdownTitleLines(
  lines: readonly string[]
): { start: number; end: number; text: string } | null {
  const start = lines.findIndex((line) => line.trim() !== "")
  if (start === -1) return null
  const atx = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[start]!)
  if (atx) return { start, end: start, text: atx[1]!.trim() }
  if (/^ {0,3}=+[ \t]*$/.test(lines[start + 1] ?? "")) {
    return { start, end: start + 1, text: lines[start]!.trim() }
  }
  return null
}

/** `markdown` with `title` as its opening level-one heading. */
export function withMarkdownTitle(markdown: string, title: string): string {
  const lines = markdown.split("\n")
  const current = markdownTitleLines(lines)
  if (current) {
    lines.splice(current.start, current.end - current.start + 1, `# ${title}`)
    return lines.join("\n")
  }
  return markdown.trim() === "" ? `# ${title}\n` : `# ${title}\n\n${markdown}`
}

/**
 * Give a Doc `title` as its opening heading. A rich Doc that is open gets
 * only that block replaced, so people typing elsewhere are not interrupted.
 */
export async function setDocTitle(
  spaceId: string,
  docPath: string,
  title: string,
  updatedBy: string
): Promise<void> {
  const current = await agentChangeBase(spaceId, docPath, undefined, false)
  const writeOptions = {
    updatedBy,
    source: "rest-api",
    reason: "Renamed document",
    managedIdentity: true,
  }
  const stored = current.base
  if (typeof stored === "string") {
    const text = withMarkdownTitle(stored, title)
    if (text === stored) return
    const written = await writeDoc(spaceId, docPath, text, {
      ...writeOptions,
      sourceRevision: current.sourceRevision,
    })
    if (!written.ok) throw new Error(written.error ?? "Failed to rename document")
    await syncDocAfterToolWrite(spaceId, docPath)
    return
  }
  if (!Array.isArray(stored)) throw new Error("Unexpected document format")
  if (richDocTitle(stored) === title) return

  const existing = titleBlock(stored)
  const heading: Block = existing
    ? { ...existing, content: [{ type: "text", text: title, styles: {} }] }
    : {
        id: randomUUID(),
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: title, styles: {} }],
        children: [],
      }
  const first = stored[0] as Block | undefined
  const region = existing
    ? { replacedBlockIds: [String(existing.id)], blocks: [heading] }
    : {
        replacedBlockIds: [],
        blocks: [heading],
        ...(typeof first?.id === "string" ? { followingBlockId: first.id } : {}),
      }
  const blocks = existing ? [heading, ...stored.slice(1)] : [heading, ...stored]
  const written = await commitAgentBlocks({
    spaceId,
    docPath,
    base: stored,
    baseIsSource: current.baseIsSource,
    blocks,
    regions: [region] as never,
    sourceRevision: current.sourceRevision,
    writeOptions,
  })
  if (!written.ok) throw new Error(written.error ?? "Failed to rename document")
  await syncDocAfterToolWrite(spaceId, docPath)
}

/**
 * The path a Doc named `title` takes: beside its current path, made from the
 * title and numbered when another Doc has it. A title without letters or
 * digits keeps the current path.
 */
export async function pathForTitle(
  spaceId: string,
  docPath: string,
  title: string
): Promise<string> {
  const from = sanitizeDocPath(docPath)
  const slug = slugify(title)
  if (!slug) return from
  const parent = from.split("/").slice(0, -1).join("/")
  const base = parent ? `${parent}/${slug}` : slug
  // Every document path is taken, archived ones too.
  const others = (await listDocuments({ spaceId, includeArchived: true }))
    .map((item) => (item.kind === "document" ? item.path : item.pathKey))
    .filter((path) => path !== from)
  return deduplicateSlug(base, others)
}

/** The title a Doc has now, as people see it when it is open. */
export async function currentDocTitle(
  spaceId: string,
  docPath: string
): Promise<string> {
  const { base } = await agentChangeBase(spaceId, docPath, undefined, false)
  if (typeof base === "string") {
    return markdownTitleLines(base.split("\n"))?.text ?? ""
  }
  return Array.isArray(base) ? richDocTitle(base) : ""
}

/**
 * Rename a Doc: set its title, then move it to the path made from it.
 * Without a title, the Doc keeps the one it has and only moves; a Doc
 * without a title stays where it is.
 */
export async function renameDocToTitle(
  spaceId: string,
  docPath: string,
  title: string | undefined,
  updatedBy: string
): Promise<RenameOutcome> {
  const from = sanitizeDocPath(docPath)
  const name =
    title === undefined
      ? await currentDocTitle(spaceId, docPath)
      : title.trim()
  if (!name) {
    return title === undefined
      ? { renamed: [], error: null }
      : { renamed: [], error: "Name is empty" }
  }
  try {
    if (title !== undefined) await setDocTitle(spaceId, docPath, name, updatedBy)
  } catch (error) {
    if (error instanceof DocEditError) return { renamed: [], error: error.message }
    throw error
  }
  const to = await pathForTitle(spaceId, docPath, name)
  if (to === from) return { renamed: [{ from, to }], error: null }
  return renameDocAndSync(spaceId, from, to)
}

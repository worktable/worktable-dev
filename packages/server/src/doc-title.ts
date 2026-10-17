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
import { createDocAliasReservationLookup } from "./doc-aliases.ts"
import {
  markdownDocTitle,
  richDocTitle,
  titleBlock,
  withMarkdownTitle,
} from "./doc-title-text.ts"
import { listDocumentsWithAliases } from "./document-query.ts"
import { DocEditError } from "./markdown-edit.ts"
import {
  sanitizeDocPath,
  slugify,
  writeDoc,
} from "./store.ts"

type Block = Record<string, unknown> & { id?: unknown }

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
  // A block someone added at the top meanwhile goes before the new title.
  if (Array.isArray(written.content) && richDocTitle(written.content) !== title) {
    throw new DocEditError(
      "revision_conflict",
      `${docPath} changed at its top while it was renamed. Try again.`
    )
  }
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
  // Every document path is taken, archived ones too, and so is every path a
  // moved document left behind for its old links.
  const { documents, aliases } = await listDocumentsWithAliases({
    spaceId,
    includeArchived: true,
  })
  const taken = new Set(
    documents
      .map((item) => (item.kind === "document" ? item.path : item.pathKey))
      .filter((path) => path !== from)
      .map((path) => path.toLowerCase())
  )
  const reserved = createDocAliasReservationLookup(aliases)
  const free = (path: string) =>
    path === from || (!taken.has(path.toLowerCase()) && !reserved(path))
  let candidate = base
  for (let n = 2; !free(candidate); n++) candidate = `${base}-${n}`
  return candidate
}

/** The title a Doc has now, as people see it when it is open. */
export async function currentDocTitle(
  spaceId: string,
  docPath: string
): Promise<string> {
  const { base } = await agentChangeBase(spaceId, docPath, undefined, false)
  if (typeof base === "string") return markdownDocTitle(base)
  return Array.isArray(base) ? richDocTitle(base) : ""
}

/**
 * Rename a Doc: move it to the path made from its new title, then set the
 * title. Moving first means a move that cannot happen changes nothing, and
 * a title that fails after the move is set by trying again, which finds the
 * Doc already at that path. Without a title, the Doc keeps the one it has and
 * only moves; a Doc without a title stays where it is.
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
  const to = await pathForTitle(spaceId, docPath, name)
  if (to !== from) {
    const moved = await renameDocAndSync(spaceId, from, to)
    if (moved.error) return moved
  }
  try {
    if (title !== undefined) await setDocTitle(spaceId, to, name, updatedBy)
  } catch (error) {
    if (error instanceof DocEditError) {
      return { renamed: to === from ? [] : [{ from, to }], error: error.message }
    }
    throw error
  }
  return { renamed: [{ from, to }], error: null }
}

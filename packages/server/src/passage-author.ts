// ============================================================
// Who wrote a passage of a Doc
// ============================================================
//
// Every save is a version with its author, but nothing records who wrote
// each sentence. To send a comment to whoever wrote the text it is about,
// walk back from the newest version while the passage is still there: the
// oldest version in that unbroken run introduced it, and its author wrote it.
// The walk is bounded, and runs only for a comment on selected text.

import {
  findPassage,
  sourceCategory,
  type AnnotationTarget,
  type PassageSelector,
} from "@worktable/types"
import { markdownReadingText } from "./markdown-passage.ts"
import {
  listOwnedDocVersionsV2,
  readOwnedDocVersionV2,
  resolveDocOwnerV2,
  usesDocumentVersionStoreV2,
} from "./document-version-compatibility-v2.ts"
import { getDocVersion, listDocVersions } from "./store.ts"
import { hasScope } from "./token-store.ts"

/** Versions read at most, newest first. */
const PASSAGE_WALK_LIMIT = 20

export interface PassageAuthor {
  /** The principal that wrote it, as its versions record it. */
  by: string
  kind: "person" | "agent"
  versionId: string
  at: string
}

/**
 * A rich block's own text: styled text, link labels inside their links, and
 * a table's cells, one row per line.
 */
function inlineText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(inlineText).join("")
  if (!content || typeof content !== "object") return ""
  const value = content as {
    text?: unknown
    content?: unknown
    rows?: unknown
    cells?: unknown
  }
  if (typeof value.text === "string") return value.text
  if (Array.isArray(value.rows)) {
    return value.rows.map((row) => inlineText(row)).join("\n")
  }
  if (Array.isArray(value.cells)) {
    return value.cells.map((cell) => inlineText(cell)).join("\n")
  }
  return inlineText(value.content)
}

/** The text a reader sees in one version of a Doc, Markdown or rich. */
function readingText(content: unknown): string | null {
  if (typeof content === "string") return markdownReadingText(content).text
  if (!Array.isArray(content)) return null
  const lines: string[] = []
  const walk = (blocks: unknown[]) => {
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue
      const value = block as { content?: unknown; children?: unknown }
      lines.push(inlineText(value.content))
      if (Array.isArray(value.children)) walk(value.children)
    }
  }
  walk(content)
  return lines.join("\n")
}

/** A Doc's versions newest first, and a reader for each, resolved once. */
async function docHistory(spaceId: string, docPath: string): Promise<{
  versions: Array<{ id: string; createdAt: string; createdBy: string; source: string }>
  read: (versionId: string) => Promise<{ after: { content: unknown } } | null>
} | null> {
  if (await usesDocumentVersionStoreV2()) {
    const owner = await resolveDocOwnerV2(spaceId, docPath)
    if (!owner) return null
    return {
      versions: await listOwnedDocVersionsV2(spaceId, owner),
      read: (versionId) => readOwnedDocVersionV2(spaceId, owner, versionId),
    }
  }
  return {
    versions: await listDocVersions(spaceId, docPath),
    read: (versionId) => getDocVersion(spaceId, docPath, versionId),
  }
}

/** A version's author as a principal, or null for work no one did. */
function authorOf(
  createdBy: string,
  source: string
): Pick<PassageAuthor, "by" | "kind"> | null {
  const category = sourceCategory(source, createdBy)
  if (category !== "agent" && category !== "human") return null
  const by = createdBy.startsWith("agent:")
    ? createdBy.slice("agent:".length)
    : createdBy
  return { by, kind: category === "agent" ? "agent" : "person" }
}

/** Who wrote the passage a comment is about, or null when unknown. */
export async function passageAuthor(
  spaceId: string,
  docPath: string,
  selector: PassageSelector
): Promise<PassageAuthor | null> {
  if (!selector.quote.trim()) return null
  const history = await docHistory(spaceId, docPath)
  if (!history) return null
  const versions = history.versions
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  let author: PassageAuthor | null = null
  for (const [index, entry] of versions.entries()) {
    // Past the limit the passage may be older still: its writer is unknown.
    if (index === PASSAGE_WALK_LIMIT) return null
    const snapshot = await history.read(entry.id)
    const text = readingText(snapshot?.after.content)
    if (text === null) return null
    // Further back only the same words count: a reworded passage was
    // written by whoever reworded it.
    const found = findPassage(text, selector)
    if (!found || (index > 0 && found.match !== "exact")) return author
    const who = authorOf(entry.createdBy, entry.source)
    // A restore or tidy-up carries text forward; the writer is further back.
    if (who) author = { ...who, versionId: entry.id, at: entry.createdAt }
  }
  // The first version had it: whoever created the Doc wrote it.
  return author
}

/**
 * Who wrote the text a new comment is about; null for a whole-Doc comment,
 * or when the commenter can't read Docs, since the answer says whether the
 * quoted words are in the Doc.
 */
export async function passageAuthorForTarget(
  spaceId: string,
  target: AnnotationTarget,
  scopes: readonly string[]
): Promise<PassageAuthor | null> {
  if (!hasScope([...scopes], "documents:read") && !hasScope([...scopes], "docs:read")) {
    return null
  }
  if (!("docPath" in target) || !("quote" in target) || !target.quote) return null
  return passageAuthor(spaceId, target.docPath, {
    quote: target.quote,
    ...("prefix" in target && target.prefix ? { prefix: target.prefix } : {}),
    ...("suffix" in target && target.suffix ? { suffix: target.suffix } : {}),
  }).catch(() => null)
}

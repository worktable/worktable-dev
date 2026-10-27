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
  normalizePassageText,
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

/** Characters of context that must still match on one side. */
const CONTEXT_MATCH = 12
/** Shorter selections say too little to find a writer by. */
const MIN_QUOTE_LENGTH = 3
/** Places looked at in one version; more and the writer is unknown. */
const MAX_PLACES = 200

function sharedEnd(a: string, b: string): number {
  let length = 0
  while (length < a.length && length < b.length && a[a.length - 1 - length] === b[b.length - 1 - length]) length++
  return length
}

function sharedStart(a: string, b: string): number {
  let length = 0
  while (length < a.length && length < b.length && a[length] === b[length]) length++
  return length
}

/**
 * Whether the selected words are in `text` word for word, in the same place:
 * the text on at least one side is still what the selection had there, so
 * an edit next to the passage doesn't move its origin, while the same words
 * elsewhere don't count. Without that context, only when they appear once.
 */
function stillHere(text: string, selector: PassageSelector): boolean {
  const flat = normalizePassageText(text)
  const quote = normalizePassageText(selector.quote)
  const prefix = normalizePassageText(selector.prefix ?? "")
  const suffix = normalizePassageText(selector.suffix ?? "")
  const withoutContext =
    selector.prefix === undefined && selector.suffix === undefined
  // No context on a side means the selection reached the Doc's edge there.
  const sideMatches = (atEdge: boolean, expected: string, shared: number) =>
    expected ? shared >= Math.min(expected.length, CONTEXT_MATCH) : atEdge
  // Bounded: stop at the answer, and give up past a few hundred places.
  let found = 0
  for (let at = flat.indexOf(quote); at !== -1; at = flat.indexOf(quote, at + 1)) {
    found += 1
    if (found > MAX_PLACES) return false
    if (withoutContext) {
      if (found > 1) return false
      continue
    }
    const before = flat.slice(Math.max(0, at - prefix.length - 1), at).trimEnd()
    const after = flat
      .slice(at + quote.length, at + quote.length + suffix.length + 1)
      .trimStart()
    if (
      sideMatches(at === 0, prefix, sharedEnd(before, prefix)) ||
      sideMatches(at + quote.length === flat.length, suffix, sharedStart(after, suffix))
    ) {
      return true
    }
  }
  return withoutContext && found === 1
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
  // MCP records the principal whole ("agent:<uuid>" for a Teams agent);
  // only REST writes add an agent: prefix to it.
  const by =
    source !== "mcp" && createdBy.startsWith("agent:")
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
  if (normalizePassageText(selector.quote).length < MIN_QUOTE_LENGTH) return null
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
    // Only the same words in the same place count, now and further back: a
    // reworded passage was written by whoever reworded it, and the same
    // words elsewhere in the Doc are another passage.
    if (!stillHere(text, selector)) return author
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

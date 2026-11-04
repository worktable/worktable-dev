// ============================================================
// Recent documents across Spaces
// ============================================================
//
// Home and Space overviews list real documents by when they changed or were
// created. Temporary documents are supporting work, so they are left out
// unless asked for; asking for only temporary documents lists them by when
// they archive. Archived Spaces and documents never appear.
//
// Each row names who last created or edited the doc, from the in-memory
// summary of each Space's activity, so a list reads no history.

import type { ActivityActor, DocumentSummary } from "@worktable/types"
import { peekDocActivity } from "./activity-log.ts"
import { pathMovesFor } from "./doc-aliases.ts"
import { docMarkdownProjection } from "./doc-markdown-projection.ts"
import { listDocumentsWithAliases } from "./document-query.ts"
import { getSpaceArchiveInfo, listSpaces, readDocSourceSnapshot } from "./store.ts"
import { isGettingStartedSpace } from "./getting-started.ts"
import { logError } from "./debug-log.ts"

export type RecentSort = "updated" | "created"

export interface RecentDocument {
  spaceId: string
  spaceName: string
  document: DocumentSummary
  /** Who last created or edited the doc, once its Space is summarized. */
  lastEditor?: ActivityActor
}

/** The newest doc an agent made in the last day, with its opening lines. */
export interface FeaturedDocument extends RecentDocument {
  excerpt?: string
}

const FEATURED_WITHIN_MS = 24 * 60 * 60 * 1000

export interface SpaceActivity {
  spaceId: string
  /** Newest change to any active document in the Space. */
  lastActivityAt?: string
}

export async function listRecentDocuments(options: {
  spaceId?: string
  sort?: RecentSort
  includeTemporary?: boolean
  /** Only temporary documents, soonest to archive first. */
  onlyTemporary?: boolean
  limit?: number
  /**
   * Also list up to this many temporary documents, soonest to archive first,
   * from the same pass, so Home needs one request for both lists.
   */
  temporaryLimit?: number
  /**
   * Only docs one of these actors created or edited. Without it, every
   * visible doc counts.
   */
  actorIds?: ReadonlySet<string>
  /** Only docs in this folder, with spaceId. */
  folder?: string
  /** Also pick the newest doc an agent made in the last day. */
  featured?: boolean
}): Promise<{
  items: RecentDocument[]
  temporary?: RecentDocument[]
  featured?: FeaturedDocument
  spaces: SpaceActivity[]
}> {
  const sort = options.sort ?? "updated"
  const limit = options.limit ?? 30
  // Across Spaces, Recent is the person's own work: Getting Started's guides
  // are listed only when that Space is asked for.
  const spaces = (await listSpaces()).filter(
    (space) =>
      !getSpaceArchiveInfo(space) &&
      (options.spaceId === undefined
        ? !isGettingStartedSpace(space)
        : space.id === options.spaceId)
  )
  // Spaces are listed in parallel; one unreadable Space must not hide the
  // rest of the workspace's recent work.
  const perSpace = await Promise.all(
    spaces.map(async (space) => {
      try {
        let newest: string | undefined
        const spaceItems: RecentDocument[] = []
        const spaceTemporary: RecentDocument[] = []
        const { documents, aliases } = await listDocumentsWithAliases({ spaceId: space.id })
        const moves = pathMovesFor(aliases)
        for (const item of documents) {
          if (item.kind !== "document") continue
          if (options.folder && !item.path.startsWith(`${options.folder}/`)) continue
          if (item.updatedAt && (!newest || item.updatedAt > newest)) {
            newest = item.updatedAt
          }
          const temporary = item.lifetime === "temporary"
          const activity = peekDocActivity(space.id, item.path, moves)
          if (
            options.actorIds &&
            !activity?.contributors.some((actor) => options.actorIds!.has(actor.id))
          ) {
            continue
          }
          const entry: RecentDocument = {
            spaceId: space.id,
            spaceName: space.name,
            document: item,
            ...(activity?.lastEditor ? { lastEditor: activity.lastEditor } : {}),
          }
          if (temporary) spaceTemporary.push(entry)
          if (options.onlyTemporary ? !temporary : !options.includeTemporary && temporary) {
            continue
          }
          spaceItems.push(entry)
        }
        return {
          items: spaceItems,
          temporary: spaceTemporary,
          activity: { spaceId: space.id, ...(newest ? { lastActivityAt: newest } : {}) },
        }
      } catch (error) {
        console.error(`[recent-documents] could not list ${space.id}:`, logError(error))
        return { items: [], temporary: [], activity: { spaceId: space.id } }
      }
    })
  )
  const items = perSpace.flatMap((entry) => entry.items)
  const activity: SpaceActivity[] = perSpace.map((entry) => entry.activity)
  const archiveOn = (item: RecentDocument) => item.document.archiveOn ?? "\uffff"
  const soonestToArchive = (list: RecentDocument[]) =>
    list.sort((a, b) => archiveOn(a).localeCompare(archiveOn(b)))
  const temporary = options.temporaryLimit
    ? {
        temporary: soonestToArchive(
          perSpace.flatMap((entry) => entry.temporary)
        ).slice(0, options.temporaryLimit),
      }
    : {}
  if (options.onlyTemporary) {
    return {
      items: soonestToArchive(items).slice(0, limit),
      ...temporary,
      spaces: activity,
    }
  }
  const key = (item: RecentDocument) =>
    sort === "created" ? item.document.createdAt : item.document.updatedAt
  // Unknown creation times are excluded from the Created view rather than
  // being shown as new.
  const sorted = items
    .filter((item) => key(item) !== undefined)
    .sort((a, b) => key(b)!.localeCompare(key(a)!))
  const featured = options.featured ? await featuredDocument(items) : undefined
  return {
    items: sorted.filter((item) => item !== featured?.from).slice(0, limit),
    ...temporary,
    ...(featured ? { featured: featured.document } : {}),
    spaces: activity,
  }
}

/** The newest doc made in the last day whose last change was an agent's. */
async function featuredDocument(
  items: RecentDocument[]
): Promise<{ from: RecentDocument; document: FeaturedDocument } | undefined> {
  const since = new Date(Date.now() - FEATURED_WITHIN_MS).toISOString()
  const newest = items
    .filter(
      (item) =>
        item.lastEditor?.kind === "agent" &&
        item.document.createdAt !== undefined &&
        item.document.createdAt >= since
    )
    .sort((a, b) => b.document.createdAt!.localeCompare(a.document.createdAt!))[0]
  if (!newest) return undefined
  const excerpt = await docExcerpt(newest.spaceId, newest.document)
  return { from: newest, document: { ...newest, ...(excerpt ? { excerpt } : {}) } }
}

// ---- excerpts ----
//
// The featured doc shows its opening lines. They come from the doc's own
// source, read once per change and kept, so a revisit reads nothing.

const EXCERPT_CHARS = 240
const EXCERPTS_KEPT = 64
const excerpts = new Map<string, { updatedAt: string; text: string | null }>()

async function docExcerpt(
  spaceId: string,
  document: DocumentSummary
): Promise<string | undefined> {
  const format = document.format.id
  if (format !== "worktable.markdown" && format !== "worktable.rich-text") return undefined
  const key = `${spaceId}\0${document.path}`
  const updatedAt = document.updatedAt ?? ""
  const cached = excerpts.get(key)
  if (cached?.updatedAt === updatedAt) return cached.text ?? undefined
  let text: string | null = null
  try {
    const snapshot = await readDocSourceSnapshot(spaceId, document.path)
    const markdown = await docMarkdownProjection(spaceId, document.path, snapshot)
    text = markdown === null ? null : plainOpening(markdown, document.title)
  } catch {
    text = null
  }
  excerpts.delete(key)
  excerpts.set(key, { updatedAt, text })
  if (excerpts.size > EXCERPTS_KEPT) excerpts.delete(excerpts.keys().next().value!)
  return text ?? undefined
}

/** The first prose after the title, as plain text, cut at a word. */
export function plainOpening(markdown: string, title: string): string | null {
  const lines = markdown
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(#{1,6}\s|\||[-*_]{3,}$|<)/.test(line))
    .filter((line) => line !== title)
    .map((line) => line.replace(/^(?:[-+*>]|\d+\.)\s+/, ""))
  const text = lines
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return null
  if (text.length <= EXCERPT_CHARS) return text
  const cut = text.slice(0, EXCERPT_CHARS)
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length)}…`
}

// ============================================================
// Recent documents across Spaces
// ============================================================
//
// Home and Space overviews list real documents by when they changed or were
// created. Temporary documents are supporting work, so they are left out
// unless asked for; asking for only temporary documents lists them by when
// they archive. Archived documents never appear, and an archived Space only
// when it is the one asked for, so its overview stays browsable.
//
// Each row names who last created or edited the doc, from the in-memory
// summary of each Space's activity. A Space's history is read once, on its
// first list after the server starts.


import type { ActivityActor, DocumentSummary } from "@worktable/types"
import { docActivityReady, peekDocActivity } from "./activity-log.ts"
import { pathMovesFor } from "./doc-aliases.ts"
import { listDocumentsWithAliases } from "./document-query.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"
import { isGettingStartedSpace } from "./getting-started.ts"
import { logError } from "./debug-log.ts"

export type RecentSort = "updated" | "created"

export interface RecentDocument {
  spaceId: string
  spaceName: string
  document: DocumentSummary
  /** Who last created or edited the doc, when its history says. */
  lastEditor?: ActivityActor
  /** Whether that last change made the doc or edited it. */
  lastAction?: "created" | "edited"
}

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
  /**
   * Uploaded files don't use up `limit`: up to that many docs, with the files
   * among them on top. Lists that fold files into one row ask for this, so a
   * burst of uploads can't push docs out.
   */
  filesBeyondLimit?: boolean
}): Promise<{
  items: RecentDocument[]
  temporary?: RecentDocument[]
  spaces: SpaceActivity[]
  /** A Space couldn't be read, so the lists may be missing some of its docs. */
  incomplete?: true
}> {
  const sort = options.sort ?? "updated"
  const limit = options.limit ?? 30
  // Across Spaces, Recent is the person's own work: Getting Started's guides
  // are listed only when that Space is asked for.
  const spaces = (await listSpaces()).filter((space) =>
    options.spaceId === undefined
      ? !getSpaceArchiveInfo(space) && !isGettingStartedSpace(space)
      : space.id === options.spaceId
  )
  // Spaces are listed in parallel; one unreadable Space must not hide the
  // rest of the workspace's recent work.
  const perSpace = await Promise.all(
    spaces.map(async (space) => {
      try {
        let newest: string | undefined
        const spaceItems: RecentDocument[] = []
        const spaceTemporary: RecentDocument[] = []
        const [{ documents, aliases }] = await Promise.all([
          listDocumentsWithAliases({ spaceId: space.id }),
          docActivityReady(space.id),
        ])
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
            ![...options.actorIds].some((id) => activity?.everyone.has(id))
          ) {
            continue
          }
          const entry: RecentDocument = {
            spaceId: space.id,
            spaceName: space.name,
            document: item,
            ...(activity?.lastEditor
              ? {
                  lastEditor: activity.lastEditor,
                  ...(activity.lastAction ? { lastAction: activity.lastAction } : {}),
                }
              : {}),
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
          failed: false,
        }
      } catch (error) {
        console.error(`[recent-documents] could not list ${space.id}:`, logError(error))
        return { items: [], temporary: [], activity: { spaceId: space.id }, failed: true }
      }
    })
  )
  const items = perSpace.flatMap((entry) => entry.items)
  const activity: SpaceActivity[] = perSpace.map((entry) => entry.activity)
  const incomplete = perSpace.some((entry) => entry.failed)
    ? { incomplete: true as const }
    : {}
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
      ...incomplete,
    }
  }
  const key = (item: RecentDocument) =>
    sort === "created" ? item.document.createdAt : item.document.updatedAt
  // Unknown creation times are excluded from the Created view rather than
  // being shown as new.
  const sorted = items
    .filter((item) => key(item) !== undefined)
    .sort((a, b) => key(b)!.localeCompare(key(a)!))
  const listed = options.filesBeyondLimit
    ? docsWithFiles(sorted, limit)
    : sorted.slice(0, limit)
  return { items: listed, ...temporary, spaces: activity, ...incomplete }
}

/** The newest `limit` docs, with up to `limit` files among them. */
function docsWithFiles(sorted: RecentDocument[], limit: number): RecentDocument[] {
  const listed: RecentDocument[] = []
  let docs = 0
  let files = 0
  for (const item of sorted) {
    if (docs >= limit) break
    if (item.document.format.id === "worktable.file") {
      if (files >= limit) continue
      files++
    } else {
      docs++
    }
    listed.push(item)
  }
  return listed
}

// ============================================================
// Recent documents across Spaces
// ============================================================
//
// Home and Space overviews list real documents by when they changed or were
// created. Temporary documents are supporting work, so they are left out
// unless asked for. Archived Spaces and documents never appear.

import type { DocumentSummary } from "@worktable/types"
import { listDocuments } from "./document-query.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"

export type RecentSort = "updated" | "created"

export interface RecentDocument {
  spaceId: string
  spaceName: string
  document: DocumentSummary
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
  limit?: number
}): Promise<{ items: RecentDocument[]; spaces: SpaceActivity[] }> {
  const sort = options.sort ?? "updated"
  const limit = options.limit ?? 30
  const spaces = (await listSpaces()).filter(
    (space) =>
      !getSpaceArchiveInfo(space) &&
      (options.spaceId === undefined || space.id === options.spaceId)
  )
  // Spaces are listed in parallel; one unreadable Space must not hide the
  // rest of the workspace's recent work.
  const perSpace = await Promise.all(
    spaces.map(async (space) => {
      try {
        let newest: string | undefined
        const spaceItems: RecentDocument[] = []
        for (const item of await listDocuments({ spaceId: space.id })) {
          if (item.kind !== "document") continue
          if (item.updatedAt && (!newest || item.updatedAt > newest)) {
            newest = item.updatedAt
          }
          if (!options.includeTemporary && item.lifetime === "temporary") continue
          spaceItems.push({ spaceId: space.id, spaceName: space.name, document: item })
        }
        return {
          items: spaceItems,
          activity: { spaceId: space.id, ...(newest ? { lastActivityAt: newest } : {}) },
        }
      } catch (error) {
        console.error(`[recent-documents] could not list ${space.id}:`, error)
        return { items: [], activity: { spaceId: space.id } }
      }
    })
  )
  const items = perSpace.flatMap((entry) => entry.items)
  const activity: SpaceActivity[] = perSpace.map((entry) => entry.activity)
  const key = (item: RecentDocument) =>
    sort === "created" ? item.document.createdAt : item.document.updatedAt
  // Unknown creation times are excluded from the Created view rather than
  // being shown as new.
  const sorted = items
    .filter((item) => key(item) !== undefined)
    .sort((a, b) => key(b)!.localeCompare(key(a)!))
  return { items: sorted.slice(0, limit), spaces: activity }
}

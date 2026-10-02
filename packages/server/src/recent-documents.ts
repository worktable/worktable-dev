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
  const items: RecentDocument[] = []
  const activity: SpaceActivity[] = []
  for (const space of spaces) {
    let newest: string | undefined
    for (const item of await listDocuments({ spaceId: space.id })) {
      if (item.kind !== "document") continue
      if (item.updatedAt && (!newest || item.updatedAt > newest)) {
        newest = item.updatedAt
      }
      if (!options.includeTemporary && item.lifetime === "temporary") continue
      items.push({ spaceId: space.id, spaceName: space.name, document: item })
    }
    activity.push({ spaceId: space.id, ...(newest ? { lastActivityAt: newest } : {}) })
  }
  const key = (item: RecentDocument) =>
    sort === "created" ? item.document.createdAt : item.document.updatedAt
  // Unknown creation times are excluded from the Created view rather than
  // being shown as new.
  const sorted = items
    .filter((item) => key(item) !== undefined)
    .sort((a, b) => key(b)!.localeCompare(key(a)!))
  return { items: sorted.slice(0, limit), spaces: activity }
}

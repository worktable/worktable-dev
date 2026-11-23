import type { RecordCollectionSummary } from "@worktable/types"

/** The collection last opened in each Space, on this device. */
const key = (spaceId: string) => `worktable-last-collection:${spaceId}`

export function rememberCollection(spaceId: string, collectionId: string): void {
  try {
    localStorage.setItem(key(spaceId), collectionId)
  } catch {
    // Without storage, Records opens the first collection.
  }
}

/** Where a Space's Records opens: the collection last open, else the first. */
export function collectionToOpen(
  spaceId: string,
  collections: readonly RecordCollectionSummary[]
): string | undefined {
  let last: string | null = null
  try {
    last = localStorage.getItem(key(spaceId))
  } catch {
    last = null
  }
  return (
    collections.find((collection) => collection.id === last)?.id ??
    collections[0]?.id
  )
}

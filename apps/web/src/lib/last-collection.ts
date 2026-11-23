import { useSyncExternalStore } from "react"
import type { RecordCollectionSummary } from "@worktable/types"

/** The collection last opened in each Space, on this device. */
const key = (spaceId: string) => `worktable-last-collection:${spaceId}`
const listeners = new Set<() => void>()

export function rememberCollection(spaceId: string, collectionId: string): void {
  try {
    localStorage.setItem(key(spaceId), collectionId)
  } catch {
    // Without storage, Records opens the first collection.
  }
  for (const listener of listeners) listener()
}

function lastCollection(spaceId: string): string | null {
  try {
    return localStorage.getItem(key(spaceId))
  } catch {
    return null
  }
}

/** Where a Space's Records opens: the collection last open, else the first. */
export function collectionToOpen(
  spaceId: string,
  collections: readonly RecordCollectionSummary[]
): string | undefined {
  const last = lastCollection(spaceId)
  return (
    collections.find((collection) => collection.id === last)?.id ??
    collections[0]?.id
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith("worktable-last-collection:")) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/** `collectionToOpen`, kept current as collections are opened. */
export function useCollectionToOpen(
  spaceId: string,
  collections: readonly RecordCollectionSummary[]
): string | undefined {
  const last = useSyncExternalStore(
    subscribe,
    () => lastCollection(spaceId),
    () => null
  )
  return (
    collections.find((collection) => collection.id === last)?.id ??
    collections[0]?.id
  )
}

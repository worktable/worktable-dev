// ============================================================
// Removing what was derived from items that are gone
// ============================================================
//
// Derived output of a deleted item can't be read from the moment of the
// delete: every read starts from an item resolved with its access check. The
// sweep then removes it from the store, for a Space a moment after its
// documents change (through Worktable or on disk) and for every Space with
// kept output a while after start. It reads the Space's catalog snapshot,
// never a file, and runs only where the store keeps something for the Space.

import { DocumentSpaceNotFoundError, readDocumentCatalogSnapshot } from "./document-query.ts"
import { derivedStore } from "./derived-store.ts"
import { onWorkspaceChange } from "./workspace-events.ts"

/** How long a Space's changes settle before its sweep. */
const SETTLE_MS = 2_000
/** When every Space with kept output is swept after start. */
const FIRST_SWEEP_MS = 30_000

/** Removes what is kept for a Space's items that are gone; how many. */
export async function sweepDerivedOutput(spaceId: string): Promise<number> {
  const store = derivedStore()
  if (!store.spaces().includes(spaceId)) return 0
  let catalog: Awaited<ReturnType<typeof readDocumentCatalogSnapshot>>
  try {
    catalog = await readDocumentCatalogSnapshot(spaceId)
  } catch (error) {
    if (error instanceof DocumentSpaceNotFoundError) return store.removeAllBut(spaceId)
    throw error
  }
  const live = new Set<string>()
  for (const entry of catalog.entries) {
    if (entry.kind === "document") live.add(entry.handle.documentId)
  }
  return store.removeAllBut(spaceId, live)
}

/** Sweeps Spaces as their documents change, and all of them after start. */
export function startDerivedSweeps(): () => void {
  const due = new Map<string, ReturnType<typeof setTimeout>>()
  const schedule = (spaceId: string, delay: number) => {
    clearTimeout(due.get(spaceId))
    const timer = setTimeout(() => {
      due.delete(spaceId)
      void sweepDerivedOutput(spaceId).catch(() => {
        // Tried again at the Space's next change.
      })
    }, delay)
    timer.unref?.()
    due.set(spaceId, timer)
  }
  const stopListening = onWorkspaceChange((event) => {
    if (
      (event.type === "documentCorpus" || event.type === "doc" || event.type === "space") &&
      event.spaceId
    ) {
      schedule(event.spaceId, SETTLE_MS)
    }
  })
  const first = setTimeout(() => {
    try {
      for (const spaceId of derivedStore().spaces()) schedule(spaceId, 0)
    } catch {
      // The store couldn't open; nothing is kept to sweep.
    }
  }, FIRST_SWEEP_MS)
  first.unref?.()
  return () => {
    stopListening()
    clearTimeout(first)
    for (const timer of due.values()) clearTimeout(timer)
    due.clear()
  }
}

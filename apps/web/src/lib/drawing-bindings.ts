import { localBounds, type Store } from "@quickdrawjs/core"
import { drawingBindingUpdates, type QuickdrawDocument } from "@worktable/types"

export function installDrawingBindings(store: Store): () => void {
  return store.listenBeforeCommit((diff, source, applyingHistory) => {
    const records = store.getSnapshot().document
      .store as QuickdrawDocument["snapshot"]["document"]["store"]
    const updates = drawingBindingUpdates(
      records,
      localBounds,
      source !== "user" || applyingHistory
        ? {}
        : {
            previous: Object.fromEntries(
              Object.entries(diff.updated).map(([id, [before]]) => [id, before])
            ) as typeof records,
            addedIds: new Set(Object.keys(diff.added)),
          }
    )
    for (const record of updates) store.put(record)
  })
}

/** Re-run the installed binding hook after text metrics change. Remote commits
 * update derived geometry without entering history or triggering autosave. */
export function refreshDrawingBindings(store: Store): void {
  store.transact(() => {}, "remote")
}

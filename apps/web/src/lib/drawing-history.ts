import {
  invertDiff,
  type Diff,
  type Snapshot,
  type Store,
} from "@quickdrawjs/core"
import { createDrawingRecordComparator } from "@worktable/types"

// History entries replace entire records. Retain a gesture only if its authored
// preconditions still hold, including dependencies introduced by other writers.
// Simulating the stack also catches earlier gestures that relied on a dropped
// one. Never partially undo a gesture or put remote changes in local history.
export function refreshDrawingHistory(
  store: Store,
  snapshot: Snapshot
): number {
  store.endBatch()
  const same = createDrawingRecordComparator()
  const retain = (history: Diff[], undo: boolean) => {
    const records = new Map(Object.entries(snapshot.document.store))
    const kept: Diff[] = []
    for (const entry of [...history].reverse()) {
      const diff = undo ? invertDiff(entry) : entry
      if (
        Object.keys(diff.added).some((id) => records.has(id)) ||
        Object.entries(diff.removed).some(
          ([id, before]) => !same(records.get(id), before)
        ) ||
        Object.entries(diff.updated).some(
          ([id, [before]]) => !same(records.get(id), before)
        )
      )
        continue
      const candidate = new Map(records)
      for (const id of Object.keys(diff.removed)) candidate.delete(id)
      for (const record of Object.values(diff.added))
        candidate.set(record.id, record)
      for (const [id, [, after]] of Object.entries(diff.updated))
        candidate.set(id, after)
      const valid = [...candidate.values()].every((record) => {
        if (record.typeName !== "shape") return true
        if (
          record.type === "image" &&
          candidate.get(record.props.assetId)?.typeName !== "asset"
        )
          return false
        return [record.props.startBinding, record.props.endBinding].every(
          (binding) => {
            if (!binding) return true
            const target = candidate.get(binding.shapeId)
            return (
              target?.typeName === "shape" &&
              ["geo", "image", "text", "note"].includes(target.type)
            )
          }
        )
      })
      if (!valid) continue
      records.clear()
      for (const [id, record] of candidate) records.set(id, record)
      kept.unshift(entry)
    }
    return kept
  }
  const undos = retain(store.undos, true)
  const redos = retain(store.redos, false)
  const discarded =
    store.undos.length + store.redos.length - undos.length - redos.length
  const diff: Diff = { added: {}, removed: {}, updated: {} }
  for (const record of store.all()) {
    const next = snapshot.document.store[record.id]
    if (!next) diff.removed[record.id] = record
    else if (!same(record, next)) diff.updated[record.id] = [record, next]
  }
  for (const record of Object.values(snapshot.document.store)) {
    if (!store.has(record.id)) diff.added[record.id] = record
  }
  store.undos.splice(0, store.undos.length, ...undos)
  store.redos.splice(0, store.redos.length, ...redos)
  store.applyDiff(diff, "remote")
  return discarded
}

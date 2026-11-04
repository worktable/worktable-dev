// When history pruning at the storage limit may remove can have grown.
//
// Pruning (storage-pruning.ts) remembers what it found it could remove, so
// it doesn't walk every version again while nothing changed: someone typing
// past the limit saves often, and each save changes history's size without
// making anything removable. The count below moves only when something can
// become removable: a version that makes the one before it old, a delete, a
// new trash entry, a restore letting go of the version it held, a full recount.

let epoch = 0

/** Something pruning may remove can have appeared. No I/O. */
export function notePrunableHistory(): void {
  epoch += 1
}

export function prunableHistoryEpoch(): number {
  return epoch
}

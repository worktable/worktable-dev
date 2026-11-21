// A thread opened at a message by search has the message in its address.
// Choosing the same result again leaves the address as it was, so nothing
// would move: each choice is counted here, and the thread shows the message
// again when the count changes.

import { useSyncExternalStore } from "react"

let openings = 0
const listeners = new Set<() => void>()

/** Count a choice of a result that opens a thread at a message. */
export function countMessageOpening(): void {
  openings += 1
  for (const listener of listeners) listener()
}

/** How many such choices there have been, to name the latest. */
export function useMessageOpenings(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => openings,
    () => 0
  )
}

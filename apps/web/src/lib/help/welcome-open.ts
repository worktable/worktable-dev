/**
 * Settings > Help's Show Again opens the welcome wherever it's mounted. A
 * tiny signal rather than shared state, since only one welcome is mounted.
 */
const listeners = new Set<() => void>()

/** Open the welcome again, as from Settings > Help. */
export function openWelcome(): void {
  for (const listener of listeners) listener()
}

/** The welcome listens for Show Again; returns the unsubscribe. */
export function onOpenWelcome(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

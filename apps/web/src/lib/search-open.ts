// Imperative "open search" channel, like settings-open. The shell's shortcut
// and its header button ask for search from the page's first code; search
// itself loads with the sidebar, so a request made before it is there is
// kept until it listens.

const OPEN_SEARCH_EVENT = "worktable:open-search"

let waiting = false

export function openSearch(): void {
  waiting = true
  window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))
}

/**
 * Subscribe to openSearch calls, hearing at once of one made before anyone
 * listened; returns the unsubscribe function.
 */
export function onOpenSearch(handler: () => void): () => void {
  const listener = () => {
    waiting = false
    handler()
  }
  window.addEventListener(OPEN_SEARCH_EVENT, listener)
  if (waiting) listener()
  return () => window.removeEventListener(OPEN_SEARCH_EVENT, listener)
}

/** Whether a key press asks for search: Cmd or Ctrl+K, or a bare slash. */
export function isSearchShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false
  if (event.key === "k" || event.key === "K") {
    return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
  }
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
    return false
  }
  // A slash typed into a field or a Doc is text.
  const target = event.target
  return !(
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  )
}

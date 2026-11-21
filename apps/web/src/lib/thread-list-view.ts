// Routes read the view from the URL before their screen loads, so this file
// imports nothing at run time.

/** Whose threads a list shows: any with a person in them, only agents', or all. */
export type ThreadListFilter = "people" | "agents" | "all"

/** A filtered list, or the archive. */
export type ThreadListView = ThreadListFilter | "archived"

/**
 * The archive is a place, so the URL names it. The filter is a preference the
 * app remembers and never puts in the URL.
 */
export interface ThreadViewSearch {
  view?: "archived"
}

export function threadViewSearch(value: unknown): ThreadViewSearch {
  return value === "archived" ? { view: "archived" } : {}
}

/** A thread opened at one of its messages, as a search found it. */
export interface ThreadMessageSearch {
  message?: string
}

/** A thread page's search, for its other threads and views. */
export function withoutMessage<T extends ThreadMessageSearch>(search: T): Omit<T, "message"> {
  const rest: T = { ...search }
  delete rest.message
  return rest
}

export function threadMessageSearch(value: unknown): ThreadMessageSearch {
  return typeof value === "string" && /^msg_[A-Za-z0-9_-]{12,}$/.test(value)
    ? { message: value }
    : {}
}

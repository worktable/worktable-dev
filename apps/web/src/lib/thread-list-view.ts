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

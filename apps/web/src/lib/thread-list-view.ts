// Routes read the view from the URL before their screen loads, so this file
// imports nothing at run time.

/** Which threads a list shows: the reader's, everyone's, or the archive. */
export type ThreadListView = "mine" | "all" | "archived"

export function parseThreadListView(value: unknown): ThreadListView {
  return value === "all" || value === "archived" ? value : "mine"
}

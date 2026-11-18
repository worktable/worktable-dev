import type { ThreadListItem } from "@worktable/types"

// Routes read the view from the URL before their screen loads, so this file
// imports nothing at run time.

/** Which threads a list shows: the reader's, everyone's, or the archive. */
export type ThreadListView = "mine" | "all" | "archived"

export function parseThreadListView(value: unknown): ThreadListView {
  return value === "all" || value === "archived" ? value : "mine"
}

/** The threads a view shows, from the list it reads. */
export function threadsInView(
  threads: ThreadListItem[],
  view: ThreadListView,
  viewerMemberId: string | undefined
): ThreadListItem[] {
  return view === "mine"
    ? threads.filter((thread) =>
        thread.members.some((member) => member.id === viewerMemberId)
      )
    : threads
}

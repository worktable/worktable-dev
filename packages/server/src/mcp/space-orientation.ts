// ============================================================
// What an agent is told about one Space
// ============================================================
//
// Asking about a Space used to return every file in it twice, with each
// Doc's headings. Past about forty Docs that is more than an agent's app
// accepts, so the agent got an error, or the middle cut out, and no pins.
// This is the answer on the preview surface: the same size for a Space of
// ten files or ten thousand. The files themselves are a list call away.

/** One file, as much of it as orientation uses. */
export interface OrientItem {
  path: string
  title?: string
  /** ISO time of its last change, when known. */
  changedAt?: string
}

/** The most top-level folders named; the rest are counted. */
export const ORIENT_FOLDER_LIMIT = 40
/** How many of the latest changes are named. */
export const ORIENT_RECENT_LIMIT = 10
/** A title past this is cut: orientation names a file, it doesn't quote it. */
const ORIENT_TITLE_LENGTH = 120
/**
 * The most characters either list may take. A path is never cut, since a cut
 * path opens nothing, so a list of very long paths names fewer of them.
 */
export const ORIENT_LIST_CHARS = 6000

/** The rows from the start of a list that fit in its share of the answer. */
function fitting<T>(rows: readonly T[]): T[] {
  const kept: T[] = []
  let used = 0
  for (const row of rows) {
    used += JSON.stringify(row).length
    if (used > ORIENT_LIST_CHARS && kept.length > 0) break
    kept.push(row)
  }
  return kept
}

export const SPACE_ORIENT_HINT =
  "List files with worktable_files_read (pathPrefix for one folder), or find them with worktable_search."

const newestFirst = (left: { changedAt?: string }, right: { changedAt?: string }) =>
  (right.changedAt ?? "").localeCompare(left.changedAt ?? "")

/**
 * A Space's files as counts by top-level folder and its latest changes.
 * Files outside any folder count toward `items` only.
 */
export function orientItems(items: readonly OrientItem[]) {
  const byFolder = new Map<string, { path: string; items: number; changedAt?: string }>()
  for (const item of items) {
    const slash = item.path.indexOf("/")
    if (slash <= 0) continue
    const path = item.path.slice(0, slash)
    const folder = byFolder.get(path) ?? { path, items: 0 }
    folder.items += 1
    if (item.changedAt && item.changedAt > (folder.changedAt ?? "")) folder.changedAt = item.changedAt
    byFolder.set(path, folder)
  }
  const folders = [...byFolder.values()].sort(
    (left, right) => newestFirst(left, right) || left.path.localeCompare(right.path)
  )
  const recent = fitting(
    items
      .filter((item) => item.changedAt)
      .sort((left, right) => newestFirst(left, right) || left.path.localeCompare(right.path))
      .slice(0, ORIENT_RECENT_LIMIT)
      .map((item) => ({
        path: item.path,
        ...(item.title ? { title: item.title.slice(0, ORIENT_TITLE_LENGTH) } : {}),
        changedAt: item.changedAt!,
      }))
  )
  const named = fitting(folders.slice(0, ORIENT_FOLDER_LIMIT))
  return {
    items: items.length,
    folders: named,
    ...(folders.length > named.length ? { moreFolders: folders.length - named.length } : {}),
    recent,
  }
}

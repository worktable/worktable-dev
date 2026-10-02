// ============================================================
// Lifetime bookkeeping triggered by document activity
// ============================================================
//
// Depends only on the store so write, rename, and annotation code can call it
// without import cycles. Both helpers are best effort: bookkeeping must never
// fail the operation that triggered it.

import { graceEndsAt } from "./lifetime-rules.ts"
import { extendDocsArchiveOn, recordDocCreated } from "./store.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"

/** Actors whose annotations are bookkeeping rather than engagement. */
export const NON_ENGAGING_ACTORS: ReadonlySet<string> = new Set(["worktable-lint"])

/**
 * Keep temporary documents active after activity that doesn't change their
 * content: renames, moves, and comments. Content changes are already counted
 * from the document's last-modified time.
 */
export async function noteDocumentActivity(
  spaceId: string,
  paths: readonly string[],
  now: number = Date.now()
): Promise<void> {
  if (paths.length === 0) return
  try {
    const extended = await extendDocsArchiveOn(spaceId, paths, graceEndsAt(now))
    if (extended.length > 0) {
      notifyWorkspaceChange({ type: "documentCorpus", spaceId })
    }
  } catch (error) {
    console.error(
      `[document-lifetime] could not extend ${paths.join(", ")} in ${spaceId}:`,
      error
    )
  }
}

/** Record when a document was created through Worktable. */
export async function noteDocumentCreated(
  spaceId: string,
  path: string,
  now: number = Date.now()
): Promise<void> {
  try {
    await recordDocCreated(spaceId, path, new Date(now).toISOString())
  } catch (error) {
    console.error(
      `[document-lifetime] could not record creation of ${spaceId}/${path}:`,
      error
    )
  }
}

// ============================================================
// Lifetime bookkeeping triggered by document activity
// ============================================================
//
// Depends only on the store so write, rename, and annotation code can call it
// without import cycles. Both helpers are best effort: bookkeeping must never
// fail the operation that triggered it.

import { recordActivity } from "./activity-log.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import { graceEndsAt } from "./lifetime-rules.ts"
import { extendDocsArchiveOn, recordDocCreated } from "./store.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"
import { logDocument, logError } from "./debug-log.ts"

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
  options: {
    now?: number
    /** What the activity needed; a comment needs only read access. */
    access?: "read" | "edit"
  } = {}
): Promise<void> {
  if (paths.length === 0) return
  try {
    const extended = await extendDocsArchiveOn(
      spaceId,
      paths,
      graceEndsAt(options.now ?? Date.now()),
      options.access
    )
    if (extended.length > 0) {
      notifyWorkspaceChange({ type: "documentCorpus", spaceId })
    }
  } catch (error) {
    console.error(
      `[document-lifetime] could not extend ${paths.length} document(s) in ${spaceId}:`,
      logError(error)
    )
  }
}

/** Record when a document was created through Worktable. */
export async function noteDocumentCreated(
  spaceId: string,
  path: string,
  now: number = Date.now()
): Promise<void> {
  recordActivity({
    spaceId,
    action: "doc.created",
    target: { kind: "doc", path },
    at: new Date(now).toISOString(),
  })
  try {
    await recordDocCreated(spaceId, path, new Date(now).toISOString())
  } catch (error) {
    console.error(
      `[document-lifetime] could not record creation of ${logDocument(spaceId, path)}:`,
      logError(error)
    )
  }
}

/**
 * Note a move or rename in Activity as one line: a Doc, with whatever moved
 * under it, or a plain folder of Docs. Paths are matched as the catalog
 * compares them, so the prefix's letter case need not be the stored Doc's.
 */
export function noteDocsMoved(
  spaceId: string,
  fromPrefix: string,
  toPrefix: string,
  renamed: readonly { from: string; to: string }[]
): void {
  const moved = renamed.filter((entry) => entry.from !== entry.to)
  if (moved.length === 0) return
  const fromKey = analyzeDocumentPath(fromPrefix).comparisonKey
  const self = moved.find(
    (entry) => analyzeDocumentPath(entry.from).comparisonKey === fromKey
  )
  recordActivity({
    spaceId,
    action: "doc.moved",
    target: self
      ? { kind: "doc", path: self.to }
      : { kind: "doc", path: toPrefix, folder: true },
    from: self?.from ?? fromPrefix,
    to: self?.to ?? toPrefix,
    count: moved.length,
  })
}

/**
 * Note a delete in Activity as one line: the Doc that was at `path`, named
 * as it was called, with whatever went under it, or a plain folder of Docs.
 * `doc` is read before the delete, since nothing can name the Doc after.
 */
export function noteDocsDeleted(
  spaceId: string,
  path: string,
  deleted: readonly string[],
  doc: { path: string; title?: string } | undefined
): void {
  if (deleted.length === 0) return
  const isDoc = doc !== undefined && deleted.includes(doc.path)
  recordActivity({
    spaceId,
    action: "doc.deleted",
    target: isDoc
      ? { kind: "doc", path: doc.path, ...(doc.title ? { title: doc.title } : {}) }
      : { kind: "doc", path, folder: true },
    count: deleted.length,
  })
}

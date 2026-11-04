// Visitor comments on deleted documents that could not be erased yet. The
// comment store can be busy or briefly unavailable when a delete runs; the
// ids wait here, in app data beside the workspace's trash, and every
// deleted-items pass retries them (deleted-items.ts). The list is per
// workspace because the comment store is.
//
// A retry erases only comments of documents that are still deleted. A
// snapshot restore or workspace replacement can bring a document back with
// its id and its comments; an erase owed by the earlier state is then
// dropped, not applied. Checking at retry time covers every restore path.

import { mkdir, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { DocumentIdSchema } from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { atomicWriteText } from "./atomic-file.ts"
import { logError } from "./debug-log.ts"
import { eraseVisitorCommentsForDocuments } from "./visitor-comment-store.ts"
import { getSpacesDir, workspaceCacheKey } from "./workspace.ts"

function listPath(): { dir: string; file: string } {
  const dir = join(ensureAppDir(), "trash", workspaceCacheKey())
  return { dir, file: join(dir, "pending-comment-erase.json") }
}

async function readPending(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(listPath().file, "utf8")) as {
      documentIds?: unknown
    }
    return Array.isArray(parsed.documentIds)
      ? parsed.documentIds.filter(
          (id): id is string => DocumentIdSchema.safeParse(id).success
        )
      : []
  } catch {
    return []
  }
}

async function writePending(documentIds: readonly string[]): Promise<void> {
  const { dir, file } = listPath()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await atomicWriteText(
    file,
    `${JSON.stringify({ version: 1, documentIds: [...new Set(documentIds)].sort() })}\n`
  )
}

function tryErase(documentIds: readonly string[]): boolean {
  try {
    return eraseVisitorCommentsForDocuments(documentIds)
  } catch (error) {
    console.warn("[deleted-items] could not erase visitor comments:", logError(error))
    return false
  }
}

/**
 * Erase deleted documents' visitor comments now, or record them for the next
 * pass. Throws only when the record itself cannot be written.
 */
export async function eraseVisitorCommentsOrRecord(
  documentIds: readonly string[]
): Promise<void> {
  if (documentIds.length === 0 || tryErase(documentIds)) return
  await writePending([...(await readPending()), ...documentIds])
}

/**
 * Every document id a live Space lists, or null when an inventory cannot be
 * read, so nothing is erased on a guess.
 */
async function liveDocumentIds(): Promise<Set<string> | null> {
  const ids = new Set<string>()
  let spaces
  try {
    spaces = await readdir(getSpacesDir(), { withFileTypes: true })
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? ids : null
  }
  for (const space of spaces) {
    if (!space.isDirectory() || space.isSymbolicLink() || space.name === ".trash") {
      continue
    }
    let text: string
    try {
      text = await readFile(join(getSpacesDir(), space.name, "documents.meta.json"), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      return null
    }
    try {
      const parsed = JSON.parse(text) as { documents?: Record<string, unknown> }
      for (const id of Object.keys(parsed.documents ?? {})) ids.add(id)
    } catch {
      return null
    }
  }
  return ids
}

/**
 * Retry recorded erases of documents that are still deleted, and drop ids
 * whose document exists again. Keeps the list when the store still refuses.
 * Callers hold write admission and the lifecycle lock, which deletes record
 * under too.
 */
export async function retryPendingCommentErase(): Promise<void> {
  const pending = await readPending()
  if (pending.length === 0) return
  const live = await liveDocumentIds()
  if (!live) return
  const deleted = pending.filter((id) => !live.has(id))
  if (deleted.length > 0 && !tryErase(deleted)) return
  const settled = new Set(pending)
  await writePending((await readPending()).filter((id) => !settled.has(id)))
}

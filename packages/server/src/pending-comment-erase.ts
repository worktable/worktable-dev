// Visitor comments on deleted documents that could not be erased yet. The
// comment store can be busy or briefly unavailable when a delete runs; the
// ids wait here, in app data beside the workspace's trash, and every
// deleted-items pass retries them (deleted-items.ts). The list is per
// workspace because the comment store is.

import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { DocumentIdSchema } from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { atomicWriteText } from "./atomic-file.ts"
import { logError } from "./debug-log.ts"
import { eraseVisitorCommentsForDocuments } from "./visitor-comment-store.ts"
import { workspaceCacheKey } from "./workspace.ts"

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
 * Retry every recorded erase; keeps the list when the store still refuses.
 * Callers hold the lifecycle lock, which deletes record under too.
 */
export async function retryPendingCommentErase(): Promise<void> {
  const pending = await readPending()
  if (pending.length === 0 || !tryErase(pending)) return
  const erased = new Set(pending)
  await writePending((await readPending()).filter((id) => !erased.has(id)))
}

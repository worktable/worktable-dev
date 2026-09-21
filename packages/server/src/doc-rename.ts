// ============================================================
// Document rename lifecycle
// ============================================================
//
// A rename is one lifecycle operation regardless of transport. REST and MCP
// both come through here so the portable file/history/meta move cannot drift
// from live Yjs state, annotations, derived indexes, freshness, or events.
//
// This module deliberately does not inspect or rewrite document content.
// Rename-stable links are provided by the portable aliases recorded here;
// document content itself remains untouched.

import {
  docExists,
  docStat,
  getDocArchiveInfo,
  listDocsByPrefix,
  renameDoc,
  sanitizeDocPath,
} from "./store.ts"
import { yjsManager } from "./yjs-manager.ts"
import {
  AnnotationPathMoveConflictError,
  renameAnnotationDocPath,
  validateAnnotationDocPathMoves,
} from "./annotation-store.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { evictFreshness } from "./freshness.ts"
import { wsManager } from "./ws.ts"
import { recordDocAlias } from "./doc-aliases.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { invalidateHostedDocumentShares } from "./share-lifecycle.ts"
import {
  moveDurableDocumentExactlyLocked,
  moveDurableDocumentsByPrefixLocked,
  type DurablePrefixRenameMove,
} from "./document-lifecycle-journal.ts"
import { notifyDocContentChanged } from "./content-events.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"
import { DOCUMENT_STORAGE_PROFILE_IDS } from "./document-storage-profile.ts"

export interface RenameOutcome {
  renamed: Array<{ from: string; to: string }>
  error: string | null
}

/** Rename one document and apply every path-keyed lifecycle update. */
export async function renameDocAndSync(
  spaceId: string,
  fromPath: string,
  toPath: string
): Promise<RenameOutcome> {
  const from = sanitizeDocPath(fromPath)
  const to = sanitizeDocPath(toPath)
  if (from === to) {
    return withDocPathLock(spaceId, () =>
      renameDocAndSyncLocked(spaceId, from, to)
    )
  }
  return yjsManager.withDocPathMoveTransition(spaceId, from, to, () =>
    withDocPathLock(spaceId, () => renameDocAndSyncLocked(spaceId, from, to))
  )
}

async function renameDocAndSyncLocked(
  spaceId: string,
  fromPath: string,
  toPath: string
): Promise<RenameOutcome> {
  const from = sanitizeDocPath(fromPath)
  const to = sanitizeDocPath(toPath)

  // The MCP tool is idempotent. Treat caller-shaped equivalents such as
  // "/notes" and "notes" as one path, but do not turn a missing source into a
  // fake success.
  if (from === to) {
    if (!(await docExists(spaceId, from))) {
      return { renamed: [], error: `Doc not found: ${from}` }
    }
    return { renamed: [{ from, to }], error: null }
  }

  const durable = await moveDurableDocumentExactlyLocked(spaceId, from, to)
  if (durable.error) return { renamed: [], error: durable.error }
  if (durable.handled) {
    const renamed = [{ from, to }]
    notifyDocContentChanged(spaceId, from)
    notifyDocContentChanged(spaceId, to)
    await notifyWorkspaceChangeAndWait({
      type: "documentCorpus",
      spaceId,
    })
    await publishRenameSignals(spaceId, renamed)
    return { renamed, error: null }
  }

  try {
    await validateAnnotationDocPathMoves(spaceId, [{ from, to }])
  } catch (error) {
    if (error instanceof AnnotationPathMoveConflictError) {
      return { renamed: [], error: error.message }
    }
    throw error
  }

  const result = await renameDoc(spaceId, from, to)
  if (result.error) return { renamed: [], error: result.error }

  const renamed = [{ from, to }]
  await invalidateRenamedShares(spaceId, renamed)
  await finalizeRenames(spaceId, renamed)
  try {
    await recordDocAlias(spaceId, from, to, "exact")
  } catch (error) {
    await rollbackRenames(spaceId, renamed)
    throw error
  }
  return { renamed, error: null }
}

/** Rename one bounded Doc subtree as an all-or-nothing lifecycle generation. */
export async function renameDocsByPrefixAndSync(
  spaceId: string,
  fromPrefix: string,
  toPrefix: string
): Promise<RenameOutcome> {
  const from = sanitizeDocPath(fromPrefix)
  const to = sanitizeDocPath(toPrefix)
  const sourcePaths = (await listDocsByPrefix(spaceId, from)).sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length
    return depth || a.localeCompare(b)
  })
  if (sourcePaths.length === 0) {
    return { renamed: [], error: `Doc not found: ${from}` }
  }
  if (from === to) return { renamed: [], error: null }
  if (sourcePaths.length > 128) {
    return {
      renamed: [],
      error: "Move a folder with 128 or fewer documents",
    }
  }
  const planned = sourcePaths.map((path) => ({
    from: path,
    to: path === from ? to : `${to}${path.slice(from.length)}`,
    storageProfileId: DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile,
  }))
  return yjsManager.withDocPathMoveTransitions(spaceId, planned, () =>
    withDocPathLock(spaceId, () =>
      renameDocsByPrefixAndSyncLocked(spaceId, from, to, planned)
    )
  )
}

async function renameDocsByPrefixAndSyncLocked(
  spaceId: string,
  from: string,
  to: string,
  planned: readonly DurablePrefixRenameMove[]
): Promise<RenameOutcome> {
  const durable = await moveDurableDocumentsByPrefixLocked(
    spaceId,
    from,
    to,
    planned
  )
  if (durable.error) return { renamed: [], error: durable.error }
  if (!durable.handled || !durable.renamed) {
    return { renamed: [], error: `Doc not found: ${from}` }
  }
  const renamed = durable.renamed.map(({ from: oldPath, to: newPath }) => ({
    from: oldPath,
    to: newPath,
  }))
  for (const move of renamed) {
    notifyDocContentChanged(spaceId, move.from)
    notifyDocContentChanged(spaceId, move.to)
  }
  await notifyWorkspaceChangeAndWait({ type: "documentCorpus", spaceId })
  await publishRenameSignals(spaceId, renamed)
  return { renamed, error: null }
}

function invalidateRenamedShares(
  spaceId: string,
  moves: Array<{ from: string; to: string }>
): Promise<void> {
  return invalidateHostedDocumentShares(
    moves.flatMap(({ from, to }) =>
      [from, to].map((artifactKey) => ({
        kind: "doc" as const,
        spaceId,
        artifactKey,
      }))
    )
  )
}

async function rollbackRenames(
  spaceId: string,
  moves: Array<{ from: string; to: string }>
): Promise<void> {
  const reversed = [...moves].reverse().map(({ from, to }) => ({
    from: to,
    to: from,
  }))
  for (const move of reversed) {
    const result = await renameDoc(spaceId, move.from, move.to, {
      skipAliasChecks: true,
    })
    if (result.error) {
      throw new Error(
        `Alias persistence failed and rename rollback failed: ${result.error}`
      )
    }
  }
  await finalizeRenames(spaceId, reversed)
}

async function finalizeRenames(
  spaceId: string,
  moves: Array<{ from: string; to: string }>
): Promise<void> {
  for (const { from, to } of moves) {
    await yjsManager.renameState(spaceId, from, to)
    await renameAnnotationDocPath(spaceId, from, to)
  }

  await publishRenameSignals(spaceId, moves)
}

async function publishRenameSignals(
  spaceId: string,
  moves: Array<{ from: string; to: string }>
): Promise<void> {
  for (const { from, to } of moves) {
    evictFreshness(spaceId, from)
    evictFreshness(spaceId, to)
  }

  invalidateSearchIndex()

  for (const { from, to } of moves) {
    wsManager.broadcast(spaceId, {
      type: "doc_deleted",
      spaceId,
      docPath: from,
    })
    const statResult = await docStat(spaceId, to)
    wsManager.broadcast(spaceId, {
      type: "doc_update",
      spaceId,
      docPath: to,
      data: {
        path: to,
        updatedAt: statResult?.updatedAt ?? Date.now(),
        archived: await getDocArchiveInfo(spaceId, to),
      },
    })
  }
}

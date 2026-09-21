import { CanonicalIdSchema } from "@worktable/types"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  analyzeDocumentPath,
  documentPathKeyIsAtOrBelow,
  documentPathKeyIsBelow,
  remapDocumentPathPrefix,
} from "./document-path.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import {
  moveDurableDocumentsByPrefixLocked,
  type DurablePrefixRenameMove,
} from "./document-lifecycle-journal.ts"
import {
  DOCUMENT_STORAGE_PROFILE_IDS,
  documentStorageProfiles,
} from "./document-storage-profile.ts"
import { DocumentInventorySpaceNotFoundError } from "./document-inventory.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { notifyDocContentChanged } from "./content-events.ts"
import { evictFreshness } from "./freshness.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { docStat, getDocArchiveInfo } from "./store.ts"
import {
  pruneEmptyWidgetParents,
  readWidget,
  withWidgetTopologyLock,
  withWidgetWriteLocks,
} from "./widget-store.ts"
import { evictWidgetFreshness } from "./widget-freshness.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"
import { wsManager } from "./ws.ts"
import { yjsManager } from "./yjs-manager.ts"

export type MoveDocumentFolderResult =
  | {
      ok: true
      from: string
      to: string
      renamed: Array<{ from: string; to: string }>
    }
  | {
      ok: false
      kind: "not-found" | "conflict"
      error: string
    }

type PlannedFolderMove = DurablePrefixRenameMove & { formatId: string }

async function planDocumentFolderMove(
  spaceId: string,
  fromPrefix: string,
  toPrefix: string
): Promise<PlannedFolderMove[] | MoveDocumentFolderResult> {
  if (!CanonicalIdSchema.safeParse(spaceId).success) {
    return {
      ok: false,
      kind: "not-found",
      error: `Folder not found: ${fromPrefix}`,
    }
  }
  const from = analyzeDocumentPath(fromPrefix)
  const to = analyzeDocumentPath(toPrefix, { enforceNewPathGrammar: true })
  if (!from.safe || from.canonicalPath !== fromPrefix || !from.comparisonKey) {
    return {
      ok: false,
      kind: "not-found",
      error: `Folder not found: ${fromPrefix}`,
    }
  }
  const fromKey = from.comparisonKey
  if (
    !to.safe ||
    !to.portable ||
    to.canonicalPath !== toPrefix ||
    !to.comparisonKey ||
    documentPathKeyIsBelow(to.comparisonKey, fromKey)
  ) {
    return {
      ok: false,
      kind: "conflict",
      error: "Target document folder path is not portable",
    }
  }

  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    registry: createBuiltinDocumentFormatRegistry(),
  })
  const withinSource = (path: string): boolean => {
    const key = analyzeDocumentPath(path).comparisonKey
    return Boolean(key && documentPathKeyIsAtOrBelow(key, fromKey))
  }
  const belowSource = (path: string): boolean => {
    const key = analyzeDocumentPath(path).comparisonKey
    return Boolean(key && documentPathKeyIsBelow(key, fromKey))
  }
  const relevant = catalog.entries.filter((entry) =>
    entry.kind === "conflict"
      ? entry.claims.some((claim) => withinSource(claim.path))
      : withinSource(entry.descriptor.path)
  )
  const hasDescendant = relevant.some((entry) =>
    entry.kind === "conflict"
      ? entry.claims.some((claim) => belowSource(claim.path))
      : belowSource(entry.descriptor.path)
  )
  if (relevant.length === 0 || !hasDescendant) {
    return {
      ok: false,
      kind: "not-found",
      error: `Folder not found: ${fromPrefix}`,
    }
  }
  if (relevant.some((entry) => entry.kind !== "document")) {
    return {
      ok: false,
      kind: "conflict",
      error: "Document sources are ambiguous inside this folder",
    }
  }

  const documents = relevant
    .filter((entry) => entry.kind === "document")
    .sort((left, right) => {
      const depth =
        left.descriptor.path.split("/").length -
        right.descriptor.path.split("/").length
      return depth || left.descriptor.path.localeCompare(right.descriptor.path)
    })
  if (documents.length > 128) {
    return {
      ok: false,
      kind: "conflict",
      error: "Move a folder with 128 or fewer documents",
    }
  }

  const moves: PlannedFolderMove[] = []
  for (const document of documents) {
    const storageProfileId = document.handle.storageProfile
    if (
      !storageProfileId ||
      !documentStorageProfiles.get(storageProfileId).managedPrefixRename ||
      document.handle.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error"
      )
    ) {
      return {
        ok: false,
        kind: "conflict",
        error: "This folder contains a document type that can't be moved yet",
      }
    }
    const fromPath = document.descriptor.path
    const toPath = remapDocumentPathPrefix(fromPath, fromPrefix, toPrefix)
    if (!toPath) {
      return {
        ok: false,
        kind: "conflict",
        error: "Document folder contents changed before the move",
      }
    }
    moves.push({
      from: fromPath,
      to: toPath,
      storageProfileId,
      formatId: document.descriptor.format.id,
    })
  }
  return moves
}

async function publishFolderMove(
  spaceId: string,
  moves: readonly PlannedFolderMove[]
): Promise<void> {
  for (const move of moves) {
    if (
      move.formatId === BUILTIN_DOCUMENT_FORMATS.html
    ) {
      evictWidgetFreshness(spaceId, move.from)
      evictWidgetFreshness(spaceId, move.to)
      const { data: widget } = await readWidget(spaceId, move.to)
      if (widget) {
        wsManager.broadcast(spaceId, {
          type: "widget_moved",
          spaceId,
          widgetId: move.to,
          previousWidgetId: move.from,
          data: widget,
        })
      }
      if (
        move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      ) {
        try {
          await pruneEmptyWidgetParents(spaceId, move.from)
        } catch (error) {
          console.warn(
            `[document-folder-move] could not prune empty folders for ${spaceId}/${move.from}`,
            error
          )
        }
      }
      continue
    }

    notifyDocContentChanged(spaceId, move.from)
    notifyDocContentChanged(spaceId, move.to)
    evictFreshness(spaceId, move.from)
    evictFreshness(spaceId, move.to)
    wsManager.broadcast(spaceId, {
      type: "doc_deleted",
      spaceId,
      docPath: move.from,
    })
    const stat = await docStat(spaceId, move.to)
    wsManager.broadcast(spaceId, {
      type: "doc_update",
      spaceId,
      docPath: move.to,
      data: {
        path: move.to,
        updatedAt: stat?.updatedAt ?? Date.now(),
        archived: await getDocArchiveInfo(spaceId, move.to),
      },
    })
  }
  invalidateSearchIndex()
  await notifyWorkspaceChangeAndWait({ type: "documentCorpus", spaceId })
}

/** Move one bounded mixed-format subtree as a single durable generation. */
export async function moveDocumentFolder(
  spaceId: string,
  fromPrefix: string,
  toPrefix: string
): Promise<MoveDocumentFolderResult> {
  let planned: PlannedFolderMove[] | MoveDocumentFolderResult
  try {
    planned = await planDocumentFolderMove(spaceId, fromPrefix, toPrefix)
  } catch (error) {
    if (error instanceof DocumentInventorySpaceNotFoundError) {
      return {
        ok: false,
        kind: "not-found",
        error: `Folder not found: ${fromPrefix}`,
      }
    }
    throw error
  }
  if (!Array.isArray(planned)) return planned
  if (fromPrefix === toPrefix) {
    return {
      ok: true,
      from: fromPrefix,
      to: toPrefix,
      renamed: planned.map(({ from, to }) => ({ from, to })),
    }
  }

  const docMoves = planned.filter(
    (move) =>
      move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
  )
  const htmlPaths = planned.flatMap((move) =>
    move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      ? [move.from, move.to]
      : []
  )
  const runJournal = async () => {
    const outcome = await moveDurableDocumentsByPrefixLocked(
      spaceId,
      fromPrefix,
      toPrefix,
      planned
    )
    if (outcome.error) {
      return {
        ok: false,
        kind: "conflict",
        error: outcome.error,
      } satisfies MoveDocumentFolderResult
    }
    if (!outcome.handled || !outcome.renamed) {
      return {
        ok: false,
        kind: "not-found",
        error: `Folder not found: ${fromPrefix}`,
      } satisfies MoveDocumentFolderResult
    }
    try {
      await publishFolderMove(spaceId, planned)
    } catch (error) {
      console.warn(
        `[document-folder-move] could not publish derived state for ${spaceId}/${fromPrefix} -> ${toPrefix}`,
        error
      )
    }
    return {
      ok: true,
      from: fromPrefix,
      to: toPrefix,
      renamed: outcome.renamed.map(({ from, to }) => ({ from, to })),
    } satisfies MoveDocumentFolderResult
  }
  const underDocumentLock = () =>
    withDocPathLock(spaceId, () =>
      htmlPaths.length === 0
        ? runJournal()
        : withWidgetTopologyLock(spaceId, () =>
            withWidgetWriteLocks(spaceId, htmlPaths, runJournal)
          )
    )
  return docMoves.length === 0
    ? underDocumentLock()
    : yjsManager.withDocPathMoveTransitions(
        spaceId,
        docMoves,
        underDocumentLock
      )
}

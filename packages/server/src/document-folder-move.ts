import { readdir, rmdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { CanonicalIdSchema } from "@worktable/types"
import { noteDocumentActivity } from "./document-activity.ts"
import { buildDocumentCatalog, type DocumentCatalog } from "./document-catalog.ts"
import { readDocumentCatalogSnapshot } from "./document-query.ts"
import { hasScope } from "./token-store.ts"
import { rewriteLinksAfterMove } from "./link-rewrite.ts"
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
import { invalidateSearchIndex } from "./search-index.ts"
import { docStat, getDocArchiveInfo } from "./store.ts"
import {
  pruneEmptyWidgetParents,
  readWidget,
  withWidgetTopologyLock,
  withWidgetWriteLocks,
} from "./widget-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"
import { wsManager } from "./ws.ts"
import { DocPathMoveConflictError, yjsManager } from "./yjs-manager.ts"
import { logDocument, logError } from "./debug-log.ts"
import {
  FOLDER_OPERATION_MAX_ENTRIES,
  folderTooLargeMessage,
} from "./folder-operation-limit.ts"

export type MoveDocumentFolderResult =
  | {
      ok: true
      from: string
      to: string
      renamed: Array<{ from: string; to: string }>
    }
  | {
      ok: false
      kind: "not-found" | "conflict" | "forbidden"
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
  if (documents.length > FOLDER_OPERATION_MAX_ENTRIES) {
    return {
      ok: false,
      kind: "conflict",
      error: folderTooLargeMessage("move", documents.length),
    }
  }

  // Answer a taken name before the move fences live rooms. The fence refuses
  // a destination someone has open, which would hide the reason.
  const sourceKeys = new Set(
    documents.map(
      (document) => analyzeDocumentPath(document.descriptor.path).comparisonKey
    )
  )
  const occupiedKeys = new Set(
    catalog.entries.map((entry) =>
      entry.kind === "conflict"
        ? entry.pathKey
        : analyzeDocumentPath(entry.descriptor.path).comparisonKey
    )
  )
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
    const toKey = analyzeDocumentPath(toPath).comparisonKey
    if (toKey && !sourceKeys.has(toKey) && occupiedKeys.has(toKey)) {
      return {
        ok: false,
        kind: "conflict",
        error: `Target path already exists: ${toPath}`,
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
  await noteDocumentActivity(
    spaceId,
    moves.map((move) => move.to)
  )
  for (const move of moves) {
    if (
      move.formatId === BUILTIN_DOCUMENT_FORMATS.html
    ) {
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
            `[document-folder-move] could not prune empty folders for ${logDocument(spaceId, move.from)}`,
            logError(error)
          )
        }
      }
      continue
    }

    notifyDocContentChanged(spaceId, move.from)
    notifyDocContentChanged(spaceId, move.to)
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
  invalidateSearchIndex({ spaceId })
  await notifyWorkspaceChangeAndWait({ type: "documentCorpus", spaceId })
}

/** Whether a catalog lists anything below `path`: sub-Docs or files. */
export function catalogHasDocumentsBelow(
  catalog: DocumentCatalog,
  path: string
): boolean {
  const key = analyzeDocumentPath(path).comparisonKey
  if (!key) return false
  return catalog.entries.some((entry) => {
    const entryKey =
      entry.kind === "conflict"
        ? entry.pathKey
        : analyzeDocumentPath(entry.descriptor.path).comparisonKey
    return Boolean(entryKey && documentPathKeyIsBelow(entryKey, key))
  })
}

/**
 * The formats a credential may move, by its scopes: Docs with docs:write,
 * HTML Docs with widgets:write, anything with documents:write. Undefined
 * when nothing limits it, as for the app's own moves, which pass no scopes.
 */
export function formatsWritableWith(
  scopes: readonly string[] | undefined
): ReadonlySet<string> | undefined {
  if (!scopes || hasScope([...scopes], "documents:write")) return undefined
  const formats = new Set<string>()
  if (hasScope([...scopes], "docs:write")) {
    formats.add(BUILTIN_DOCUMENT_FORMATS.markdown)
    formats.add(BUILTIN_DOCUMENT_FORMATS.richText)
  }
  if (hasScope([...scopes], "widgets:write")) {
    formats.add(BUILTIN_DOCUMENT_FORMATS.html)
  }
  return formats
}

/**
 * Whether a Doc has a folder of its own to move with it: the Doc exists and
 * sub-Docs or files sit in the folder named after it. A folder with no Doc
 * of its own is not a Doc's, and a move naming it finds no Doc. Reads the
 * Space's snapshot; a single-Doc move checks again under its lock.
 */
export async function hasDocumentsBelow(
  spaceId: string,
  path: string,
  options: { lockHeld?: boolean } = {}
): Promise<boolean> {
  const key = analyzeDocumentPath(path).comparisonKey
  if (!key) return false
  // A Space that can't be read here is refused by the move itself, with its
  // own reason.
  const catalog = await readDocumentCatalogSnapshot(spaceId, options).catch(
    () => null
  )
  if (!catalog) return false
  const isDocument = catalog.entries.some(
    (entry) =>
      entry.kind === "document" &&
      analyzeDocumentPath(entry.descriptor.path).comparisonKey === key
  )
  return isDocument && catalogHasDocumentsBelow(catalog, path)
}

/**
 * Remove the folders a move left empty, deepest first, so the Space's folder
 * matches what it lists. A folder with anything still in it stays.
 */
async function removeEmptiedFolders(directory: string): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removeEmptiedFolders(join(directory, entry.name))
    }
  }
  await rmdir(directory).catch(() => undefined)
}

/** Move one bounded mixed-format subtree as a single durable generation. */
export async function moveDocumentFolder(
  spaceId: string,
  fromPrefix: string,
  toPrefix: string,
  /**
   * The formats the caller may move. Checked on the plan, which the move
   * confirms under its lock, so nothing else slips in.
   */
  options: { formats?: ReadonlySet<string> } = {}
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
  const { formats } = options
  if (formats && planned.some((move) => !formats.has(move.formatId))) {
    return {
      ok: false,
      kind: "forbidden",
      error:
        "This folder holds documents this access can't move. Moving it needs documents:write access.",
    }
  }
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
        `[document-folder-move] could not publish derived state for ${logDocument(spaceId, fromPrefix)} -> ${logDocument(spaceId, toPrefix)}`,
        logError(error)
      )
    }
    await removeEmptiedFolders(
      resolve(getWorkspaceRoot(), "spaces", spaceId, "docs", ...fromPrefix.split("/"))
    )
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
  let result: MoveDocumentFolderResult
  try {
    result =
      docMoves.length === 0
        ? await underDocumentLock()
        : await yjsManager.withDocPathMoveTransitions(
            spaceId,
            docMoves,
            underDocumentLock
          )
  } catch (error) {
    // The fence refused before anything moved.
    if (error instanceof DocPathMoveConflictError) {
      return { ok: false, kind: "conflict", error: error.message }
    }
    throw error
  }
  // Outside the locks: rewriting links writes the Docs that hold them.
  if (result.ok) await rewriteLinksAfterMove(spaceId, result.renamed)
  return result
}

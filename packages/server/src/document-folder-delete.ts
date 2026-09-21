import { CanonicalIdSchema } from "@worktable/types"
import { buildDocumentCatalog } from "./document-catalog.ts"
import { DOCUMENT_DELETE_ADAPTER_IDS } from "./document-delete-adapter.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import { DocumentInventorySpaceNotFoundError } from "./document-inventory.ts"
import {
  admitManagedDocumentWrite,
  ManagedDocumentAdmissionError,
} from "./document-identity-admission.ts"
import {
  deleteDurableDocumentsByPrefixLocked,
  didDocumentLifecyclePreserveGeneration,
  type DurablePrefixDeleteDocument,
} from "./document-lifecycle-journal.ts"
import {
  analyzeDocumentPath,
  documentPathKeyIsAtOrBelow,
  documentPathKeyIsBelow,
} from "./document-path.ts"
import { documentStorageProfiles } from "./document-storage-profile.ts"
import { withDocGenerationLocks } from "./doc-generation-lock.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { notifyDocContentChanged } from "./content-events.ts"
import { evictFreshness } from "./freshness.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import {
  pruneEmptyWidgetParents,
  withWidgetTopologyLock,
  withWidgetWriteLocks,
} from "./widget-store.ts"
import { evictWidgetFreshness } from "./widget-freshness.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"
import { wsManager } from "./ws.ts"
import { DocFormatTransitionConflictError, yjsManager } from "./yjs-manager.ts"

export type DeleteDocumentFolderResult =
  | { ok: true; path: string; paths: string[] }
  | {
      ok: false
      kind: "not-found" | "conflict"
      error: string
    }

interface PlannedDocumentFolderDelete extends DurablePrefixDeleteDocument {
  identity: "durable" | "provisional"
  formatId: string
}

async function planDocumentFolderDelete(
  spaceId: string,
  prefix: string
): Promise<PlannedDocumentFolderDelete[] | DeleteDocumentFolderResult> {
  if (!CanonicalIdSchema.safeParse(spaceId).success) {
    return {
      ok: false,
      kind: "not-found",
      error: `Folder not found: ${prefix}`,
    }
  }
  const analyzed = analyzeDocumentPath(prefix)
  if (
    !analyzed.safe ||
    analyzed.canonicalPath !== prefix ||
    !analyzed.comparisonKey
  ) {
    return {
      ok: false,
      kind: "not-found",
      error: `Folder not found: ${prefix}`,
    }
  }
  const prefixKey = analyzed.comparisonKey
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    registry: createBuiltinDocumentFormatRegistry(),
  })
  const withinFolder = (path: string): boolean => {
    const key = analyzeDocumentPath(path).comparisonKey
    return Boolean(key && documentPathKeyIsAtOrBelow(key, prefixKey))
  }
  const belowFolder = (path: string): boolean => {
    const key = analyzeDocumentPath(path).comparisonKey
    return Boolean(key && documentPathKeyIsBelow(key, prefixKey))
  }
  const relevant = catalog.entries.filter((entry) =>
    entry.kind === "conflict"
      ? entry.claims.some((claim) => withinFolder(claim.path))
      : withinFolder(entry.descriptor.path)
  )
  const hasDescendant = relevant.some((entry) =>
    entry.kind === "conflict"
      ? entry.claims.some((claim) => belowFolder(claim.path))
      : belowFolder(entry.descriptor.path)
  )
  if (relevant.length === 0 || !hasDescendant) {
    return {
      ok: false,
      kind: "not-found",
      error: `Folder not found: ${prefix}`,
    }
  }
  if (relevant.some((entry) => entry.kind !== "document")) {
    return {
      ok: false,
      kind: "conflict",
      error: "Document sources are ambiguous inside this folder",
    }
  }
  const entries = relevant
    .filter((entry) => entry.kind === "document")
    .sort((left, right) => {
      const depth =
        left.descriptor.path.split("/").length -
        right.descriptor.path.split("/").length
      return depth || left.descriptor.path.localeCompare(right.descriptor.path)
    })
  if (entries.length > 128) {
    return {
      ok: false,
      kind: "conflict",
      error: "Delete a folder with 128 or fewer documents",
    }
  }

  const documents: PlannedDocumentFolderDelete[] = []
  for (const entry of entries) {
    const storageProfileId = entry.handle.storageProfile
    const deleteAdapter = storageProfileId
      ? documentStorageProfiles.get(storageProfileId).deleteAdapter
      : null
    if (
      !storageProfileId ||
      !deleteAdapter ||
      entry.handle.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error"
      )
    ) {
      return {
        ok: false,
        kind: "conflict",
        error: "This folder contains a document type that can't be deleted yet",
      }
    }
    documents.push({
      path: entry.descriptor.path,
      storageProfileId,
      deleteAdapter,
      identity: entry.handle.identity,
      formatId: entry.descriptor.format.id,
    })
  }
  return documents
}

async function publishFolderDelete(
  spaceId: string,
  documents: readonly PlannedDocumentFolderDelete[]
): Promise<void> {
  for (const document of documents) {
    if (document.formatId === BUILTIN_DOCUMENT_FORMATS.html) {
      evictWidgetFreshness(spaceId, document.path)
      wsManager.broadcast(spaceId, {
        type: "widget_deleted",
        spaceId,
        widgetId: document.path,
      })
      if (document.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml) {
        try {
          await pruneEmptyWidgetParents(spaceId, document.path)
        } catch (error) {
          console.warn(
            `[document-folder-delete] could not prune empty folders for ${spaceId}/${document.path}`,
            error
          )
        }
      }
      continue
    }
    notifyDocContentChanged(spaceId, document.path)
    evictFreshness(spaceId, document.path)
    wsManager.broadcast(spaceId, {
      type: "doc_deleted",
      spaceId,
      docPath: document.path,
    })
  }
  invalidateSearchIndex()
  await notifyWorkspaceChangeAndWait({ type: "documentCorpus", spaceId })
}

/** Permanently delete one bounded mixed-format document folder atomically. */
export async function deleteDocumentFolder(
  spaceId: string,
  path: string
): Promise<DeleteDocumentFolderResult> {
  let planned: PlannedDocumentFolderDelete[] | DeleteDocumentFolderResult
  try {
    planned = await planDocumentFolderDelete(spaceId, path)
    if (
      Array.isArray(planned) &&
      planned.some((document) => document.identity === "provisional")
    ) {
      for (const document of planned) {
        if (document.identity === "durable") continue
        await admitManagedDocumentWrite({
          spaceId,
          path: document.path,
          family:
            document.deleteAdapter ===
            DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml
              ? "html"
              : "doc",
          transaction: async () => undefined,
          committedClaim: () => null,
          intent: "delete",
        })
      }
      planned = await planDocumentFolderDelete(spaceId, path)
    }
  } catch (error) {
    if (error instanceof DocumentInventorySpaceNotFoundError) {
      return {
        ok: false,
        kind: "not-found",
        error: `Folder not found: ${path}`,
      }
    }
    if (error instanceof ManagedDocumentAdmissionError) {
      return { ok: false, kind: "conflict", error: error.message }
    }
    throw error
  }
  if (!Array.isArray(planned)) return planned
  if (planned.some((document) => document.identity !== "durable")) {
    return {
      ok: false,
      kind: "conflict",
      error: "Document identities changed before folder deletion",
    }
  }

  const docPaths = planned.flatMap((document) =>
    document.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc
      ? [document.path]
      : []
  )
  const htmlPaths = planned.flatMap((document) =>
    document.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml
      ? [document.path]
      : []
  )
  const runJournal = async (): Promise<DeleteDocumentFolderResult> => {
    const outcome = await deleteDurableDocumentsByPrefixLocked(
      spaceId,
      path,
      planned
    )
    if (outcome.error) {
      return { ok: false, kind: "conflict", error: outcome.error }
    }
    if (!outcome.handled || !outcome.deleted) {
      return {
        ok: false,
        kind: "not-found",
        error: `Folder not found: ${path}`,
      }
    }
    try {
      await publishFolderDelete(spaceId, planned)
    } catch (error) {
      console.warn(
        `[document-folder-delete] could not publish derived state for ${spaceId}/${path}`,
        error
      )
    }
    return { ok: true, path, paths: outcome.deleted.map((entry) => entry.path) }
  }
  const underNamespaceLocks = () =>
    withDocPathLock(spaceId, () =>
      htmlPaths.length === 0
        ? runJournal()
        : withWidgetTopologyLock(spaceId, () =>
            withWidgetWriteLocks(spaceId, htmlPaths, runJournal)
          )
    )
  if (docPaths.length === 0) return underNamespaceLocks()
  try {
    return await withDocGenerationLocks(
      docPaths.map((docPath) => ({ spaceId, docPath })),
      () =>
        yjsManager.withDocGenerationTransitions(
          spaceId,
          docPaths,
          underNamespaceLocks,
          (result) => result.ok,
          didDocumentLifecyclePreserveGeneration
        )
    )
  } catch (error) {
    if (error instanceof DocFormatTransitionConflictError) {
      return {
        ok: false,
        kind: "conflict",
        error: "This folder is already changing. Try again.",
      }
    }
    throw error
  }
}

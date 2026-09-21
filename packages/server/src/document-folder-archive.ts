import { CanonicalIdSchema } from "@worktable/types"
import { DOCUMENT_ARCHIVE_ADAPTER_IDS } from "./document-archive-adapter.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import { DocumentInventorySpaceNotFoundError } from "./document-inventory.ts"
import {
  setDurableDocumentsArchivedByPrefixLocked,
  type DurablePrefixArchiveDocument,
} from "./document-lifecycle-journal.ts"
import {
  analyzeDocumentPath,
  documentPathKeyIsAtOrBelow,
  documentPathKeyIsBelow,
} from "./document-path.ts"
import { documentStorageProfiles } from "./document-storage-profile.ts"
import { materializeHtmlDocumentStorageV2, usesHtmlDocumentStorageV2 } from "./html-document-storage-v2.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { notifyDocContentChanged } from "./content-events.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { getDocArchiveInfo } from "./store.ts"
import { readWidget, withWidgetWriteLocks } from "./widget-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"
import { wsManager } from "./ws.ts"

export type SetDocumentFolderArchivedResult =
  | {
      ok: true
      path: string
      archived: boolean
      /** Every member covered by the converged folder operation, not only transitions. */
      paths: string[]
    }
  | {
      ok: false
      kind: "not-found" | "conflict"
      error: string
    }

interface PlannedFolderArchive {
  documents: PlannedFolderArchiveDocument[]
}

interface PlannedFolderArchiveDocument extends DurablePrefixArchiveDocument {
  formatId: string
}

async function planDocumentFolderArchive(
  spaceId: string,
  prefix: string
): Promise<PlannedFolderArchive | SetDocumentFolderArchivedResult> {
  if (!CanonicalIdSchema.safeParse(spaceId).success) {
    return {
      ok: false,
      kind: "not-found",
      error: `Folder not found: ${prefix}`,
    }
  }
  const analyzedPrefix = analyzeDocumentPath(prefix)
  if (
    !analyzedPrefix.safe ||
    analyzedPrefix.canonicalPath !== prefix ||
    !analyzedPrefix.comparisonKey
  ) {
    return {
      ok: false,
      kind: "not-found",
      error: `Folder not found: ${prefix}`,
    }
  }
  const prefixKey = analyzedPrefix.comparisonKey

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
      error: "Archive or restore a folder with 128 or fewer documents",
    }
  }

  const documents: PlannedFolderArchiveDocument[] = []
  for (const entry of entries) {
    const storageProfileId = entry.handle.storageProfile
    if (
      !storageProfileId ||
      !documentStorageProfiles.get(storageProfileId).archiveAdapter ||
      entry.handle.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error"
      )
    ) {
      return {
        ok: false,
        kind: "conflict",
        error:
          "This folder contains a document type that can't be archived or restored yet",
      }
    }
    documents.push({
      path: entry.descriptor.path,
      storageProfileId,
      formatId: entry.descriptor.format.id,
    })
  }
  return { documents }
}

async function publishFolderArchive(
  spaceId: string,
  archived: boolean,
  planned: readonly PlannedFolderArchiveDocument[],
  changed: readonly DurablePrefixArchiveDocument[]
): Promise<void> {
  const plannedByPath = new Map(
    planned.map((document) => [document.path, document])
  )
  for (const document of changed) {
    try {
      const plan = plannedByPath.get(document.path)
      if (!plan) {
        throw new Error("Document archive publication plan changed")
      }
      if (plan.formatId === BUILTIN_DOCUMENT_FORMATS.html) {
        const { data: widget } = await readWidget(spaceId, document.path)
        if (widget) {
          wsManager.broadcast(spaceId, {
            type: "widget_update",
            spaceId,
            widgetId: document.path,
            data: widget,
          })
        }
        continue
      }
      const profile = documentStorageProfiles.get(document.storageProfileId)
      const archiveAdapter = profile.archiveAdapter
      if (
        archiveAdapter === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest
      ) {
        const { data: widget } = await readWidget(spaceId, document.path)
        if (widget) {
          wsManager.broadcast(spaceId, {
            type: "widget_update",
            spaceId,
            widgetId: document.path,
            data: widget,
          })
        }
        continue
      }
      if (
        archiveAdapter === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyDocMetadata
      ) {
        notifyDocContentChanged(spaceId, document.path)
        wsManager.broadcast(spaceId, {
          type: "doc_update",
          spaceId,
          docPath: document.path,
          data: {
            path: document.path,
            archived: archived
              ? await getDocArchiveInfo(spaceId, document.path)
              : null,
          },
        })
        continue
      }
      if (archiveAdapter === null) {
        throw new Error("Document archive publication adapter is missing")
      }
      const unsupportedAdapter: never = archiveAdapter
      throw new Error(
        `Unsupported document archive publication adapter: ${String(unsupportedAdapter)}`
      )
    } catch (error) {
      console.warn(
        `[document-folder-archive] could not publish derived state for ${spaceId}/${document.path}`,
        error
      )
    }
  }
  invalidateSearchIndex()
  await notifyWorkspaceChangeAndWait({ type: "documentCorpus", spaceId })
}

/** Converge one bounded mixed-format document folder's archive state. */
export async function setDocumentFolderArchived(options: {
  spaceId: string
  path: string
  archived: boolean
  archivedBy: string
  reason?: string
}): Promise<SetDocumentFolderArchivedResult> {
  let planned: PlannedFolderArchive | SetDocumentFolderArchivedResult
  try {
    planned = await planDocumentFolderArchive(options.spaceId, options.path)
  } catch (error) {
    if (error instanceof DocumentInventorySpaceNotFoundError) {
      return {
        ok: false,
        kind: "not-found",
        error: `Folder not found: ${options.path}`,
      }
    }
    throw error
  }
  if ("ok" in planned) return planned

  const htmlPaths = planned.documents.flatMap((document) =>
    documentStorageProfiles.get(document.storageProfileId).archiveAdapter ===
    DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest
      ? [document.path]
      : []
  )
  const runJournal = async (): Promise<SetDocumentFolderArchivedResult> => {
    if (await usesHtmlDocumentStorageV2()) {
      for (const document of planned.documents) {
        if (document.formatId === BUILTIN_DOCUMENT_FORMATS.html) {
          await materializeHtmlDocumentStorageV2(options.spaceId, document.path)
        }
      }
    }
    const outcome = await setDurableDocumentsArchivedByPrefixLocked(
      options.spaceId,
      options.path,
      options.archived,
      planned.documents,
      {
        archivedBy: options.archivedBy,
        ...(options.reason ? { reason: options.reason } : {}),
      }
    )
    if (outcome.error) {
      return { ok: false, kind: "conflict", error: outcome.error }
    }
    if (!outcome.handled) {
      return {
        ok: false,
        kind: "not-found",
        error: `Folder not found: ${options.path}`,
      }
    }
    try {
      await publishFolderArchive(
        options.spaceId,
        options.archived,
        planned.documents,
        outcome.changed ?? []
      )
    } catch (error) {
      console.warn(
        `[document-folder-archive] could not publish derived state for ${options.spaceId}/${options.path}`,
        error
      )
    }
    return {
      ok: true,
      path: options.path,
      archived: options.archived,
      paths: planned.documents.map((document) => document.path),
    }
  }

  return withDocPathLock(options.spaceId, () =>
    htmlPaths.length === 0
      ? runJournal()
      : withWidgetWriteLocks(options.spaceId, htmlPaths, runJournal)
  )
}

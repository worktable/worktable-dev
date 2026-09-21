import {
  CanonicalIdSchema,
  WidgetIdSchema,
  type DocumentId,
} from "@worktable/types"
import {
  admitManagedDocumentWrite,
  ManagedDocumentAdmissionError,
} from "./document-identity-admission.ts"
import { DocumentInventorySpaceNotFoundError } from "./document-inventory.ts"
import { deleteDurableHtmlExactlyLocked } from "./document-lifecycle-journal.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { evictWidgetFreshness } from "./widget-freshness.ts"
import {
  pruneEmptyWidgetParents,
  withWidgetWriteLock,
} from "./widget-store.ts"
import { wsManager } from "./ws.ts"
import {
  isHtmlDocumentPath,
  usesHtmlDocumentStorageV2,
} from "./html-document-storage-v2.ts"
import {
  deleteRegisteredDocument,
  DocumentWriteError,
} from "./document-write-service.ts"

export type DeleteHtmlDocumentResult =
  | { ok: true; documentId: DocumentId }
  | { ok: false; kind: "not-found" | "conflict"; error: string }

/**
 * Retire one HTML document generation through the common namespace and its
 * format-specific transaction. REST and MCP deliberately share this path so
 * neither transport can omit generation-bound companions or derived state.
 */
export async function deleteHtmlDocument(
  spaceId: string,
  widgetId: string
): Promise<DeleteHtmlDocumentResult> {
  const storageV2 = await usesHtmlDocumentStorageV2()
  if (
    !CanonicalIdSchema.safeParse(spaceId).success ||
    (storageV2
      ? !isHtmlDocumentPath(widgetId)
      : !WidgetIdSchema.safeParse(widgetId).success)
  ) {
    return {
      ok: false,
      kind: "not-found",
      error: `Widget not found: ${widgetId}`,
    }
  }

  if (storageV2) {
    try {
      const deleted = await deleteRegisteredDocument({
        spaceId,
        path: widgetId,
      })
      evictWidgetFreshness(spaceId, widgetId)
      invalidateSearchIndex()
      wsManager.broadcast(spaceId, {
        type: "widget_deleted",
        spaceId,
        widgetId,
      })
      return { ok: true, documentId: deleted.documentId }
    } catch (error) {
      if (error instanceof DocumentWriteError) {
        return {
          ok: false,
          kind: error.reason === "not-found" ? "not-found" : "conflict",
          error: error.message,
        }
      }
      throw error
    }
  }

  let outcome: Awaited<ReturnType<typeof deleteDurableHtmlExactlyLocked>>
  try {
    outcome = await admitManagedDocumentWrite({
      spaceId,
      path: widgetId,
      family: "html",
      intent: "delete",
      transaction: () =>
        withWidgetWriteLock(spaceId, widgetId, async () => {
          const deleted = await deleteDurableHtmlExactlyLocked(
            spaceId,
            widgetId
          )
          if (deleted.handled && !deleted.error && deleted.documentId) {
            // These effects are rebuildable, but they must publish before a
            // same-path writer can establish the next generation.
            try {
              await pruneEmptyWidgetParents(spaceId, widgetId)
            } catch (error) {
              console.warn(
                `[html-delete] could not prune empty folders for ${spaceId}/${widgetId}`,
                error
              )
            }
            try {
              evictWidgetFreshness(spaceId, widgetId)
              invalidateSearchIndex()
              wsManager.broadcast(spaceId, {
                type: "widget_deleted",
                spaceId,
                widgetId,
              })
            } catch (error) {
              console.warn(
                `[html-delete] could not publish derived deletion state for ${spaceId}/${widgetId}`,
                error
              )
            }
          }
          return deleted
        }),
      committedClaim: () => null,
    })
  } catch (error) {
    if (error instanceof DocumentInventorySpaceNotFoundError) {
      return {
        ok: false,
        kind: "not-found",
        error: `Widget not found: ${widgetId}`,
      }
    }
    if (error instanceof ManagedDocumentAdmissionError) {
      return { ok: false, kind: "conflict", error: error.message }
    }
    throw error
  }

  if (!outcome.handled) {
    return {
      ok: false,
      kind: "not-found",
      error: `Widget not found: ${widgetId}`,
    }
  }
  if (outcome.error || !outcome.documentId) {
    return {
      ok: false,
      kind: "conflict",
      error: outcome.error ?? "Could not delete this HTML doc. Try again.",
    }
  }

  return { ok: true, documentId: outcome.documentId }
}

import {
  CanonicalIdSchema,
  WidgetIdSchema,
  type DocumentId,
} from "@worktable/types"
import { withDocPathLock } from "./doc-path-lock.ts"
import { DocumentInventorySpaceNotFoundError } from "./document-inventory.ts"
import { moveDurableHtmlExactlyLocked } from "./document-lifecycle-journal.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { evictWidgetFreshness } from "./widget-freshness.ts"
import {
  pruneEmptyWidgetParents,
  readWidget,
  withWidgetTopologyLock,
  withWidgetWriteLocks,
} from "./widget-store.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"
import { wsManager } from "./ws.ts"
import {
  isHtmlDocumentPath,
  usesHtmlDocumentStorageV2,
} from "./html-document-storage-v2.ts"
import { parseNewDocumentPath } from "./document-path.ts"
import {
  DocumentWriteError,
  moveRegisteredDocument,
} from "./document-write-service.ts"

export type MoveHtmlDocumentResult =
  | {
      ok: true
      from: string
      to: string
      documentId: DocumentId
    }
  | {
      ok: false
      kind: "not-found" | "conflict"
      error: string
    }

/**
 * Move one logical HTML document through the common namespace and durable
 * bundle lifecycle. REST and MCP share this service so path-keyed companions,
 * stable identity, aliases, and derived state cannot drift by transport.
 */
export async function moveHtmlDocument(
  spaceId: string,
  from: string,
  to: string
): Promise<MoveHtmlDocumentResult> {
  const storageV2 = await usesHtmlDocumentStorageV2()
  if (
    !CanonicalIdSchema.safeParse(spaceId).success ||
    (storageV2
      ? !isHtmlDocumentPath(from)
      : !WidgetIdSchema.safeParse(from).success)
  ) {
    return {
      ok: false,
      kind: "not-found",
      error: `HTML doc not found: ${from}`,
    }
  }
  if (
    storageV2
      ? "error" in parseNewDocumentPath(to)
      : !WidgetIdSchema.safeParse(to).success
  ) {
    return {
      ok: false,
      kind: "conflict",
      error: `HTML doc path cannot be moved here: ${to}`,
    }
  }

  if (storageV2) {
    try {
      const moved = await moveRegisteredDocument({ spaceId, path: from, to })
      evictWidgetFreshness(spaceId, from)
      evictWidgetFreshness(spaceId, to)
      invalidateSearchIndex()
      const { data: widget } = await readWidget(spaceId, to)
      if (widget) {
        wsManager.broadcast(spaceId, {
          type: from === to ? "widget_update" : "widget_moved",
          spaceId,
          widgetId: to,
          ...(from !== to ? { previousWidgetId: from } : {}),
          data: widget,
        })
      }
      return {
        ok: true,
        from,
        to,
        documentId: moved.documentId,
      }
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

  let outcome: Awaited<ReturnType<typeof moveDurableHtmlExactlyLocked>>
  try {
    outcome = await withDocPathLock(spaceId, () =>
      withWidgetTopologyLock(spaceId, () =>
        withWidgetWriteLocks(spaceId, [from, to], async () => {
          const moved = await moveDurableHtmlExactlyLocked(spaceId, from, to)
          if (!moved.handled || moved.error || !moved.documentId) return moved

          // Publish rebuildable state before a managed writer can reuse either
          // endpoint. The portable move has already committed at this point.
          if (from !== to) {
            try {
              await pruneEmptyWidgetParents(spaceId, from)
            } catch (error) {
              console.warn(
                `[html-move] could not prune empty folders for ${spaceId}/${from}`,
                error
              )
            }
          }
          try {
            evictWidgetFreshness(spaceId, from)
            evictWidgetFreshness(spaceId, to)
            invalidateSearchIndex()

            const { data: widget } = await readWidget(spaceId, to)
            if (widget) {
              wsManager.broadcast(spaceId, {
                type: from === to ? "widget_update" : "widget_moved",
                spaceId,
                widgetId: to,
                ...(from !== to ? { previousWidgetId: from } : {}),
                data: widget,
              })
            }
            await notifyWorkspaceChangeAndWait({
              type: "documentCorpus",
              spaceId,
            })
          } catch (error) {
            console.warn(
              `[html-move] could not publish derived move state for ${spaceId}/${from} -> ${to}`,
              error
            )
          }
          return moved
        })
      )
    )
  } catch (error) {
    if (error instanceof DocumentInventorySpaceNotFoundError) {
      return {
        ok: false,
        kind: "not-found",
        error: `HTML doc not found: ${from}`,
      }
    }
    throw error
  }

  if (!outcome.handled) {
    return {
      ok: false,
      kind: "not-found",
      error: `HTML doc not found: ${from}`,
    }
  }
  if (outcome.error || !outcome.documentId) {
    return {
      ok: false,
      kind: "conflict",
      error: outcome.error ?? "Could not move this HTML doc. Try again.",
    }
  }
  return {
    ok: true,
    from,
    to,
    documentId: outcome.documentId,
  }
}

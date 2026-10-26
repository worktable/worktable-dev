import type { WidgetFile } from "@worktable/types"
import { reservedByAliasIn } from "./doc-aliases.ts"
import {
  admitManagedDocumentWrite,
  ManagedDocumentAdmissionError,
} from "./document-identity-admission.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { deduplicateSlug, slugify } from "./store.ts"
import { buildWidgetFile } from "./widget-authoring.ts"
import {
  captureWidgetContentForOverwrite,
  recordWidgetVersion,
  versionableWidget,
} from "./widget-version-store.ts"
import {
  widgetIdDedupePool,
  withWidgetTopologyLock,
  withWidgetWriteLock,
  writeWidget,
} from "./widget-store.ts"
import { usesHtmlDocumentStorageV2 } from "./html-document-storage-v2.ts"

export interface CreateHtmlDocumentInput {
  spaceId: string
  explicitId?: string
  folder?: string
  name: string
  description?: string
  html: string
  createdBy?: string
  metadata?: Record<string, unknown>
  permissions?: WidgetFile["permissions"]
  requests?: WidgetFile["requests"]
  versionSource: string
  versionUpdatedBy: string
  /** Private initial content can be published without an edit-history entry. */
  recordVersion?: boolean
  /** Observe exact saved bytes while the transaction is locked. Must handle its own failures. */
  onSaved?: (saved: {
    widget: WidgetFile
    documentId?: string
  }) => Promise<void>
}

export interface CreateHtmlDocumentResult {
  data?: WidgetFile
  error?: string
}

/**
 * Create or explicitly replace one HTML document through the common namespace.
 * Automatic path selection stays in the same serialized transaction as the
 * write so concurrent REST and MCP creates cannot choose one bundle path.
 */
export async function createHtmlDocument(
  input: CreateHtmlDocumentInput
): Promise<CreateHtmlDocumentResult> {
  const storageV2 = await usesHtmlDocumentStorageV2()
  const claimFor = (id: string) => ({
    format: {
      id: BUILTIN_DOCUMENT_FORMATS.html,
      sourceVersion: 1 as const,
    },
    source: storageV2
      ? ({
          kind: "file" as const,
          relativePath: `docs/${id}.html`,
        } as const)
      : ({
          kind: "bundle" as const,
          relativePath: `widgets/${id}`,
        } as const),
  })
  return admitManagedDocumentWrite({
    spaceId: input.spaceId,
    path:
      input.explicitId ??
      (async (catalog) => {
        const folderReservation = input.folder
          ? reservedByAliasIn(catalog.aliases, input.folder)
          : null
        // Suffixing a leaf cannot escape a moved folder's prefix reservation.
        if (folderReservation?.kind === "prefix") {
          throw new ManagedDocumentAdmissionError(
            `This path is reserved by another document: ${folderReservation.path}`
          )
        }
        const slug = slugify(input.name)
        const base = input.folder ? `${input.folder}/${slug}` : slug
        const taken = widgetIdDedupePool(
          catalog.entries.map((entry) => ({
            id: (entry.kind === "document"
              ? entry.descriptor.path
              : entry.pathKey
            ).normalize("NFC"),
          }))
        )
        let candidate = await deduplicateSlug(base, taken)
        while (reservedByAliasIn(catalog.aliases, candidate)) {
          taken.push(candidate)
          candidate = await deduplicateSlug(base, taken)
        }
        return candidate
      }),
    family: "html",
    allowHtmlMetadataRepair: true,
    newDocumentClaim: claimFor,
    transaction: (id, admission) =>
      withWidgetTopologyLock(input.spaceId, () =>
        withWidgetWriteLock(input.spaceId, id, async () => {
          const beforeContent = await captureWidgetContentForOverwrite(
            input.spaceId,
            id
          )
          const result = await writeWidget(
            input.spaceId,
            buildWidgetFile({
              id,
              name: input.name,
              description: input.description,
              createdBy: input.createdBy,
              metadata: input.metadata,
              permissions: input.permissions,
              requests: input.requests,
            }),
            input.html,
            admission ? { documentId: admission.documentId } : undefined
          )
          if (result.error || !result.data) {
            return { error: result.error ?? "Write failed" }
          }
          if (input.recordVersion !== false)
            await recordWidgetVersion(
              input.spaceId,
              id,
              beforeContent,
              {
                source: input.versionSource,
                updatedBy: input.versionUpdatedBy,
              },
              {
                ...(admission ? { documentId: admission.documentId } : {}),
                ...(storageV2
                  ? {
                      afterContent: {
                        html: input.html,
                        widget: versionableWidget(result.data),
                        authoredSource: {
                          htmlBytes: new TextEncoder().encode(input.html),
                        },
                      },
                    }
                  : {}),
              }
            )
          result.release?.()
          await input.onSaved?.({
            widget: result.data,
            documentId: admission?.documentId,
          })
          return { data: result.data }
        })
      ),
    committedClaim: (result, id) => (result.data ? claimFor(id) : null),
  })
}

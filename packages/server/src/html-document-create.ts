import type { WidgetFile } from "@worktable/types"
import { readDocAliases, reservedByAliasIn } from "./doc-aliases.ts"
import { admitManagedDocumentWrite } from "./document-identity-admission.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { deduplicateSlug, slugify } from "./store.ts"
import { buildWidgetFile } from "./widget-authoring.ts"
import {
  captureWidgetContentForOverwrite,
  recordWidgetVersion,
  versionableWidget,
} from "./widget-version-store.ts"
import {
  listWidgets,
  widgetIdDedupePool,
  withWidgetTopologyLock,
  withWidgetWriteLock,
  writeWidget,
} from "./widget-store.ts"
import { usesHtmlDocumentStorageV2 } from "./html-document-storage-v2.ts"

export interface CreateHtmlDocumentInput {
  spaceId: string
  explicitId?: string
  name: string
  description?: string
  html: string
  createdBy?: string
  metadata?: Record<string, unknown>
  permissions?: WidgetFile["permissions"]
  versionSource: string
  versionUpdatedBy: string
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
      (async () => {
        const existing = await listWidgets(input.spaceId, {
          includeArchived: true,
          includeAliasShadows: true,
        })
        const base = slugify(input.name)
        const taken = widgetIdDedupePool(existing)
        const { aliases } = await readDocAliases(input.spaceId)
        let candidate = await deduplicateSlug(base, taken)
        while (aliases && reservedByAliasIn(aliases, candidate)) {
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
            }),
            input.html,
            admission ? { documentId: admission.documentId } : undefined
          )
          if (result.error || !result.data) {
            return { error: result.error ?? "Write failed" }
          }
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
          return { data: result.data }
        })
      ),
    committedClaim: (result, id) => (result.data ? claimFor(id) : null),
  })
}

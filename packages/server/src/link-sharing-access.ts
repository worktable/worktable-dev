import { randomBytes } from "node:crypto"
import { LINK_GRANT_MAX_COLLECTIONS } from "@worktable/types/constants"
import {
  CanonicalIdSchema,
  describeAbilities,
  type LinkGrant,
  type RecordCollectionSchema,
  type RecordFile,
  type ShareLinkAccess,
  type SharingPolicy,
} from "@worktable/types"
import { effectiveLinkGrant, validateLinkGrant } from "./link-grant.ts"
import { createLinkKey, openLinkReadView } from "./link-grant-view.ts"
import { suggestLinkGrant } from "./link-grant-suggest.ts"
import { readWidgetDocument } from "./widget-store.ts"
import { inferWidgetRecordPermissions } from "./widget-authoring.ts"
import { canWidgetRecord } from "./widget-runtime-policy.ts"
import { recordIndex, recordIndexEnabled } from "./record-index.ts"
import { listRecords, readRecordCollectionSchema } from "./record-store.ts"
import { runAsLinkVisitor, withLinkGrantRead } from "./team-policy.ts"
import type { ObservedRecordQuery } from "./html-preview.ts"

class CountsPending extends Error {}

/**
 * The collections an HTML tool reads, as its source and permissions name
 * them, without running it. Read when the share dialog opens.
 */
export async function toolReadCollections(
  spaceId: string,
  path: string
): Promise<string[]> {
  const { data } = await readWidgetDocument(spaceId, path)
  if (!data || data.widget.archive) return []
  const { permissions } = data.widget
  return [
    ...new Set([
      ...Object.keys(inferWidgetRecordPermissions(data.html)),
      ...Object.keys(permissions.records),
    ]),
  ]
    .filter(
      (id) =>
        CanonicalIdSchema.safeParse(id).success &&
        canWidgetRecord({ permissions }, id, "read")
    )
    .slice(0, LINK_GRANT_MAX_COLLECTIONS)
}

/** One explicit sharer action, outside the visitor and member-page hot paths. */
export async function prepareShareLinkAccess(input: {
  spaceId: string
  path: string
  policy: SharingPolicy
  grant?: LinkGrant
  observe: boolean
  scopes: string[]
  signal: AbortSignal
}): Promise<ShareLinkAccess | null> {
  const { data } = await readWidgetDocument(input.spaceId, input.path)
  if (!data || data.widget.archive) return null
  let html = data.html
  let permissions = data.widget.permissions
  let observed: ObservedRecordQuery[] = []
  const warnings: ShareLinkAccess["warnings"] = []
  if (input.observe) {
    try {
      const { freezeHtmlPreviewSnapshot, captureHtmlPreview } =
        await import("./html-preview.ts")
      const snapshot = await freezeHtmlPreviewSnapshot({
        spaceId: input.spaceId,
        path: input.path,
      })
      const capture = await captureHtmlPreview({
        snapshot,
        scopes: input.scopes,
        signal: input.signal,
        options: { timeoutMs: 5000 },
        observeRecordReads: true,
      })
      html = snapshot.html
      permissions = snapshot.permissions
      observed = capture.observed ?? []
      if (capture.status !== "complete")
        warnings.push({
          code: "preview_partial",
          message: "The check did not finish. Test the link before sharing it.",
        })
    } catch {
      warnings.push({
        code: "preview_unavailable",
        message:
          "The tool could not be checked. Review its access and test the link before sharing it.",
      })
    }
  }
  const names = new Set(
    [
      ...Object.keys(input.grant?.collections ?? {}),
      ...observed.map((read) => read.collectionId),
      ...Object.keys(inferWidgetRecordPermissions(html)),
      ...Object.keys(permissions.records),
    ].filter(
      (id) =>
        CanonicalIdSchema.safeParse(id).success &&
        canWidgetRecord({ permissions }, id, "read")
    )
  )
  if (names.size > LINK_GRANT_MAX_COLLECTIONS)
    warnings.push({
      code: "collections_limit",
      message: "This tool names more collections than one link can open.",
    })
  const schemas = new Map<string, RecordCollectionSchema>()
  const queue = [...names].slice(0, LINK_GRANT_MAX_COLLECTIONS)
  const queued = new Set(queue)
  for (const id of queue) {
    const { data: schema } = await readRecordCollectionSchema(input.spaceId, id)
    if (!schema) continue
    schemas.set(id, schema)
    for (const field of Object.values(schema.fields)) {
      const target = field.references
      if (
        !target ||
        queued.has(target) ||
        queued.size >= LINK_GRANT_MAX_COLLECTIONS ||
        !CanonicalIdSchema.safeParse(target).success ||
        !canWidgetRecord({ permissions }, target, "read")
      )
        continue
      queued.add(target)
      queue.push(target)
    }
  }
  const suggestion = suggestLinkGrant({ permissions, html, observed, schemas })
  const grant = input.grant ?? suggestion.grant
  const effectiveGrant = effectiveLinkGrant(grant, permissions, input.policy)
  const issues = validateLinkGrant(grant, schemas)
  for (const id of Object.keys(grant.collections)) {
    if (!Object.hasOwn(effectiveGrant.collections, id))
      issues.push({
        collectionId: id,
        message: "The tool or this Worktable no longer allows this access.",
      })
  }
  const blocked = new Set(issues.map((issue) => issue.collectionId))
  const counts: Record<string, number> = Object.create(null)
  const loadRows = async (collectionId: string): Promise<RecordFile[]> => {
    if (!recordIndexEnabled())
      return listRecords(input.spaceId, collectionId, {
        includeArchived: false,
      })
    const rows = recordIndex.listCollection(input.spaceId, collectionId, false)
    if (rows === null) throw new CountsPending()
    return rows
  }
  await runAsLinkVisitor(() =>
    withLinkGrantRead(input.spaceId, async () => {
      const view = await openLinkReadView(
        input.spaceId,
        effectiveGrant,
        createLinkKey(randomBytes(32)),
        { schemas, loadRows }
      )
      for (const id of Object.keys(effectiveGrant.collections)) {
        if (blocked.has(id)) continue
        try {
          counts[id] = (await view.rows(id)).length
        } catch (error) {
          if (!(error instanceof CountsPending)) throw error
          warnings.push({
            code: "counts_pending",
            collectionId: id,
            message:
              "The record count is being prepared. Check it again shortly.",
          })
        }
      }
    })
  )
  const collections = Object.fromEntries(schemas)
  return {
    grant,
    effectiveGrant,
    collections,
    counts,
    sentences: describeAbilities({
      audience: "link",
      grant: effectiveGrant,
      collections,
      counts,
    }).sentences,
    warnings: [...warnings, ...suggestion.warnings],
    issues,
    stateReadable: permissions.state?.read !== false,
  }
}
